import { z } from "zod";

export const CardDraft = z.object({
  riff_on: z.string().nullable().describe("id of the ONE swipe-file post this card responds to (from SWIPE FILE), or null only for a pure work-note card."),
  their_point: z.string().nullable().describe("What that post actually argued or showed, in one specific sentence (their numbers, their example). Null if riff_on is null."),
  riff_type: z.string().describe("How the owner responds: extend (adds his evidence), disagree (pushes back with his experience), apply (tries their idea in his world), teardown (dissects their example), react-to-data (responds to their numbers), screenshot-commentary, or original (work notes only)."),
  title: z.string().describe("Working title, under 80 chars."),
  platform: z.enum(["linkedin", "hashnode"]),
  hook: z.string().describe("The opening line(s) the owner would post, in his voice: plain, specific, lowercase-friendly, no hype."),
  hook_breakdown: z.string().describe("Why the hook works, in 1-2 plain sentences: the move it makes (a number, a confession, a stake, a contrarian turn) and why that stops a GTM engineer mid-scroll."),
  angle: z.string().describe("What makes this the owner's post and not a rehash: the build, the lesson, the opinion."),
  outline: z.array(z.string()).describe("3-6 beats for the post."),
  format: z.string().describe("One of: story, list, contrarian, teardown, howto, data, casestudy, screenshot-commentary, question, essay."),
  hook_template_used: z.string().nullable().describe("Which swipe-file template this adapts, verbatim, or null."),
  brain_refs: z.array(z.string()).describe("ids of work-note items this draws on (from the WORK NOTES list). Empty if none."),
  evidence: z.array(z.object({ item_id: z.string(), why: z.string() })).describe("Swipe-file items (from the SWIPE FILE list) that inspired it, by id."),
  why_now: z.string().describe("Why this is timely given what the sources are talking about this week."),
  predicted_score: z.number().int().min(1).max(10).describe("Your honest guess at how well it lands with GTM engineers, 1-10."),
});
export type CardDraft = z.infer<typeof CardDraft>;

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
  riff_on?: string | null;
  riff_type?: string;
  their_point?: string | null;
  source_rating?: "good" | "bad" | "neutral";
  another_angle?: boolean;
};
