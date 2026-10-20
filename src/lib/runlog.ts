import { appendJsonl } from "./jsonl.js";
import { statePath } from "./paths.js";
import { postMessage, sections } from "./slack.js";

export type RunRecord = { task: string; at: string; ok: boolean; errors: string[]; stats: Record<string, unknown> };

/**
 * Every scheduled task records what it did (data/runs.jsonl), so the health check can tell "ran and found nothing"
 * from "didn't run" or "failed quietly". Errors also go to Slack right away: silent failures are the expensive kind.
 */
export async function logRun(task: string, stats: Record<string, unknown>, errors: string[] = []): Promise<void> {
  appendJsonl(statePath("data", "runs.jsonl"), [{ task, at: new Date().toISOString(), ok: errors.length === 0, errors, stats } satisfies RunRecord]);
  if (errors.length && process.env.SLACK_BOT_TOKEN) {
    const text = `⚠️ *${task}* finished with ${errors.length} problem${errors.length > 1 ? "s" : ""}:\n${errors.slice(0, 8).map((e) => `• ${e.slice(0, 300)}`).join("\n")}`;
    await postMessage(process.env.SLACK_CHANNEL || "content-agents", text, sections(text)).catch(() => {});
  }
}
