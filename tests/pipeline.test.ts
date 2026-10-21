import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { testEnv, seedState, mockFetch, routes, slackCalls, goodCard, write, iso } from "./helpers.ts";

const dir = testEnv();
seedState(dir);

const { setFakeLLM, fakeCalls, prompt } = await import("../src/agents/llm.ts");
const { ideate } = await import("../src/agents/ideate.ts");
const { cardBody, writeCard, listCards, readCard } = await import("../src/agents/cards.ts");
const { sweepFeedback } = await import("../src/agents/feedback.ts");
const { loadSources } = await import("../src/registry/store.ts");
const { distill, loadHooks } = await import("../src/agents/distill.ts");
const { intake } = await import("../src/agents/intake.ts");
const { retro, decideProposal, loadProposals } = await import("../src/agents/retro.ts");
const { health } = await import("../src/agents/health.ts");

/** One fake model for every stage, chosen by the requested output schema. */
let ideateRound = 0;
function fakeModel() {
  setFakeLLM((r) => {
    const user = JSON.stringify(r.messages);
    if (r.schemaKeys.includes("hook_template")) return { hook: "a hook", hook_template: "[x] did [y]", format: "Data!", topics: ["gtm engineering"], core_claim: "c", why_it_worked: "w", hook_quality: 5, relevance: 5 };
    if (r.schemaKeys.includes("draft")) return { draft: "para one\n\npara two", notes: "- check the number" };
    if (r.schemaKeys.includes("breakdown")) return { breakdown: "a number" };
    if (r.schemaKeys.includes("summary")) return { summary: ["rejects plumbing"], winning_patterns: ["# What works", "_stamp_", "- numbers", "1. numbers"], rejected_patterns: ["- plumbing"], prompt_rules: [{ prompt: "ideate", rule: "Lead with the audience's problem.", evidence: "2 rejects" }] };
    if (r.schemaKeys.includes("cards")) {
      ideateRound++;
      if (user.includes("REVISION REQUIRED")) return { cards: [goodCard({ title: "Repaired card", hook: "3 SEs, 1 Slack bot, 30 minutes.", riff_on: "linkedin:999", hook_template_used: "fixed move", brain_refs: [] })] };
      if (user.includes("REWRITE REQUEST") || user.includes("ANOTHER ANGLE REQUEST") || user.includes("SAVED POST(S)"))
        return { cards: [goodCard({ title: `Follow-up ${ideateRound}`, riff_type: "disagree", hook_template_used: `fu ${ideateRound}` })] };
      return { cards: [
        goodCard(),
        goodCard({ title: "Signals are earned, not bought", hook: "signals are earned, not bought.", riff_on: "substack:beta.substack.com:1", hook_template_used: "aphorism" }),
      ] };
    }
    throw new Error(`unexpected schema ${r.schemaKeys}`);
  });
}

beforeEach(() => {
  mockFetch();
  fakeModel();
});

test("ideate: generic card is caught, repaired once, and cards are written with resolved references", async () => {
  const r = await ideate({ n: 2 });
  assert.equal(r.files.length, 2);
  assert.equal(fakeCalls.filter((c) => c.schemaKeys.includes("cards")).length, 2, "one generation + one repair");
  const cards = r.files.map((f) => readCard(f));
  assert.ok(cards.some((c) => c.body.startsWith("# Repaired card")), "aphorism card replaced");
  assert.ok(!cards.some((c) => /earned, not bought/.test(c.body)));
  const first = cards.find((c) => c.meta.riff_on === "substack:alpha.substack.com:1")!;
  assert.deepEqual(first.meta.brain_refs, ["brain:sessions/2026-10/2026-10-12-quoting-bot#accomplished"], "model's loose ref snapped to the real note id");
  assert.ok(first.meta.sources.includes("substack:alpha"));
  assert.ok(first.meta.slack?.ts, "Slack message pointer recorded");
  assert.equal(first.meta.content?.title, first.body.split("\n")[0].slice(2), "structured content stored alongside the markdown");
  assert.equal(first.meta.format, "data");
  const prompt0 = JSON.stringify(fakeCalls[0].messages);
  for (const must of ["FACTS ABOUT THEIR WORK", "SEs in demos", "NEVER THE TOPIC", "RFPs", "Signals beat lists", "excerpt:"]) assert.ok(prompt0.includes(must), `ideation input includes ${must}`);
  assert.ok(!prompt0.includes("roadblocks"), "bug-note sections are not fed to ideation");
});

function card(id: string, over: Record<string, unknown> = {}) {
  const meta = { id, created_at: iso(0), platform: "linkedin" as const, verdict: "pending" as const, why: "", predicted_score: 7, format: "data", sources: ["substack:alpha"], evidence: ["substack:alpha.substack.com:1"], brain_refs: [], seed: null, langsmith_run_id: null, model: "fake", published_url: "", riff_on: "substack:alpha.substack.com:1", riff_type: "extend", slack: { channel: "C0TEST0001", ts: "1.1" }, ...over };
  return writeCard("inbox", meta as never, cardBody(goodCard() as never));
}
const score = (id: string) => loadSources().sources.find((s) => s.id === id)?.pheromone;
const feedbackRows = () => fs.readFileSync(path.join(dir, "data/feedback.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("verdicts: approve drafts + credits; rejects move scores only when rated; another angle and rewrite regenerate", async () => {
  for (const q of ["inbox"] as const) for (const c of listCards(q)) fs.unlinkSync(c.file);
  const before = { ...score("substack:alpha")! };
  card("c-approve", { verdict: "approve" });
  card("c-neutral", { verdict: "reject", source_rating: "neutral" });
  const r1 = await sweepFeedback();
  assert.deepEqual([r1.approved, r1.rejected], [1, 1]);
  assert.equal(listCards("drafted").length, 1, "approved card drafted");
  assert.equal(listCards("approved").length, 0, "nothing stuck in approved");
  assert.match(readCard(listCards("drafted")[0].file).body, /## Draft \(4 words\)/);
  assert.ok(slackCalls("chat.postMessage").some((c) => c.body.thread_ts === "1.1"), "draft posted in the card's thread");
  assert.equal(score("substack:alpha")!.hits, before.hits + 2, "approve credits the source");
  assert.equal(score("substack:alpha")!.misses, before.misses, "neutral reject leaves the source alone");

  card("c-good", { verdict: "reject", source_rating: "good", another_angle: true, riff_on: "linkedin:999", sources: [] });
  card("c-bad", { verdict: "reject", source_rating: "bad" });
  card("c-rewrite", { verdict: "rewrite", why: "less negative" });
  const r2 = await sweepFeedback();
  assert.deepEqual([r2.rejected, r2.rewritten], [2, 1]);
  assert.equal(score("substack:alpha")!.misses, before.misses + 2, "'not worth riffing on' docks the source twice");
  const dave = loadSources().sources.find((s) => s.id === "linkedin:dave");
  assert.ok(dave && dave.status === "candidate" && dave.pheromone.hits === 1, "a good-rated unfollowed author becomes a candidate with +1");
  const inbox = listCards("inbox");
  assert.ok(inbox.some((c) => c.meta.seed === "angle:c-good" && c.meta.riff_on === "linkedin:999"), "another angle stays on the same post");
  assert.ok(inbox.some((c) => c.meta.seed === "rewrite:c-rewrite"), "rewrite produced a replacement");
  const rows = feedbackRows();
  assert.deepEqual(rows.map((r) => [r.card, r.verdict, r.source_rating]).sort(), [["c-approve", "approve", "good"], ["c-bad", "reject", "bad"], ["c-good", "reject", "good"], ["c-neutral", "reject", "neutral"], ["c-rewrite", "rewrite", null]]);
  assert.equal(listCards("rejected").length, 4);
});

test("distill: new posts land in the swipe file, format normalized, strong posts lay candidate trails", async () => {
  const month = new Date().toISOString().slice(0, 7);
  fs.appendFileSync(path.join(dir, `data/items/linkedin/${month}.jsonl`), JSON.stringify({ id: "linkedin:1000", source_id: "linkedin:erin", type: "linkedin", url: "https://example.com/e", title: "Erin post", author: "Erin E", published_at: iso(1), text: "Erin wrote about GTM agents with real numbers.", text_truncated: false, metrics: { likes: 200, comments: 40, shares: 1, wordcount: 50 }, tags: [], paywalled: false, outbound_links: [], fetched_at: iso(0), found_via: "term:revops", author_url: "https://www.linkedin.com/in/erin/" }) + "\n");
  const before = loadHooks().length;
  const r = await distill({ limit: 50 });
  assert.ok(r.distilled >= 1 && r.failed === 0);
  assert.equal(loadHooks().length, before + r.distilled);
  assert.equal(loadHooks().find((h) => h.item_id === "linkedin:1000")?.format, "data", "\"Data!\" normalized");
  assert.ok(r.candidates.includes("linkedin:erin"), "engaged, relevant author becomes a candidate");
});

test("intake: a pasted Substack link is saved, credited +3, distilled, and riffed in the thread", async () => {
  routes.push({ match: /gamma\.substack\.com\/api\/v1\/posts\/hello/, reply: () => ({ id: 77, title: "Hello GTM", slug: "hello", canonical_url: "https://gamma.substack.com/p/hello", post_date: iso(1), audience: "everyone", reactions: { "❤": 9 }, comment_count: 2, body_html: "<p>Agents in revops, 40 teams surveyed.</p>", publishedBylines: [{ name: "Gus Gamma" }] }) });
  write(dir, "config/sources.yaml", fs.readFileSync(path.join(dir, "config/sources.yaml"), "utf8").replace("sources:\n", "sources:\n  - {id: substack:gamma, type: substack, url: https://gamma.substack.com, status: active, added_at: \"2026-10-01\", method: substack_api}\n"));
  const r = await intake({ text: "love this <https://gamma.substack.com/p/hello>", urls: ["https://gamma.substack.com/p/hello"], files: [], channel: "C0TEST0001", ts: "9.9" });
  assert.deepEqual(r.saved, ["substack:gamma.substack.com:77"]);
  assert.ok(r.cards >= 1);
  const riffs = listCards("inbox").filter((c) => c.meta.seed?.startsWith("saved:")).map((c) => c.meta.riff_on);
  assert.ok(riffs.length && riffs.every((x) => x === "substack:gamma.substack.com:77"), `saved-post cards riff on the saved post, got ${riffs}`);
  const savedPrompt = JSON.stringify(fakeCalls.find((c) => JSON.stringify(c.messages).includes("SAVED POST(S)"))!.messages);
  assert.ok(!savedPrompt.includes("Signals beat lists"), "other people's posts are not in a saved-link prompt");
  assert.equal(loadSources().sources.find((s) => s.id === "substack:gamma")!.pheromone.hits >= 3, true);
  assert.ok(loadHooks().some((h) => h.item_id === "substack:gamma.substack.com:77"));
  assert.ok(slackCalls("chat.postMessage").some((c) => c.body.thread_ts === "9.9"));
});

test("retro: memory rewritten without echoed headings; accepted rule reaches the prompt", async () => {
  const r = await retro({});
  assert.ok(r.feedback >= 5 && r.proposals >= 1);
  const wp = fs.readFileSync(path.join(dir, "memory/winning-patterns.md"), "utf8");
  assert.equal((wp.match(/^# /gm) ?? []).length, 1, "single heading");
  assert.ok(!wp.includes("_stamp_"));
  assert.equal((wp.match(/^- numbers$/gm) ?? []).length, 1, "markdown stripped and duplicates merged in code");
  const avoid = fs.readFileSync(path.join(dir, "memory/rejected.md"), "utf8");
  assert.match(avoid, /^- \[direct feedback\] RFPs as a topic\.$/m, "direct feedback survives even though the model dropped it");
  assert.match(avoid, /^- plumbing$/m);
  const rule = loadProposals().find((p) => p.kind === "prompt_rule")!;
  assert.match(await decideProposal(rule.id, "accept"), /Accepted/);
  assert.match(prompt("ideate"), /Lead with the audience's problem\./);
  assert.match(await decideProposal(rule.id, "accept"), /already accepted/, "double click is harmless");
});

test("health runs end to end on this state and catches a planted broken reference", async () => {
  let checks = await health();
  const names = checks.map((c) => c.name);
  for (const n of ["every post in the swipe file", "every verdict recorded", "cards cite real posts", "idea generator receives memory"]) assert.ok(names.includes(n), n);
  assert.equal(checks.find((c) => c.name === "every verdict recorded")!.status, "ok");
  card("c-broken", { riff_on: "substack:nope:404", evidence: ["substack:nope:404"] });
  checks = await health();
  assert.equal(checks.find((c) => c.name === "cards cite real posts")!.status, "fail");
});

test("your-post tracking keeps only posts you wrote", async () => {
  const { trackMyPosts } = await import("../src/agents/social.ts");
  const p = (id: string, who: string) => ({ id, type: "post", linkedinUrl: `https://www.linkedin.com/posts/${id}`, content: `post ${id}`, postedAt: { date: iso(1) }, author: { name: who, publicIdentifier: who, linkedinUrl: `https://www.linkedin.com/in/${who}` }, engagement: { likes: 4, comments: 1, shares: 0 } });
  routes.push({ match: /linkedin-profile-posts/, reply: () => [p("111", "me-handle"), p("222", "some-company")] });
  assert.equal(await trackMyPosts("https://www.linkedin.com/in/me-handle/"), 1);
  const snap = fs.readFileSync(path.join(dir, "data/my-posts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(snap.map((s) => s.id), ["linkedin:111"]);
});

test("dedupe: re-pasting a link doesn't re-credit or re-riff; /ca source and pin don't duplicate", async () => {
  routes.push({ match: /gamma\.substack\.com\/api\/v1\/posts\/hello/, reply: () => ({ id: 77, title: "Hello GTM", slug: "hello", canonical_url: "https://gamma.substack.com/p/hello", post_date: iso(1), audience: "everyone", reactions: { "❤": 9 }, comment_count: 2, body_html: "<p>x</p>", publishedBylines: [{ name: "Gus Gamma" }] }) });
  const hitsBefore = loadSources().sources.find((s) => s.id === "substack:gamma")!.pheromone.hits;
  const r = await intake({ text: "<https://gamma.substack.com/p/hello>", urls: ["https://gamma.substack.com/p/hello"], files: [], channel: "C0TEST0001", ts: "9.10" });
  assert.deepEqual([r.saved.length, r.cards, r.repeats.length], [0, 0, 1]);
  assert.equal(loadSources().sources.find((s) => s.id === "substack:gamma")!.pheromone.hits, hitsBefore);
  assert.match(slackCalls("chat.postMessage").at(-1)!.body.text, /Already saved/);

  const { addSource, pinTerm } = await import("../src/agents/slash.ts");
  routes.push({ match: /^https:\/\/carol-redirect\.example/, reply: () => "<html></html>" });
  assert.match(await addSource("https://www.linkedin.com/in/Carol/"), /Already following `linkedin:carol`/);
  const n = loadSources().sources.length;
  pinTerm("GTM Engineering");
  pinTerm("gtm engineering");
  const { loadTerms } = await import("../src/registry/store.ts");
  assert.equal(loadTerms().terms.filter((t) => t.term.toLowerCase() === "gtm engineering").length, 1);
  assert.equal(loadSources().sources.length, n);
});

test("a post the model declines is recorded as skipped, counted as a miss, and never retried", async () => {
  const month = new Date().toISOString().slice(0, 7);
  fs.mkdirSync(path.join(dir, "data/items/x"), { recursive: true });
  fs.appendFileSync(path.join(dir, `data/items/x/${month}.jsonl`), JSON.stringify({ id: "x:42", source_id: "x:someone", type: "x", url: "https://x.com/s/status/42", title: "off topic", author: "someone", published_at: iso(1), text: "off-topic tooling", text_truncated: false, metrics: { likes: 20, comments: 1, shares: 0, wordcount: 2 }, tags: [], paywalled: false, outbound_links: [], fetched_at: iso(0), found_via: "term:revops" }) + "\n");
  const missesBefore = (await import("../src/registry/store.ts")).loadTerms().terms.find((t) => t.id === "term:revops")!.pheromone.misses;
  const { setFakeLLM: set } = await import("../src/agents/llm.ts");
  set(() => null); // parse returns no output…
  const llm = await import("../src/agents/llm.ts");
  const orig = llm.claude().messages.parse;
  (llm.claude().messages as { parse: unknown }).parse = async (...a: unknown[]) => ({ ...(await (orig as (...x: unknown[]) => Promise<object>)(...a)), stop_reason: "refusal" });
  const r = await distill({ limit: 50 });
  (llm.claude().messages as { parse: unknown }).parse = orig;
  assert.equal(r.failed, 0);
  assert.equal(loadHooks().find((h) => h.item_id === "x:42")?.skipped, "model declined");
  assert.equal((await import("../src/registry/store.ts")).loadTerms().terms.find((t) => t.id === "term:revops")!.pheromone.misses, missesBefore + 1);
  fakeModel();
  assert.equal((await distill({ limit: 50 })).distilled, 0, "not retried");
});

test("scheduled batch path: Batch API first pass at half price; prompt cache breakpoint sits between stable and volatile parts", async () => {
  const llm = await import("../src/agents/llm.ts");
  llm.resetTally();
  const sleeps: number[] = [];
  const r = await ideate({ n: 2, post: false, batch: { sleep: async (ms) => void sleeps.push(ms), deadlineMs: Date.now() + 60_000 } });
  assert.equal(r.files.length, 2);
  assert.ok(sleeps.length >= 1, "polled the batch");
  const cardCalls = fakeCalls.filter((c) => c.schemaKeys.includes("cards"));
  const content = cardCalls[0].messages[0].content as { text: string; cache_control?: unknown }[];
  assert.equal(content.length, 2);
  assert.deepEqual(content[0].cache_control, { type: "ephemeral" });
  assert.match(content[0].text, /SWIPE FILE/);
  assert.match(content[0].text, /FACTS ABOUT THEIR WORK/);
  assert.ok(!content[0].text.includes("ALREADY COVERED"), "changing data stays out of the cached block");
  assert.match(content[1].text, /ALREADY COVERED[\s\S]*Write 2 cards\./);
  // first pass billed at batch rates, repair at normal rates: 1000 in / 200 out on Opus → $0.008 normal, $0.004 batch
  assert.equal(llm.tokenTally.usd.toFixed(4), (0.004 + 0.008).toFixed(4));
  assert.equal(llm.costUsd("claude-opus-5-5", { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 }).toFixed(4), "0.0080");
});

test("click-driven calls share the exact cached prefix with each other", async () => {
  const { ideateOne } = await import("../src/agents/ideate.ts");
  const c = readCard(card("c-prefix", { verdict: "rewrite", why: "shorter" }));
  await ideateOne(c);
  await ideateOne(c);
  const blocks = fakeCalls.filter((x) => x.schemaKeys.includes("cards")).map((x) => (x.messages[0].content as { text: string }[])[0].text);
  assert.equal(blocks.at(-1), blocks.at(-2), "identical stable block → cache hit on the second click");
});

test("short links are expanded before they're classified", async () => {
  const { expandUrl } = await import("../src/lib/http.ts");
  const target = "https://www.linkedin.com/posts/joerhew_the-og-gtm-engineers-share-7518693931749064704-j6rF/?utm_source=share";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => ({ url: u.includes("lnkd.in") ? target : u })) as never;
  try {
    assert.equal(await expandUrl("https://lnkd.in/p/gkKXF64h"), target);
    assert.equal(await expandUrl("https://alpha.substack.com/p/x"), "https://alpha.substack.com/p/x", "non-shorteners untouched");
  } finally {
    globalThis.fetch = realFetch;
  }
  const { detect } = await import("../src/registry/detect.ts");
  assert.equal(detect(target)?.kind, "post");
  assert.equal(detect(target)?.type, "linkedin");
});
