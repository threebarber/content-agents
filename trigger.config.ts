import { defineConfig } from "@trigger.dev/sdk";

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
  build: { extensions: [] },
});
