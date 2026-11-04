import { z } from "zod";

export const CardDraft = z.object({
  riff_on: z.string().nullable().describe("id of the ONE swipe-file post that sparked this idea (from SWIPE FILE), or null only for a pure work-note card. The spark, not the subject: it never appears in the hook."),
  their_point: z.string().nullable().describe("What that post actually argued or showed, in one specific sentence (their numbers, their example). Null if riff_on is null."),
  riff_type: z.string().describe("How the idea relates to the spark: extend (the owner's own experience of the same thing), disagree (their experience says otherwise), apply (they tried it themselves), teardown (dissects the example), react-to-data (their take on the numbers), screenshot-commentary (the one card per batch that may quote the post), or original (work notes only)."),
  title: z.string().describe("Working title, under 80 chars."),
  platform: z.enum(["linkedin", "hashnode"]),
  hook: z.string().describe("The opening line(s) the owner would post, in their voice (see THEIR VOICE). Stands on its own: opens with the owner's situation, build, number, confession, risk, or opinion, never with another person's name or claim."),
  hook_move: z.string().describe("The move the hook makes, one of: confession, credential-gap, risk, scene, stat-line, before-after, dare, list, question, tool-love, hot-take, how-i, result, reaction."),
  hook_breakdown: z.string().describe("Why the hook works, in 1-2 plain sentences: the move it makes (a number, a confession, a stake, a contrarian turn) and why that stops a GTM engineer mid-scroll."),
  angle: z.string().describe("What makes this post the owner's and not a rehash: the build, the lesson, the opinion."),
  outline: z.array(z.string()).describe("3-6 beats for the post."),
  format: z.string().describe("One of: story, list, contrarian, teardown, howto, data, casestudy, screenshot-commentary, question, essay."),
  hook_template_used: z.string().nullable().describe("Which HOOK LIBRARY template this adapts, verbatim, or null."),
  brain_refs: z.array(z.string()).describe("ids of work-note items this draws on (from the WORK NOTES list). Empty if none."),
  evidence: z.array(z.object({ item_id: z.string(), why: z.string() })).describe("Swipe-file items (from the SWIPE FILE list) that inspired it, by id."),
  why_now: z.string().describe("Why this is timely given what the sources are talking about this week."),
  predicted_score: z.number().int().min(1).max(10).describe("Your honest guess at how well it lands with GTM engineers, 1-10."),
});
export type CardDraft = z.infer<typeof CardDraft>;

/** Fixed vocabularies. The model writes free text; code maps it onto these (unknown → "other"). */
export const FORMATS = ["story", "list", "contrarian", "teardown", "howto", "data", "casestudy", "screenshotcommentary", "question", "essay", "roundup", "interview", "announcement", "other"] as const;
export const HOOK_MOVES = ["confession", "credentialgap", "risk", "scene", "statline", "beforeafter", "dare", "list", "question", "toollove", "hottake", "howi", "result", "reaction", "other"] as const;
export const RIFF_TYPES = ["extend", "disagree", "apply", "teardown", "reacttodata", "screenshotcommentary", "original"] as const;
const key = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
const FORMAT_SYNONYMS: Record<string, string> = { tutorial: "howto", guide: "howto", walkthrough: "howto", stats: "data", numbers: "data", research: "data", case: "casestudy", hottake: "contrarian", opinion: "contrarian", listicle: "list", thread: "list", narrative: "story", personalstory: "story", screenshot: "screenshotcommentary", quotetweet: "screenshotcommentary", podcast: "interview", news: "announcement", launch: "announcement", newsletter: "roundup", digest: "roundup" };
const RIFF_SYNONYMS: Record<string, string> = { agree: "extend", build: "extend", buildon: "extend", pushback: "disagree", counter: "disagree", contrarian: "disagree", tryit: "apply", application: "apply", dissect: "teardown", data: "reacttodata", reacttonumbers: "reacttodata", quote: "screenshotcommentary", screenshot: "screenshotcommentary", worknotes: "original", own: "original" };
const MOVE_SYNONYMS: Record<string, string> = { admission: "confession", failure: "confession", outsider: "credentialgap", underdog: "credentialgap", gap: "credentialgap", stakes: "risk", bet: "risk", story: "scene", moment: "scene", stat: "statline", number: "statline", numbers: "statline", data: "statline", contrast: "beforeafter", transformation: "beforeafter", challenge: "dare", myweek: "list", listicle: "list", favoritetool: "toollove", enthusiasm: "toollove", contrarian: "hottake", opinion: "hottake", unpopularopinion: "hottake", howto: "howi", walkthrough: "howi", outcome: "result", results: "result", quotereact: "reaction", quote: "reaction", react: "reaction", newsreact: "reaction" };
export function normalizeHookMove(s: string): string {
  const k = key(s);
  return (HOOK_MOVES as readonly string[]).includes(k) ? k : MOVE_SYNONYMS[k] ?? "other";
}
export function normalizeFormat(s: string): string {
  const k = key(s);
  return (FORMATS as readonly string[]).includes(k) ? k : FORMAT_SYNONYMS[k] ?? "other";
}
export function normalizeRiffType(s: string): string {
  const k = key(s);
  return (RIFF_TYPES as readonly string[]).includes(k) ? k : RIFF_SYNONYMS[k] ?? "extend";
}

export const IdeateOutput = z.object({ cards: z.array(CardDraft) });

export const Verdict = z.enum(["pending", "approve", "reject", "rewrite"]);
export type Verdict = z.infer<typeof Verdict>;

/** Frontmatter written to queue/<state>/<id>.md */
export type CardMeta = {
  id: string;
  created_at: string;
  platform: "linkedin" | "hashnode";
  verdict: Verdict;
  why: string;
  predicted_score: number;
  format: string;
  sources: string[]; // source_ids credited when the verdict lands
  evidence: string[]; // item ids
  brain_refs: string[];
  seed: string | null; // "rewrite:<card id>" | "saved:<item id>" | null
  langsmith_run_id: string | null;
  model: string;
  published_url: string;
  slack?: { channel: string; ts: string };
  hook_breakdown?: string;
  hook_move?: string;
  /** The structured card as generated (normalized). Slack, drafts, and the retro read this, not the markdown. */
  content?: CardDraft;
  riff_on?: string | null;
  riff_type?: string;
  their_point?: string | null;
  source_rating?: "good" | "bad" | "neutral";
  another_angle?: boolean;
};
