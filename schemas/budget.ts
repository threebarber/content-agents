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
});
export type Budget = z.infer<typeof Budget>;
