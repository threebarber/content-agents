import { Client } from "langsmith";
import { listCards, moveCard, type Card } from "./cards.js";
import { markDecided } from "./slack-cards.js";
import { ideateOne, ideateAnotherAngle } from "./ideate.js";
import { draftCard } from "./draft.js";
import { readCard } from "./cards.js";
import fs from "node:fs";
import { statePath } from "../lib/paths.js";
import { appendJsonl } from "../lib/jsonl.js";
import { loadSources, saveSources, loadForaging, findSource, today } from "../registry/store.js";
import { loadHooks } from "./distill.js";
import { itemsById } from "../lib/items.js";
import { Source } from "../../schemas/source.js";
import { hit, miss } from "../registry/pheromone.js";

const SCORE = { approve: 1, rewrite: 0.5, reject: 0 } as const;

export type FeedbackStats = { approved: number; rejected: number; rewritten: number; usd: number };

/** Process verdicts on inbox cards: score the run in LangSmith, credit sources, move files, rewrite immediately. */
export async function sweepFeedback(log: (m: string) => void = () => {}): Promise<FeedbackStats> {
  const decided = listCards("inbox").filter((c) => c.meta.verdict && c.meta.verdict !== "pending");
  const stats: FeedbackStats = { approved: 0, rejected: 0, rewritten: 0, usd: 0 };
  // retry drafts that failed on a previous sweep (approved but never drafted)
  for (const c of listCards("approved")) {
    try {
      const d = await draftCard(c);
      stats.usd += d.usd;
      fs.unlinkSync(c.file);
      log(`drafted (retry): ${c.meta.id}`);
    } catch (e) {
      log(`draft retry failed for ${c.meta.id}: ${(e as Error).message}`);
    }
  }
  if (!decided.length) return stats;
  const ls = process.env.LANGSMITH_API_KEY ? new Client() : null;
  const fo = loadForaging();
  const reg = loadSources();
  const hookSource = new Map(loadHooks().map((h) => [h.item_id, h.source_id]));
  for (const c of decided) {
    const v = c.meta.verdict as keyof typeof SCORE;
    if (!(v in SCORE)) continue;
    if (ls && c.meta.langsmith_run_id) {
      await ls.createFeedback(c.meta.langsmith_run_id, "owner_verdict", { score: SCORE[v], value: v, comment: c.meta.why || undefined }).catch((e) => log(`langsmith feedback failed: ${e.message}`));
    }
    // Idea quality and source quality are separate signals. Approve credits the sources; a reject only moves
    // source scores when the owner rated the post (good → small boost, bad → double miss). No opinion = no change.
    const rating = c.meta.source_rating ?? "neutral";
    const riffSource = c.meta.riff_on ? hookSource.get(c.meta.riff_on) : undefined;
    const rated = v === "reject" && rating !== "neutral" ? (riffSource ? [riffSource] : c.meta.sources) : [];
    // a post rated good whose author isn't followed yet: follow them as a candidate
    if (rating === "good" && riffSource && !findSource(reg, riffSource)) {
      const it = itemsById([c.meta.riff_on!]).get(c.meta.riff_on!);
      if (it && ["linkedin", "x", "substack"].includes(it.type)) {
        reg.sources.push(Source.parse({ id: riffSource, type: it.type, name: it.author ?? undefined, author: it.author ?? undefined, url: it.author_url ?? null, status: "candidate", added_by: "human", added_at: today(), discovered_via: `rated-good:${it.id}` }));
      }
    }
    for (const sid of v === "approve" ? c.meta.sources : rated) {
      const s = findSource(reg, sid);
      if (!s) continue;
      if (v === "approve") hit(s, fo.hit_rules.approved_card_bonus);
      else if (rating === "good") hit(s, 1);
      else if (rating === "bad") miss(s, 2);
    }
    appendJsonl(statePath("data", "feedback.jsonl"), [{ card: c.meta.id, verdict: v, why: c.meta.why, sources: c.meta.sources, riff_on: c.meta.riff_on ?? null, source_rating: v === "reject" ? rating : v === "approve" ? "good" : null, run_id: c.meta.langsmith_run_id, at: new Date().toISOString() }]);
    const note = c.meta.why ? ` — “${c.meta.why}”` : "";
    const slackSafe = (p: Promise<void>) => p.catch((e) => log(`slack update failed: ${e.message}`));
    if (v === "approve") {
      const approvedFile = moveCard(c, "approved");
      await slackSafe(markDecided(c.meta.slack, c, `✅ *Approved*${note} — drafting now, it'll appear in this thread`));
      try {
        const d = await draftCard(readCard(approvedFile));
        stats.usd += d.usd;
        fs.unlinkSync(approvedFile); // lives in queue/drafted now
        await slackSafe(markDecided(c.meta.slack, c, `✅ *Approved*${note} — draft (${d.words} words) in the thread ↓`));
      } catch (e) {
        log(`draft failed for ${c.meta.id}: ${(e as Error).message}`);
        await slackSafe(markDecided(c.meta.slack, c, `✅ *Approved*${note} — draft failed, will retry next sweep`));
      }
      stats.approved++;
    } else if (v === "reject") {
      const src = rating === "good" ? " · post rated good" : rating === "bad" ? " · post rated not worth it" : "";
      await slackSafe(markDecided(c.meta.slack, c, `🗑️ *Rejected*${note}${src}${c.meta.another_angle ? " — another angle coming in this thread" : ""}`));
      if (c.meta.another_angle) {
        try {
          stats.usd += (await ideateAnotherAngle(c as Card)).usd;
        } catch (e) {
          log(`another angle failed for ${c.meta.id}: ${(e as Error).message}`);
        }
      }
      moveCard(c, "rejected");
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

