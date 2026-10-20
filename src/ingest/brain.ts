import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { z } from "zod";
import { statePath, codeDir } from "../lib/paths.js";
import { loadRedact, redact } from "./redact.js";
import type { Item } from "../../schemas/item.js";

const BrainConfig = z.object({
  repo: z.string(),
  include: z.array(
    z.object({
      glob: z.string(),
      kind: z.string(),
      sections: z.array(z.string()).default(["*"]),
      exclude_files: z.array(z.string()).default([]),
      line_filter: z.string().optional(),
    }),
  ),
  exclude: z.array(z.string()).default([]),
  lookback_days: z.number().default(7),
});
export type BrainConfig = z.infer<typeof BrainConfig>;

export function loadBrainConfig(): BrainConfig {
  return BrainConfig.parse(YAML.parse(fs.readFileSync(statePath("config", "brain.yaml"), "utf8")));
}

/**
 * Clone or update the brain repo into a local cache.
 * Token precedence: BRAIN_GITHUB_TOKEN (a separate read-only fine-grained PAT) → GITHUB_TOKEN → ambient git credentials.
 * GitHub fine-grained PATs apply one permission set to every repo they cover, so a read-only brain token
 * has to be a second token, not a second scope on the state token.
 */
export function syncBrain(repo: string, dir = path.join(codeDir(), ".brain-cache")): string {
  const token = process.env.BRAIN_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const url = token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
  if (fs.existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["-C", dir, "fetch", "--depth", "1", "origin"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "reset", "--hard", "origin/HEAD"], { stdio: "ignore" });
  } else {
    execFileSync("git", ["clone", "--depth", "1", "--quiet", url, dir], { stdio: "ignore" });
  }
  return dir;
}

function globToRe(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${re}$`);
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

/** Split markdown into {heading, body} sections by ## headings. Text before the first ## is heading "". */
export function sections(md: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let cur = { heading: "", body: "" };
  for (const line of md.split("\n")) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      if (cur.body.trim()) out.push(cur);
      cur = { heading: m[1].trim(), body: "" };
    } else cur.body += line + "\n";
  }
  if (cur.body.trim()) out.push(cur);
  return out;
}

function fileChangedWithin(dir: string, rel: string, days: number): boolean {
  try {
    const out = execFileSync("git", ["-C", dir, "log", "-1", "--format=%ct", "--", rel], { encoding: "utf8" }).trim();
    if (!out) return true; // shallow clone may lack history → include
    return Number(out) * 1000 >= Date.now() - days * 86400000;
  } catch {
    return true;
  }
}

export type BrainPullOpts = { all?: boolean; dir?: string };

/** Read allowed brain files, keep allowed sections, redact, emit Items of type "brain". */
export function pullBrain(cfg: BrainConfig, opts: BrainPullOpts = {}): { items: Item[]; dropped: number; files: number } {
  const dir = opts.dir ?? syncBrain(cfg.repo);
  const red = loadRedact();
  const excl = cfg.exclude.map(globToRe);
  const fetchedAt = new Date().toISOString();
  const items: Item[] = [];
  let dropped = 0;
  let files = 0;
  for (const rel of walk(dir)) {
    if (!rel.endsWith(".md")) continue;
    if (excl.some((re) => re.test(rel))) continue;
    const rule = cfg.include.find((r) => globToRe(r.glob).test(rel) && !r.exclude_files.includes(path.basename(rel)));
    if (!rule) continue;
    if (!opts.all && !fileChangedWithin(dir, rel, cfg.lookback_days)) continue;
    files++;
    const md = fs.readFileSync(path.join(dir, rel), "utf8");
    const secs = sections(md).filter((s) => rule.sections.includes("*") || rule.sections.some((w) => s.heading.toLowerCase().startsWith(w.toLowerCase())));
    for (const sec of secs) {
      let body = sec.body;
      if (rule.line_filter) body = body.split("\n").filter((l) => new RegExp(rule.line_filter!).test(l)).join("\n");
      body = body.replace(/<!--[\s\S]*?-->/g, "").trim();
      if (body.length < 40) continue;
      const r = redact(body, red);
      if (r.dropped) {
        dropped++;
        continue;
      }
      const stat = fs.statSync(path.join(dir, rel));
      const dateFromName = rel.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
      items.push({
        id: `brain:${rel.replace(/\.md$/, "")}#${sec.heading ? sec.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "top"}`,
        source_id: "brain",
        type: "rss", // schema placeholder; stored under data/items/brain/
        url: `brain://${rel}`,
        title: `${path.basename(rel, ".md")}${sec.heading ? " — " + sec.heading : ""}`,
        author: null,
        published_at: (dateFromName ? new Date(dateFromName) : stat.mtime).toISOString(),
        text: r.text.slice(0, 15_000),
        text_truncated: r.text.length > 15_000,
        metrics: { likes: null, comments: null, shares: null, wordcount: null },
        tags: [rule.kind],
        paywalled: false,
        outbound_links: [],
        fetched_at: fetchedAt,
      });
    }
  }
  return { items, dropped, files };
}
