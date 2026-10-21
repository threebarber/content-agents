import { schedules, logger, wait } from "@trigger.dev/sdk";
import { logRun } from "../lib/runlog.js";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { ideate } from "../agents/ideate.js";
import { tokenTally } from "../agents/llm.js";
import { loadBudget } from "../registry/store.js";

/**
 * Sun + Wed: submitted at 04:30 ET through the Batch API (half price); cards usually land well before 06:00.
 * If the batch isn't back by 07:30 ET it's cancelled and a normal request runs instead.
 */
export const ideateTask = schedules.task({
  id: "ideate",
  cron: { pattern: "30 4 * * 0,3", timezone: "America/New_York" },
  maxDuration: 1800, // compute only; batch waits are checkpointed and don't count
  run: async () => {
    if (!stateToken()) return { skipped: "missing STATE_GITHUB_TOKEN" };
    const dir = checkoutState();
    const useBatch = loadBudget().use_batch_api;
    const r = await ideate(useBatch ? { batch: { sleep: (ms) => wait.for({ seconds: Math.round(ms / 1000) }), deadlineMs: Date.now() + 3 * 3600_000 } } : {});
    logger.info("ideate", { cards: r.files.length, usd: r.usd, run: r.runId });
    await logRun("ideate", { cards: r.files.length, usd: r.usd, run: r.runId, batch: useBatch, tokens: { ...tokenTally } }, r.files.length ? [] : ["ideate produced no cards"]);
    const committed = commitState(dir, `ideate: ${r.files.length} cards ($${r.usd.toFixed(3)})`);
    return { cards: r.files.length, usd: r.usd, langsmithRun: r.runId, committed };
  },
});
