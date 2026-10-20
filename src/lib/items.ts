import fs from "node:fs";
import path from "node:path";
import { statePath } from "./paths.js";
import type { Item } from "../../schemas/item.js";

/** Look up stored items by id across data/items/<type>/*.jsonl (cheap prefix match, then parse). */
export function itemsById(ids: string[]): Map<string, Item> {
  const want = new Set(ids);
  const out = new Map<string, Item>();
  if (!want.size) return out;
  const base = path.dirname(statePath("data", "items", ".x"));
  for (const type of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const dir = path.join(base, type);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line) continue;
        const id = line.match(/^\{"id":"([^"]+)"/)?.[1];
        if (id && want.has(id)) out.set(id, JSON.parse(line));
      }
    }
  }
  return out;
}
