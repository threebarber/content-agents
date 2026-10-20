import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * In Trigger.dev there is no persistent disk: clone the private state repo into a temp dir,
 * point STATE_DIR at it, and commit+push whatever a task changed. Locally, STATE_DIR=./state is
 * already a checkout and these become no-ops unless FORCE_STATE_CLONE=1.
 */
export function checkoutState(): string {
  const repo = process.env.STATE_REPO;
  const local = process.env.STATE_DIR;
  if (local && fs.existsSync(path.join(local, ".git")) && !process.env.FORCE_STATE_CLONE) return path.resolve(local);
  if (!repo) throw new Error("STATE_REPO not set and no local STATE_DIR checkout");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN required to clone STATE_REPO");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-state-"));
  execFileSync("git", ["clone", "--depth", "1", "--quiet", `https://x-access-token:${token}@github.com/${repo}.git`, dir], { stdio: "ignore" });
  process.env.STATE_DIR = dir;
  return dir;
}

export function commitState(dir: string, message: string): boolean {
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  run(["add", "-A"]);
  const status = run(["status", "--porcelain"]).trim();
  if (!status) return false;
  run(["-c", "user.name=content-agents", "-c", "user.email=content-agents@users.noreply.github.com", "commit", "-q", "-m", message]);
  if (process.env.STATE_REPO && process.env.GITHUB_TOKEN) {
    // rebase-safe push: pull first in case another task committed
    try {
      run(["pull", "--rebase", "-q"]);
    } catch {}
    run(["push", "-q"]);
  }
  return true;
}
