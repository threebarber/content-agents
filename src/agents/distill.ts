import fs from "node:fs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { claude, MODELS, prompt, tally } from "./llm.js";
import { z } from "zod";
import { HookExtraction, type HookRecord } from "../../schemas/hook.js";
import { normalizeFormat, normalizeHookMove } from "../../schemas/card.js";
import type { Item } from "../../schemas/item.js";
import { statePath } from "../lib/paths.js";
import { readJsonl, appendJsonl } from "../lib/jsonl.js";
import { withDb } from "../lib/duckdb.js";
import { loadSources, saveSources, loadTerms, saveTerms, loadForaging } from "../registry/store.js";
import { hit, miss } from "../registry/pheromone.js";
import { generateCandidates } from "../registry/candidates.js";

export const HOOKS_FILE = () => statePath("data", "hooks.jsonl");

export function loadHooks(): HookRecord[] {
  return readJsonl<HookRecord>(HOOKS_FILE());
}

/** Per-author engagement z-scores for every non-paywalled item (likes + 2×comments). */
async function zScores(): Promise<Map<string, number>> {
  return withDb(async (q) => {
    const rows = await q(`
      WITH base AS (SELECT id, source_id, coalesce(metrics.likes,0) + 2*coalesce(metrics.comments,0) AS eng FROM items WHERE type <> 'rss'),
      s AS (SELECT source_id, avg(eng) mu, stddev_samp(eng) sd, count(*) n FROM base GROUP BY source_id)
      SELECT b.id, CASE WHEN s.n >= 3 AND b.source_id NOT LIKE 'me:%'  AND s.sd > 0 THEN (b.eng - s.mu)/s.sd ELSE NULL END AS z FROM base b JOIN s USING (source_id)`);
    return new Map(rows.map((r) => [String(r.id), r.z == null ? NaN : Number(r.z)]));
  });
}

async function pendingItems(limit: number): Promise<Item[]> {
  const done = new Set(loadHooks().map((h) => h.item_id));
  const active = new Set(loadSources().sources.filter((s) => ["active", "trial", "candidate"].includes(s.status)).map((s) => s.id));
  const items = await withDb(async (q) =>
    q(`SELECT * FROM items WHERE type IN ('substack','linkedin','x','rss') AND NOT paywalled ORDER BY published_at DESC`),
  );
  // web pages are only distilled when the owner saved them (optional columns are checked here, not in SQL, since a
  // column only exists once some item has it)
  const eligible = (i: Item) => i.type !== "rss" || !i.source_id.startsWith("web:") || i.saved_by === "human";
  return (items as unknown as Item[]).filter((i) => eligible(i) && !done.has(i.id) && (active.has(i.source_id) || !!i.found_via || i.saved_by === "human")).slice(0, limit);
}

export type DistillStats = { distilled: number; hits: number; failed: number; usd: number; candidates: string[] };

export async function distill(opts: { limit?: number; concurrency?: number; log?: (m: string) => void; maxCandidates?: number } = {}): Promise<DistillStats> {
  const log = opts.log ?? (() => {});
  const items = await pendingItems(opts.limit ?? 500);
  if (!items.length) return { distilled: 0, hits: 0, failed: 0, usd: 0, candidates: [] };
  const z = await zScores();
  const fo = loadForaging();
  const sources = loadSources();
  const terms = loadTerms();
  const system = prompt("distill");
  const stats: DistillStats = { distilled: 0, hits: 0, failed: 0, usd: 0, candidates: [] };
  const out: HookRecord[] = [];
  const queue = [...items];

  const worker = async () => {
    while (queue.length) {
      const it = queue.shift()!;
      const ez = z.get(it.id);
      const eng = `likes=${it.metrics.likes ?? "?"} comments=${it.metrics.comments ?? "?"} restacks=${it.metrics.shares ?? "?"}; z vs author's norm=${ez == null || Number.isNaN(ez) ? "unknown" : ez.toFixed(2)}`;
      try {
        const res = await claude().messages.parse({
          model: MODELS.distill,
          max_tokens: 2000,
          system,
          messages: [{ role: "user", content: `AUTHOR: ${it.author}\nTITLE: ${it.title}\nENGAGEMENT: ${eng}\n\n${it.text.slice(0, 6000)}` }],
          output_config: { format: zodOutputFormat(HookExtraction) },
        });
        const p = res.parsed_output;
        stats.usd += tally(MODELS.distill, res.usage);
        if (!p && res.stop_reason === "refusal") {
          // a post the model won't summarize is off-topic for us: record it as skipped (never retried) and as a miss
          out.push({ item_id: it.id, source_id: it.source_id, author: it.author, title: it.title, url: it.url, published_at: it.published_at, engagement_z: null, hit: false, model: MODELS.distill, distilled_at: new Date().toISOString(), skipped: "model declined", hook: "", hook_template: "", format: "other", topics: [], core_claim: "", why_it_worked: "", hook_quality: 0, relevance: 0 });
          const via = it.found_via?.startsWith("term:") ? terms.terms.find((t) => t.id === it.found_via) : undefined;
          if (via) miss(via);
          const src = sources.sources.find((s) => s.id === it.source_id);
          if (src) miss(src);
          stats.distilled++;
          log(`skipped ${it.id}: model declined`);
          continue;
        }
        if (!p) throw new Error(`no parsed output (stop_reason=${res.stop_reason})`);
        const zval = ez == null || Number.isNaN(ez) ? null : Math.round(ez * 100) / 100;
        const engScore = (it.metrics.likes ?? 0) + 2 * (it.metrics.comments ?? 0);
        const socialHit = !!it.found_via && engScore >= 60 && p.relevance >= 3;
        const isHit = (zval != null && zval >= fo.hit_rules.engagement_z_min && p.relevance >= 3) || socialHit || (p.hook_quality >= fo.hit_rules.hook_quality_min && p.relevance >= 3);
        p.format = normalizeFormat(p.format);
        p.hook_move = normalizeHookMove(p.hook_move);
        p.topics = [...new Set(p.topics.map((t) => t.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 6);
        out.push({ ...p, item_id: it.id, source_id: it.source_id, author: it.author, title: it.title, url: it.url, published_at: it.published_at, engagement_z: zval, hit: isHit, model: MODELS.distill, distilled_at: new Date().toISOString() });
        // pheromone: the source, plus any active term the post's topics touch
        const src = sources.sources.find((s) => s.id === it.source_id);
        if (src) (isHit ? hit(src, 1, it.published_at) : miss(src, 1));
        const via = it.found_via?.startsWith("term:") ? terms.terms.find((t) => t.id === it.found_via) : undefined;
        if (via) (isHit ? hit(via) : miss(via));
        const topicText = p.topics.join(" | ").toLowerCase();
        for (const t of terms.terms) if (t !== via && t.status === "active" && t.term.split(" ").every((w) => topicText.includes(w.toLowerCase()))) (isHit ? hit(t) : miss(t));
        stats.distilled++;
        if (isHit) stats.hits++;
        if (stats.distilled % 25 === 0) log(`distilled ${stats.distilled}/${items.length} ($${stats.usd.toFixed(3)})`);
      } catch (e) {
        stats.failed++;
        log(`distill failed ${it.id}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, items.length) }, worker));
  appendJsonl(HOOKS_FILE(), out);
  // lay new trails: authors / linked publications behind this run's hits become candidates
  const byId = new Map(items.map((i) => [i.id, i]));
  stats.candidates = generateCandidates(sources, out.filter((h) => h.hit), byId, opts.maxCandidates ?? 10).map((c) => c.id);
  if (stats.candidates.length) log(`new candidate sources: ${stats.candidates.join(", ")}`);
  saveSources(sources);
  saveTerms(terms);
  return stats;
}

export function ensureFile(f: string) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, "");
}

const Regrade = z.object({ grades: z.array(z.object({ id: z.string(), relevance: z.number().int().min(1).max(5) })) });

/**
 * Re-score relevance for recent posts with the current rubric (cheap: one Haiku call per 40 posts, hook + claim only).
 * A post that drops below the bar stops being a hit, and the source and search term that found it get the hit taken back.
 */
export async function regradeRelevance(opts: { days?: number; log?: (m: string) => void } = {}): Promise<{ checked: number; lowered: number; unhit: number; usd: number }> {
  const log = opts.log ?? (() => {});
  const since = Date.now() - (opts.days ?? 30) * 86400000;
  const all = loadHooks();
  const pool = all.filter((h) => !h.skipped && h.relevance >= 3 && new Date(h.published_at).getTime() >= since);
  const lines = prompt("distill").split("\n");
  const start = lines.findIndex((l) => l.startsWith("- `relevance`"));
  const end = lines.findIndex((l) => l.startsWith("- Be terse"));
  const rubric = lines.slice(start, end).join("\n");
  const sources = loadSources();
  const terms = loadTerms();
  const rows = await withDb((q) => q(`SELECT id, found_via FROM items`)).catch(() => []);
  const via = new Map(rows.map((r) => [String(r.id), r.found_via == null ? null : String(r.found_via)]));
  let usd = 0, lowered = 0, unhit = 0;
  for (let i = 0; i < pool.length; i += 40) {
    const chunk = pool.slice(i, i + 40);
    const res = await claude().messages.parse({
      model: MODELS.distill,
      max_tokens: 3000,
      system: `Grade each post's relevance from 1 to 5.\n${rubric}`,
      output_config: { format: zodOutputFormat(Regrade) },
      messages: [{ role: "user", content: chunk.map((h) => `[${h.item_id}] ${h.author}: ${h.hook.replace(/\s+/g, " ").slice(0, 200)}\n  claim: ${h.core_claim}\n  topics: ${h.topics.join(", ")}`).join("\n\n") }],
    });
    usd += tally(MODELS.distill, res.usage);
    const grade = new Map((res.parsed_output?.grades ?? []).map((g) => [g.id, g.relevance]));
    for (const h of chunk) {
      const r = grade.get(h.item_id);
      if (r == null || r >= h.relevance) continue;
      lowered++;
      const wasHit = h.hit;
      h.relevance = r;
      if (wasHit && r < 3) {
        h.hit = false;
        unhit++;
        for (const x of [sources.sources.find((s) => s.id === h.source_id), terms.terms.find((t) => t.id === via.get(h.item_id))]) {
          if (!x) continue;
          x.pheromone.hits = Math.max(0, x.pheromone.hits - 1);
          miss(x);
        }
      }
    }
    log(`regraded ${Math.min(i + 40, pool.length)}/${pool.length} ($${usd.toFixed(4)})`);
  }
  fs.writeFileSync(HOOKS_FILE(), all.map((h) => JSON.stringify(h)).join("\n") + "\n");
  saveSources(sources);
  saveTerms(terms);
  return { checked: pool.length, lowered, unhit, usd };
}
