import { schedules, logger } from "@trigger.dev/sdk";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { sweepFeedback } from "../agents/feedback.js";

/**
 * Hourly: apply verdicts committed to queue/inbox cards (approve / reject / rewrite).
 * Rewrites regenerate immediately within the sweep. When Trigger.dev webhooks leave beta,
 * a GitHub push webhook will call this same function for instant turnaround.
 */
export const feedbackSweep = schedules.task({
  id: "feedback-sweep",
  cron: { pattern: "7 * * * *", timezone: "America/New_York" },
  maxDuration: 600,
  run: async () => {
    if (!stateToken()) return { skipped: "missing STATE_GITHUB_TOKEN" };
    const dir = checkoutState();
    const r = await sweepFeedback((m) => logger.info(m));
    const total = r.approved + r.rejected + r.rewritten;
    const committed = total ? commitState(dir, `feedback: ${r.approved} approved, ${r.rejected} rejected, ${r.rewritten} rewritten`) : false;
    return { ...r, committed };
  },
});
