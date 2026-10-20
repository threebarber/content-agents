import { task, logger } from "@trigger.dev/sdk";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { intake, type IntakePayload } from "../agents/intake.js";
import { runSlash } from "../agents/slash.js";
import { stateWrites } from "./queues.js";

async function react(channel: string, ts: string, remove: string, add: string) {
  const call = (m: string, b: unknown) => fetch(`https://slack.com/api/${m}`, { method: "POST", headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(b) });
  await call("reactions.remove", { channel, timestamp: ts, name: remove }).catch(() => {});
  await call("reactions.add", { channel, timestamp: ts, name: add }).catch(() => {});
}

/** A link or screenshot posted in #content-agents (or a DM to the bot). */
export const intakeTask = task({
  id: "intake",
  queue: stateWrites,
  maxDuration: 900,
  run: async (p: IntakePayload) => {
    if (!stateToken()) throw new Error("missing STATE_GITHUB_TOKEN");
    const dir = checkoutState();
    try {
      const r = await intake(p, (m) => logger.info(m));
      await react(p.channel, p.ts, "eyes", r.saved.length || r.sourcesAdded.length ? "white_check_mark" : "x");
      return { ...r, committed: commitState(dir, `intake: ${r.saved.length} saved, ${r.sourcesAdded.length} sources, ${r.cards} cards`) };
    } catch (e) {
      await react(p.channel, p.ts, "eyes", "x");
      throw e;
    }
  },
});

/** `/ca …` slash command. */
export const slashCommand = task({
  id: "slash-command",
  queue: stateWrites,
  maxDuration: 600,
  run: async (p: { text: string; user?: string; channel?: string; response_url: string }) => {
    if (!stateToken()) throw new Error("missing STATE_GITHUB_TOKEN");
    const dir = checkoutState();
    let reply: string;
    try {
      reply = (await runSlash(p.text)).reply;
    } catch (e) {
      reply = `Failed: ${(e as Error).message.slice(0, 300)}`;
    }
    await fetch(p.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: true, text: reply }) });
    return { reply, committed: commitState(dir, `/ca ${p.text}${p.user ? ` (${p.user})` : ""}`) };
  },
});
