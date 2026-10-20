import { test } from "node:test";
import assert from "node:assert/strict";
import { testEnv, seedState, goodCard } from "./helpers.ts";

const dir = testEnv();
seedState(dir);

const { detect } = await import("../src/registry/detect.ts");
const { allocate, sampleBeta } = await import("../src/registry/thompson.ts");
const { decay, hit, isoWeek } = await import("../src/registry/pheromone.ts");
const { normalizeUrl, loadSources, loadForaging } = await import("../src/registry/store.ts");
const { slugGuesses } = await import("../src/registry/resolve.ts");
const { verifyCards, normalizeRefs, projectKey } = await import("../src/agents/ideate.ts");
const { redact } = await import("../src/ingest/redact.ts");
const { sections } = await import("../src/ingest/brain.ts");
const { htmlToText, extractLinks } = await import("../src/lib/http.ts");
const { cardBody } = await import("../src/agents/cards.ts");
const { parseBody } = await import("../src/agents/slack-cards.ts");

test("detect classifies sources and posts", () => {
  assert.deepEqual(detect("https://alpha.substack.com/p/hello")?.kind, "post");
  assert.equal(detect("alpha.substack.com")?.kind, "source");
  assert.equal(detect("https://www.linkedin.com/in/carol/?x=1")?.url, "https://www.linkedin.com/in/carol/");
  assert.equal(detect("https://www.linkedin.com/posts/carol_abc-activity-123")?.kind, "post");
  assert.equal(detect("https://x.com/dan/status/123")?.kind, "post");
  assert.equal(detect("https://twitter.com/dan")?.url, "https://x.com/dan");
  assert.equal(detect("@dan")?.type, "x");
  assert.equal(detect("https://www.growthunhinged.com/p/x")?.type, "substack"); // /p/ on a custom domain
});

test("normalizeUrl strips www, query, trailing slash", () => {
  assert.equal(normalizeUrl("https://www.Foo.com/bar/?q=1#x"), "https://foo.com/bar");
});

test("slug guesses include author and name forms", () => {
  const g = slugGuesses("The Signal", "Brendan J Short");
  for (const s of ["signal", "brendanjshort", "short"]) assert.ok(g.includes(s), s);
});

test("Thompson sampling: exploit + explore + one random lane", () => {
  for (let i = 0; i < 200; i++) {
    const b = sampleBeta(2, 5);
    assert.ok(b > 0 && b < 1);
  }
  const reg = loadSources();
  const alloc = allocate(reg.sources, 100, loadForaging());
  assert.ok(alloc.some((a) => a.lane === "exploit"));
  assert.ok(alloc.some((a) => a.lane === "random"), "a candidate must always be reachable");
  assert.ok(alloc.filter((a) => a.lane === "exploit").every((a) => a.items >= 1), "no active source goes dark");
});

test("pheromone decay is idempotent within an ISO week", () => {
  const s = loadSources().sources[0];
  hit(s, 10);
  const fo = loadForaging();
  assert.equal(decay(s, fo), true);
  const after = s.pheromone.hits;
  assert.equal(decay(s, fo), false);
  assert.equal(s.pheromone.hits, after);
  assert.match(isoWeek(new Date("2026-10-20")), /^2026-W43$/);
});

test("generic hooks are flagged, specific ones pass", () => {
  const bad = [
    "trusted output is earned by checks, not context",
    "demand gen never existed. it was always demand capture.",
    "AI SDRs aren’t replacing reps, they’re replacing bad lists.",
    "most teams think about context wrong.",
  ];
  const good = ["I tracked 47 buying signals in Clay last month. 1 changed a deal.", "Ask ChatGPT who builds the best Clay tables. Go ahead. I’ll wait."];
  const cards = [...bad, ...good].map((hook, i) => goodCard({ hook, riff_on: null, brain_refs: [], hook_template_used: `move ${i}` }));
  const issues = verifyCards(cards as never, [], 0);
  bad.forEach((_, i) => assert.ok(issues.has(i), `should flag: ${bad[i]}`));
  good.forEach((_, i) => assert.ok(!issues.has(bad.length + i), `should pass: ${good[i]} → ${issues.get(bad.length + i)}`));
});

test("checker enforces avoid topics, riff ids, duplicates, and project spread", () => {
  const hooks = [{ item_id: "substack:alpha.substack.com:1" }, { item_id: "substack:beta.substack.com:1" }] as never;
  const cards = [
    goodCard({ title: "How I measure an RFP agent", hook: "57 RFP rows. 11 failed." }),
    goodCard({ riff_on: "nope:1", hook_template_used: "b" }),
    goodCard({ riff_on: "substack:beta.substack.com:1", hook_template_used: "c", brain_refs: ["brain:sessions/2026-10/2026-10-12-quoting-bot#a"] }),
    goodCard({ riff_on: "substack:beta.substack.com:1", hook_template_used: "d", brain_refs: ["brain:sessions/2026-10/2026-10-14-quoting-bot#a"] }),
    goodCard({ title: "Wrong Salesforce org for a week", hook: "For 7 days every check hit the wrong Salesforce org.", riff_on: null, hook_template_used: "e" }),
  ];
  const issues = verifyCards(cards as never, hooks, 0);
  assert.match(issues.get(0)!.join(), /never-the-topic/);
  assert.match(issues.get(1)!.join(), /not a SWIPE FILE id/);
  assert.match(issues.get(3)!.join(), /same post as card 3/);
  assert.match(issues.get(3)!.join(), /third card leaning on the same work project/);
  assert.match(issues.get(4)!.join(), /troubleshooting/);
});

test("work-note references snap to exact ids; project keys group sessions", () => {
  const known = ["brain:sessions/2026-10/2026-10-12-quoting-bot#accomplished", "brain:projects/dealroom#top"];
  assert.deepEqual(normalizeRefs(["sessions/2026-10/2026-10-12-quoting-bot", "projects/dealroom#top", "made/up"], known), known);
  assert.equal(projectKey("brain:sessions/2026-10/2026-10-19-golden-rfp#x"), "golden-rfp");
  assert.equal(projectKey("brain:projects/dealroom.log#top"), "dealroom");
});

test("redaction substitutes names/links and drops secrets", () => {
  const cfg = { replacements: [{ pattern: "\\b(Acme)\\b", with: "[customer]", flags: "gi" }, { pattern: "https?://[^\\s)]*slack\\.com[^\\s)]*", with: "[slack-link]", flags: "g" }, { pattern: "\\b(?:ghp)[A-Za-z0-9_-]{10,}\\b", with: "[secret]", flags: "g" }], drop_if_match: ["\\[secret\\]"], people_allowlist: [] };
  const r = redact("Acme asked in https://x.slack.com/archives/C1/p2 about acme", cfg);
  assert.equal(r.text, "[customer] asked in [slack-link] about [customer]");
  assert.equal(r.dropped, false);
  assert.equal(redact("token ghpABCDEFGHIJKLMNOP", cfg).dropped, true);
});

test("markdown sections split on ## headings", () => {
  const s = sections("intro\n## Accomplished\n- a\n## Roadblocks\n- b\n");
  assert.deepEqual(s.map((x) => x.heading), ["", "Accomplished", "Roadblocks"]);
});

test("html to text and link extraction", () => {
  assert.equal(htmlToText("<p>a &amp; b</p><p>c</p>").text, "a & b\nc");
  assert.deepEqual(extractLinks('<a href="https://a.com/x?y=1">x</a>'), ["https://a.com/x"]);
});

test("card body round-trips through the Slack parser", () => {
  const c = goodCard({ hook: "line one\nline two" });
  const p = parseBody(cardBody(c as never));
  assert.equal(p.title, c.title);
  assert.equal(p.hook, "line one\nline two");
  assert.equal(p.angle, "your take");
  assert.equal(p.template, "the stat line");
});
