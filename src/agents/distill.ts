import fs from "node:fs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { claude, MODELS, prompt, costUsd } from "./llm.js";
import { HookExtraction, type HookRecord } from "../../schemas/hook.js";
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
    q(`SELECT * FROM items WHERE type IN ('substack','linkedin','x') AND NOT paywalled ORDER BY published_at DESC`),
  );
  return (items as unknown as Item[]).filter((i) => !done.has(i.id) && (active.has(i.source_id) || !!i.found_via)).slice(0, limit);
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
        stats.usd += costUsd(MODELS.distill, res.usage);
        if (!p) throw new Error(`no parsed output (stop_reason=${res.stop_reason})`);
        const zval = ez == null || Number.isNaN(ez) ? null : Math.round(ez * 100) / 100;
        const engScore = (it.metrics.likes ?? 0) + 2 * (it.metrics.comments ?? 0);
        const socialHit = !!it.found_via && engScore >= 60 && p.relevance >= 3;
        const isHit = (zval != null && zval >= fo.hit_rules.engagement_z_min && p.relevance >= 3) || socialHit || (p.hook_quality >= fo.hit_rules.hook_quality_min && p.relevance >= 3);
        p.format = p.format.toLowerCase().replace(/[^a-z]/g, "") || "other";
        out.push({ ...p, item_id: it.id, source_id: it.source_id, author: it.author, title: it.title, url: it.url, published_at: it.published_at, engagement_z: zval, hit: isHit, model: MODELS.distill, distilled_at: new Date().toISOString() });
        // pheromone: the source, plus any active term the post's topics touch
        const src = sources.sources.find((s) => s.id === it.source_id);
        if (src) (isHit ? hit(src, 1, it.published_at) : miss(src, 1));
        const via = it.found_via?.startsWith("term:") ? terms.terms.find((t) => t.id === it.found_via!.slice(5)) : undefined;
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
