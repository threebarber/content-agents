import { schedules } from "@trigger.dev/sdk";
import { checkoutState, stateToken } from "../lib/state-repo.js";
import { health, formatHealth } from "../agents/health.js";
import { postMessage, sections } from "../lib/slack.js";

/** Mondays 08:00 ET: post the health report (pulled / remembered / referenced). Read-only: commits nothing. */
export const healthTask = schedules.task({
  id: "health",
  cron: { pattern: "0 8 * * 1", timezone: "America/New_York" },
  maxDuration: 300,
  run: async () => {
    if (!stateToken()) return { skipped: "missing STATE_GITHUB_TOKEN" };
    checkoutState();
    const checks = await health();
    if (process.env.SLACK_BOT_TOKEN) await postMessage(process.env.SLACK_CHANNEL || "content-agents", "Weekly health check", sections(formatHealth(checks, true)));
    return { fail: checks.filter((c) => c.status === "fail").length, warn: checks.filter((c) => c.status === "warn").length };
  },
});
