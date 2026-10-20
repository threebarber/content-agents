import { Source } from "../../schemas/source.js";
import type { HookRecord } from "../../schemas/hook.js";
import type { Item } from "../../schemas/item.js";
import { findSource, slugify, today } from "./store.js";
import type { SourcesFile } from "../../schemas/source.js";

/**
 * Laying new trails: authors of posts that cleared the bar become candidate sources.
 * - LinkedIn / X: the post's author (found via a search term or mentioned by a followed source)
 * - Substack: other publications linked from high-performing posts
 * Returns the new candidates (capped), already added to `reg`.
 */
export function generateCandidates(reg: SourcesFile, hits: HookRecord[], items: Map<string, Item>, cap: number): Source[] {
  const added: Source[] = [];
  const add = (s: Source) => {
    if (added.length >= cap) return;
    if (findSource(reg, s.id) || (s.url && findSource(reg, s.url))) return;
    reg.sources.push(s);
    added.push(s);
  };
  // a trail is only laid for posts that are on-topic, well-hooked, and actually earned engagement
  const JOBISH = /\b(we('| a)re hiring|now hiring|job opening|apply here|career update|open role|join (our|my) team|looking for an?\b.{0,40}\b(engineer|director|manager|lead))/i;
  for (const h of hits) {
    const it = items.get(h.item_id);
    if (!it) continue;
    const eng = (it.metrics.likes ?? 0) + 2 * (it.metrics.comments ?? 0);
    if (h.relevance < 4 || h.hook_quality < 4 || JOBISH.test(it.text.slice(0, 400))) continue;
    if ((it.type === "linkedin" || it.type === "x") && eng < 30) continue;
    if ((it.type === "linkedin" || it.type === "x") && it.author_url) {
      const handle = it.source_id.split(":")[1];
      if (!handle || handle === "unknown") continue;
      add(Source.parse({
        id: it.source_id, type: it.type, name: it.author ?? handle, author: it.author ?? handle, url: it.author_url,
        status: "candidate", added_by: "agent:ingest", added_at: today(),
        discovered_via: it.found_via ?? `item:${it.id}`, method: it.type === "linkedin" ? "apify:harvestapi/linkedin-profile-posts" : "apify:apidojo/tweet-scraper",
        budget_tier: "normal", notes: `from "${(it.title ?? "").slice(0, 80)}" (${it.metrics.likes ?? "?"} likes)`,
      }));
    }
    if (it.type === "substack") {
      for (const link of it.outbound_links) {
        let host: string;
        try { host = new URL(link).host.replace(/^www\./, ""); } catch { continue; }
        if (!host.endsWith(".substack.com")) continue;
        const slug = host.replace(/\.substack\.com$/, "");
        add(Source.parse({
          id: `substack:${slugify(slug)}`, type: "substack", url: `https://${host}`, status: "candidate",
          added_by: "agent:ingest", added_at: today(), discovered_via: `link:${it.id}`, method: "substack_api", budget_tier: "cheap",
          notes: `linked from ${it.author ?? it.source_id}: "${(it.title ?? "").slice(0, 60)}"`,
        }));
      }
    }
  }
  return added;
}
