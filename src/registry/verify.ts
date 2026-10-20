import { getJson, getText } from "../lib/http.js";
import type { Source } from "../../schemas/source.js";

export type Verification = { ok: boolean; title: string | null; byline: string | null; reason: string };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter((t) => t.length > 2 && !["the", "and", "newsletter", "substack"].includes(t));

/** Does a resolved substack actually belong to the expected name/author? */
export async function verifySubstack(s: Source): Promise<Verification> {
  if (!s.url) return { ok: false, title: null, byline: null, reason: "no url" };
  let title: string | null = null;
  let byline: string | null = null;
  try {
    const html = (await getText(s.url)).text;
    title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.replace(/\s*\|\s*Substack.*$/i, "").trim() ?? null;
    const og = html.match(/property="og:site_name" content="([^"]*)"/)?.[1];
    if (og) title = og;
  } catch {}
  try {
    const posts = await getJson<{ publishedBylines?: { name: string }[] }[]>(`${s.url}/api/v1/posts?limit=3`);
    byline = posts.find((p) => p.publishedBylines?.[0]?.name)?.publishedBylines?.[0]?.name ?? null;
  } catch {}
  const expectName = tokens(s.name ?? "");
  const expectAuthor = tokens(s.author ?? "");
  const gotTitle = title ? norm(title) : "";
  const gotByline = byline ? norm(byline) : "";
  const allIn = (toks: string[], hay: string) => toks.length > 0 && toks.every((t) => hay.includes(t));
  // strict: full author in byline/title, or a multi-word name fully in the title,
  // or a single-word name that leads the title with no contradicting byline
  const authorHit = allIn(expectAuthor, gotByline) || allIn(expectAuthor, gotTitle);
  const nameHit = expectName.length >= 2 ? allIn(expectName, gotTitle) : expectName.length === 1 && gotTitle.startsWith(expectName[0]) && (!gotByline || expectAuthor.some((t) => gotByline.includes(t)) || gotByline.includes(expectName[0]));
  const ok = authorHit || nameHit;
  return { ok, title, byline, reason: ok ? (nameHit && authorHit ? "name+author" : nameHit ? "name" : "author") : "no match" };
}
