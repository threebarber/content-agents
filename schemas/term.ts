import { z } from "zod";
import { Pheromone, SourceStatus } from "./source.js";

export const TermKind = z.enum(["topic", "hashtag", "x_query", "person_query"]);
export const TermUse = z.enum(["tagging", "x_search", "linkedin_search", "web_search", "candidate_relevance"]);

export const Term = z.object({
  id: z.string(),
  term: z.string(),
  kind: TermKind.default("topic"),
  status: SourceStatus.default("candidate"),
  pinned: z.boolean().default(false), // human-pinned: always searched, never retired by the weekly re-derive
  used_for: z.array(TermUse).default(["tagging"]),
  added_by: z.string().default("human"),
  added_at: z.string().optional(),
  discovered_via: z.string().default("seed"),
  pheromone: Pheromone.prefault({}),
});
export type Term = z.infer<typeof Term>;

export const TermsFile = z.object({ terms: z.array(Term).default([]) });
export type TermsFile = z.infer<typeof TermsFile>;
