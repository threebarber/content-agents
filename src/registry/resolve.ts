import { getJson, getText } from "../lib/http.js";
import type { Source } from "../../schemas/source.js";
import { slugify } from "./store.js";

export type Resolution = { url: string; method: string } | null;

async function isSubstackApi(home: string): Promise<boolean> {
  try {
    const posts = await getJson<unknown[]>(`${home}/api/v1/posts?limit=1`);
    return Array.isArray(posts);
  } catch {
    return false;
  }
}
async function hasRss(home: string): Promise<boolean> {
  try {
    const r = await getText(`${home}/feed`);
    return r.status === 200 && /<rss|<feed/i.test(r.text.slice(0, 2000));
  } catch {
    return false;
  }
}

/** Candidate substack slugs from a publication name and author. */
export function slugGuesses(name?: string, author?: string): string[] {
  const out = new Set<string>();
  const clean = (s: string) => slugify(s).replace(/-/g, "");
  if (name) {
    const n = name.replace(/^(the|a)\s+/i, "").replace(/'s\s+(substack|newsletter)$/i, "").replace(/\s+(substack|newsletter)$/i, "");
    out.add(clean(n));
    out.add(clean(name));
    out.add(slugify(n));
  }
  if (author) {
    const parts = author.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
    if (parts.length) {
      out.add(parts.join(""));
      out.add(parts[parts.length - 1]);
      out.add(parts[0]);
      if (parts.length >= 2) out.add(parts[0][0] + parts[parts.length - 1]);
      out.add(parts.join("-"));
    }
  }
  return [...out].filter((s) => s.length >= 3 && s.length <= 40);
}

/** Resolve a source to a fetchable URL + method. Probes the given url first, then slug guesses. */
/** substack.com/@handle → that person's primary publication home (via Substack's public profile API). */
export async function substackHandleHome(handle: string): Promise<string | null> {
  try {
    const p = await getJson<{ primaryPublication?: { subdomain?: string; custom_domain?: string | null }; publicationUsers?: { publication: { subdomain: string; custom_domain: string | null } }[] }>(`https://substack.com/api/v1/user/${handle}/public_profile`);
    const pub = p.primaryPublication?.subdomain ? p.primaryPublication : p.publicationUsers?.[0]?.publication;
    if (!pub?.subdomain) return null;
    return pub.custom_domain ? `https://${pub.custom_domain}` : `https://${pub.subdomain}.substack.com`;
  } catch {
    return null;
  }
}

export async function resolveSource(s: Source): Promise<Resolution> {
  const handle = s.url?.match(/^https:\/\/substack\.com\/@([^/]+)$/)?.[1];
  if (handle) {
    const home = await substackHandleHome(handle);
    if (home && (await isSubstackApi(home))) return { url: home, method: "substack_api" };
  }
  const probes: string[] = [];
  if (s.url) probes.push(s.url.replace(/\/+$/, ""));
  if (s.type === "substack" || s.type === "rss") for (const g of slugGuesses(s.name, s.author)) probes.push(`https://${g}.substack.com`);
  for (const home of probes) {
    if (await isSubstackApi(home)) return { url: home, method: "substack_api" };
  }
  for (const home of probes.slice(0, 1)) {
    if (await hasRss(home)) return { url: home, method: "rss" };
  }
  return null;
}
