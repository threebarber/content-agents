import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "langsmith/wrappers/anthropic";
import fs from "node:fs";
import path from "node:path";
import { statePath, codeDir } from "../lib/paths.js";

/** Models are config, not code. Defaults: Haiku for bulk extraction, Opus for ideation. */
export const MODELS = {
  distill: process.env.DISTILL_MODEL || "claude-haiku-5-5",
  ideate: process.env.IDEATE_MODEL || "claude-opus-5-5",
};

let client: Anthropic | null = null;

/** Anthropic client, traced to LangSmith when LANGSMITH_API_KEY is set. */
export function claude(): Anthropic {
  if (client) return client;
  if (process.env.CA_FAKE_LLM === "1") return (client = fakeClient() as unknown as Anthropic);
  // User-scoped keys (sk-ant-usr…) must name a workspace; workspace-scoped keys don't need it.
  const ws = process.env.ANTHROPIC_WORKSPACE_ID;
  const base = new Anthropic({ maxRetries: 4, ...(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {}) });
  client = process.env.LANGSMITH_API_KEY ? wrapAnthropic(base) : base;
  return client;
}

/**
 * Load a prompt: the public base (prompts/<name>.md) plus private learned rules accepted from retros
 * (state/prompts/rules/<name>.md). A full private override (state/prompts/overrides/<name>.md) still wins if present.
 */
export function prompt(name: string): string {
  return fillOwner(rawPrompt(name));
}

/** How prompts refer to the person this system writes for. Private: state/config/persona.yaml `name:` (default "the author"). */
export function ownerName(): string {
  const f = statePath("config", "persona.yaml");
  const m = fs.existsSync(f) ? fs.readFileSync(f, "utf8").match(/^name:\s*["']?([^"'\n]+)/m) : null;
  return m?.[1]?.trim() || "the author";
}
const fillOwner = (s: string) => s.replace(/\{\{owner\}\}/g, ownerName());

function rawPrompt(name: string): string {
  const override = statePath("prompts", "overrides", `${name}.md`);
  if (fs.existsSync(override)) return fs.readFileSync(override, "utf8");
  const base = fs.readFileSync(path.join(codeDir(), "prompts", `${name}.md`), "utf8");
  const rules = statePath("prompts", "rules", `${name}.md`);
  return fs.existsSync(rules) ? `${base.trim()}\n\nRules learned from the owner's feedback (follow these):\n${fs.readFileSync(rules, "utf8").trim()}\n` : base;
}

export function addPromptRule(name: string, rule: string): void {
  const f = statePath("prompts", "rules", `${name}.md`);
  fs.appendFileSync(f, `- ${rule.trim()}\n`);
}

export function readMemory(name: string): string {
  const f = statePath("memory", `${name}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "";
}

/** Rough cost tracker (per-MTok prices; update when models change). */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
export function costUsd(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null }): number {
  const [i, o] = PRICES[model] ?? [4, 20];
  return ((usage.input_tokens + (usage.cache_read_input_tokens ?? 0) * 0.1) * i + usage.output_tokens * o) / 1e6;
}

/**
 * Offline test mode (CA_FAKE_LLM=1): `messages.parse` returns whatever the registered handler builds for the request,
 * so the whole pipeline runs with no API calls. Tests register a handler with setFakeLLM().
 */
export type FakeRequest = { model: string; system?: string; messages: { content: unknown }[]; schemaKeys: string[] };
let fakeHandler: (r: FakeRequest) => unknown = () => {
  throw new Error("CA_FAKE_LLM=1 but no handler registered (setFakeLLM)");
};
export const fakeCalls: FakeRequest[] = [];
export function setFakeLLM(h: (r: FakeRequest) => unknown): void {
  fakeHandler = h;
  fakeCalls.length = 0;
}
function fakeClient() {
  return {
    messages: {
      parse: async (req: { model: string; system?: string; messages: { content: unknown }[]; output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } } }) => {
        const r: FakeRequest = { model: req.model, system: req.system, messages: req.messages, schemaKeys: Object.keys(req.output_config?.format?.schema?.properties ?? {}) };
        fakeCalls.push(r);
        return { parsed_output: fakeHandler(r), usage: { input_tokens: 1000, output_tokens: 200 }, stop_reason: "end_turn", content: [] };
      },
    },
  };
}
