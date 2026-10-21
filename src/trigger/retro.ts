import { schedules, task, logger } from "@trigger.dev/sdk";
import { logRun } from "../lib/runlog.js";
import { tokenTally } from "../agents/llm.js";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { retro, decideProposal } from "../agents/retro.js";
import { stateWrites } from "./queues.js";

/** Fridays 16:00 ET: learn from the week's verdicts, update memory, post proposals with Accept/Skip buttons. */
export const retroTask = schedules.task({
  id: "retro",
  cron: { pattern: "0 16 * * 5", timezone: "America/New_York" },
  maxDuration: 900,
  run: async () => {
    if (!stateToken()) return { skipped: "missing STATE_GITHUB_TOKEN" };
    const dir = checkoutState();
    const r = await retro({});
    logger.info("retro", r);
    await logRun("retro", { ...r, tokens: { ...tokenTally } });
    return { ...r, committed: commitState(dir, `retro: ${r.feedback} verdicts, ${r.proposals} proposals ($${r.usd.toFixed(3)})`) };
  },
});

/** Triggered by the Slack worker when the owner clicks Accept/Skip on a retro proposal. */
export const applyProposal = task({
  id: "apply-proposal",
  queue: stateWrites,
  maxDuration: 300,
  run: async (p: { proposalId: string; decision: "accept" | "skip"; user?: string }) => {
    if (!stateToken()) throw new Error("missing STATE_GITHUB_TOKEN");
    const dir = checkoutState();
    const line = await decideProposal(p.proposalId, p.decision);
    return { line, committed: commitState(dir, `proposal ${p.decision}: ${p.proposalId}`) };
  },
});
