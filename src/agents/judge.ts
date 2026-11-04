import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { claude, MODELS, prompt, readMemory, tally } from "./llm.js";
import { listCards } from "./cards.js";
import type { CardDraft } from "../../schemas/card.js";

const Judgement = z.object({
  verdicts: z.array(
    z.object({
      card: z.number().int().describe("The card's number in the batch, from 1."),
      worth: z.number().int().min(1).max(5).describe("Is this worth writing about? 1 = never, 5 = write it today."),
      reason: z.string().describe("One plain sentence why."),
      fix: z.string().describe("What would make it worth writing; empty if 4-5."),
    }),
  ),
});
export type Worth = { score: number; reason: string; fix: string };

/** Cards scoring below this are sent back for a rewrite (and dropped if the rewrite still scores below it). */
export const WORTH_MIN = 3;

/** The owner's own verdicts are the calibration: what they approved, and what they rejected with their reason. */
function pastVerdicts(): string {
  const line = (c: ReturnType<typeof listCards>[number]) => `${c.body.split("\n")[0].replace(/^# /, "")} :: ${(c.meta.content?.hook ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
  const approved = [...listCards("approved"), ...listCards("drafted"), ...listCards("published")].slice(-15).map((c) => `- ${line(c)}`);
  const rejected = listCards("rejected")
    .filter((c) => c.meta.why && !/^superseded/.test(c.meta.why))
    .slice(-30)
    .map((c) => `- ${line(c)}\n  their reason: ${c.meta.why}`);
  return `APPROVED\n${approved.join("\n") || "(none yet)"}\n\nREJECTED\n${rejected.join("\n") || "(none yet)"}`;
}

/** One call grades a whole batch. Returns a score per card index; cards the judge skipped get no score. */
export async function judgeCards(cards: CardDraft[]): Promise<{ worth: Map<number, Worth>; usd: number }> {
  if (!cards.length) return { worth: new Map(), usd: 0 };
  const batch = cards
    .map((c, i) => `CARD ${i + 1}: ${c.title}\nhook: ${c.hook}\nangle: ${c.angle}\noutline: ${c.outline.join(" / ")}${c.their_point ? `\nsparked by: ${c.their_point}` : ""}`)
    .join("\n\n");
  const res = await claude().messages.parse({
    model: MODELS.judge,
    max_tokens: 4000,
    system: prompt("judge"),
    output_config: { format: zodOutputFormat(Judgement) },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: [`THEIR VOICE\n${readMemory("voice")}`, `THEIR PAST VERDICTS\n${pastVerdicts()}`, `REJECTED PATTERNS\n${readMemory("rejected")}`, `WHAT WORKS\n${readMemory("winning-patterns")}`].join("\n\n=====\n\n"), cache_control: { type: "ephemeral" } },
          { type: "text", text: `THE BATCH\n\n${batch}\n\nGrade every card.` },
        ],
      },
    ],
  });
  const usd = tally(MODELS.judge, res.usage);
  const worth = new Map<number, Worth>();
  for (const v of res.parsed_output?.verdicts ?? []) if (v.card >= 1 && v.card <= cards.length) worth.set(v.card - 1, { score: v.worth, reason: v.reason, fix: v.fix });
  return { worth, usd };
}
