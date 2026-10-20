import { tasks } from "@trigger.dev/sdk";
import { postMessage, sections } from "../lib/slack.js";

/** Any task that fails for good (after retries) posts a Slack alert, so nothing breaks silently. */
tasks.onFailure(async ({ task, error }) => {
  if (!process.env.SLACK_BOT_TOKEN) return;
  const msg = error instanceof Error ? error.message : String(error);
  const text = `🚨 *${task}* failed after retries:\n\`\`\`${msg.slice(0, 1500)}\`\`\``;
  await postMessage(process.env.SLACK_CHANNEL || "content-agents", text, sections(text)).catch(() => {});
});
