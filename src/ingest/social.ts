import { runActor } from "../lib/apify.js";
import type { Item } from "../../schemas/item.js";

const LI_SEARCH = "harvestapi/linkedin-post-search";
const LI_PROFILE = "harvestapi/linkedin-profile-posts";
// apidojo/tweet-scraper caps runs per month on Apify's free plan (and then silently returns {noResults:true});
// xquik takes several search terms in one run and has no per-user run cap.
const X_SCRAPER = "xquik/x-tweet-scraper";

type LiPost = {
  id: string; linkedinUrl: string; content?: string;
  author?: { name?: string; publicIdentifier?: string; linkedinUrl?: string; info?: string };
  postedAt?: { date?: string };
  engagement?: { likes?: number; comments?: number; shares?: number };
  repostedBy?: unknown; type?: string;
};
type Tweet = {
  id: string; url: string; text?: string; fullText?: string; createdAt?: string; lang?: string;
  likeCount?: number; replyCount?: number; retweetCount?: number; quoteCount?: number; viewCount?: number; bookmarkCount?: number;
  isReply?: boolean; isRetweet?: boolean;
  author?: { userName?: string; username?: string; name?: string; url?: string; followers?: number };
  noResults?: boolean;
  entities?: { urls?: { expanded_url?: string }[] };
};

export const liProfileUrl = (u?: string) => (u ? u.split("?")[0].replace(/\/+$/, "") + "/" : undefined);
const firstLine = (t: string) => t.split("\n").find((l) => l.trim())?.trim().slice(0, 140) ?? null;

function liItem(p: LiPost, foundVia?: string): Item | null {
  const text = (p.content ?? "").trim();
  if (!text || !p.postedAt?.date) return null;
  const handle = (p.author?.publicIdentifier ?? "unknown").toLowerCase();
  return {
    id: `linkedin:${p.id}`,
    source_id: `linkedin:${handle}`,
    type: "linkedin",
    url: p.linkedinUrl,
    title: firstLine(text),
    author: p.author?.name ?? null,
    published_at: new Date(p.postedAt.date).toISOString(),
    text: text.slice(0, 15000),
    text_truncated: text.length > 15000,
    metrics: { likes: p.engagement?.likes ?? null, comments: p.engagement?.comments ?? null, shares: p.engagement?.shares ?? null, wordcount: text.split(/\s+/).length },
    tags: [],
    paywalled: false,
    outbound_links: [],
    fetched_at: new Date().toISOString(),
    author_url: liProfileUrl(p.author?.linkedinUrl ?? (handle !== "unknown" ? `https://www.linkedin.com/in/${handle}` : undefined)),
    ...(foundVia ? { found_via: foundVia } : {}),
  };
}

/** Engagement-bait and spam patterns that dominate X search results. */
const X_SPAM = /looking to engage with|follow (me|back)|drop your|let'?s connect|giveaway|airdrop|we'?re hiring|dm me for/i;

function xItem(t: Tweet, foundVia?: string, strict = true): Item | null {
  const text = (t.fullText ?? t.text ?? "").trim();
  if (!text || !t.createdAt) return null;
  if (strict && (t.isRetweet || t.isReply || X_SPAM.test(text))) return null;
  const user = t.author?.userName ?? t.author?.username;
  const handle = (user ?? "unknown").toLowerCase();
  return {
    id: `x:${t.id}`,
    source_id: `x:${handle}`,
    type: "x",
    url: t.url,
    title: firstLine(text),
    author: t.author?.name ?? handle,
    published_at: new Date(t.createdAt).toISOString(),
    text,
    text_truncated: false,
    metrics: { likes: t.likeCount ?? null, comments: t.replyCount ?? null, shares: (t.retweetCount ?? 0) + (t.quoteCount ?? 0), wordcount: text.split(/\s+/).length, views: t.viewCount ?? null },
    tags: [],
    paywalled: false,
    outbound_links: (t.entities?.urls ?? []).map((u) => u.expanded_url).filter((u): u is string => !!u),
    fetched_at: new Date().toISOString(),
    author_url: `https://x.com/${user ?? handle}`,
    ...(foundVia ? { found_via: foundVia } : {}),
  };
}

/** One actor run for all terms; items tagged with the term that found them. */
export async function searchLinkedIn(terms: { id: string; term: string }[], perTerm: number): Promise<Item[]> {
  if (!terms.length) return [];
  const raw = await runActor<LiPost & { query?: { search?: string } }>(LI_SEARCH, { searchQueries: terms.map((t) => t.term), maxPosts: perTerm, postedLimit: "week", sortBy: "relevance" });
  return raw.flatMap((p) => {
    const t = terms.find((x) => x.term.toLowerCase() === (p.query?.search ?? "").toLowerCase());
    const it = liItem(p, t ? `term:${t.id}` : undefined);
    return it ? [it] : [];
  });
}

export async function linkedInProfilePosts(profileUrls: string[], perProfile: number, postedLimit: "week" | "month" | "24h" = "week"): Promise<Item[]> {
  if (!profileUrls.length) return [];
  const raw = await runActor<LiPost>(LI_PROFILE, { targetUrls: profileUrls, maxPosts: perProfile, postedLimit, includeReposts: false, includeQuotePosts: true });
  return raw.flatMap((p) => (p.type && p.type !== "post" ? [] : liItem(p) ?? []));
}

/** Apify actors report failures (run caps, blocks) as a single {noResults:true} item: surface that as an error. */
function assertResults<T extends { noResults?: boolean }>(raw: T[], label: string): T[] {
  if (raw.length && raw.every((r) => r.noResults)) throw new Error(`${label}: actor returned noResults (run limit or block?)`);
  return raw.filter((r) => !r.noResults);
}

/** All terms in one run; the date and likes filters live in the query itself. Each tweet is credited to the term it matches. */
export async function searchX(terms: { id: string; term: string }[], perTerm: number, minLikes: number, sinceDays = 14): Promise<Item[]> {
  if (!terms.length) return [];
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
  const raw = assertResults(
    await runActor<Tweet>(X_SCRAPER, {
      searchTerms: terms.map((t) => `${t.term} min_faves:${minLikes} lang:en -filter:replies since:${since}`),
      maxItems: perTerm * terms.length,
      maxItemsPerTarget: perTerm,
      queryType: "Top",
    }),
    "x search",
  );
  const words = terms.map((t) => ({ ...t, words: t.term.toLowerCase().split(/\s+/) }));
  return raw.flatMap((tw) => {
    const text = (tw.fullText ?? tw.text ?? "").toLowerCase();
    const match = words.find((t) => t.words.every((w) => text.includes(w))) ?? words.find((t) => t.words.some((w) => text.includes(w)));
    const it = xItem(tw, match ? `term:${match.id}` : undefined);
    return it ? [it] : [];
  });
}

export async function xHandlePosts(handles: string[], perHandle: number, sinceDays = 14): Promise<Item[]> {
  if (!handles.length) return [];
  const since = Date.now() - sinceDays * 86400000;
  const raw = assertResults(await runActor<Tweet>(X_SCRAPER, { twitterHandles: handles, maxItems: perHandle * handles.length, maxItemsPerTarget: perHandle, queryType: "Latest" }), "x creators");
  return raw.flatMap((t) => (t.createdAt && new Date(t.createdAt).getTime() >= since ? xItem(t) ?? [] : []));
}

/** A single LinkedIn post by URL (the profile-posts actor accepts post URLs). */
export async function linkedInPostByUrl(url: string): Promise<Item | null> {
  const raw = await runActor<LiPost>(LI_PROFILE, { targetUrls: [url], maxPosts: 1 });
  return raw.map((p) => liItem(p)).find((i): i is Item => !!i) ?? null;
}

/** A single tweet by URL. */
export async function xPostByUrl(url: string): Promise<Item | null> {
  const id = url.match(/status\/(\d+)/)?.[1];
  const raw = await runActor<Tweet>(X_SCRAPER, id ? { tweetIds: [id], maxItems: 1 } : { startUrls: [url], maxItems: 1 });
  return raw[0] ? xItem(raw[0], undefined, false) : null; // explicitly saved: skip the spam/reply filters
}
