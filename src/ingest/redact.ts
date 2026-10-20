import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { statePath } from "../lib/paths.js";

const RedactFile = z.object({
  replacements: z.array(z.object({ pattern: z.string(), with: z.string(), flags: z.string().default("g") })).default([]),
  drop_if_match: z.array(z.string()).default([]),
  people_allowlist: z.array(z.string()).default([]),
});
export type RedactConfig = z.infer<typeof RedactFile>;

export function loadRedact(): RedactConfig {
  const f = statePath("config", "redact.yaml");
  return RedactFile.parse(fs.existsSync(f) ? YAML.parse(fs.readFileSync(f, "utf8")) : {});
}

export type Redacted = { text: string; replaced: number; dropped: boolean };

/** Pass 1: deterministic substitution + hard drops. Pass 2 (LLM check) lives in agents/ (Phase 1). */
export function redact(text: string, cfg: RedactConfig): Redacted {
  let out = text;
  let replaced = 0;
  for (const r of cfg.replacements) {
    const re = new RegExp(r.pattern, r.flags);
    out = out.replace(re, () => {
      replaced++;
      return r.with;
    });
  }
  const dropped = cfg.drop_if_match.some((p) => new RegExp(p).test(out));
  return { text: out, replaced, dropped };
}
