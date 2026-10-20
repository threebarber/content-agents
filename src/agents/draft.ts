import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { claude, MODELS, prompt, readMemory, costUsd } from "./llm.js";
import { writeCard, type Card } from "./cards.js";
import { parseBody } from "./slack-cards.js";
import { loadHooks } from "./distill.js";
import { itemsById } from "../lib/items.js";
import { postMessage, sections } from "../lib/slack.js";
import { withDb } from "../lib/duckdb.js";

const DraftOut = z.object({
  draft: z.string().describe("The full post text (LinkedIn) or markdown (Hashnode)."),
  notes: z.string().describe("What the owner should verify, fill in, or decide before posting. Short bullets."),
});

async function recentOwnPosts(k: number): Promise<string> {
  const rows = await withDb((q) => q(`SELECT text FROM items WHERE source_id = 'me:linkedin' ORDER BY published_at DESC LIMIT ${k}`)).catch(() => []);
  return rows.map((r, i) => `--- his post ${i + 1} ---\n${String(r.text).slice(0, 1500)}`).join("\n\n");
}

const callDraft = traceable(
  async (input: { system: string; user: string; maxTokens: number }) => {
    const res = await claude().messages.parse({
      model: MODELS.ideate,
      max_tokens: input.maxTokens,
      system: input.system,
      output_config: { effort: "high", format: zodOutputFormat(DraftOut) },
      messages: [{ role: "user", content: input.user }],
    });
    if (!res.parsed_output) throw new Error(`draft: no parsed output (stop_reason=${res.stop_reason})`);
    return { ...res.parsed_output, usd: costUsd(MODELS.ideate, res.usage), run_id: getCurrentRunTree(true)?.id ?? null };
  },
  { name: "draft", run_type: "chain" },
);

export type DraftResult = { file: string; usd: number; runId: string | null; words: number };

/** Write a first draft for an approved card, save it to queue/drafted, and post it in the card's Slack thread. */
export async function draftCard(card: Card): Promise<DraftResult> {
  const linkedin = card.meta.platform === "linkedin";
  const notes = itemsById(card.meta.brain_refs ?? []);
  const hooks = new Map(loadHooks().map((h) => [h.item_id, h]));
  const evidence = card.meta.evidence.map((id) => hooks.get(id)).filter((h) => !!h);
  const own = await recentOwnPosts(5);
  const user = [
    `APPROVED CARD\n${card.body.split("\n---\n")[0]}${card.meta.why ? `\n\nThe owner's note when approving: "${card.meta.why}"` : ""}`,
    `HIS WORK NOTES (redacted source material)\n${[...notes.values()].map((n) => `[${n.title}]\n${n.text.slice(0, 3000)}`).join("\n\n") || "(none — work from the card)"}`,
    `INSPIRATION (posts this riffs on)\n${evidence.map((h) => `${h!.author} — "${h!.title}"\n  hook: ${h!.hook}\n  claim: ${h!.core_claim}`).join("\n") || "(none)"}`,
    `HIS VOICE\n${readMemory("voice") || ""}\n${own || "(no past posts available yet: write plainly and specifically)"}`,
    `WHAT HE TENDS TO APPROVE\n${readMemory("winning-patterns") || "(not enough feedback yet)"}`,
  ].join("\n\n=====\n\n");
  const r = await callDraft({ system: prompt(linkedin ? "draft_linkedin" : "draft_hashnode"), user, maxTokens: linkedin ? 4000 : 12000 });
  const words = r.draft.split(/\s+/).filter(Boolean).length;
  card.meta.verdict = "approve";
  const body = `${card.body.split("\n---\n")[0].trim()}\n\n---\n\n## Draft (${words} words)\n\n${r.draft}\n\n## Notes\n\n${r.notes}\n`;
  const file = writeCard("drafted", { ...card.meta, langsmith_run_id: card.meta.langsmith_run_id }, body);
  if (card.meta.slack && process.env.SLACK_BOT_TOKEN) await postDraftThread(card, r.draft, r.notes, words);
  return { file, usd: r.usd, runId: r.run_id, words };
}

async function postDraftThread(card: Card, draft: string, notes: string, words: number): Promise<void> {
  const { channel, ts } = card.meta.slack!;
  const { title } = parseBody(card.body);
  const label = card.meta.platform === "linkedin" ? "LinkedIn post" : "Hashnode article";
  // Slack sections cap at 3,000 chars: split on paragraph boundaries into code blocks (easy to copy, keeps line breaks)
  const chunks: string[] = [];
  let cur = "";
  for (const para of draft.split(/\n{2,}/)) {
    if ((cur + "\n\n" + para).length > 2700 && cur) {
      chunks.push(cur);
      cur = para;
    } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) chunks.push(cur);
  const head = `*First draft* · ${label} · ${words} words`;
  await postMessage(channel, `Draft: ${title}`, [
    { type: "section", text: { type: "mrkdwn", text: head } },
    ...chunks.slice(0, 1).map((c) => ({ type: "section", text: { type: "mrkdwn", text: "```" + c.replace(/```/g, "ʼʼʼ") + "```" } })),
  ], ts);
  for (const c of chunks.slice(1)) await postMessage(channel, "(draft continued)", [{ type: "section", text: { type: "mrkdwn", text: "```" + c.replace(/```/g, "ʼʼʼ") + "```" } }], ts);
  await postMessage(channel, "Notes", sections(`*Before you post*\n${notes.slice(0, 2800)}`), ts);
}
