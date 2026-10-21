import { loadTerms, saveTerms, loadSources, saveSources, findTerm, findExisting, slugify, today } from "../registry/store.js";
import { detect } from "../registry/detect.js";
import { expandUrl } from "../lib/http.js";
import { resolveSource } from "../registry/resolve.js";
import { Term } from "../../schemas/term.js";
import { Source } from "../../schemas/source.js";
import { ideate } from "./ideate.js";
import { health, formatHealth } from "./health.js";

export function pinTerm(term: string, x = true): string {
  const f = loadTerms();
  let t = findTerm(f, term);
  if (!t) {
    t = Term.parse({ id: `term:${slugify(term)}`, term: term.toLowerCase(), kind: "topic", status: "active", added_by: "human", added_at: today(), discovered_via: "human pin" });
    f.terms.push(t);
  }
  t.pinned = true;
  t.status = "active";
  t.used_for = [...new Set([...t.used_for, "tagging", "candidate_relevance", "linkedin_search", ...(x ? ["x_search"] : [])])] as typeof t.used_for;
  saveTerms(f);
  return `📌 Pinned *${t.term}*. It's searched on LinkedIn${x ? " and X" : ""} every run.`;
}

export function unpinTerm(term: string): string {
  const f = loadTerms();
  const t = findTerm(f, term);
  if (!t) return `No term "${term}".`;
  t.pinned = false;
  saveTerms(f);
  return `Unpinned *${t.term}*. The weekly re-derive will decide whether to keep searching it.`;
}

export function termsReport(): string {
  const ts = loadTerms().terms.filter((t) => t.used_for.some((u) => u.endsWith("_search")));
  const rows = ts.map((t) => {
    const n = t.pheromone.hits + t.pheromone.misses;
    const where = [t.used_for.includes("linkedin_search") ? "LI" : "", t.used_for.includes("x_search") ? "X" : ""].filter(Boolean).join("+");
    return `${t.pinned ? "📌" : "•"} *${t.term}* (${where}) — ${n ? `${Math.round((100 * t.pheromone.hits) / n)}% strong of ${n.toFixed(0)}` : "not searched yet"}`;
  });
  return `*Searched terms (${ts.length})*\n${rows.join("\n")}`;
}

export async function addSource(input: string): Promise<string> {
  const url = await expandUrl(input);
  const d = detect(url);
  if (!d) return `Couldn't recognize ${url}.`;
  if (d.kind === "post") return "That's a single post: paste it in the channel instead and I'll riff on it.";
  const reg = loadSources();
  const id = `${d.type}:${slugify(d.key)}`;
  const existing = await findExisting(reg, id, d.url);
  if (existing) return `Already following \`${existing.id}\`${existing.status !== "active" ? ` (${existing.status})` : ""}.`;
  const s = Source.parse({ id, type: d.type, url: d.url, status: "active", added_by: "human", added_at: today(), discovered_via: "human:/ca", budget_tier: d.type === "substack" ? "cheap" : "normal" });
  const r = await resolveSource(s).catch(() => null);
  if (r) Object.assign(s, { url: r.url, method: r.method });
  reg.sources.push(s);
  saveSources(reg);
  return `Following \`${id}\`. Its posts are pulled from the next run on.`;
}

export async function runSlash(text: string): Promise<{ reply: string; public?: boolean }> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ").replace(/^["“]|["”]$/g, "").trim();
  switch (cmd?.toLowerCase()) {
    case "pin": return { reply: arg ? pinTerm(arg) : "Usage: `/ca pin <term>`" };
    case "unpin": return { reply: arg ? unpinTerm(arg) : "Usage: `/ca unpin <term>`" };
    case "terms": return { reply: termsReport() };
    case "source": case "follow": return { reply: arg ? await addSource(arg.replace(/^<|>$/g, "").split("|")[0]) : "Usage: `/ca source <url>`" };
    case "ideate": {
      const r = await ideate({});
      return { reply: `Posted ${r.files.length} new idea cards.` };
    }
    case "health": return { reply: formatHealth(await health(), true) };
    default: return { reply: `Unknown command \`${cmd}\`. Try \`/ca help\`.` };
  }
}
