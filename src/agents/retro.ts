import fs from "node:fs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { claude, MODELS, prompt, readMemory, costUsd, addPromptRule } from "./llm.js";
import { listCards } from "./cards.js";
import { parseBody } from "./slack-cards.js";
import { statePath } from "../lib/paths.js";
import { readJsonl, appendJsonl } from "../lib/jsonl.js";
import { postMessage, updateMessage, sections } from "../lib/slack.js";
import { loadSources, saveSources, loadTerms, loadForaging, findSource } from "../registry/store.js";

const RetroOut = z.object({
  summary: z.array(z.string()),
  winning_patterns: z.string(),
  rejected_patterns: z.string(),
  prompt_rules: z.array(z.object({ prompt: z.enum(["ideate", "draft_linkedin", "draft_hashnode", "distill"]), rule: z.string(), evidence: z.string() })),
});

export type Proposal =
  | { id: string; kind: "prompt_rule"; prompt: string; rule: string; evidence: string; status: "pending" | "accepted" | "skipped"; created_at: string; slack?: { channel: string; ts: string } }
  | { id: string; kind: "source_status"; source_id: string; to: "active" | "paused" | "retired"; reason: string; status: "pending" | "accepted" | "skipped"; created_at: string; slack?: { channel: string; ts: string } };

const PROPOSALS = () => statePath("data", "proposals.json");
export function loadProposals(): Proposal[] {
  return fs.existsSync(PROPOSALS()) ? JSON.parse(fs.readFileSync(PROPOSALS(), "utf8")) : [];
}
export function saveProposals(p: Proposal[]): void {
  fs.writeFileSync(PROPOSALS(), JSON.stringify(p, null, 2));
}

type Fb = { card: string; verdict: string; why: string; sources: string[]; at: string };

/** Deterministic foraging proposals: promote candidates that keep producing, retire ones that don't, pause quiet actives. */
function sourceProposals(): Proposal[] {
  const fo = loadForaging();
  const now = Date.now();
  const out: Proposal[] = [];
  const pending = new Set(loadProposals().filter((p) => p.status === "pending" && p.kind === "source_status").map((p) => (p as { source_id: string }).source_id));
  for (const s of loadSources().sources) {
    if (pending.has(s.id)) continue;
    const { hits, misses, last_hit_at } = s.pheromone;
    const mk = (to: "active" | "paused" | "retired", reason: string): Proposal => ({ id: `src-${s.id}-${to}-${new Date().toISOString().slice(0, 10)}`, kind: "source_status", source_id: s.id, to, reason, status: "pending", created_at: new Date().toISOString() });
    if ((s.status === "candidate" || s.status === "trial") && hits >= fo.promotion.trial_to_active_hits)
      out.push(mk("active", `${hits.toFixed(0)} strong posts vs ${misses.toFixed(0)} weak since it was discovered (${s.discovered_via})`));
    else if ((s.status === "candidate" || s.status === "trial") && misses >= 5 && hits < 1)
      out.push(mk("retired", `${misses.toFixed(0)} posts sampled, none strong`));
    else if (s.status === "active" && last_hit_at && now - new Date(last_hit_at).getTime() > fo.demotion.active_to_paused_weeks * 7 * 86400000 && hits < fo.demotion.active_to_paused_hits_below)
      out.push(mk("paused", `no strong post in ${fo.demotion.active_to_paused_weeks}+ weeks`));
  }
  return out.slice(0, 6);
}

const callRetro = traceable(
  async (input: { system: string; user: string }) => {
    const res = await claude().messages.parse({
      model: MODELS.ideate,
      max_tokens: 8000,
      system: input.system,
      output_config: { effort: "high", format: zodOutputFormat(RetroOut) },
      messages: [{ role: "user", content: input.user }],
    });
    if (!res.parsed_output) throw new Error(`retro: no parsed output (stop_reason=${res.stop_reason})`);
    return { ...res.parsed_output, usd: costUsd(MODELS.ideate, res.usage), run_id: getCurrentRunTree(true)?.id ?? null };
  },
  { name: "retro", run_type: "chain" },
);

export type RetroResult = { usd: number; proposals: number; feedback: number };

export async function retro(opts: { days?: number; post?: boolean } = {}): Promise<RetroResult> {
  const since = Date.now() - (opts.days ?? 7) * 86400000;
  const fb = readJsonl<Fb>(statePath("data", "feedback.jsonl")).filter((f) => new Date(f.at).getTime() >= since);
  const cards = new Map(["approved", "rejected", "drafted", "published"].flatMap((q) => listCards(q as "approved").map((c) => [c.meta.id, c] as const)));
  const fbText = fb
    .map((f) => {
      const c = cards.get(f.card);
      const b = c ? parseBody(c.body) : null;
      return `- ${f.verdict.toUpperCase()}${f.why ? ` ("${f.why}")` : ""}: ${b?.title ?? f.card}\n    hook: ${b?.hook ?? ""}\n    format: ${c?.meta.format ?? "?"} · ${c?.meta.platform ?? "?"} · grounded in work notes: ${(c?.meta.brain_refs?.length ?? 0) > 0}`;
    })
    .join("\n");
  const myPosts = readJsonl<{ id: string; first_line: string; likes: number; comments: number; at: string }>(statePath("data", "my-posts.jsonl"));
  const latest = new Map(myPosts.map((p) => [p.id, p]));
  const terms = loadTerms().terms.filter((t) => t.used_for.some((u) => u.endsWith("_search")));
  const user = [
    `VERDICTS THIS WEEK (${fb.length})\n${fbText || "(none)"}`,
    `HIS PUBLISHED POSTS AND HOW THEY DID\n${[...latest.values()].map((p) => `- ❤️${p.likes} 💬${p.comments} "${p.first_line}"`).join("\n") || "(none yet)"}`,
    `CURRENT "WHAT WORKS" MEMORY\n${readMemory("winning-patterns") || "(empty)"}`,
    `CURRENT "WHAT TO AVOID" MEMORY\n${readMemory("rejected") || "(empty)"}`,
    `CURRENT IDEATE PROMPT (for context on what rules already exist)\n${prompt("ideate").slice(0, 4000)}`,
  ].join("\n\n=====\n\n");
  const r = await callRetro({ system: prompt("retro"), user });

  fs.writeFileSync(statePath("memory", "winning-patterns.md"), `# What works\n\n_Updated by the retro on ${new Date().toISOString().slice(0, 10)}._\n\n${r.winning_patterns.trim()}\n`);
  fs.writeFileSync(statePath("memory", "rejected.md"), `# What to avoid\n\n_Updated by the retro on ${new Date().toISOString().slice(0, 10)}._\n\n${r.rejected_patterns.trim()}\n`);
  const covered = ["drafted", "published"].flatMap((q) => listCards(q as "drafted").map((c) => `- ${parseBody(c.body).title}`));
  fs.writeFileSync(statePath("memory", "topics-covered.md"), `# Topics already drafted or published\n\n${covered.join("\n") || "_none yet_"}\n`);

  const date = new Date().toISOString().slice(0, 10);
  const proposals: Proposal[] = [
    ...r.prompt_rules.map((p, i): Proposal => ({ id: `rule-${date}-${i}`, kind: "prompt_rule", prompt: p.prompt, rule: p.rule, evidence: p.evidence, status: "pending", created_at: new Date().toISOString() })),
    ...sourceProposals(),
  ];
  const all = [...loadProposals(), ...proposals];
  appendJsonl(statePath("data", "retros.jsonl"), [{ at: new Date().toISOString(), summary: r.summary, feedback: fb.length, proposals: proposals.map((p) => p.id), run_id: r.run_id, usd: r.usd }]);

  if (opts.post !== false && process.env.SLACK_BOT_TOKEN) {
    const channel = process.env.SLACK_CHANNEL || "content-agents";
    const approved = fb.filter((f) => f.verdict === "approve").length;
    const rejected = fb.filter((f) => f.verdict === "reject").length;
    const rewrites = fb.filter((f) => f.verdict === "rewrite").length;
    const searched = terms.map((t) => `${t.pinned ? "📌 " : ""}${t.term} (${t.pheromone.hits.toFixed(0)}/${(t.pheromone.hits + t.pheromone.misses).toFixed(0)})`).join(", ");
    const newCands = loadSources().sources.filter((s) => s.status === "candidate" && s.added_at && new Date(s.added_at).getTime() >= since);
    await postMessage(channel, "Weekly retro", [
      { type: "header", text: { type: "plain_text", text: `Weekly retro · ${date}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `${approved} approved · ${rejected} rejected · ${rewrites} rewrites · ${proposals.length} proposals below` }] },
      { type: "section", text: { type: "mrkdwn", text: `*What it learned*\n${r.summary.map((s) => `• ${s}`).join("\n")}`.slice(0, 2900) } },
      { type: "section", text: { type: "mrkdwn", text: `*Search terms* (strong/scored)\n${searched}`.slice(0, 2900) } },
      ...(newCands.length ? [{ type: "section", text: { type: "mrkdwn", text: `*New candidate sources this week* (${newCands.length})\n${newCands.slice(0, 12).map((s) => `• ${s.url ? `<${s.url}|${s.name ?? s.id}>` : s.id} — ${s.notes ?? s.discovered_via}`).join("\n")}`.slice(0, 2900) } }] : []),
    ]);
    for (const p of proposals) {
      const text = p.kind === "prompt_rule" ? `*Proposed rule for \`${p.prompt}\`*\n${p.rule}\n_Evidence: ${p.evidence}_` : `*${p.to === "active" ? "Promote" : p.to === "paused" ? "Pause" : "Retire"} source* \`${p.source_id}\`\n${p.reason}`;
      const m = await postMessage(channel, text.replace(/\*/g, ""), [
        { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } },
        { type: "actions", block_id: `proposal:${p.id}`.slice(0, 255), elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Accept" }, action_id: "accept_proposal", value: p.id },
          { type: "button", text: { type: "plain_text", text: "Skip" }, action_id: "skip_proposal", value: p.id },
        ] },
      ]);
      p.slack = { channel: m.channel, ts: m.ts };
    }
  }
  saveProposals(all);
  return { usd: r.usd, proposals: proposals.length, feedback: fb.length };
}

/** Apply or skip one proposal (from a Slack button). */
export async function decideProposal(id: string, decision: "accept" | "skip"): Promise<string> {
  const all = loadProposals();
  const p = all.find((x) => x.id === id);
  if (!p) return `proposal ${id} not found`;
  if (p.status !== "pending") return `already ${p.status}`;
  let line: string;
  if (decision === "skip") {
    p.status = "skipped";
    line = "⏭️ Skipped";
  } else if (p.kind === "prompt_rule") {
    addPromptRule(p.prompt, p.rule);
    p.status = "accepted";
    line = `✅ Accepted — added to \`${p.prompt}\` rules`;
  } else {
    const reg = loadSources();
    const s = findSource(reg, p.source_id);
    if (s) {
      s.status = p.to;
      s.notes = `${s.notes ?? ""} [${p.to} via retro ${p.created_at.slice(0, 10)}: ${p.reason}]`.trim();
      saveSources(reg);
    }
    p.status = "accepted";
    line = `✅ Accepted — \`${p.source_id}\` is now ${p.to}`;
  }
  saveProposals(all);
  if (p.slack) {
    const text = p.kind === "prompt_rule" ? `*Rule for \`${p.prompt}\`*\n${p.rule}` : `*${p.source_id}* → ${p.to}\n${p.reason}`;
    await updateMessage(p.slack.channel, p.slack.ts, line, [...sections(text), { type: "context", elements: [{ type: "mrkdwn", text: line }] }]).catch(() => {});
  }
  return line;
}
