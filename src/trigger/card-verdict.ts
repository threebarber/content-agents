import { task, logger, queue } from "@trigger.dev/sdk";
import { checkoutState, commitState, stateToken } from "../lib/state-repo.js";
import { listCards, writeCard } from "../agents/cards.js";
import { sweepFeedback } from "../agents/feedback.js";
import { markDecided } from "../agents/slack-cards.js";

/** One verdict at a time, so concurrent clicks never race on the state repo. */
const verdicts = queue({ name: "verdicts", concurrencyLimit: 1 });

export type CardVerdictPayload = {
  cardId: string;
  verdict: "approve" | "reject" | "rewrite";
  why?: string;
  user?: string;
  slack?: { channel: string; ts: string };
};

/** Triggered by the Slack button worker (slack-worker/). Applies the verdict, runs the feedback loop, commits. */
export const cardVerdict = task({
  id: "card-verdict",
  queue: verdicts,
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
    if (p.slack) card.meta.slack = p.slack;
    writeCard("inbox", card.meta, card.body);
    const r = await sweepFeedback((m) => logger.info(m));
    const committed = commitState(dir, `verdict: ${p.verdict} ${p.cardId}${p.user ? ` (via Slack, ${p.user})` : ""}`);
    return { ...r, committed };
  },
});
