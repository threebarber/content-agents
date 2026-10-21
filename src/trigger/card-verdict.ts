import { task, logger } from "@trigger.dev/sdk";
import { stateWrites } from "./queues.js";
import { logRun } from "../lib/runlog.js";
import { tokenTally } from "../agents/llm.js";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { listCards, writeCard } from "../agents/cards.js";
import { sweepFeedback } from "../agents/feedback.js";
import { markDecided } from "../agents/slack-cards.js";


export type CardVerdictPayload = {
  cardId: string;
  verdict: "approve" | "reject" | "rewrite";
  why?: string;
  sourceRating?: "good" | "bad" | "neutral";
  anotherAngle?: boolean;
  user?: string;
  slack?: { channel: string; ts: string };
};

/** Triggered by the Slack button worker (slack-worker/). Applies the verdict, runs the feedback loop, commits. */
export const cardVerdict = task({
  id: "card-verdict",
  queue: stateWrites,
  maxDuration: 600,
  run: async (p: CardVerdictPayload) => {
    if (!stateToken()) throw new Error("missing STATE_GITHUB_TOKEN");
    const dir = checkoutState();
    const card = listCards("inbox").find((c) => c.meta.id === p.cardId);
    if (!card) {
      logger.warn("card not in inbox (already decided?)", { cardId: p.cardId });
      await markDecided(p.slack, null, `Already handled: \`${p.cardId}\``).catch(() => {});
      return { skipped: "not in inbox" };
    }
    card.meta.verdict = p.verdict;
    card.meta.why = (p.why ?? "").trim();
    if (p.verdict === "reject") {
      card.meta.source_rating = p.sourceRating ?? "neutral";
      card.meta.another_angle = !!p.anotherAngle;
    }
    if (p.slack) card.meta.slack = p.slack;
    writeCard("inbox", card.meta, card.body);
    const r = await sweepFeedback((m) => logger.info(m));
    await logRun("card-verdict", { verdict: p.verdict, usd: r.usd, tokens: { ...tokenTally } });
    const committed = commitState(dir, `verdict: ${p.verdict} ${p.cardId} (via Slack)`);
    return { ...r, committed };
  },
});
