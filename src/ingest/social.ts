import { runActor } from "../lib/apify.js";
import type { Item } from "../../schemas/item.js";

const LI_SEARCH = "harvestapi/linkedin-post-search";
const LI_PROFILE = "harvestapi/linkedin-profile-posts";
const X_SCRAPER = "apidojo/tweet-scraper";

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
  author?: { userName?: string; name?: string; url?: string; followers?: number };
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
  const handle = (t.author?.userName ?? "unknown").toLowerCase();
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
    author_url: `https://x.com/${t.author?.userName ?? handle}`,
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

export async function searchX(terms: { id: string; term: string }[], perTerm: number, minLikes: number, sinceDays = 14): Promise<Item[]> {
  const out: Item[] = [];
  const start = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
  for (const t of terms) {
    const raw = await runActor<Tweet>(X_SCRAPER, { searchTerms: [t.term], maxItems: perTerm, sort: "Top", tweetLanguage: "en", minimumFavorites: minLikes, start });
    for (const tw of raw) {
      const it = xItem(tw, `term:${t.id}`);
      if (it) out.push(it);
    }
  }
  return out;
}

export async function xHandlePosts(handles: string[], perHandle: number, sinceDays = 14): Promise<Item[]> {
  if (!handles.length) return [];
  const start = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
  const raw = await runActor<Tweet>(X_SCRAPER, { twitterHandles: handles, maxItems: perHandle * handles.length, sort: "Latest", start });
  return raw.flatMap((t) => xItem(t) ?? []);
}

/** A single LinkedIn post by URL (the profile-posts actor accepts post URLs). */
export async function linkedInPostByUrl(url: string): Promise<Item | null> {
  const raw = await runActor<LiPost>(LI_PROFILE, { targetUrls: [url], maxPosts: 1 });
  return raw.map((p) => liItem(p)).find((i): i is Item => !!i) ?? null;
}

/** A single tweet by URL. */
export async function xPostByUrl(url: string): Promise<Item | null> {
  const raw = await runActor<Tweet>(X_SCRAPER, { startUrls: [url], maxItems: 1 });
  return raw[0] ? xItem(raw[0], undefined, false) : null; // explicitly saved: skip the spam/reply filters
}
