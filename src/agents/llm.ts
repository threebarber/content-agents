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
  // User-scoped keys (sk-ant-usr…) must name a workspace; workspace-scoped keys don't need it.
  const ws = process.env.ANTHROPIC_WORKSPACE_ID;
  const base = new Anthropic({ maxRetries: 4, ...(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {}) });
  client = process.env.LANGSMITH_API_KEY ? wrapAnthropic(base) : base;
  return client;
}

/** Load a prompt: state/prompts/overrides/<name>.md if present (private tweaks), else prompts/<name>.md (public). */
export function prompt(name: string): string {
  const override = statePath("prompts", "overrides", `${name}.md`);
  if (fs.existsSync(override)) return fs.readFileSync(override, "utf8");
  return fs.readFileSync(path.join(codeDir(), "prompts", `${name}.md`), "utf8");
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
