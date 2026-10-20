import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

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
    extensions: [
      // On deploy, copy the app's env vars from the local .env into the target environment.
      // TRIGGER_* and STATE_DIR are deliberately excluded. Add GITHUB_TOKEN etc. to .env and redeploy.
      syncEnvVars(async () => {
        const keys = ["STATE_REPO", "BRAIN_REPO", "GITHUB_TOKEN", "BRAIN_GITHUB_TOKEN", "ANTHROPIC_API_KEY", "APIFY_TOKEN", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_TRACING", "SLACK_WEBHOOK_URL", "SLACK_SIGNING_SECRET", "GITHUB_WEBHOOK_SECRET"];
        return keys.filter((k) => process.env[k]).map((k) => ({ name: k, value: process.env[k]! }));
      }),
    ],
  },
});
