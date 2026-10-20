import fs from "node:fs";
import YAML from "yaml";
import { statePath } from "../lib/paths.js";
import { SourcesFile, type Source } from "../../schemas/source.js";
import { TermsFile, type Term } from "../../schemas/term.js";
import { Foraging } from "../../schemas/foraging.js";
import { Budget } from "../../schemas/budget.js";

const SOURCES_HEADER = `# Source registry — schema: schemas/source.ts (public repo). Edited by humans and by the foraging loop (PLAN.md §4).
# status: candidate | trial | active | paused | retired
# discovered_via: seed | link:<item> | mention:<item> | recommendation:<src> | comment:<item> | term:<term> | human
# method (filled by resolver): substack_api | rss | apify:<actor>
`;
const TERMS_HEADER = `# Term registry — schema: schemas/term.ts. kind: topic | hashtag | x_query | person_query
# used_for: tagging | x_search | web_search | candidate_relevance
`;

function readYaml<T>(file: string, schema: { parse: (x: unknown) => T }, fallback: unknown): T {
  const raw = fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, "utf8")) : fallback;
  return schema.parse(raw ?? fallback);
}
function writeYaml(file: string, header: string, data: unknown): void {
  fs.writeFileSync(file, header + YAML.stringify(data, { lineWidth: 0 }));
}

export function loadSources(): SourcesFile {
  return readYaml(statePath("config", "sources.yaml"), SourcesFile, { sources: [] });
}
export function saveSources(f: SourcesFile): void {
  writeYaml(statePath("config", "sources.yaml"), SOURCES_HEADER, f);
}
export function loadTerms(): TermsFile {
  return readYaml(statePath("config", "terms.yaml"), TermsFile, { terms: [] });
}
export function saveTerms(f: TermsFile): void {
  writeYaml(statePath("config", "terms.yaml"), TERMS_HEADER, f);
}
export function loadForaging() {
  return readYaml(statePath("config", "foraging.yaml"), Foraging, {});
}
export function loadBudget() {
  return readYaml(statePath("config", "budget.yaml"), Budget, {});
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u.startsWith("http") ? u : `https://${u}`);
    url.hash = "";
    url.search = "";
    let host = url.host.toLowerCase().replace(/^www\./, "");
    let p = url.pathname.replace(/\/+$/, "");
    return `https://${host}${p}`;
  } catch {
    return u;
  }
}

export function findSource(f: SourcesFile, idOrUrl: string): Source | undefined {
  const n = normalizeUrl(idOrUrl);
  return f.sources.find((s) => s.id === idOrUrl || (s.url && normalizeUrl(s.url) === n));
}

export function upsertSource(f: SourcesFile, s: Source): { source: Source; created: boolean } {
  const existing = findSource(f, s.id) ?? (s.url ? findSource(f, s.url) : undefined);
  if (existing) {
    Object.assign(existing, { ...s, id: existing.id, pheromone: existing.pheromone, added_at: existing.added_at, added_by: existing.added_by, discovered_via: existing.discovered_via });
    return { source: existing, created: false };
  }
  f.sources.push(s);
  return { source: s, created: true };
}

export function findTerm(f: TermsFile, idOrTerm: string): Term | undefined {
  const t = idOrTerm.toLowerCase().trim();
  return f.terms.find((x) => x.id === idOrTerm || x.term.toLowerCase() === t);
}
