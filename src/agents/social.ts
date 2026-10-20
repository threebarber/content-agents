import { monthSpendUsd } from "../lib/apify.js";
import { searchLinkedIn, linkedInProfilePosts, searchX, xHandlePosts } from "../ingest/social.js";
import { writeItems, appendJsonl } from "../lib/jsonl.js";
import { statePath } from "../lib/paths.js";
import { loadSources, saveSources, loadTerms, loadBudget, loadForaging } from "../registry/store.js";
import { sampleBeta } from "../registry/thompson.js";
import type { Item } from "../../schemas/item.js";

export type SocialStats = { linkedin: number; x: number; mine: number; spend_before: number; skipped?: string; errors: string[] };

/**
 * Twice a week: search LinkedIn + X for active terms, pull posts from followed / candidate creators (Thompson-sampled),
 * and snapshot the owner's own LinkedIn posts for outcome tracking. Guarded by the monthly Apify budget.
 */
export async function ingestSocial(log: (m: string) => void = () => {}): Promise<SocialStats> {
  const b = loadBudget();
  const fo = loadForaging();
  const reg = loadSources();
  const terms = loadTerms().terms.filter((t) => t.status === "active");
  const stats: SocialStats = { linkedin: 0, x: 0, mine: 0, spend_before: 0, errors: [] };
  const spend = await monthSpendUsd();
  stats.spend_before = spend.used;
  if (spend.used >= b.monthly_usd.apify) {
    stats.skipped = `apify month-to-date $${spend.used.toFixed(2)} ≥ budget $${b.monthly_usd.apify}`;
    return stats;
  }
  const S = b.social;
  const run = async (label: string, fn: () => Promise<Item[]>) => {
    try {
      const items = await fn();
      const n = writeItems(items);
      log(`${label}: ${items.length} pulled, ${n} new`);
      return { items, n };
    } catch (e) {
      stats.errors.push(`${label}: ${(e as Error).message.slice(0, 200)}`);
      return { items: [] as Item[], n: 0 };
    }
  };

  // 1. term search
  const liTerms = terms.filter((t) => t.used_for.includes("linkedin_search")).map((t) => ({ id: t.id.replace(/^term:/, ""), term: t.term }));
  const xTerms = terms.filter((t) => t.used_for.includes("x_search")).map((t) => ({ id: t.id.replace(/^term:/, ""), term: t.term }));
  stats.linkedin += (await run("linkedin search", () => searchLinkedIn(liTerms, S.linkedin_posts_per_term))).n;
  stats.x += (await run("x search", () => searchX(xTerms, S.x_tweets_per_term, S.x_min_likes))).n;

  // 2. creators: every active creator gets a full pull; candidates/trial get a trial-size pull, chosen by
  //    Thompson sampling (most promising first) plus one uniformly random pick, capped per run.
  for (const type of ["linkedin", "x"] as const) {
    const pool = reg.sources.filter((s) => s.type === type && s.url && !["paused", "retired"].includes(s.status));
    if (!pool.length) continue;
    const active = pool.filter((s) => s.status === "active").slice(0, 20);
    const explore = pool.filter((s) => s.status !== "active").map((s) => ({ s, w: sampleBeta(1 + s.pheromone.hits, 1 + s.pheromone.misses) })).sort((a, b) => b.w - a.w).map((x) => x.s);
    const trialN = Math.min(explore.length, 8);
    const picks = explore.slice(0, trialN - 1);
    const rest = explore.slice(trialN - 1);
    if (rest.length) picks.push(rest[Math.floor(Math.random() * rest.length)]);
    const run2 = async (srcs: typeof pool, per: number, label: string) => {
      if (!srcs.length) return;
      const urls = srcs.map((s) => s.url!);
      const r = type === "linkedin"
        ? await run(`linkedin ${label} (${urls.length})`, () => linkedInProfilePosts(urls, per))
        : await run(`x ${label} (${urls.length})`, () => xHandlePosts(urls.map((u) => u.split("/").pop()!), per));
      stats[type] += r.n;
      const now = new Date().toISOString();
      for (const s of srcs) {
        s.last_pulled_at = now;
        if (s.status === "candidate") s.status = "trial";
      }
    };
    await run2(active, S.profile_posts_per_creator, "creators");
    await run2(picks, S.trial_posts, "trials");
  }

  // 3. the owner's own LinkedIn posts: outcome snapshots (48h / 7d / later all just append; analysis picks the right one)
  const me = reg.me.linkedin_profile;
  if (me) {
    const r = await run("my linkedin posts", () => linkedInProfilePosts([me], 20, "month"));
    const mine = r.items.map((i) => ({ ...i, source_id: "me:linkedin" }));
    writeItems(mine);
    appendJsonl(statePath("data", "my-posts.jsonl"), mine.map((i) => ({ id: i.id, url: i.url, published_at: i.published_at, at: new Date().toISOString(), likes: i.metrics.likes, comments: i.metrics.comments, shares: i.metrics.shares, first_line: i.title })));
    stats.mine = mine.length;
  }
  saveSources(reg);
  return stats;
}
