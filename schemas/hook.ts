import { z } from "zod";

/** What the distiller extracts from one post (model output). */
export const HookExtraction = z.object({
  hook: z.string().describe("The opening 1-2 lines exactly as written (or the title+subtitle if the body opens weakly)."),
  hook_template: z.string().describe("A reusable, topic-agnostic version of the hook with [placeholders]."),
  format: z.string().describe("One of: story, list, contrarian, teardown, howto, data, casestudy, roundup, question, announcement, essay, interview, other."),
  topics: z.array(z.string()).describe("3-6 short lowercase topics, e.g. 'gtm engineering', 'clay', 'signals', 'pricing'."),
  core_claim: z.string().describe("The one idea the post argues, in one sentence."),
  why_it_worked: z.string().describe("Hypothesis for why this resonated (or would), one or two sentences."),
  hook_quality: z.number().int().min(1).max(5).describe("1 = generic, 5 = would stop a GTM engineer mid-scroll."),
  relevance: z.number().int().min(1).max(5).describe("Relevance to a GTM engineer / solutions engineer who builds with AI. 1 = none, 5 = core."),
});
export type HookExtraction = z.infer<typeof HookExtraction>;

/** Stored swipe-file record: extraction + provenance. One per item in data/hooks.jsonl. */
export type HookRecord = HookExtraction & {
  item_id: string;
  source_id: string;
  author: string | null;
  title: string | null;
  url: string;
  published_at: string;
  engagement_z: number | null;
  hit: boolean;
  model: string;
  distilled_at: string;
  /** set when the post was deliberately not distilled (e.g. the model declined it); never retried */
  skipped?: string;
};
