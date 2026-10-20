import { schedules, logger } from "@trigger.dev/sdk";
import { logRun } from "../lib/runlog.js";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { ideate } from "../agents/ideate.js";

/** Sun + Wed 06:00 ET: write idea cards to queue/inbox and post them to Slack. */
export const ideateTask = schedules.task({
  id: "ideate",
  cron: { pattern: "0 6 * * 0,3", timezone: "America/New_York" },
  maxDuration: 900,
  run: async () => {
    if (!stateToken()) return { skipped: "missing STATE_GITHUB_TOKEN" };
    const dir = checkoutState();
    const r = await ideate({});
    logger.info("ideate", { cards: r.files.length, usd: r.usd, run: r.runId });
    await logRun("ideate", { cards: r.files.length, usd: r.usd, run: r.runId }, r.files.length ? [] : ["ideate produced no cards"]);
    const committed = commitState(dir, `ideate: ${r.files.length} cards ($${r.usd.toFixed(3)})`);
    return { cards: r.files.length, usd: r.usd, langsmithRun: r.runId, committed };
  },
});
