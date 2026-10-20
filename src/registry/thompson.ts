import type { Source } from "../../schemas/source.js";
import type { Foraging } from "../../schemas/foraging.js";

/** Beta(a,b) sample via two gamma draws (Marsaglia–Tsang). */
export function sampleBeta(a: number, b: number, rng = Math.random): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y);
}
function sampleGamma(k: number, rng: () => number): number {
  if (k < 1) return sampleGamma(k + 1, rng) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function normal(rng: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type Allocation = { source: Source; items: number; lane: "exploit" | "explore" | "random" };

/**
 * Split an item budget across sources, ant-style:
 *  - exploit lane: active sources, Thompson-sampled on Beta(1+hits, 1+misses); budget ∝ sampled score
 *  - explore lane: candidate/trial sources, same sampling, gets `exploration_share` of the budget
 *  - random lane: `random_slot_per_run` uniformly random candidates get a trial-sized pull
 */
export function allocate(sources: Source[], budget: number, f: Foraging, rng = Math.random): Allocation[] {
  const active = sources.filter((s) => s.status === "active");
  const explorable = sources.filter((s) => s.status === "candidate" || s.status === "trial");
  const eps = Math.max(f.exploration_floor, f.exploration_share);
  const exploreBudget = explorable.length ? Math.round(budget * eps) : 0;
  const exploitBudget = budget - exploreBudget;
  const out: Allocation[] = [];

  const weigh = (xs: Source[]) =>
    xs.map((s) => ({ s, w: sampleBeta(1 + s.pheromone.hits, 1 + s.pheromone.misses, rng) }));

  if (active.length && exploitBudget > 0) {
    const w = weigh(active);
    const total = w.reduce((a, b) => a + b.w, 0) || 1;
    // floor of 1 item so no active source goes fully dark
    for (const { s, w: wi } of w) out.push({ source: s, items: Math.max(1, Math.round((wi / total) * exploitBudget)), lane: "exploit" });
  }
  if (explorable.length && exploreBudget > 0) {
    const randomPicks = new Set<string>();
    const pool = [...explorable];
    for (let i = 0; i < Math.min(f.random_slot_per_run, pool.length); i++) {
      const idx = Math.floor(rng() * pool.length);
      randomPicks.add(pool.splice(idx, 1)[0].id);
    }
    for (const id of randomPicks) out.push({ source: explorable.find((s) => s.id === id)!, items: f.trial.items, lane: "random" });
    const w = weigh(pool).sort((a, b) => b.w - a.w);
    const perTrial = f.trial.items;
    const n = Math.max(0, Math.floor((exploreBudget - randomPicks.size * perTrial) / perTrial));
    for (const { s } of w.slice(0, n)) out.push({ source: s, items: perTrial, lane: "explore" });
  }
  return out;
}
