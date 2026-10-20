import { postMessage, updateMessage, sections } from "../lib/slack.js";
import { readCard, writeCard, repoUrl, type Card } from "./cards.js";

type Block = Record<string, unknown>;

/** Pull title / hook / angle back out of a card body (cards are the source of truth, Slack is a view). */
export function parseBody(body: string): { title: string; hook: string; angle: string } {
  const title = body.match(/^# (.+)$/m)?.[1] ?? "(untitled)";
  const hook = (body.match(/\*\*Hook\*\*\n\n((?:> .*\n?)+)/)?.[1] ?? "").replace(/^> ?/gm, "").trim();
  const angle = body.match(/\*\*Angle:\*\* (.+)/)?.[1] ?? "";
  return { title, hook, angle };
}

/** Block Kit for one card: title, hook, angle, and Approve / Rewrite / Reject buttons. */
export function cardBlocks(card: Card): Block[] {
  const { title, hook, angle } = parseBody(card.body);
  const m = card.meta;
  const url = repoUrl(card.file);
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${title}*\n_${m.platform} · ${m.format} · ${m.predicted_score}/10_` } },
    { type: "section", text: { type: "mrkdwn", text: `> ${hook.replace(/\n/g, "\n> ").slice(0, 2800)}` } },
    ...(angle ? [{ type: "context", elements: [{ type: "mrkdwn", text: angle.slice(0, 2900) }] }] : []),
    {
      type: "actions",
      block_id: `card:${m.id}`.slice(0, 255),
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve_card", value: m.id },
        { type: "button", text: { type: "plain_text", text: "Rewrite" }, action_id: "rewrite_card", value: m.id },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "reject_card", value: m.id },
        ...(url ? [{ type: "button", text: { type: "plain_text", text: "Open" }, action_id: "open_card", url }] : []),
      ],
    },
  ];
}

/** Replace the buttons with a one-line outcome, keeping the card text. */
export function decidedBlocks(blocks: Block[], line: string): Block[] {
  return [...blocks.filter((b) => b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text: line }] }];
}

/** Post a heading, then one message per card (so each can be decided and updated on its own). Records the Slack ts on each card. */
export async function postCards(files: string[], heading: string): Promise<void> {
  const channel = process.env.SLACK_CHANNEL || "content-agents";
  await postMessage(channel, heading, sections(heading));
  for (const f of files) {
    const card = readCard(f);
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
