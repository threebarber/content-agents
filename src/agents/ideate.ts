import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { claude, MODELS, prompt, readMemory, costUsd } from "./llm.js";
import { IdeateOutput, type CardDraft, type CardMeta } from "../../schemas/card.js";
import { loadHooks } from "./distill.js";
import { cardBody, cardId, listCards, writeCard, repoUrl, type Card } from "./cards.js";
import { withDb } from "../lib/duckdb.js";
import { postCards } from "./slack-cards.js";
import type { HookRecord } from "../../schemas/hook.js";
import { readJsonl } from "../lib/jsonl.js";
import { statePath } from "../lib/paths.js";

type MyPost = { id: string; url: string; published_at: string; at: string; likes: number | null; comments: number | null; shares: number | null; first_line: string | null };

/** Latest snapshot of each of the owner's own LinkedIn posts: what landed, in his real voice. */
function myPosts(k: number): string {
  const latest = new Map<string, MyPost>();
  for (const p of readJsonl<MyPost>(statePath("data", "my-posts.jsonl"))) latest.set(p.id, p);
  const rows = [...latest.values()].sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, k);
  return rows.map((p) => `- (${p.published_at.slice(0, 10)}) ❤️${p.likes ?? "?"} 💬${p.comments ?? "?"} 🔁${p.shares ?? "?"}  "${p.first_line ?? ""}"`).join("\n");
}

type BrainRow = { id: string; title: string; text: string; published_at: string; kind: string };

function swipeFile(days: number, k: number): HookRecord[] {
  const since = Date.now() - days * 86400000;
  return loadHooks()
    .filter((h) => new Date(h.published_at).getTime() >= since && h.relevance >= 3)
    .sort((a, b) => score(b) - score(a))
    .slice(0, k);
  function score(h: HookRecord) {
    return (h.engagement_z ?? 0) + h.hook_quality * 0.6 + h.relevance * 0.6;
  }
}

async function workNotes(days: number, k: number): Promise<BrainRow[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await withDb((q) =>
    q(`SELECT id, title, text, published_at::VARCHAR AS published_at, tags[1] AS kind FROM items
       WHERE source_id = 'brain' AND published_at >= '${since}' AND tags[1] IN ('session','daily','project','ideas','knowledge')
       ORDER BY CASE tags[1] WHEN 'session' THEN 0 WHEN 'daily' THEN 1 WHEN 'ideas' THEN 2 ELSE 3 END, published_at DESC LIMIT ${k}`),
  );
  return rows as unknown as BrainRow[];
}

function covered(): string {
  const lines: string[] = [];
  for (const q of ["inbox", "approved", "rejected", "drafted", "published"] as const)
    for (const c of listCards(q).slice(-40)) lines.push(`- [${q}${c.meta.verdict === "reject" && c.meta.why ? `: ${c.meta.why}` : ""}] ${c.body.split("\n")[0].replace(/^# /, "")}`);
  return lines.join("\n") || "(none yet)";
}

function render(hooks: HookRecord[], notes: BrainRow[], extra: string): string {
  const sw = hooks
    .map((h) => `[${h.item_id}] ${h.author} — "${h.title}" (z=${h.engagement_z ?? "?"}, q=${h.hook_quality}, ${h.format})\n  hook: ${h.hook}\n  template: ${h.hook_template}\n  claim: ${h.core_claim}\n  why: ${h.why_it_worked}`)
    .join("\n\n");
  const wn = notes.map((n) => `[${n.id}] (${n.kind}, ${n.published_at.slice(0, 10)}) ${n.title}\n${n.text.slice(0, 1200)}`).join("\n\n---\n\n");
  return [
    `LEARNED PREFERENCES\n${readMemory("winning-patterns") || "(none yet — first runs)"}\n\nREJECTED PATTERNS\n${readMemory("rejected") || "(none yet)"}`,
    `ALREADY COVERED OR REJECTED\n${covered()}`,
    `HIS RECENT LINKEDIN POSTS (his real voice and what landed; don't repeat these)\n${myPosts(15) || "(none fetched yet)"}`,
    `SWIPE FILE (top posts from newsletters he follows and from LinkedIn/X searches on his topics, last 3 weeks)\n\n${sw || "(empty)"}`,
    `WORK NOTES (redacted, last 10 days)\n\n${wn || "(none)"}`,
    extra,
  ].join("\n\n=====\n\n");
}

const callModel = traceable(
  async (input: { system: string; user: string; n: number }) => {
    const res = await claude().messages.parse({
      model: MODELS.ideate,
      max_tokens: 16000,
      system: input.system,
      output_config: { effort: "high", format: zodOutputFormat(IdeateOutput) },
      messages: [{ role: "user", content: input.user + `\n\n=====\n\nWrite ${input.n} cards.` }],
    });
    if (!res.parsed_output) throw new Error(`ideate: no parsed output (stop_reason=${res.stop_reason})`);
    return { cards: res.parsed_output.cards, usd: costUsd(MODELS.ideate, res.usage), run_id: getCurrentRunTree(true)?.id ?? null };
  },
  { name: "ideate", run_type: "chain" },
);

function toMeta(d: CardDraft, hooks: HookRecord[], runId: string | null, seed: string | null): CardMeta {
  const evidence = d.evidence.map((e) => e.item_id);
  const sources = [...new Set(evidence.map((id) => hooks.find((h) => h.item_id === id)?.source_id).filter((s): s is string => !!s))];
  return {
    id: cardId(d.title),
    created_at: new Date().toISOString(),
    platform: d.platform,
    verdict: "pending",
    why: "",
    predicted_score: d.predicted_score,
    format: d.format,
    sources,
    evidence,
    brain_refs: d.brain_refs,
    seed,
    langsmith_run_id: runId,
    model: MODELS.ideate,
    published_url: "",
    hook_breakdown: d.hook_breakdown,
  };
}

export type IdeateResult = { files: string[]; usd: number; runId: string | null };

export async function ideate(opts: { n?: number; post?: boolean; dry?: boolean } = {}): Promise<IdeateResult> {
  const hooks = swipeFile(21, 40);
  const notes = await workNotes(10, 25);
  const n = opts.n ?? 7;
  const { cards, usd, run_id } = await callModel({ system: prompt("ideate"), user: render(hooks, notes, ""), n });
  if (opts.dry) {
    for (const c of cards) console.log(`\n[${c.platform}/${c.format}] ${c.title}\n  ${c.hook}`);
    return { files: [], usd, runId: run_id };
  }
  const files = cards.map((c) => writeCard("inbox", toMeta(c, hooks, run_id, null), cardBody(c)));
  if (opts.post !== false && process.env.SLACK_BOT_TOKEN) await postCards(files, `*${files.length} new idea cards.* Approve, rewrite, or reject each one below.`);
  return { files, usd, runId: run_id };
}

/** Rewrite one card immediately using the owner's note. */
export async function ideateOne(prev: Card): Promise<IdeateResult> {
  const hooks = swipeFile(21, 30);
  const notes = await workNotes(14, 15);
  const extra = `REWRITE REQUEST\nThe owner marked this card "rewrite" — good idea, wrong angle. His note: "${prev.meta.why || "(no note)"}".\nOriginal card:\n${prev.body}\n\nWrite one replacement card that keeps what was good and follows his note.`;
  const { cards, usd, run_id } = await callModel({ system: prompt("ideate"), user: render(hooks, notes, extra), n: 1 });
  const c = cards[0];
  const file = writeCard("inbox", toMeta(c, hooks, run_id, `rewrite:${prev.meta.id}`), cardBody(c));
  if (process.env.SLACK_BOT_TOKEN) await postCards([file], `Rewrite of _${prev.body.split("\n")[0].replace(/^# /, "")}_ — following your note: “${prev.meta.why}”`);
  return { files: [file], usd, runId: run_id };
}


/** Riff on posts the owner dropped into Slack (links or screenshots), steered by his note. */
export async function ideateFromSaved(items: { id: string; author: string | null; title: string | null; text: string; metrics: { likes: number | null; comments: number | null } }[], note: string, thread?: { channel: string; ts: string }): Promise<IdeateResult> {
  const hooks = swipeFile(21, 20);
  const notes = await workNotes(14, 15);
  const saved = items.map((i) => `[${i.id}] ${i.author ?? "?"} (❤️${i.metrics.likes ?? "?"} 💬${i.metrics.comments ?? "?"})\n${i.text.slice(0, 3000)}`).join("\n\n");
  const extra = `THE OWNER SAVED THIS FOR YOU\nHe dropped these post(s) into Slack because they caught his eye${note ? `, with this note: "${note}"` : ""}.\n\n${saved}\n\nWrite ${items.length > 1 ? 3 : 2} cards that riff on what he saved, connected to his own work where it fits. One may be a screenshot-commentary card (quote the post, add his take). Cite the saved item ids in evidence.`;
  const { cards, usd, run_id } = await callModel({ system: prompt("ideate"), user: render(hooks, notes, extra), n: items.length > 1 ? 3 : 2 });
  const files = cards.map((c) => {
    const meta = toMeta(c, hooks, run_id, `saved:${items[0]?.id}`);
    meta.evidence = [...new Set([...meta.evidence, ...items.map((i) => i.id)])];
    return writeCard("inbox", meta, cardBody(c));
  });
  if (process.env.SLACK_BOT_TOKEN) await postCards(files, `*${files.length} ideas from what you saved*`, thread);
  return { files, usd, runId: run_id };
}
