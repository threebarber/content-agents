import { z } from "zod";

export const Budget = z.object({
  monthly_usd: z
    .object({
      apify: z.number().default(4),
      anthropic: z.number().default(8),
    })
    .prefault({}),
  items_per_run: z
    .object({
      substack: z.number().int().default(400),
      linkedin: z.number().int().default(300),
      x: z.number().int().default(200),
    })
    .prefault({}),
  backfill_days: z.number().int().default(90),
  ideas_per_batch: z.number().int().default(10),
  ideate_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  use_batch_api: z.boolean().default(true),
  social: z
    .object({
      linkedin_posts_per_term: z.number().int().default(15),
      x_tweets_per_term: z.number().int().default(25),
      x_min_likes: z.number().int().default(15),
      profile_posts_per_creator: z.number().int().default(8),
      trial_posts: z.number().int().default(5),
      max_new_candidates_per_run: z.number().int().default(10),
      search_terms: z.number().int().default(12), // total searched terms: pinned + derived
    })
    .prefault({}),
});
export type Budget = z.infer<typeof Budget>;
