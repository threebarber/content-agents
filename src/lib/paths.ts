import path from "node:path";
import fs from "node:fs";

/** Root of the private state checkout. Defaults to ./state next to the code. */
export function stateDir(): string {
  const d = process.env.STATE_DIR ?? path.resolve(process.cwd(), "state");
  return d;
}
export function statePath(...parts: string[]): string {
  const p = path.join(stateDir(), ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
export function codeDir(): string {
  return process.cwd();
}
