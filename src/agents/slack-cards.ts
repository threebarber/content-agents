import fs from "node:fs";
import path from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { postMessage, updateMessage, sections } from "../lib/slack.js";
import { readCard, writeCard, repoUrl, type Card } from "./cards.js";
import { loadHooks } from "./distill.js";
import { claude, MODELS } from "./llm.js";
import { statePath } from "../lib/paths.js";
import type { Item } from "../../schemas/item.js";

type Block = Record<string, unknown>;

/** Pull title / hook / angle back out of a card body (the card file is the source of truth; Slack is a view). */
export function parseBody(body: string): { title: string; hook: string; angle: string; template: string } {
  const title = body.match(/^# (.+)$/m)?.[1] ?? "(untitled)";
  const hook = (body.match(/\*\*Hook\*\*\n\n((?:> .*\n?)+)/)?.[1] ?? "").replace(/^> ?/gm, "").trim();
  const angle = body.match(/\*\*Angle:\*\* (.+)/)?.[1] ?? "";
  const template = body.match(/\*\*Template:\*\* (.+)/)?.[1] ?? "";
  return { title, hook, angle, template };
}

const PLATFORM: Record<string, string> = {
  linkedin: "LinkedIn post · ~150–250 words",
  hashnode: "Hashnode article · ~1,200–2,000 words",
};
const FORMAT: Record<string, string> = {
  story: "Story: what happened, then what you learned",
  teardown: "Teardown: walk through a failure or system step by step",
  howto: "How-to: steps someone can copy",
  contrarian: "Contrarian: take a stance against the common view",
  list: "List: numbered takeaways",
  data: "Data: lead with the numbers",
  casestudy: "Case study: one real example, start to finish",
  "screenshotcommentary": "Screenshot + take: quote one post, add your view",
  question: "Question: open a debate and answer it yourself",
  essay: "Essay: argue one idea",
};
const fmtKey = (f: string) => f.toLowerCase().replace(/[^a-z]/g, "");

/** Read engagement for the items a card cites. */
function itemsById(ids: string[]): Map<string, Item> {
  const want = new Set(ids);
  const out = new Map<string, Item>();
  const root = statePath("data", "items", ".x");
  const base = path.dirname(root);
  for (const type of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const dir = path.join(base, type);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line) continue;
        const id = line.match(/^\{"id":"([^"]+)"/)?.[1];
        if (id && want.has(id)) out.set(id, JSON.parse(line));
      }
    }
  }
  return out;
}

function vsUsual(z: number | null): string {
  if (z == null) return "";
  if (z >= 1.5) return " · _way above their usual_";
  if (z >= 0.5) return " · _above their usual_";
  if (z <= -0.5) return " · _below their usual_";
  return " · _typical for them_";
}

/** "Inspired by" lines: linked title, author, likes, comments, and how it did vs the author's norm. */
function sourceLines(card: Card): string[] {
  const hooks = new Map(loadHooks().map((h) => [h.item_id, h]));
  const items = itemsById(card.meta.evidence);
  return card.meta.evidence.slice(0, 4).flatMap((id) => {
    const h = hooks.get(id);
    const it = items.get(id);
    if (!h && !it) return [];
    const title = (it?.title ?? h?.title ?? "post").replace(/[<>|]/g, "").slice(0, 90);
    const url = it?.url ?? h?.url;
    const who = it?.author ?? h?.author ?? "";
    const likes = it?.metrics?.likes;
    const comments = it?.metrics?.comments;
    const stats = [likes != null ? `❤️ ${likes}` : "", comments != null ? `💬 ${comments}` : ""].filter(Boolean).join("  ");
    return [`• ${url ? `<${url}|${title}>` : title} — ${who}${stats ? `  ${stats}` : ""}${vsUsual(h?.engagement_z ?? null)}`];
  });
}

function notesLine(card: Card): string {
  const refs = card.meta.brain_refs ?? [];
  if (!refs.length) return "";
  const kinds = new Map<string, Set<string>>();
  for (const r of refs) {
    const kind = r.includes("/sessions/") || r.startsWith("brain:sessions") ? "build session" : r.includes("daily") ? "daily note" : r.includes("projects") ? "project file" : "note";
    const date = r.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!kinds.has(kind)) kinds.set(kind, new Set());
    if (date) kinds.get(kind)!.add(new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  }
  return [...kinds].map(([k, d]) => `${k}${d.size ? ` (${[...d].join(", ")})` : ""}`).join(" · ");
}

/** Block Kit for one card. Readable top to bottom: what to write, the hook, why it works, where it came from, decide. */
export function cardBlocks(card: Card): Block[] {
  const { title, hook, angle, template } = parseBody(card.body);
  const m = card.meta;
  const url = repoUrl(card.file);
  const fmt = FORMAT[fmtKey(m.format)] ?? m.format;
  const sources = sourceLines(card);
  const notes = notesLine(card);
  const blocks: Block[] = [
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: title.slice(0, 150), emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `*${PLATFORM[m.platform] ?? m.platform}*   ·   ${fmt}   ·   predicted ${m.predicted_score}/10` }] },
    { type: "section", text: { type: "mrkdwn", text: `*Opening line*\n>${hook.replace(/\n/g, "\n>").slice(0, 2800)}` } },
  ];
  if (m.hook_breakdown || template)
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Why this hook works*\n${m.hook_breakdown ?? ""}${template ? `${m.hook_breakdown ? "\n" : ""}_Pattern:_ ${template}` : ""}`.slice(0, 2900) } });
  if (angle) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Your angle*\n${angle}`.slice(0, 2900) } });
  if (sources.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Inspired by*\n${sources.join("\n")}`.slice(0, 2900) } });
  if (notes) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `From your work notes: ${notes}` }] });
  blocks.push({
    type: "actions",
    block_id: `card:${m.id}`.slice(0, 255),
    elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve_card", value: m.id },
      { type: "button", text: { type: "plain_text", text: "Rewrite" }, action_id: "rewrite_card", value: m.id },
      { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "reject_card", value: m.id },
      ...(url ? [{ type: "button", text: { type: "plain_text", text: "Full card" }, action_id: "open_card", url }] : []),
    ],
  });
  return blocks;
}

/** Replace the buttons with a one-line outcome, keeping the card text. */
export function decidedBlocks(blocks: Block[], line: string): Block[] {
  return [...blocks.filter((b) => b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text: line }] }];
}

/** Older cards predate hook_breakdown: fill it in with one cheap call. */
async function ensureBreakdown(card: Card): Promise<void> {
  if (card.meta.hook_breakdown) return;
  const { hook } = parseBody(card.body);
  const res = await claude().messages.parse({
    model: MODELS.distill,
    max_tokens: 400,
    messages: [{ role: "user", content: `In 1-2 plain sentences, explain why this LinkedIn/blog opening line works for an audience of GTM engineers: name the move it makes (a number, a confession, a stake, a contrarian turn, specificity) and why it stops the scroll.\n\nOpening line: ${hook}` }],
    output_config: { format: zodOutputFormat(z.object({ breakdown: z.string() })) },
  });
  card.meta.hook_breakdown = res.parsed_output?.breakdown;
}

/** Post a heading, then one message per card (each can be decided and updated on its own). Records the Slack ts on each card. */
export async function postCards(files: string[], heading: string): Promise<void> {
  const channel = process.env.SLACK_CHANNEL || "content-agents";
  await postMessage(channel, heading, sections(heading));
  for (const f of files) {
    const card = readCard(f);
    await ensureBreakdown(card).catch(() => {});
    const { title } = parseBody(card.body);
    const r = await postMessage(channel, title, cardBlocks(card));
    card.meta.slack = { channel: r.channel, ts: r.ts };
    writeCard("inbox", card.meta, card.body);
  }
}

export async function markDecided(slack: { channel: string; ts: string } | undefined, card: Card | null, line: string): Promise<void> {
  if (!slack) return;
  const blocks = card ? decidedBlocks(cardBlocks(card), line) : sections(line);
  await updateMessage(slack.channel, slack.ts, line, blocks);
}
