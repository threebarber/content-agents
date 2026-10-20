import fs from "node:fs";
import { statePath } from "../lib/paths.js";
import { readJsonl } from "../lib/jsonl.js";
import { itemsById } from "../lib/items.js";
import { withDb } from "../lib/duckdb.js";
import { monthSpendUsd } from "../lib/apify.js";
import { loadSources, loadBudget } from "../registry/store.js";
import { loadHooks } from "./distill.js";
import { listCards } from "./cards.js";
import { ideationInputs } from "./ideate.js";
import type { RunRecord } from "../lib/runlog.js";

export type Check = { area: "Pulled" | "Remembered" | "Referenced"; name: string; status: "ok" | "warn" | "fail"; detail: string };

const H = 3600_000;
const ago = (iso?: string | null) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);
const fmtAgo = (ms: number) => (ms === Infinity ? "never" : ms < 2 * H ? `${Math.round(ms / 60000)}m ago` : ms < 48 * H ? `${Math.round(ms / H)}h ago` : `${Math.round(ms / (24 * H))}d ago`);

/** Run every check. Nothing here calls a model; Apify is only asked for month-to-date spend. */
export async function health(): Promise<Check[]> {
  const out: Check[] = [];
  const add = (area: Check["area"], name: string, status: Check["status"], detail: string) => out.push({ area, name, status, detail });

  // ---------- PULLED ----------
  const runs = readJsonl<RunRecord>(statePath("data", "runs.jsonl"));
  const expect: [string, number][] = [["ingest-distill", 26 * H], ["ingest-social", 4 * 24 * H], ["ideate", 4 * 24 * H], ["retro", 8 * 24 * H]];
  for (const [task, max] of expect) {
    const last = runs.filter((r) => r.task === task).at(-1);
    if (!last) add("Pulled", `${task} ran`, "warn", "no run recorded yet (logging started 2026-10-20)");
    else {
      const late = ago(last.at) > max;
      add("Pulled", `${task} ran`, !last.ok ? "fail" : late ? "fail" : "ok", `last ${fmtAgo(ago(last.at))}${last.ok ? "" : `, errors: ${last.errors.slice(0, 2).join("; ")}`}`);
    }
  }
  const fresh = await withDb((q) => q(`SELECT type, count(*) n, epoch_ms(max(fetched_at::TIMESTAMP)) AS last_ms FROM items WHERE source_id <> 'brain' AND fetched_at >= now() - INTERVAL 7 DAY GROUP BY type`));
  const byType = new Map(fresh.map((r) => [String(r.type), r]));
  for (const t of ["substack", "linkedin", "x"]) {
    const r = byType.get(t);
    add("Pulled", `${t} posts this week`, r && Number(r.n) > 0 ? "ok" : "fail", r ? `${r.n} new, last fetched ${fmtAgo(Date.now() - Number(r.last_ms))}` : "nothing fetched in 7 days");
  }
  const reg = loadSources();
  const active = reg.sources.filter((s) => s.status === "active");
  const staleDaily = active.filter((s) => (s.method === "substack_api" || s.method === "sitemap") && ago(s.last_pulled_at) > 30 * H);
  add("Pulled", "every active newsletter checked daily", staleDaily.length ? "fail" : "ok", staleDaily.length ? `not checked in 30h: ${staleDaily.map((s) => s.id).join(", ")}` : `${active.filter((s) => s.method === "substack_api" || s.method === "sitemap").length} newsletters, all checked`);
  const staleSocial = active.filter((s) => (s.type === "linkedin" || s.type === "x") && ago(s.last_pulled_at) > 4 * 24 * H);
  add("Pulled", "every followed creator pulled", staleSocial.length ? "warn" : "ok", staleSocial.length ? `not pulled in 4 days: ${staleSocial.map((s) => s.id).join(", ")}` : "all followed creators pulled on schedule");
  const newest = await withDb((q) => q(`SELECT source_id, epoch_ms(max(published_at::TIMESTAMP)) AS newest_ms FROM items GROUP BY source_id`));
  const newestBy = new Map(newest.map((r) => [String(r.source_id), Number(r.newest_ms)]));
  const dormant = active.filter((s) => s.type === "substack" || s.type === "rss").filter((s) => !newestBy.has(s.id) || Date.now() - newestBy.get(s.id)! > 60 * 24 * H);
  add("Pulled", "newsletters still publishing", dormant.length ? "warn" : "ok", dormant.length ? `${dormant.length} quiet for 60+ days: ${dormant.map((s) => s.name ?? s.id).join(", ")}` : "all active newsletters published recently");
  try {
    const spend = await monthSpendUsd();
    const cap = loadBudget().monthly_usd.apify;
    add("Pulled", "Apify spend", spend.used >= cap ? "fail" : spend.used >= cap * 0.75 ? "warn" : "ok", `$${spend.used.toFixed(2)} of $${cap} budget ($${spend.limit} plan cap)`);
  } catch (e) {
    add("Pulled", "Apify spend", "warn", `couldn't read: ${(e as Error).message}`);
  }

  // ---------- REMEMBERED ----------
  const hooks = loadHooks();
  const hooked = new Set(hooks.map((h) => h.item_id));
  const eligible = await withDb((q) => q(`SELECT id, source_id, found_via FROM items WHERE (type IN ('substack','linkedin','x') OR (type = 'rss' AND source_id NOT LIKE 'web:%')) AND NOT paywalled`));
  const followed = new Set(reg.sources.filter((s) => ["active", "trial", "candidate"].includes(s.status)).map((s) => s.id));
  const missing = eligible.filter((r) => (followed.has(String(r.source_id)) || r.found_via) && !hooked.has(String(r.id)));
  add("Remembered", "every post in the swipe file", missing.length > 20 ? "fail" : missing.length ? "warn" : "ok", missing.length ? `${missing.length} posts not distilled yet` : `${hooked.size} posts distilled, none missing`);
  const fb = readJsonl<{ card: string; verdict: string }>(statePath("data", "feedback.jsonl"));
  const fbCards = new Set(fb.map((f) => f.card));
  const decided = (["approved", "rejected", "drafted"] as const).flatMap((q) => listCards(q)).filter((c) => !/^superseded/.test(c.meta.why ?? ""));
  const unrecorded = decided.filter((c) => !fbCards.has(c.meta.id));
  add("Remembered", "every verdict recorded", unrecorded.length ? "fail" : "ok", unrecorded.length ? `${unrecorded.length} decided cards with no feedback row: ${unrecorded.slice(0, 3).map((c) => c.meta.id).join(", ")}` : `${fb.length} verdicts recorded`);
  const undrafted = listCards("approved");
  add("Remembered", "every approval has a draft", undrafted.length ? "fail" : "ok", undrafted.length ? `${undrafted.length} approved cards without a draft` : `${listCards("drafted").length} drafts`);
  const scored = reg.sources.filter((s) => s.pheromone.hits + s.pheromone.misses > 0).length;
  add("Remembered", "source scores updating", scored ? "ok" : "fail", `${scored} of ${reg.sources.length} sources have been scored`);
  const mem = ["winning-patterns", "rejected", "facts"].map((m) => [m, statePath("memory", `${m}.md`)] as const);
  const memInfo = mem.map(([m, f]) => `${m} ${fs.existsSync(f) ? fmtAgo(Date.now() - fs.statSync(f).mtimeMs) : "missing"}`);
  add("Remembered", "memory files present", mem.every(([, f]) => fs.existsSync(f)) ? "ok" : "fail", memInfo.join(", "));

  // ---------- REFERENCED ----------
  const recent = (["inbox", "approved", "rejected", "drafted"] as const).flatMap((q) => listCards(q)).filter((c) => ago(c.meta.created_at) < 7 * 24 * H);
  const hookById = new Map(hooks.map((h) => [h.item_id, h]));
  const allRefs = recent.flatMap((c) => [c.meta.riff_on, ...c.meta.evidence, ...(c.meta.brain_refs ?? [])]).filter((x): x is string => !!x);
  const items = itemsById(allRefs);
  const badRiff = recent.filter((c) => c.meta.riff_on && !(hookById.has(c.meta.riff_on) && items.get(c.meta.riff_on)?.url));
  const badEvidence = recent.flatMap((c) => c.meta.evidence.filter((id) => !items.has(id)).map((id) => `${c.meta.id}→${id}`));
  const badNotes = recent.flatMap((c) => (c.meta.brain_refs ?? []).filter((id) => !items.has(id)).map((id) => `${c.meta.id}→${id}`));
  const riffed = recent.filter((c) => c.meta.riff_on).length;
  add("Referenced", "cards cite real posts", badRiff.length || badEvidence.length ? "fail" : "ok", badRiff.length || badEvidence.length ? `${badRiff.length} bad riff links, ${badEvidence.length} missing evidence (${[...badRiff.map((c) => c.meta.id), ...badEvidence].slice(0, 3).join(", ")})` : `${riffed}/${recent.length} recent cards riff on a real post; all ${allRefs.length} references resolve`);
  add("Referenced", "work-note references resolve", badNotes.length ? "warn" : "ok", badNotes.length ? `${badNotes.length} missing: ${badNotes.slice(0, 3).join(", ")}` : "all resolve");
  const traced = recent.filter((c) => c.meta.langsmith_run_id).length;
  add("Referenced", "cards traced in LangSmith", traced === recent.length ? "ok" : "warn", `${traced}/${recent.length} recent cards have a run id`);
  try {
    const i = await ideationInputs();
    const thin = [i.swipe < 15 && `swipe file only ${i.swipe} posts`, i.swipeWithExcerpt < 10 && `only ${i.swipeWithExcerpt} excerpts`, i.facts < 1 && "no facts", i.avoid < 1 && "no avoid list", i.avoidTopics < 1 && "no blocked topics"].filter(Boolean);
    add("Referenced", "idea generator receives memory", thin.length ? "warn" : "ok", `${i.swipe} swipe posts (${i.swipeWithExcerpt} with excerpts), ${i.notes} work notes from ${i.notesProjects} projects, ${i.myPosts} of your posts, ${i.facts} facts, ${i.winning} what-works, ${i.avoid} avoid, ${i.avoidTopics} blocked topics, ${i.rules} learned rules, ${i.recentTopics} recent topics${thin.length ? ` — ${thin.join("; ")}` : ""}`);
  } catch (e) {
    add("Referenced", "idea generator receives memory", "fail", `couldn't assemble inputs: ${(e as Error).message}`);
  }
  return out;
}

export function formatHealth(checks: Check[], markdown = false): string {
  const icon = { ok: "✅", warn: "⚠️", fail: "❌" } as const;
  const bad = checks.filter((c) => c.status !== "ok");
  const head = bad.length ? `*Health: ${bad.filter((c) => c.status === "fail").length} failing, ${bad.filter((c) => c.status === "warn").length} warnings*` : "*Health: all checks pass*";
  const areas = ["Pulled", "Remembered", "Referenced"] as const;
  const body = areas.map((a) => `*${a}*\n${checks.filter((c) => c.area === a).map((c) => `${icon[c.status]} ${c.name} — ${c.detail}`).join("\n")}`).join("\n\n");
  return markdown ? `${head}\n\n${body}` : `${head}\n\n${body}`.replace(/\*/g, "");
}
