import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { statePath } from "../lib/paths.js";
import type { CardDraft, CardMeta } from "../../schemas/card.js";

export type Card = { meta: CardMeta; body: string; file: string };
export const QUEUES = ["inbox", "approved", "rejected", "drafted", "published", "saved"] as const;

export function cardBody(d: CardDraft): string {
  return [
    `# ${d.title}`,
    ``,
    `**Hook**`,
    ``,
    `> ${d.hook.replace(/\n/g, "\n> ")}`,
    ``,
    `**Angle:** ${d.angle}`,
    ``,
    `**Outline**`,
    ...d.outline.map((b) => `- ${b}`),
    ``,
    `**Why now:** ${d.why_now}`,
    d.hook_template_used ? `\n**Template:** ${d.hook_template_used}` : "",
    ``,
    `---`,
    `_To decide: set \`verdict:\` above to approve, reject, or rewrite (optionally add a one-line \`why:\`), then commit._`,
  ].join("\n");
}

export function writeCard(queue: (typeof QUEUES)[number], meta: CardMeta, body: string): string {
  const file = statePath("queue", queue, `${meta.id}.md`);
  fs.writeFileSync(file, `---\n${YAML.stringify(meta, { lineWidth: 0 })}---\n\n${body}\n`);
  return file;
}

export function readCard(file: string): Card {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`no frontmatter in ${file}`);
  return { meta: YAML.parse(m[1]) as CardMeta, body: m[2].trim(), file };
}

export function listCards(queue: (typeof QUEUES)[number]): Card[] {
  const dir = statePath("queue", queue, ".keep");
  const d = path.dirname(dir);
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readCard(path.join(d, f)));
}

export function moveCard(card: Card, to: (typeof QUEUES)[number]): string {
  const dest = writeCard(to, card.meta, card.body);
  if (path.resolve(dest) !== path.resolve(card.file)) fs.unlinkSync(card.file);
  return dest;
}

/** Card id from date + title; a numeric suffix keeps two same-titled cards from overwriting each other. */
export function cardId(title: string, date = new Date()): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const base = `${date.toISOString().slice(0, 10)}-${slug}`;
  const taken = (id: string) => QUEUES.some((q) => fs.existsSync(statePath("queue", q, `${id}.md`)));
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/** Title / hook / angle / template from the card's structured content; markdown parsing only for older cards. */
export function cardContent(card: Card): { title: string; hook: string; angle: string; template: string } {
  const c = card.meta.content;
  if (c) return { title: c.title, hook: c.hook, angle: c.angle, template: c.hook_template_used ?? "" };
  const b = card.body;
  return {
    title: b.match(/^# (.+)$/m)?.[1] ?? "(untitled)",
    hook: (b.match(/\*\*Hook\*\*\n\n((?:> .*\n?)+)/)?.[1] ?? "").replace(/^> ?/gm, "").trim(),
    angle: b.match(/\*\*Angle:\*\* (.+)/)?.[1] ?? "",
    template: b.match(/\*\*Template:\*\* (.+)/)?.[1] ?? "",
  };
}

export function repoUrl(file: string): string | null {
  const repo = process.env.STATE_REPO;
  if (!repo) return null;
  const rel = file.split(`${path.sep}queue${path.sep}`)[1];
  return rel ? `https://github.com/${repo}/blob/main/queue/${rel}` : null;
}
