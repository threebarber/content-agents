import { Client } from "langsmith";
import { listCards, moveCard, type Card } from "./cards.js";
import { markDecided } from "./slack-cards.js";
import { ideateOne } from "./ideate.js";
import { statePath } from "../lib/paths.js";
import { appendJsonl } from "../lib/jsonl.js";
import { loadSources, saveSources, loadForaging, findSource } from "../registry/store.js";
import { hit, miss } from "../registry/pheromone.js";

const SCORE = { approve: 1, rewrite: 0.5, reject: 0 } as const;

export type FeedbackStats = { approved: number; rejected: number; rewritten: number; usd: number };

/** Process verdicts on inbox cards: score the run in LangSmith, credit sources, move files, rewrite immediately. */
export async function sweepFeedback(log: (m: string) => void = () => {}): Promise<FeedbackStats> {
  const decided = listCards("inbox").filter((c) => c.meta.verdict && c.meta.verdict !== "pending");
  const stats: FeedbackStats = { approved: 0, rejected: 0, rewritten: 0, usd: 0 };
  if (!decided.length) return stats;
  const ls = process.env.LANGSMITH_API_KEY ? new Client() : null;
  const fo = loadForaging();
  const reg = loadSources();
  for (const c of decided) {
    const v = c.meta.verdict as keyof typeof SCORE;
    if (!(v in SCORE)) continue;
    if (ls && c.meta.langsmith_run_id) {
      await ls.createFeedback(c.meta.langsmith_run_id, "owner_verdict", { score: SCORE[v], value: v, comment: c.meta.why || undefined }).catch((e) => log(`langsmith feedback failed: ${e.message}`));
    }
    for (const sid of c.meta.sources) {
      const s = findSource(reg, sid);
      if (!s) continue;
      if (v === "approve") hit(s, fo.hit_rules.approved_card_bonus);
      else if (v === "reject") miss(s, 1);
    }
    appendJsonl(statePath("data", "feedback.jsonl"), [{ card: c.meta.id, verdict: v, why: c.meta.why, sources: c.meta.sources, run_id: c.meta.langsmith_run_id, at: new Date().toISOString() }]);
    const note = c.meta.why ? ` — “${c.meta.why}”` : "";
    const slackSafe = (p: Promise<void>) => p.catch((e) => log(`slack update failed: ${e.message}`));
    if (v === "approve") {
      moveCard(c, "approved");
      await slackSafe(markDecided(c.meta.slack, c, `✅ *Approved*${note}`));
      stats.approved++;
    } else if (v === "reject") {
      moveCard(c, "rejected");
      await slackSafe(markDecided(c.meta.slack, c, `🗑️ *Rejected*${note}`));
      stats.rejected++;
    } else {
      await slackSafe(markDecided(c.meta.slack, c, `✍️ *Rewriting*${note} — new version coming below`));
      const r = await ideateOne(c as Card);
      stats.usd += r.usd;
      c.meta.why = `${c.meta.why} (rewritten → ${r.files[0]?.split("/").pop()})`.trim();
      moveCard(c, "rejected");
      stats.rewritten++;
    }
    log(`${v}: ${c.meta.id}`);
  }
  saveSources(reg);
  return stats;
}
