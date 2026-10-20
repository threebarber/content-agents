import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const DAY = 86400000;
export const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

/** Isolated env: temp state dir, fake model, fake Slack, no tracing, and no real network. */
export function testEnv(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-test-"));
  Object.assign(process.env, {
    STATE_DIR: dir,
    CA_FAKE_LLM: "1",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL: "C0TEST0001",
    APIFY_TOKEN: "apify-test",
    LANGSMITH_TRACING: "false",
    STATE_REPO: "",
  });
  delete process.env.LANGSMITH_API_KEY;
  delete process.env.STATE_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  return dir;
}

export function write(dir: string, rel: string, content: string) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
export const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

export type Call = { url: string; body: any };
export const calls: Call[] = [];
export const routes: { match: RegExp; reply: (url: string, body: any) => unknown }[] = [];

/** Replace fetch: Slack and Apify get canned replies, extra routes can be added, anything else throws. */
export function mockFetch() {
  calls.length = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    let body: any = init?.body;
    try {
      body = typeof body === "string" ? JSON.parse(body) : body;
    } catch {}
    calls.push({ url, body });
    const hit = routes.find((r) => r.match.test(url));
    let reply: unknown;
    if (hit) reply = hit.reply(url, body);
    else if (url.includes("slack.com/api/")) reply = { ok: true, ts: `1792.${calls.length}`, channel: "C0TEST0001", channels: [], messages: [{ blocks: [] }] };
    else if (url.includes("api.apify.com/v2/users/me/limits")) reply = { data: { current: { monthlyUsageUsd: 0.5 }, limits: { maxMonthlyUsageUsd: 5 } } };
    else if (url.includes("api.trigger.dev")) reply = { id: "run_test" };
    else throw new Error(`unexpected network call in test: ${url}`);
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status: 200, headers: { "content-type": typeof reply === "string" ? "text/html" : "application/json" } });
  }) as typeof fetch;
}
export const slackCalls = (method: string) => calls.filter((c) => c.url.endsWith(`/api/${method}`));

export function sign(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return { "x-slack-signature": "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex"), "x-slack-request-timestamp": String(ts) };
}

/** A small but complete state repo: sources, terms, config, newsletter + social + brain items, and swipe-file hooks. */
export function seedState(dir: string) {
  write(dir, "config/sources.yaml", `me:\n  linkedin_profile: null\n  hashnode_rss: null\nsources:
  - {id: substack:alpha, type: substack, name: Alpha GTM, author: Ann Alpha, url: https://alpha.substack.com, status: active, added_at: "2026-10-01", method: substack_api}
  - {id: substack:beta, type: substack, name: Beta Ops, author: Bo Beta, url: https://beta.substack.com, status: active, added_at: "2026-10-01", method: substack_api}
  - {id: linkedin:carol, type: linkedin, name: Carol C, author: Carol C, url: https://www.linkedin.com/in/carol/, status: candidate, added_at: "2026-10-01", method: apify}
`);
  write(dir, "config/terms.yaml", `terms:\n  - {id: term:gtm-engineering, term: gtm engineering, kind: topic, status: active, pinned: true, used_for: [tagging, linkedin_search, x_search]}\n  - {id: term:revops, term: revops, kind: topic, status: active, used_for: [tagging, linkedin_search]}\n`);
  write(dir, "config/foraging.yaml", "exploration_share: 0.2\n");
  write(dir, "config/budget.yaml", "monthly_usd: {apify: 4, anthropic: 8}\n");
  write(dir, "config/avoid-topics.yaml", `topics:\n  - {pattern: "\\\\bRFPs?\\\\b", why: "nobody cares about RFPs"}\n  - {pattern: "wrong (salesforce )?org|demo (org|env)\\\\b", why: "troubleshooting"}\n`);
  write(dir, "memory/facts.md", "# Facts\n\n- The Slack quoting bot is used by SEs in demos, not reps.\n");
  write(dir, "memory/rejected.md", "# What to avoid\n\n- [direct feedback] RFPs as a topic.\n");
  write(dir, "memory/winning-patterns.md", "# What works\n\n- Lead with a real number.\n");
  const m = (likes: number, comments: number) => ({ likes, comments, shares: 0, wordcount: 400 });
  const post = (id: string, src: string, type: string, author: string, title: string, likes: number, comments: number, days: number, extra: object = {}) => ({
    id, source_id: src, type, url: `https://example.com/${id.replace(/[^a-z0-9]/gi, "-")}`, title, author, published_at: iso(days),
    text: `${title}. A longer body about GTM engineering, signals, and agents in revenue teams. `.repeat(6), text_truncated: false,
    metrics: m(likes, comments), tags: [], paywalled: false, outbound_links: [], fetched_at: iso(0), ...extra,
  });
  const month = new Date().toISOString().slice(0, 7);
  write(dir, `data/items/substack/${month}.jsonl`, jsonl([
    post("substack:alpha.substack.com:1", "substack:alpha", "substack", "Ann Alpha", "Signals beat lists", 120, 30, 3, { outbound_links: ["https://gamma.substack.com/p/x"] }),
    post("substack:alpha.substack.com:2", "substack:alpha", "substack", "Ann Alpha", "Why RevOps owns the CRM", 20, 2, 5),
    post("substack:alpha.substack.com:3", "substack:alpha", "substack", "Ann Alpha", "Weekly links", 10, 1, 8),
    post("substack:beta.substack.com:1", "substack:beta", "substack", "Bo Beta", "The GTM engineer cost equation", 60, 12, 2),
  ]));
  write(dir, `data/items/linkedin/${month}.jsonl`, jsonl([
    post("linkedin:999", "linkedin:dave", "linkedin", "Dave D", "AI SDRs book meetings nobody reads", 300, 80, 1, { found_via: "term:revops", author_url: "https://www.linkedin.com/in/dave/" }),
  ]));
  const note = (proj: string, section: string, days: number, kind = "session") => ({
    id: `brain:sessions/2026-10/2026-10-1${days}-${proj}#${section}`, source_id: "brain", type: "rss", url: `brain://${proj}`, title: `${proj} — ${section}`,
    author: null, published_at: iso(days), text: `Built the ${proj} thing. Shipped a Slack bot in 30 minutes with Claude Code. `.repeat(8), text_truncated: false,
    metrics: { likes: null, comments: null, shares: null, wordcount: null }, tags: [kind], paywalled: false, outbound_links: [], fetched_at: iso(0),
  });
  write(dir, `data/items/brain/${month}.jsonl`, jsonl([note("quoting-bot", "accomplished", 2), note("quoting-bot", "roadblocks", 2), note("trial-monitor", "accomplished", 4), note("quoting-bot", "accomplished", 6)]));
  const hook = (item_id: string, source_id: string, author: string, title: string, z: number, hit: boolean) => ({
    item_id, source_id, author, title, url: `https://example.com/${item_id}`, published_at: iso(3), engagement_z: z, hit, model: "fake", distilled_at: iso(0),
    hook: `${title}: a real hook.`, hook_template: "[number] [audience] did [thing]", format: "data", topics: ["gtm engineering", "signals"], core_claim: `${title} claim`, why_it_worked: "a number", hook_quality: 4, relevance: 4,
  });
  write(dir, "data/hooks.jsonl", jsonl([
    hook("substack:alpha.substack.com:1", "substack:alpha", "Ann Alpha", "Signals beat lists", 1.4, true),
    hook("substack:beta.substack.com:1", "substack:beta", "Bo Beta", "The GTM engineer cost equation", 0.8, true),
    hook("linkedin:999", "linkedin:dave", "Dave D", "AI SDRs book meetings nobody reads", 1.1, true),
  ]));
}

export const goodCard = (over: Record<string, unknown> = {}) => ({
  riff_on: "substack:alpha.substack.com:1", their_point: "Ann said signals beat lists, with 120 likes.", riff_type: "extend",
  title: "47 signals and one I actually used", platform: "linkedin", hook: "I tracked 47 buying signals in Clay last month. 1 changed a deal.",
  hook_breakdown: "a number and a twist", angle: "your take", outline: ["a", "b", "c"], format: "data",
  hook_template_used: "the stat line", brain_refs: ["sessions/2026-10/2026-10-12-quoting-bot"], evidence: [{ item_id: "substack:alpha.substack.com:1", why: "riff" }],
  why_now: "this week", predicted_score: 7, ...over,
});
