import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars, additionalFiles } from "@trigger.dev/build/extensions/core";
import fs from "node:fs";
import { parseEnv } from "node:util";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_gbalbxpgxsjybcpcoqup",
  dirs: ["./src/trigger"],
  // Free plan: schedules must be ≥ hourly. Small machines are plenty for ingestion.
  machine: "small-1x",
  maxDuration: 1800,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 20000, factor: 2, randomize: true },
  },
  build: {
    // DuckDB ships a native binding: install it in the image instead of bundling it.
    external: ["@duckdb/node-api", "@duckdb/node-bindings"],
    extensions: [
      additionalFiles({ files: ["./prompts/**"] }),
      // On deploy, copy the app's env vars from the local .env into the target environment.
      // TRIGGER_* and STATE_DIR are deliberately excluded. Add GITHUB_TOKEN etc. to .env and redeploy.
      syncEnvVars(async () => {
        const keys = ["ANTHROPIC_WORKSPACE_ID", "STATE_REPO", "BRAIN_REPO", "STATE_GITHUB_TOKEN", "BRAIN_GITHUB_TOKEN", "ANTHROPIC_API_KEY", "APIFY_TOKEN", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_TRACING", "SLACK_BOT_TOKEN", "SLACK_CHANNEL", "SLACK_SIGNING_SECRET", "GITHUB_WEBHOOK_SECRET"];
        // Read .env directly: the CLI's own env loading doesn't reliably expose every key to this hook.
        const fromFile = fs.existsSync(".env") ? (parseEnv(fs.readFileSync(".env", "utf8")) as Record<string, string>) : {};
        const val = (k: string) => (fromFile[k] ?? process.env[k] ?? "").trim();
        return keys.filter((k) => val(k)).map((k) => ({ name: k, value: val(k) }));
      }),
    ],
  },
});
