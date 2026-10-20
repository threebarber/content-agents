#!/usr/bin/env node
import { Command } from "commander";
import { loadSources, saveSources, loadTerms, saveTerms, loadForaging, loadBudget, today, slugify, upsertSource, findSource, findTerm, normalizeUrl } from "./registry/store.js";
import { detect } from "./registry/detect.js";
import { resolveSource } from "./registry/resolve.js";
import { verifySubstack } from "./registry/verify.js";
import { allocate } from "./registry/thompson.js";
import { decay } from "./registry/pheromone.js";
import { pullSubstack } from "./ingest/substack.js";
import { writeItems, existingItemIds, appendJsonl } from "./lib/jsonl.js";
import { loadBrainConfig, pullBrain } from "./ingest/brain.js";
import { statePath } from "./lib/paths.js";
import { withDb, TOP_BY_Z } from "./lib/duckdb.js";
import { postMessage, sections } from "./lib/slack.js";
import { distill, loadHooks } from "./agents/distill.js";
import { ideate } from "./agents/ideate.js";
import { sweepFeedback } from "./agents/feedback.js";
import { postCards } from "./agents/slack-cards.js";
import { listCards } from "./agents/cards.js";
import { ingestSocial } from "./agents/social.js";
import { deriveTerms } from "./agents/terms.js";
import { retro } from "./agents/retro.js";
import { pinTerm, unpinTerm } from "./agents/slash.js";
import { Source } from "../schemas/source.js";
import { Term } from "../schemas/term.js";

const program = new Command().name("ca").description("content-agents CLI");

// ---------- sources ----------
const sources = program.command("sources").description("source registry");

sources
  .command("ls")
  .option("--status <s>")
  .option("--type <t>")
  .option("--json")
  .action((o) => {
    const f = loadSources();
    let xs = f.sources;
    if (o.status) xs = xs.filter((s) => s.status === o.status);
    if (o.type) xs = xs.filter((s) => s.type === o.type);
    if (o.json) return console.log(JSON.stringify(xs, null, 2));
    for (const s of xs) console.log(`${s.status.padEnd(9)} ${s.type.padEnd(8)} ${(s.method ?? "-").padEnd(12)} ${String(s.pheromone.hits).padStart(5)}/${String(s.pheromone.misses).padEnd(5)} ${s.id}  ${s.url ?? ""}`);
    console.error(`${xs.length} sources`);
  });

sources
  .command("add <urlOrHandle>")
  .option("--tags <tags>", "comma-separated")
  .option("--active", "add as active instead of candidate")
  .option("--via <discovered_via>", "provenance", "human")
  .option("--by <added_by>", "human | agent:<task>", "human")
  .option("--name <name>")
  .option("--author <author>")
  .action(async (input, o) => {
    const d = detect(input);
    if (!d) return fail(`could not classify ${input}`);
    if (d.kind === "post") return fail(`${input} looks like a single post; use \`ca intake\` (Phase 1) for posts`);
    const f = loadSources();
    const s = Source.parse({
      id: `${d.type}:${slugify(d.key)}`,
      type: d.type,
      name: o.name,
      author: o.author,
      url: d.url,
      status: o.active ? "active" : "candidate",
      tags: o.tags ? o.tags.split(",").map((t: string) => t.trim()) : [],
      added_by: o.by,
      added_at: today(),
      discovered_via: o.via,
      budget_tier: d.type === "substack" || d.type === "rss" ? "cheap" : "normal",
    });
    const { source, created } = upsertSource(f, s);
    const r = await resolveSource(source);
    if (r) Object.assign(source, { url: r.url, method: r.method, type: r.method === "substack_api" ? "substack" : source.type });
    saveSources(f);
    console.log(`${created ? "added" : "updated"} ${source.id} status=${source.status} method=${source.method ?? "unresolved"}`);
  });

sources
  .command("set <id> <kv...>")
  .description("set fields, e.g. status=paused url=https://...")
  .action((id, kvs: string[]) => {
    const f = loadSources();
    const s = findSource(f, id);
    if (!s) return fail(`no source ${id}`);
    for (const kv of kvs) {
      const [k, v] = kv.split("=", 2);
      (s as Record<string, unknown>)[k] = v === "null" ? null : v;
    }
    Source.parse(s);
    saveSources(f);
    console.log(`updated ${s.id}`);
  });

sources
  .command("resolve")
  .description("probe unresolved sources and fill url/method")
  .option("--all", "re-probe resolved ones too")
  .option("--concurrency <n>", "", "6")
  .action(async (o) => {
    const f = loadSources();
    const todo = f.sources.filter((s) => o.all || !s.method);
    let ok = 0;
    await pmap(todo, Number(o.concurrency), async (s) => {
      const r = await resolveSource(s);
      if (r) {
        s.url = r.url;
        s.method = r.method;
        if (r.method === "substack_api") s.type = "substack";
        ok++;
        console.log(`✓ ${s.id.padEnd(45)} ${r.method.padEnd(12)} ${r.url}`);
      } else console.log(`✗ ${s.id.padEnd(45)} unresolved  (${s.name ?? ""} / ${s.author ?? ""})`);
    });
    saveSources(f);
    console.error(`resolved ${ok}/${todo.length}`);
  });

sources
  .command("verify")
  .description("check resolved substacks really belong to the expected name/author; unresolve mismatches")
  .option("--concurrency <n>", "", "6")
  .option("--fix", "clear url/method on mismatches so resolve/web-search can retry")
  .action(async (o) => {
    const f = loadSources();
    const todo = f.sources.filter((s) => s.type === "substack" && s.method === "substack_api");
    let bad = 0;
    await pmap(todo, Number(o.concurrency), async (s) => {
      const v = await verifySubstack(s);
      console.log(`${v.ok ? "✓" : "✗"} ${s.id.padEnd(45)} ${(v.reason).padEnd(12)} title="${v.title ?? ""}" byline="${v.byline ?? ""}"  ${s.url}`);
      if (!v.ok) {
        bad++;
        if (o.fix) {
          s.notes = `slug guess ${s.url} mismatched (title="${v.title ?? ""}", byline="${v.byline ?? ""}")`;
          s.url = null;
          s.method = null;
        }
      }
    });
    saveSources(f);
    console.error(`${bad} mismatches of ${todo.length}`);
  });

sources
  .command("decay")
  .description("apply weekly pheromone evaporation (idempotent per ISO week)")
  .action(() => {
    const f = loadSources();
    const fo = loadForaging();
    const n = f.sources.filter((s) => decay(s, fo)).length;
    saveSources(f);
    const t = loadTerms();
    const m = t.terms.filter((x) => decay(x, fo)).length;
    saveTerms(t);
    console.log(`decayed ${n} sources, ${m} terms`);
  });

sources
  .command("plan")
  .description("show how the next run would allocate its item budget (Thompson sampling)")
  .option("--type <t>", "", "substack")
  .action((o) => {
    const f = loadSources();
    const fo = loadForaging();
    const b = loadBudget();
    const budget = (b.items_per_run as Record<string, number>)[o.type] ?? 100;
    const alloc = allocate(f.sources.filter((s) => s.type === o.type && s.method), budget, fo);
    for (const a of alloc.sort((x, y) => y.items - x.items)) console.log(`${a.lane.padEnd(8)} ${String(a.items).padStart(4)}  ${a.source.id}`);
    console.error(`${alloc.length} sources, ${alloc.reduce((n, a) => n + a.items, 0)} items (budget ${budget})`);
  });

// ---------- terms ----------
const terms = program.command("terms").description("term registry");
terms.command("ls").action(() => {
  for (const t of loadTerms().terms) console.log(`${t.pinned ? "📌" : "  "} ${t.status.padEnd(9)} ${t.kind.padEnd(12)} ${String(t.pheromone.hits).padStart(4)}/${String(t.pheromone.misses).padEnd(4)} ${t.id}  "${t.term}"  [${t.used_for.join(",")}]`);
});
terms
  .command("add <term>")
  .option("--kind <k>", "topic | hashtag | x_query | person_query", "topic")
  .option("--active")
  .option("--for <uses>", "comma-separated used_for", "tagging")
  .option("--via <discovered_via>", "", "human")
  .option("--by <added_by>", "", "human")
  .action((term, o) => {
    const f = loadTerms();
    if (findTerm(f, term)) return fail(`term exists: ${term}`);
    f.terms.push(Term.parse({ id: `term:${slugify(term)}`, term, kind: o.kind, status: o.active ? "active" : "candidate", used_for: o.for.split(","), added_by: o.by, added_at: today(), discovered_via: o.via }));
    saveTerms(f);
    console.log(`added term:${slugify(term)}`);
  });

terms
  .command("pin <term>")
  .description("always search this term on LinkedIn + X; the weekly re-derive never drops it")
  .option("--no-x", "LinkedIn only")
  .action((term, o) => console.log(pinTerm(term, o.x)));

terms
  .command("unpin <term>")
  .description("let the weekly re-derive decide whether to keep searching this term")
  .action((term) => console.log(unpinTerm(term)));

terms
  .command("derive")
  .description("derive LinkedIn/X search terms from what the active newsletters write about")
  .option("-n <n>", "total searched terms incl. pinned (default: budget.social.search_terms)")
  .option("--dry", "show proposals without changing terms.yaml")
  .action(async (o) => {
    const r = await deriveTerms({ n: o.n ? Number(o.n) : undefined, dry: o.dry });
    for (const p of r.proposed) console.log(`  ${p.term.padEnd(32)} ${p.why}`);
    if (!o.dry) console.log(`\nadded: ${r.added.join(", ") || "-"}\nkept: ${r.kept.join(", ") || "-"}\nno longer searched: ${r.retired.join(", ") || "-"}`);
    console.log(`$${r.usd.toFixed(4)}`);
  });

// ---------- ingest ----------
const ingest = program.command("ingest").description("pull items from sources into state/data/items");
ingest
  .command("substack")
  .option("--days <n>", "lookback window", String(loadBudget().backfill_days))
  .option("--all", "pull every resolved substack (ignore Thompson budget)")
  .option("--source <id>", "single source")
  .option("--max <n>", "max posts per source", "400")
  .option("--concurrency <n>", "", "5")
  .action(async (o) => {
    const f = loadSources();
    const fo = loadForaging();
    const b = loadBudget();
    const since = new Date(Date.now() - Number(o.days) * 86400000).toISOString();
    let plan: { source: Source; items: number; lane: string }[];
    const pool = f.sources.filter((s) => s.type === "substack" && s.method === "substack_api" && s.status !== "retired" && s.status !== "paused");
    if (o.source) {
      const s = findSource(f, o.source);
      if (!s) return fail(`no source ${o.source}`);
      plan = [{ source: s, items: Number(o.max), lane: "manual" }];
    } else if (o.all) plan = pool.map((s) => ({ source: s, items: Number(o.max), lane: "all" }));
    else plan = allocate(pool, b.items_per_run.substack, fo);

    let total = 0;
    const errors: string[] = [];
    await pmap(plan, Number(o.concurrency), async ({ source, items, lane }) => {
      try {
        const pulled = await pullSubstack(source, { sinceISO: since, max: items, sort: lane === "explore" || lane === "random" ? "top" : "new" });
        const n = writeItems(pulled);
        source.last_pulled_at = new Date().toISOString();
        total += n;
        console.log(`${lane.padEnd(7)} ${String(n).padStart(4)} new / ${String(pulled.length).padStart(4)} pulled  ${source.id}`);
      } catch (e) {
        errors.push(`${source.id}: ${(e as Error).message}`);
      }
    });
    saveSources(f);
    console.error(`\n${total} new items written; ${errors.length} errors`);
    for (const e of errors) console.error("  " + e);
  });

ingest
  .command("brain")
  .option("--all", "ignore lookback window; read every allowed file")
  .option("--dir <path>", "use an existing checkout instead of cloning")
  .option("--dry", "print what would be written, write nothing")
  .action((o) => {
    const cfg = loadBrainConfig();
    const { items, dropped, files } = pullBrain(cfg, { all: o.all, dir: o.dir });
    if (o.dry) {
      for (const it of items) console.log(`${it.tags[0]?.padEnd(12)} ${it.published_at.slice(0, 10)} ${String(it.text.length).padStart(6)}ch  ${it.id}`);
      return console.error(`${items.length} items from ${files} files (${dropped} dropped by redaction) — dry run`);
    }
    // brain items live in their own folder regardless of schema type
    const byMonth = new Map<string, typeof items>();
    for (const it of items) {
      const f = statePath("data", "items", "brain", `${it.published_at.slice(0, 7)}.jsonl`);
      if (!byMonth.has(f)) byMonth.set(f, []);
      byMonth.get(f)!.push(it);
    }
    let n = 0;
    for (const [f, rows] of byMonth) {
      const have = new Set(existingItemIds("brain"));
      const fresh = rows.filter((r) => !have.has(r.id));
      appendJsonl(f, fresh);
      n += fresh.length;
    }
    console.error(`${n} new brain items from ${files} files (${dropped} dropped by redaction)`);
  });

ingest
  .command("social")
  .description("LinkedIn + X: term search, creator pulls (Thompson-sampled), and your own post stats")
  .action(async () => {
    const r = await ingestSocial(console.error);
    console.log(JSON.stringify(r));
  });

// ---------- query ----------
program
  .command("stats")
  .description("item counts per type")
  .action(() => {
    for (const t of ["substack", "linkedin", "x", "rss", "brain"]) {
      const n = existingItemIds(t).size;
      if (n) console.log(`${t.padEnd(9)} ${n}`);
    }
  });

program
  .command("top")
  .description("top items by per-author engagement z-score (DuckDB over data/items)")
  .option("-n <n>", "", "20")
  .option("--type <t>", "", "substack")
  .option("--all-sources", "include paused/retired sources")
  .action(async (o) => {
    const ids = o.allSources ? undefined : loadSources().sources.filter((s) => s.status === "active" || s.status === "trial").map((s) => s.id);
    await withDb(async (q) => {
      const rows = await q(TOP_BY_Z(Number(o.n), o.type, ids));
      for (const r of rows) console.log(`${String(r.z).padStart(5)}  ${String(r.eng).padStart(5)}  ${String(r.published).padEnd(10)}  ${String(r.author).slice(0, 22).padEnd(22)}  ${String(r.title).slice(0, 70)}`);
    });
  });

program
  .command("sql <query>")
  .description("run arbitrary SQL against the `items` view")
  .action(async (sql) => {
    await withDb(async (q) => console.log(JSON.stringify(await q(sql), null, 2)));
  });

program
  .command("slack <text>")
  .description("post a message to SLACK_CHANNEL (smoke test for the bot token)")
  .option("--channel <c>", "", process.env.SLACK_CHANNEL ?? "#content-agents")
  .action(async (text, o) => {
    const r = await postMessage(o.channel, text, sections(text));
    console.log(`posted to ${r.channel} at ${r.ts}`);
  });

program
  .command("distill")
  .description("swipe-file extraction (Haiku) for items without a hook record")
  .option("--limit <n>", "", "500")
  .option("--concurrency <n>", "", "6")
  .action(async (o) => {
    const r = await distill({ limit: Number(o.limit), concurrency: Number(o.concurrency), log: console.error });
    console.log(`distilled ${r.distilled} (${r.hits} hits, ${r.failed} failed) for $${r.usd.toFixed(4)}`);
  });

program
  .command("hooks")
  .description("show swipe-file records, best first")
  .option("-n <n>", "", "15")
  .action((o) => {
    const hs = loadHooks().sort((a, b) => (b.engagement_z ?? 0) + b.hook_quality - ((a.engagement_z ?? 0) + a.hook_quality)).slice(0, Number(o.n));
    for (const h of hs) console.log(`\n${h.hit ? "★" : " "} q${h.hook_quality} r${h.relevance} z${h.engagement_z ?? "?"}  ${h.author} — ${h.title}\n   hook: ${h.hook.slice(0, 160)}\n   tmpl: ${h.hook_template.slice(0, 160)}\n   why:  ${h.why_it_worked.slice(0, 160)}`);
  });

program
  .command("ideate")
  .description("write idea cards to queue/inbox and post them to Slack")
  .option("-n <n>", "", "7")
  .option("--dry", "print cards, write nothing")
  .option("--no-post", "don't post to Slack")
  .action(async (o) => {
    const r = await ideate({ n: Number(o.n), dry: o.dry, post: o.post });
    console.log(`${r.files.length} cards, $${r.usd.toFixed(4)}, langsmith run ${r.runId ?? "-"}`);
    for (const f of r.files) console.log("  " + f);
  });

program
  .command("feedback")
  .description("process verdicts on inbox cards")
  .action(async () => {
    const r = await sweepFeedback(console.error);
    console.log(JSON.stringify(r));
  });

program
  .command("repost")
  .description("re-post every pending inbox card to Slack with buttons")
  .action(async () => {
    const files = listCards("inbox").filter((c) => c.meta.verdict === "pending").map((c) => c.file);
    await postCards(files, `*${files.length} idea cards waiting on you.* Approve, rewrite, or reject each one below.`);
    console.log(`reposted ${files.length}`);
  });

program
  .command("retro")
  .description("run the weekly retro now (memory updates + proposals)")
  .option("--days <n>", "", "7")
  .option("--no-post", "don't post to Slack")
  .action(async (o) => console.log(JSON.stringify(await retro({ days: Number(o.days), post: o.post }))));

program.parseAsync().catch((e) => fail(e.message));

function fail(msg: string): never {
  console.error("error:", msg);
  process.exit(1);
  throw new Error(msg);
}
async function pmap<T>(xs: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const q = [...xs];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) await fn(q.shift()!);
  }));
}
