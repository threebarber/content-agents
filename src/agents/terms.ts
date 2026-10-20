import fs from "node:fs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { claude, MODELS, costUsd } from "./llm.js";
import { loadHooks } from "./distill.js";
import { loadSources, loadTerms, saveTerms, loadBudget, slugify, today } from "../registry/store.js";
import { statePath } from "../lib/paths.js";
import { Term } from "../../schemas/term.js";

const Derived = z.object({
  terms: z.array(
    z.object({
      term: z.string().describe("Search phrase, 1-4 words, lowercase, unambiguous on LinkedIn/X (e.g. 'clay gtm' not 'clay')."),
      why: z.string().describe("Which newsletter themes it captures, one short sentence."),
      linkedin: z.boolean().describe("Worth searching on LinkedIn."),
      x: z.boolean().describe("Worth searching on X (shorter, punchier topics; skip enterprise-only jargon)."),
    }),
  ),
});

const STATE_FILE = () => statePath("data", "terms-derived.json");

/** Weighted topic counts from hooks of the active newsletters: relevance × (1 + engagement z, floored). */
function topicWeights(): { topic: string; weight: number; posts: number }[] {
  const newsletters = new Set(loadSources().sources.filter((s) => s.type === "substack" && s.status === "active").map((s) => s.id));
  const w = new Map<string, { weight: number; posts: number }>();
  for (const h of loadHooks()) {
    if (!newsletters.has(h.source_id) || h.relevance < 3) continue;
    const boost = h.relevance * (1 + Math.max(0, h.engagement_z ?? 0));
    for (const t of h.topics) {
      const k = t.toLowerCase().trim();
      const cur = w.get(k) ?? { weight: 0, posts: 0 };
      w.set(k, { weight: cur.weight + boost, posts: cur.posts + 1 });
    }
  }
  return [...w].map(([topic, v]) => ({ topic, ...v })).sort((a, b) => b.weight - a.weight);
}

export type DeriveResult = { added: string[]; kept: string[]; retired: string[]; usd: number };

/**
 * Derive LinkedIn/X search terms from what the followed newsletters write about.
 * Derived terms become the search set; previously-searched terms not re-derived stop being searched
 * (they keep tagging/relevance use and their pheromone history).
 */
export async function deriveTerms(opts: { n?: number; dry?: boolean } = {}): Promise<DeriveResult & { proposed: { term: string; why: string }[] }> {
  const topics = topicWeights().slice(0, 80);
  const reg = loadTerms();
  const pinned = reg.terms.filter((t) => t.pinned);
  // Stability: a searched term keeps its slot until it has enough results to judge (≥10 posts scored),
  // and keeps it after that if at least 40% of its posts were strong. Only proven underperformers free a slot.
  const searched = reg.terms.filter((t) => !t.pinned && t.used_for.some((u) => u.endsWith("_search")));
  const scored = (t: (typeof searched)[number]) => t.pheromone.hits + t.pheromone.misses;
  const locked = searched.filter((t) => scored(t) < 10 || t.pheromone.hits / scored(t) >= 0.4);
  const slots = Math.max(0, (opts.n ?? loadBudget().social.search_terms) - pinned.length - locked.length);
  if (slots === 0) return { added: [], kept: locked.map((t) => t.term), retired: [], usd: 0, proposed: [] };
  const perf = reg.terms
    .filter((t) => t.used_for.some((u) => u.endsWith("_search")))
    .map((t) => `- "${t.term}": ${t.pheromone.hits.toFixed(0)} strong posts / ${t.pheromone.misses.toFixed(0)} weak`)
    .join("\n");
  const res = await claude().messages.parse({
    model: MODELS.ideate,
    max_tokens: 4000,
    output_config: { effort: "medium", format: zodOutputFormat(Derived) },
    messages: [
      {
        role: "user",
        content: `These are the topics that the GTM, growth, and AI newsletters a GTM engineer follows actually write about, weighted by how relevant and how well-received each post was (topic: weight, posts).

${topics.map((t) => `${t.topic}: ${t.weight.toFixed(1)}, ${t.posts}`).join("\n")}

Turn them into ${slots} search phrases for finding high-engagement LinkedIn and X posts in this same world. Rules:
- Merge near-duplicates ("gtm engineer" / "gtm engineering" can stay as one phrase if they behave the same).
- Each phrase must be unambiguous on social search. Bare words that mean something else ("clay", "signals", "pipeline") need a qualifier.
- Prefer phrases practitioners post about (tools, plays, roles, problems) over abstract categories.
- Skip hiring/career/job-post topics.
- These are already searched (pinned by the user, or still being tested), so do NOT propose them or near-duplicates of them: ${[...pinned, ...locked].map((t) => `"${t.term}"`).join(", ") || "(none)"}.

How the current search terms performed (strong = on-topic, well-hooked or high-engagement):
${perf || "(none yet)"}`,
      },
    ],
  });
  const usd = costUsd(MODELS.ideate, res.usage);
  const proposed = (res.parsed_output?.terms ?? []).slice(0, slots);
  if (opts.dry) return { added: [], kept: [], retired: [], usd, proposed };

  const derivedIds = new Set<string>();
  const added: string[] = [];
  const kept: string[] = [];
  for (const p of proposed) {
    const id = `term:${slugify(p.term)}`;
    derivedIds.add(id);
    const uses = [...(p.linkedin ? ["linkedin_search"] : []), ...(p.x ? ["x_search"] : [])] as ("linkedin_search" | "x_search")[];
    const existing = reg.terms.find((t) => t.id === id || t.term.toLowerCase() === p.term.toLowerCase());
    if (existing?.pinned) continue;
    if (existing) {
      existing.status = "active";
      existing.used_for = [...new Set([...existing.used_for.filter((u) => !u.endsWith("_search")), "tagging", "candidate_relevance", ...uses])] as typeof existing.used_for;
      kept.push(existing.term);
    } else {
      reg.terms.push(Term.parse({ id, term: p.term.toLowerCase(), kind: "topic", status: "active", used_for: ["tagging", "candidate_relevance", ...uses], added_by: "agent:derive-terms", added_at: today(), discovered_via: `newsletters: ${p.why}`.slice(0, 200) }));
      added.push(p.term);
    }
  }
  const retired: string[] = [];
  for (const t of reg.terms) {
    if (t.pinned || locked.includes(t) || derivedIds.has(t.id) || !t.used_for.some((u) => u.endsWith("_search"))) continue;
    t.used_for = t.used_for.filter((u) => !u.endsWith("_search"));
    retired.push(t.term);
  }
  saveTerms(reg);
  fs.writeFileSync(STATE_FILE(), JSON.stringify({ derived_at: new Date().toISOString(), proposed, added, kept, retired }, null, 2));
  return { added, kept: [...kept, ...locked.map((t) => t.term)], retired, usd, proposed };
}

/** True when the last derivation is older than `days` (or never ran). */
export function derivationStale(days = 7): boolean {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    return Date.now() - new Date(d.derived_at).getTime() > days * 86400000;
  } catch {
    return true;
  }
}
