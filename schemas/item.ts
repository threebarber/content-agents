import { z } from "zod";
import { SourceType } from "./source.js";

/** One piece of content pulled from a source. Stored as JSONL under data/items/<type>/<yyyy-mm>.jsonl */
export const Item = z.object({
  id: z.string(), // "<type>:<source-key>:<native-id>"
  source_id: z.string(),
  type: SourceType,
  url: z.string(),
  title: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  published_at: z.string(), // ISO
  text: z.string(), // plain text, truncated
  text_truncated: z.boolean().default(false),
  metrics: z
    .object({
      likes: z.number().nullable().default(null),
      comments: z.number().nullable().default(null),
      shares: z.number().nullable().default(null), // restacks / reposts
      wordcount: z.number().nullable().default(null),
    })
    .prefault({}),
  tags: z.array(z.string()).default([]),
  paywalled: z.boolean().default(false),
  outbound_links: z.array(z.string()).default([]), // candidate-generation input
  fetched_at: z.string(),
  saved_by: z.enum(["human"]).optional(),
  note: z.string().optional(),
});
export type Item = z.infer<typeof Item>;
