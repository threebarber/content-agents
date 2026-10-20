import { z } from "zod";

export const SourceType = z.enum(["substack", "linkedin", "x", "rss", "hashnode", "youtube"]);
export type SourceType = z.infer<typeof SourceType>;

export const SourceStatus = z.enum(["candidate", "trial", "active", "paused", "retired"]);
export type SourceStatus = z.infer<typeof SourceStatus>;

export const Pheromone = z.object({
  hits: z.number().default(0),
  misses: z.number().default(0),
  last_hit_at: z.string().nullable().default(null),
  decayed_at: z.string().nullable().default(null),
});
export type Pheromone = z.infer<typeof Pheromone>;

export const Source = z.object({
  id: z.string(),
  type: SourceType,
  name: z.string().optional(),
  author: z.string().optional(),
  url: z.string().nullable().default(null),
  status: SourceStatus.default("candidate"),
  tags: z.array(z.string()).default([]),
  added_by: z.string().default("human"),
  added_at: z.string(),
  discovered_via: z.string().default("seed"),
  method: z.string().nullable().default(null),
  budget_tier: z.enum(["cheap", "normal", "expensive"]).default("normal"),
  pheromone: Pheromone.prefault({}),
  trial: z.object({ started_at: z.string(), hits: z.number().default(0) }).optional(),
  last_pulled_at: z.string().nullable().default(null),
  notes: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const SourcesFile = z.object({
  me: z
    .object({
      linkedin_profile: z.string().nullable().default(null),
      hashnode_rss: z.string().nullable().default(null),
    })
    .prefault({}),
  sources: z.array(Source).default([]),
});
export type SourcesFile = z.infer<typeof SourcesFile>;
