import fs from "node:fs";
import path from "node:path";
import { statePath } from "./paths.js";
import type { Item } from "../../schemas/item.js";

export function itemsFile(type: string, publishedAt: string): string {
  return statePath("data", "items", type, `${publishedAt.slice(0, 7)}.jsonl`);
}

export function readJsonl<T = unknown>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

/** Strings sliced mid-emoji leave lone surrogates, which DuckDB rejects as malformed JSON. */
const wellFormed = (_k: string, v: unknown) => (typeof v === "string" ? v.toWellFormed() : v);

export function appendJsonl(file: string, rows: unknown[]): void {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r, wellFormed)).join("\n") + "\n");
}

/** All item ids already stored for a type (dedup). */
export function existingItemIds(type: string): Set<string> {
  const dir = statePath("data", "items", type);
  const ids = new Set<string>();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const it of readJsonl<Item>(path.join(dir, f))) ids.add(it.id);
  }
  return ids;
}

/** Write items, bucketed by published month, skipping ids already present. Returns count written. */
export function writeItems(items: Item[]): number {
  const byFile = new Map<string, Item[]>();
  const seen = new Map<string, Set<string>>();
  let n = 0;
  for (const it of items) {
    const f = itemsFile(it.type, it.published_at);
    if (!seen.has(f)) seen.set(f, new Set(readJsonl<Item>(f).map((x) => x.id)));
    if (seen.get(f)!.has(it.id)) continue;
    seen.get(f)!.add(it.id);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f)!.push(it);
    n++;
  }
  for (const [f, rows] of byFile) appendJsonl(f, rows);
  return n;
}
