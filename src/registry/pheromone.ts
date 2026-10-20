import type { Source } from "../../schemas/source.js";
import type { Term } from "../../schemas/term.js";
import type { Foraging } from "../../schemas/foraging.js";

type HasPheromone = Source | Term;

export function hit(x: HasPheromone, n = 1, at = new Date().toISOString()): void {
  x.pheromone.hits += n;
  x.pheromone.last_hit_at = at;
}
export function miss(x: HasPheromone, n = 1): void {
  x.pheromone.misses += n;
}

/** Weekly evaporation. Idempotent per ISO week. */
export function decay(x: HasPheromone, f: Foraging, now = new Date()): boolean {
  const wk = isoWeek(now);
  if (x.pheromone.decayed_at === wk) return false;
  x.pheromone.hits = round(x.pheromone.hits * f.decay_factor_weekly);
  x.pheromone.misses = round(x.pheromone.misses * f.decay_factor_weekly);
  x.pheromone.decayed_at = wk;
  return true;
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
const round = (n: number) => Math.round(n * 1000) / 1000;
