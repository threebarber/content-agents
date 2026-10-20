import { schedules, logger } from "@trigger.dev/sdk";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { loadSources, saveSources, loadForaging, loadBudget } from "../registry/store.js";
import { allocate } from "../registry/thompson.js";
import { decay } from "../registry/pheromone.js";
import { pullSubstack } from "../ingest/substack.js";
import { writeItems } from "../lib/jsonl.js";
import { loadBrainConfig, pullBrain } from "../ingest/brain.js";
import { appendJsonl, existingItemIds } from "../lib/jsonl.js";
import { statePath } from "../lib/paths.js";
import { distill } from "../agents/distill.js";

/**
 * Daily: Thompson-sample Substack sources, pull new items, read the brain, commit to the state repo.
 * Distill (Haiku) is Phase 1 and will slot in after ingestion.
 */
export const ingestDistill = schedules.task({
  id: "ingest-distill",
  cron: { pattern: "0 5 * * *", timezone: "America/New_York" },
  machine: "small-1x",
  maxDuration: 1500,
  run: async (payload) => {
    if (!stateToken() && !process.env.STATE_DIR) {
      logger.warn("STATE_GITHUB_TOKEN not set — cannot clone STATE_REPO; skipping run. Add it in Trigger.dev → Environment variables.");
      return { skipped: "missing STATE_GITHUB_TOKEN" };
    }
    const dir = checkoutState();
    logger.info("state checkout", { dir, scheduled: payload.timestamp });

    const f = loadSources();
    const fo = loadForaging();
    const b = loadBudget();
    // weekly evaporation (idempotent)
    const decayed = f.sources.filter((s) => decay(s, fo)).length;

    const pool = f.sources.filter((s) => s.type === "substack" && s.method === "substack_api" && !["retired", "paused"].includes(s.status));
    const plan = allocate(pool, b.items_per_run.substack, fo);
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    let written = 0;
    const errors: string[] = [];
    for (const a of plan) {
      try {
        const items = await pullSubstack(a.source, { sinceISO: since, max: a.items, sort: a.lane === "exploit" ? "new" : "top" });
        const n = writeItems(items);
        a.source.last_pulled_at = new Date().toISOString();
        written += n;
        await new Promise((r) => setTimeout(r, 400)); // be polite to Substack
        logger.info("pulled", { source: a.source.id, lane: a.lane, pulled: items.length, new: n });
      } catch (e) {
        errors.push(`${a.source.id}: ${(e as Error).message}`);
      }
    }
    saveSources(f);

    // brain (lookback window from brain.yaml)
    let brainNew = 0;
    if (process.env.BRAIN_REPO) {
      try {
        const cfg = loadBrainConfig();
        const { items, dropped } = pullBrain({ ...cfg, repo: process.env.BRAIN_REPO });
        const have = existingItemIds("brain");
        const fresh = items.filter((i) => !have.has(i.id));
        const byMonth = new Map<string, typeof fresh>();
        for (const it of fresh) {
          const file = statePath("data", "items", "brain", `${it.published_at.slice(0, 7)}.jsonl`);
          (byMonth.get(file) ?? byMonth.set(file, []).get(file)!).push(it);
        }
        for (const [file, rows] of byMonth) appendJsonl(file, rows);
        brainNew = fresh.length;
        logger.info("brain", { files: items.length, new: brainNew, dropped });
      } catch (e) {
        errors.push(`brain: ${(e as Error).message}`);
      }
    }

    // distill new items into the swipe file (Haiku); pheromone updates happen inside
    let distilled = { distilled: 0, hits: 0, failed: 0, usd: 0 };
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        distilled = await distill({ limit: 300, concurrency: 6, log: (m) => logger.info(m) });
      } catch (e) {
        errors.push(`distill: ${(e as Error).message}`);
      }
    }

    const committed = commitState(dir, `ingest: ${written} substack, ${brainNew} brain, ${distilled.distilled} distilled ($${distilled.usd.toFixed(3)}), ${decayed} decayed (${new Date(payload.timestamp).toISOString().slice(0, 10)})`);
    return { written, brainNew, decayed, distilled, sources: plan.length, errors, committed };
  },
});
