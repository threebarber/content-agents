import { getJson, htmlToText, extractLinks } from "../lib/http.js";
import type { Source } from "../../schemas/source.js";
import type { Item } from "../../schemas/item.js";

type SubstackPost = {
  id: number;
  title: string;
  subtitle?: string;
  slug: string;
  canonical_url: string;
  post_date: string;
  audience: string; // everyone | only_paid | founding
  reactions?: Record<string, number>;
  comment_count?: number;
  restacks?: number;
  wordcount?: number;
  body_html?: string;
  postTags?: { name: string }[];
  publishedBylines?: { name: string }[];
  type?: string;
};

export type PullOpts = { sinceISO?: string; max?: number; sort?: "new" | "top" };

/** Pull posts from a Substack publication via the public JSON API. */
export async function pullSubstack(source: Source, opts: PullOpts = {}): Promise<Item[]> {
  if (!source.url) throw new Error(`no url for ${source.id}`);
  const home = source.url.replace(/\/+$/, "");
  const max = opts.max ?? 400;
  const since = opts.sinceISO ? new Date(opts.sinceISO).getTime() : 0;
  const out: Item[] = [];
  const pageSize = Math.min(50, max);
  const fetchedAt = new Date().toISOString();

  for (let offset = 0; out.length < max; offset += pageSize) {
    const path =
      opts.sort === "top"
        ? `${home}/api/v1/archive?sort=top&limit=${pageSize}&offset=${offset}`
        : `${home}/api/v1/posts?limit=${pageSize}&offset=${offset}`;
    const page = await getJson<SubstackPost[]>(path);
    if (!Array.isArray(page) || page.length === 0) break;
    let stop = false;
    for (const p of page) {
      const ts = new Date(p.post_date).getTime();
      if (since && ts < since && opts.sort !== "top") {
        stop = true;
        break;
      }
      out.push(toItem(source, p, fetchedAt));
      if (out.length >= max) break;
    }
    if (stop || page.length < pageSize) break;
  }
  return out;
}

export function toItem(source: Source, p: SubstackPost, fetchedAt: string): Item {
  const body = p.body_html ?? "";
  const { text, truncated } = htmlToText(body);
  const likes = p.reactions ? Object.values(p.reactions).reduce((a, b) => a + b, 0) : null;
  const host = new URL(source.url!).host.replace(/^www\./, "");
  const outbound = extractLinks(body).filter((l) => {
    try {
      const h = new URL(l).host.replace(/^www\./, "");
      return h !== host && !/substackcdn|substack\.com\/(redirect|app-link|subscribe)|twitter|x\.com|linkedin|youtube|wikipedia|amazon|google/.test(l) && (h.endsWith("substack.com") || /\/p\//.test(l));
    } catch {
      return false;
    }
  });
  return {
    id: `substack:${host}:${p.id}`,
    source_id: source.id,
    type: "substack",
    url: p.canonical_url,
    title: p.title ?? null,
    author: p.publishedBylines?.[0]?.name ?? source.author ?? null,
    published_at: new Date(p.post_date).toISOString(),
    text: (p.subtitle ? p.subtitle + "\n\n" : "") + text,
    text_truncated: truncated,
    metrics: {
      likes,
      comments: p.comment_count ?? null,
      shares: p.restacks ?? null,
      wordcount: p.wordcount ?? null,
    },
    tags: (p.postTags ?? []).map((t) => t.name),
    paywalled: p.audience !== "everyone",
    outbound_links: outbound,
    fetched_at: fetchedAt,
  };
}
