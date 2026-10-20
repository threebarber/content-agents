import { schedules, logger } from "@trigger.dev/sdk";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { ingestSocial } from "../agents/social.js";
import { distill } from "../agents/distill.js";

/**
 * Sun + Wed 04:00 ET (two hours before ideate): LinkedIn + X term search, creator pulls, your own post stats,
 * then distill everything new so the 06:00 ideate run sees it. Skips paid pulls past the monthly Apify budget.
 */
export const ingestSocialTask = schedules.task({
  id: "ingest-social",
  cron: { pattern: "0 4 * * 0,3", timezone: "America/New_York" },
  maxDuration: 1500,
  run: async () => {
    if (!stateToken()) return { skipped: "missing STATE_GITHUB_TOKEN" };
    if (!process.env.APIFY_TOKEN) return { skipped: "missing APIFY_TOKEN" };
    const dir = checkoutState();
    const social = await ingestSocial((m) => logger.info(m));
    const d = process.env.ANTHROPIC_API_KEY ? await distill({ limit: 400, concurrency: 6, log: (m) => logger.info(m) }) : null;
    const committed = commitState(dir, `social: ${social.linkedin} linkedin, ${social.x} x, ${social.mine} mine; distilled ${d?.distilled ?? 0}, +${d?.candidates.length ?? 0} candidates${social.skipped ? ` (skipped: ${social.skipped})` : ""}`);
    return { social, distilled: d, committed };
  },
});
