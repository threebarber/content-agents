import { getText, htmlToText } from "../lib/http.js";
import type { Source } from "../../schemas/source.js";
import type { Item } from "../../schemas/item.js";

/**
 * Newsletters off Substack (beehiiv, Ghost, custom sites): read /sitemap.xml, keep post URLs (/p/ by default)
 * changed in the window, then read each page's title, publish date, and text. No engagement numbers exist here.
 */
export async function pullSitemap(source: Source, opts: { sinceISO?: string; max?: number; postPath?: RegExp } = {}): Promise<Item[]> {
  if (!source.url) throw new Error(`no url for ${source.id}`);
  const home = source.url.replace(/\/+$/, "");
  const since = opts.sinceISO ? new Date(opts.sinceISO).getTime() : 0;
  const sm = await getText(`${home}/sitemap.xml`);
  if (sm.status >= 400) throw new Error(`sitemap ${sm.status}`);
  const entries = [...sm.text.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)]
    .map((m) => ({ loc: m[1], lastmod: m[2] ? new Date(m[2]).getTime() : 0 }))
    .filter((e) => (opts.postPath ?? /\/p\//).test(e.loc) && (!since || e.lastmod >= since))
    .sort((a, b) => b.lastmod - a.lastmod)
    .slice(0, opts.max ?? 20);
  const host = new URL(home).host.replace(/^www\./, "");
  const out: Item[] = [];
  for (const e of entries) {
    const page = await getText(e.loc);
    if (page.status >= 400) continue;
    const meta = (k: string) => page.text.match(new RegExp(`(?:property|name)="${k}" content="([^"]*)"`))?.[1]?.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    const published = meta("article:published_time") ?? (e.lastmod ? new Date(e.lastmod).toISOString() : null);
    if (!published || (since && new Date(published).getTime() < since)) continue;
    const body = page.text.match(/<article[\s\S]*<\/article>/i)?.[0] ?? page.text;
    const { text, truncated } = htmlToText(body);
    const slug = new URL(e.loc).pathname.split("/").filter(Boolean).pop() ?? e.loc;
    out.push({
      id: `web:${host}:${slug}`,
      source_id: source.id,
      type: "rss",
      url: e.loc,
      title: meta("og:title") ?? null,
      author: source.author ?? null,
      published_at: new Date(published).toISOString(),
      text: (meta("og:description") ? `${meta("og:description")}\n\n` : "") + text,
      text_truncated: truncated,
      metrics: { likes: null, comments: null, shares: null, wordcount: text.split(/\s+/).length },
      tags: [],
      paywalled: false,
      outbound_links: [],
      fetched_at: new Date().toISOString(),
    });
  }
  return out;
}
