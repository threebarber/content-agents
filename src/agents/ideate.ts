import fs from "node:fs";
import YAML from "yaml";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { claude, MODELS, prompt, readMemory, costUsd } from "./llm.js";
import { IdeateOutput, normalizeFormat, normalizeRiffType, type CardDraft, type CardMeta } from "../../schemas/card.js";
import { loadHooks } from "./distill.js";
import { cardBody, cardId, listCards, writeCard, repoUrl, type Card } from "./cards.js";
import { withDb } from "../lib/duckdb.js";
import { loadBudget } from "../registry/store.js";
import { postCards } from "./slack-cards.js";
import type { HookRecord } from "../../schemas/hook.js";
import { readJsonl } from "../lib/jsonl.js";
import { itemsById } from "../lib/items.js";
import { statePath } from "../lib/paths.js";

type MyPost = { id: string; url: string; published_at: string; at: string; likes: number | null; comments: number | null; shares: number | null; first_line: string | null };

/** Latest snapshot of each of the owner's own LinkedIn posts: what landed, in their real voice. */
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

/** Project key for a work-note item id: sessions/2026-10/2026-10-19-golden-rfp#x → golden-rfp; projects/dealroom#x → dealroom. */
export function projectKey(id: string): string {
  const path = id.replace(/^brain:/, "").split("#")[0];
  const base = path.split("/").pop() ?? path;
  return base.replace(/^\d{4}-\d{2}-\d{2}-?/, "").replace(/\.log$/, "") || base;
}

/**
 * Work notes for ideation: a 30-day window, at most `perProject` sections from any one project, interleaved across
 * projects so one busy day can't flood the context. Daily notes count as one project per week.
 */
async function workNotes(days: number, k: number, perProject = 2): Promise<BrainRow[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = (await withDb((q) =>
    q(`SELECT id, title, text, published_at::VARCHAR AS published_at, tags[1] AS kind FROM items
       WHERE source_id = 'brain' AND published_at >= '${since}' AND length(text) > 200
       -- what was built, decided, or thought; never bug notes (roadblocks, discoveries, knowledge-base gotchas)
       AND (
         (tags[1] = 'session' AND split_part(id, '#', 2) = 'accomplished')
         OR (tags[1] = 'project' AND split_part(id, '#', 2) IN ('top', 'key-decisions', 'open-questions'))
         OR tags[1] IN ('daily', 'ideas')
       )
       ORDER BY published_at DESC`),
  )) as unknown as BrainRow[];
  const byProject = new Map<string, BrainRow[]>();
  for (const r of rows) {
    const key = r.kind === "daily" ? `daily-${r.published_at.slice(0, 7)}` : projectKey(r.id);
    const list = byProject.get(key) ?? [];
    if (list.length < perProject) list.push(r);
    byProject.set(key, list);
  }
  // round-robin across projects (deterministic shuffle by key so the order isn't always newest-first)
  const groups = [...byProject.entries()].sort((a, b) => hash(a[0]) - hash(b[0])).map(([, v]) => v);
  const out: BrainRow[] = [];
  for (let i = 0; out.length < k && groups.some((g) => g[i]); i++) for (const g of groups) if (g[i] && out.length < k) out.push(g[i]);
  return out;
  function hash(s: string) {
    let h = new Date().getUTCDate();
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h;
  }
}

type AvoidTopic = { pattern: string; why: string };
export function avoidTopics(): AvoidTopic[] {
  const f = statePath("config", "avoid-topics.yaml");
  if (!fs.existsSync(f)) return [];
  return (YAML.parse(fs.readFileSync(f, "utf8"))?.topics ?? []) as AvoidTopic[];
}

/** Titles + riffs of cards from the last `days` days (any queue): the next batch must pick different topics. */
function recentTopics(days: number): string {
  const since = Date.now() - days * 86400000;
  const lines: string[] = [];
  for (const q of ["inbox", "approved", "rejected", "drafted", "published"] as const)
    for (const c of listCards(q)) if (new Date(c.meta.created_at).getTime() >= since) lines.push(`- ${c.body.split("\n")[0].replace(/^# /, "")}${c.meta.their_point ? ` (riff on: ${c.meta.their_point.slice(0, 90)})` : ""}`);
  return lines.join("\n");
}

function covered(): string {
  const lines: string[] = [];
  for (const q of ["inbox", "approved", "rejected", "drafted", "published"] as const)
    for (const c of listCards(q).slice(-40)) lines.push(`- [${q}${c.meta.verdict === "reject" && c.meta.why ? `: ${c.meta.why}` : ""}] ${c.body.split("\n")[0].replace(/^# /, "")}`);
  return lines.join("\n") || "(none yet)";
}

function render(hooks: HookRecord[], notes: BrainRow[], extra: string): string {
  const items = itemsById(hooks.map((h) => h.item_id));
  const sw = hooks
    .map((h, i) => {
      const it = items.get(h.item_id);
      const eng = it ? `❤️${it.metrics.likes ?? "?"} 💬${it.metrics.comments ?? "?"}` : "";
      const excerpt = i < 18 && it ? `\n  excerpt: ${it.text.replace(/\s+/g, " ").slice(0, 900)}` : "";
      return `[${h.item_id}] ${h.author} — "${h.title}" (${it?.type ?? "?"}, ${eng}, z=${h.engagement_z ?? "?"}, ${h.format})\n  hook: ${h.hook}\n  claim: ${h.core_claim}\n  why it worked: ${h.why_it_worked}${excerpt}`;
    })
    .join("\n\n");
  const wn = notes.map((n) => `[${n.id}] (${n.kind}, ${n.published_at.slice(0, 10)}) ${n.title}\n${n.text.slice(0, 1200)}`).join("\n\n---\n\n");
  return [
    `FACTS ABOUT THEIR WORK (corrections from them; never contradict)\n${readMemory("facts") || "(none)"}`,
    `LEARNED PREFERENCES\n${readMemory("winning-patterns") || "(none yet — first runs)"}\n\nREJECTED PATTERNS\n${readMemory("rejected") || "(none yet)"}`,
    `ALREADY COVERED OR REJECTED\n${covered()}`,
    `TOPICS FROM THE LAST TWO BATCHES (pick different topics, different posts, different projects)\n${recentTopics(8) || "(none)"}`,
    `NEVER THE TOPIC (may appear only as a one-line supporting example)\n${avoidTopics().map((t) => `- /${t.pattern}/ — ${t.why}`).join("\n") || "(none)"}`,
    `HIS RECENT LINKEDIN POSTS (his real voice and what landed; don't repeat these)\n${myPosts(15) || "(none fetched yet)"}`,
    `SWIPE FILE (top posts from newsletters he follows and from LinkedIn/X searches on his topics, last 3 weeks)\n\n${sw || "(empty)"}`,
    `WORK NOTES (redacted, last 30 days: what was built, decided, or thought — optional evidence, never the topic)\n\n${wn || "(none)"}`,
    extra,
  ].join("\n\n=====\n\n");
}

const callModel = traceable(
  async (input: { system: string; user: string; n: number }) => {
    // streamed: a 10-card batch plus thinking can exceed what a non-streaming request may ask for
    const res = await claude()
      .messages.stream({
        model: MODELS.ideate,
        max_tokens: 64000,
        system: input.system,
        output_config: { effort: "high", format: zodOutputFormat(IdeateOutput) },
        messages: [{ role: "user", content: input.user + `\n\n=====\n\nWrite ${input.n} cards.` }],
      })
      .finalMessage();
    if (!res.parsed_output) throw new Error(`ideate: no parsed output (stop_reason=${res.stop_reason})`);
    return { cards: res.parsed_output.cards, usd: costUsd(MODELS.ideate, res.usage), run_id: getCurrentRunTree(true)?.id ?? null };
  },
  { name: "ideate", run_type: "chain" },
);

function toMeta(d: CardDraft, hooks: HookRecord[], runId: string | null, seed: string | null, noteIds: string[] = []): CardMeta {
  // ids the model cites are checked against stored items: anything that doesn't exist is dropped, never stored
  const cited = [...new Set([...(d.riff_on ? [d.riff_on] : []), ...d.evidence.map((e) => e.item_id)])];
  const known = itemsById(cited);
  const evidence = cited.filter((id) => known.has(id));
  if (d.riff_on && !known.has(d.riff_on)) d.riff_on = null;
  const sourceOf = (id: string) => hooks.find((h) => h.item_id === id)?.source_id ?? known.get(id)?.source_id;
  const sources = [...new Set(evidence.map(sourceOf).filter((s): s is string => !!s && s !== "brain" && !s.startsWith("web:")))];
  d.format = normalizeFormat(d.format);
  d.riff_type = d.riff_on ? normalizeRiffType(d.riff_type) : "original";
  d.brain_refs = noteIds.length ? normalizeRefs(d.brain_refs, noteIds) : d.brain_refs;
  d.evidence = d.evidence.filter((e) => known.has(e.item_id));
  return {
    content: d,
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
    riff_on: d.riff_on,
    riff_type: d.riff_type,
    their_point: d.their_point,
  };
}

export type IdeateResult = { files: string[]; usd: number; runId: string | null };

/** Patterns every model reaches for when it has nothing specific to say. */
const GENERIC = [
  /\b(isn['’]?t|is not|aren['’]?t|are not|wasn['’]?t|was not)\b[^.?!\n]{0,70}[,;:—–-]\s*(it['’]?s|they['’]?re|it was|but)\b/i,
  /,\s*not\s+[a-z]/i,
  /\bnot\s+(about|a|an|the)?\s*\w+(\s+\w+){0,3},?\s+but\b/i,
  /\b(is|are) earned\b|\bthe real (problem|issue|story|question|bottleneck)\b|\b(was|were) always\b|\bnever (was|existed)\b|\bhere['’]?s the thing\b|\blet that sink in\b/i,
];

/** Verification loop: deterministic checks on a batch. Returns issues per card index (empty = pass). */
export function verifyCards(cards: CardDraft[], hooks: HookRecord[], minRiffs: number): Map<number, string[]> {
  const ids = new Set(hooks.map((h) => h.item_id));
  const issues = new Map<number, string[]>();
  const add = (i: number, m: string) => issues.set(i, [...(issues.get(i) ?? []), m]);
  const seenRiff = new Map<string, number>();
  const seenMove = new Map<string, number>();
  cards.forEach((c, i) => {
    const first = c.hook.split(/(?<=[.?!])\s|\n/)[0] ?? c.hook;
    if (GENERIC.some((re) => re.test(first) || re.test(c.title))) add(i, `generic antithesis/aphorism hook or title ("${first.slice(0, 80)}")`);
    if (c.riff_on && !ids.has(c.riff_on)) add(i, `riff_on "${c.riff_on}" is not a SWIPE FILE id`);
    if (c.riff_on) {
      if (seenRiff.has(c.riff_on)) add(i, `riffs on the same post as card ${seenRiff.get(c.riff_on)! + 1}`);
      else seenRiff.set(c.riff_on, i);
    }
    const move = (c.hook_template_used ?? "").toLowerCase().slice(0, 40);
    if (move) {
      if (seenMove.has(move)) add(i, `same hook move as card ${seenMove.get(move)! + 1}`);
      else seenMove.set(move, i);
    }
    const opening = c.hook.split(/(?<=[.?!])\s+/).slice(0, 2).join(" ");
    if (!/\d/.test(opening) && !/\b[A-Z][a-zA-Z]{2,}\b/.test(opening.slice(1))) add(i, "opening has no concrete specific (number, named tool/company/person)");
  });
  const avoid = avoidTopics().map((t) => ({ re: new RegExp(t.pattern, "i"), why: t.why }));
  const perProject = new Map<string, number[]>();
  cards.forEach((c, i) => {
    for (const a of avoid) if (a.re.test(c.title) || a.re.test(c.hook)) add(i, `topic is on the never-the-topic list (${a.why}); make the post about something the audience cares about`);
    for (const key of new Set((c.brain_refs ?? []).map(projectKey))) perProject.set(key, [...(perProject.get(key) ?? []), i]);
  });
  for (const [key, idx] of perProject) if (idx.length > 2) for (const i of idx.slice(2)) add(i, `third card leaning on the same work project (${key}); use a different project or none`);
  const riffs = cards.filter((c) => c.riff_on && ids.has(c.riff_on)).length;
  if (riffs < minRiffs) cards.forEach((c, i) => { if (!c.riff_on) add(i, `batch needs ≥${minRiffs} cards riffing on a swipe-file post (has ${riffs}); make this one a response to a specific post`); });
  return issues;
}

/** Snap the model's work-note references to exact item ids (it sometimes drops the "brain:" prefix or the #section). */
export function normalizeRefs(refs: string[], known: string[]): string[] {
  const out = new Set<string>();
  for (const raw of refs) {
    const r = raw.trim();
    const withPrefix = r.startsWith("brain:") ? r : `brain:${r}`;
    if (known.includes(withPrefix)) out.add(withPrefix);
    else {
      const base = withPrefix.split("#")[0];
      for (const k of known) if (k.split("#")[0] === base) out.add(k);
    }
  }
  return [...out];
}

/** Generate, check, and repair once: flagged cards are sent back with the reasons and replaced. */
async function generateChecked(user: string, n: number, hooks: HookRecord[]): Promise<{ cards: CardDraft[]; usd: number; run_id: string | null; repaired: number }> {
  const first = await callModel({ system: prompt("ideate"), user, n });
  let cards = first.cards;
  let usd = first.usd;
  const issues = verifyCards(cards, hooks, Math.max(1, n - 2));
  if (!issues.size) return { cards, usd, run_id: first.run_id, repaired: 0 };
  const flagged = [...issues.keys()];
  const keep = cards.filter((_, i) => !issues.has(i));
  const report = flagged.map((i) => `Card ${i + 1} "${cards[i].title}" — hook: "${cards[i].hook}"\n  problems: ${issues.get(i)!.join("; ")}`).join("\n");
  const repair = await callModel({
    system: prompt("ideate"),
    user: `${user}\n\n=====\n\nREVISION REQUIRED\nThese cards failed review:\n${report}\n\nCards already accepted (don't duplicate their posts or hook moves):\n${keep.map((c) => `- [${c.riff_on}] ${c.hook_template_used} :: ${c.hook}`).join("\n") || "(none)"}`,
    n: flagged.length,
  });
  usd += repair.usd;
  cards = [...keep, ...repair.cards.slice(0, flagged.length)];
  return { cards, usd, run_id: first.run_id, repaired: flagged.length };
}

export async function ideate(opts: { n?: number; post?: boolean; dry?: boolean } = {}): Promise<IdeateResult> {
  const hooks = swipeFile(21, 45);
  const notes = await workNotes(30, 20);
  const n = opts.n ?? loadBudget().ideas_per_batch;
  const { cards, usd, run_id, repaired } = await generateChecked(render(hooks, notes, ""), n, hooks);
  if (repaired) console.error(`ideate: repaired ${repaired} card(s) that failed review`);
  if (opts.dry) {
    for (const c of cards) console.log(`\n[${c.platform}/${c.format}] ${c.title}\n  ${c.hook}`);
    return { files: [], usd, runId: run_id };
  }
  const files = cards.map((c) => writeCard("inbox", toMeta(c, hooks, run_id, null, notes.map((n) => n.id)), cardBody(c)));
  if (opts.post !== false && process.env.SLACK_BOT_TOKEN) await postCards(files, `*${files.length} new idea cards.* Approve, rewrite, or reject each one below.`);
  return { files, usd, runId: run_id };
}

/** Rewrite one card immediately using the owner's note. */
export async function ideateOne(prev: Card): Promise<IdeateResult> {
  const hooks = swipeFile(21, 30);
  const notes = await workNotes(14, 15);
  const extra = `REWRITE REQUEST\nThe owner marked this card "rewrite" — good idea, wrong angle. Their note: "${prev.meta.why || "(no note)"}".\nOriginal card:\n${prev.body}\n\nWrite one replacement card that keeps what was good and follows their note.`;
  const { cards, usd, run_id } = await callModel({ system: prompt("ideate"), user: render(hooks, notes, extra), n: 1 });
  const c = cards[0];
  const file = writeCard("inbox", toMeta(c, hooks, run_id, `rewrite:${prev.meta.id}`, notes.map((n) => n.id)), cardBody(c));
  if (process.env.SLACK_BOT_TOKEN) await postCards([file], `Rewrite of _${prev.body.split("\n")[0].replace(/^# /, "")}_ — following your note: “${prev.meta.why}”`);
  return { files: [file], usd, runId: run_id };
}


type SavedItem = { id: string; source_id: string; author: string | null; title: string | null; text: string; url: string; published_at: string; metrics: { likes: number | null; comments: number | null } };

/**
 * Riff on posts the owner dropped into Slack. Each card's riff_on is the saved post, assigned in code (the model only
 * chooses the angle); the swipe file is shown as background, not as material to riff on.
 */
export async function ideateFromSaved(items: SavedItem[], note: string, thread?: { channel: string; ts: string }): Promise<IdeateResult> {
  const stored = new Map(loadHooks().map((h) => [h.item_id, h]));
  const savedHooks: HookRecord[] = items.map((i) => stored.get(i.id) ?? {
    item_id: i.id, source_id: i.source_id, author: i.author, title: i.title, url: i.url, published_at: i.published_at, engagement_z: null, hit: true,
    model: "", distilled_at: "", hook: (i.title ?? i.text.split("\n")[0]).slice(0, 200), hook_template: "", format: "other", topics: [], core_claim: "", why_it_worked: "", hook_quality: 3, relevance: 3,
  });
  const background = swipeFile(21, 12).filter((h) => !items.some((i) => i.id === h.item_id));
  const notes = await workNotes(30, 15);
  const per = items.length > 1 ? 1 : 2;
  const n = Math.min(4, per * items.length);
  const saved = items.map((i) => `[${i.id}] ${i.author ?? "?"} — "${i.title ?? ""}" (❤️${i.metrics.likes ?? "?"} 💬${i.metrics.comments ?? "?"})\n${i.text.slice(0, 6000)}`).join("\n\n---\n\n");
  const extra = `SAVED POST(S): THE SUBJECT OF THIS BATCH\nThe owner dropped ${items.length > 1 ? "these posts" : "this post"} into Slack${note ? ` with this note: "${note}"` : ""}.\n\n${saved}\n\nWrite ${n} card(s). Every card must respond to a saved post above: set riff_on to its id (${items.map((i) => i.id).join(", ")}), and their_point to what that post specifically argued. Use the SWIPE FILE only as background for what else people are saying; do not riff on it. Pull evidence from the work notes where it fits. Use a different riff_type and hook move for each card.`;
  const { cards, usd, run_id } = await generateChecked(render([...savedHooks, ...background], notes, extra), n, savedHooks);
  const files = cards.map((c, k) => {
    // enforce the subject: a card that wandered to another post is pointed back at the saved one
    if (!items.some((i) => i.id === c.riff_on)) c.riff_on = items[k % items.length].id;
    if (!c.evidence.some((e) => e.item_id === c.riff_on)) c.evidence.unshift({ item_id: c.riff_on!, why: "saved by the owner" });
    const meta = toMeta(c, [...savedHooks, ...background], run_id, `saved:${c.riff_on}`, notes.map((x) => x.id));
    return writeCard("inbox", meta, cardBody(c));
  });
  if (process.env.SLACK_BOT_TOKEN) await postCards(files, `*${files.length} ideas from what you saved*`, thread);
  return { files, usd, runId: run_id };
}

/** the owner rejected the idea but liked the post: write one card with a genuinely different angle on the same post. */
export async function ideateAnotherAngle(prev: Card): Promise<IdeateResult> {
  const hooks = swipeFile(30, 45);
  const riff = prev.meta.riff_on;
  const pool = riff && !hooks.some((h) => h.item_id === riff) ? [...loadHooks().filter((h) => h.item_id === riff), ...hooks] : hooks;
  const notes = await workNotes(14, 15);
  const extra = `ANOTHER ANGLE REQUEST\nThe owner rejected this idea but rated the post it riffed on as good. Their note on the idea: "${prev.meta.why || "(none)"}".\nRejected card:\n${prev.body.split("\n---\n")[0]}\n\nWrite ONE new card that riffs on the same post (riff_on: ${riff ?? "the same post"}) with a different riff_type, a different angle, and a different hook move. Don't reuse the rejected idea's framing.`;
  const { cards, usd, run_id } = await callModel({ system: prompt("ideate"), user: render(pool, notes, extra), n: 1 });
  const c = cards[0];
  if (riff) c.riff_on = riff;
  const file = writeCard("inbox", toMeta(c, pool, run_id, `angle:${prev.meta.id}`, notes.map((n) => n.id)), cardBody(c));
  if (process.env.SLACK_BOT_TOKEN) await postCards([file], "*Another angle on the same post*", prev.meta.slack);
  return { files: [file], usd, runId: run_id };
}

/** What the idea generator actually receives right now (for the health check: "is memory really referenced?"). */
export async function ideationInputs(): Promise<{ swipe: number; swipeWithExcerpt: number; notes: number; notesProjects: number; myPosts: number; facts: number; winning: number; avoid: number; avoidTopics: number; rules: number; recentTopics: number; promptChars: number }> {
  const hooks = swipeFile(21, 45);
  const notes = await workNotes(30, 20);
  const items = itemsById(hooks.map((h) => h.item_id));
  const bullets = (t: string) => t.split("\n").filter((l) => l.trim().startsWith("- ")).length;
  const rendered = prompt("ideate") + render(hooks, notes, "");
  const rulesFile = statePath("prompts", "rules", "ideate.md");
  return {
    swipe: hooks.length,
    swipeWithExcerpt: hooks.slice(0, 18).filter((h) => items.get(h.item_id)?.text).length,
    notes: notes.length,
    notesProjects: new Set(notes.map((n) => projectKey(n.id))).size,
    myPosts: myPosts(15).split("\n").filter(Boolean).length,
    facts: bullets(readMemory("facts")),
    winning: bullets(readMemory("winning-patterns")),
    avoid: bullets(readMemory("rejected")),
    avoidTopics: avoidTopics().length,
    rules: fs.existsSync(rulesFile) ? bullets(fs.readFileSync(rulesFile, "utf8")) : 0,
    recentTopics: recentTopics(8).split("\n").filter(Boolean).length,
    promptChars: rendered.length,
  };
}
