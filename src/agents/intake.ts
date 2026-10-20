import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { detect } from "../registry/detect.js";
import { resolveSource } from "../registry/resolve.js";
import { loadSources, saveSources, loadForaging, findSource, slugify, today } from "../registry/store.js";
import { hit } from "../registry/pheromone.js";
import { Source } from "../../schemas/source.js";
import type { Item } from "../../schemas/item.js";
import { getJson, getText, htmlToText } from "../lib/http.js";
import { toItem } from "../ingest/substack.js";
import { linkedInPostByUrl, xPostByUrl } from "../ingest/social.js";
import { writeItems } from "../lib/jsonl.js";
import { distill } from "./distill.js";
import { ideateFromSaved } from "./ideate.js";
import { claude, MODELS } from "./llm.js";
import { postMessage, sections } from "../lib/slack.js";

export type IntakePayload = { text: string; urls: string[]; files: { url: string; mimetype: string; name?: string }[]; channel: string; ts: string; user?: string };

const Shot = z.object({
  platform: z.string().describe("linkedin, x, substack, or other"),
  author: z.string().nullable(),
  text: z.string().describe("The post text exactly as visible."),
  likes: z.number().nullable(),
  comments: z.number().nullable(),
});

async function fetchPost(url: string): Promise<Item | null> {
  const d = detect(url);
  const now = new Date().toISOString();
  if (d?.type === "substack" && d.kind === "post") {
    const u = new URL(url);
    const slug = u.pathname.split("/p/")[1]?.split("/")[0];
    const home = `https://${u.host}`;
    const reg = loadSources();
    const src = findSource(reg, home) ?? Source.parse({ id: `substack:${slugify(u.host.replace(/\.substack\.com$/, ""))}`, type: "substack", url: home, added_at: today() });
    const post = await getJson<Parameters<typeof toItem>[1]>(`${home}/api/v1/posts/${slug}`);
    return toItem(src, post, now);
  }
  if (d?.type === "linkedin" && d.kind === "post") return linkedInPostByUrl(url);
  if (d?.type === "x" && d.kind === "post") return xPostByUrl(url);
  const page = await getText(url);
  if (page.status >= 400) return null;
  const title = page.text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null;
  const { text, truncated } = htmlToText(page.text);
  const host = new URL(page.finalUrl).host.replace(/^www\./, "");
  return { id: `web:${slugify(page.finalUrl).slice(0, 120)}`, source_id: `web:${host}`, type: "rss", url: page.finalUrl, title, author: host, published_at: now, text, text_truncated: truncated, metrics: { likes: null, comments: null, shares: null, wordcount: text.split(/\s+/).length }, tags: [], paywalled: false, outbound_links: [], fetched_at: now };
}

async function readScreenshot(f: { url: string; mimetype: string }): Promise<Item | null> {
  const res = await fetch(f.url, { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
  if (!res.ok) return null;
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  const media = (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(f.mimetype) ? f.mimetype : "image/png") as "image/png";
  const r = await claude().messages.parse({
    model: MODELS.distill,
    max_tokens: 3000,
    output_config: { format: zodOutputFormat(Shot) },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: media, data } },
      { type: "text", text: "This is a screenshot of a social post. Extract the platform, author, the full visible post text, and likes/comments counts if visible." },
    ] }],
  });
  const s = r.parsed_output;
  if (!s?.text) return null;
  const now = new Date().toISOString();
  const handle = slugify(s.author ?? "unknown");
  const type = s.platform === "linkedin" || s.platform === "x" ? s.platform : "rss";
  return { id: `shot:${Date.now()}-${handle}`, source_id: `${type === "rss" ? "web" : type}:${handle}`, type, url: f.url, title: s.text.split("\n")[0].slice(0, 140), author: s.author, published_at: now, text: s.text, text_truncated: false, metrics: { likes: s.likes, comments: s.comments, shares: null, wordcount: s.text.split(/\s+/).length }, tags: ["screenshot"], paywalled: false, outbound_links: [], fetched_at: now };
}

/** A link or screenshot the owner dropped in Slack: save it as content, credit its author strongly, riff on it. */
export async function intake(p: IntakePayload, log: (m: string) => void = () => {}): Promise<{ saved: string[]; sourcesAdded: string[]; cards: number; usd: number }> {
  const note = p.text.replace(/<https?:[^>]+>/g, "").trim();
  const reg = loadSources();
  const fo = loadForaging();
  const saved: Item[] = [];
  const sourcesAdded: string[] = [];
  const thread = { channel: p.channel, ts: p.ts };

  for (const url of p.urls) {
    const d = detect(url);
    if (d && d.kind === "source") {
      // a publication / profile link: follow it as a candidate
      const s = Source.parse({ id: `${d.type}:${slugify(d.key)}`, type: d.type, url: d.url, status: "candidate", added_by: "human", added_at: today(), discovered_via: "human:slack", budget_tier: d.type === "substack" ? "cheap" : "normal" });
      if (!findSource(reg, s.id) && !findSource(reg, d.url)) {
        const r = await resolveSource(s).catch(() => null);
        if (r) Object.assign(s, { url: r.url, method: r.method });
        reg.sources.push(s);
        sourcesAdded.push(s.id);
      }
      continue;
    }
    try {
      const it = await fetchPost(url);
      if (it) saved.push(it);
      else log(`could not fetch ${url}`);
    } catch (e) {
      log(`fetch failed ${url}: ${(e as Error).message}`);
    }
  }
  for (const f of p.files) {
    const it = await readScreenshot(f).catch((e) => (log(`screenshot failed: ${e.message}`), null));
    if (it) saved.push(it);
  }

  // save as content + strongest pheromone signal on the author (a manual save beats any automatic hit)
  for (const it of saved) {
    it.saved_by = "human";
    if (note) it.note = note;
    it.found_via = "saved:slack";
    let s = findSource(reg, it.source_id);
    if (!s && ["linkedin", "x", "substack"].includes(it.type) && !it.source_id.endsWith(":unknown")) {
      s = Source.parse({ id: it.source_id, type: it.type, name: it.author ?? undefined, author: it.author ?? undefined, url: it.author_url ?? null, status: "candidate", added_by: "human", added_at: today(), discovered_via: `saved:${it.id}` });
      reg.sources.push(s);
      sourcesAdded.push(s.id);
    }
    if (s) hit(s, fo.hit_rules.manual_save_bonus);
  }
  writeItems(saved);
  saveSources(reg);
  let usd = 0;
  if (saved.length) usd += (await distill({ limit: 50, log })).usd;

  let cards = 0;
  if (saved.length) {
    const r = await ideateFromSaved(saved, note, thread);
    usd += r.usd;
    cards = r.files.length;
  }
  const parts = [
    saved.length ? `Saved ${saved.length} post${saved.length > 1 ? "s" : ""} to the swipe file${cards ? `, ${cards} ideas below` : ""}.` : "",
    sourcesAdded.length ? `Now following (as candidates): ${sourcesAdded.map((s) => `\`${s}\``).join(", ")}.` : "",
    !saved.length && !sourcesAdded.length ? "Couldn't read that link. Try a direct post URL or a screenshot." : "",
  ].filter(Boolean);
  if (!cards) await postMessage(p.channel, parts.join(" "), sections(parts.join(" ")), p.ts).catch(() => {});
  return { saved: saved.map((s) => s.id), sourcesAdded, cards, usd };
}
