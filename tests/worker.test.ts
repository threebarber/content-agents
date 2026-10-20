import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockFetch, calls, slackCalls, sign } from "./helpers.ts";

const worker = (await import("../slack-worker/src/index.ts")).default;
const env = { SLACK_SIGNING_SECRET: "s3cret", SLACK_BOT_TOKEN: "xoxb-t", TRIGGER_SECRET_KEY: "tr_prod_t" };
const W = "https://w.example";
const triggers = (task: string) => calls.filter((c) => c.url.includes(`/tasks/${task}/trigger`));

function post(path: string, body: string, headers: Record<string, string> = sign(env.SLACK_SIGNING_SECRET, body)) {
  return worker.fetch(new Request(W + path, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body }), env);
}
const action = (payload: object) => "payload=" + encodeURIComponent(JSON.stringify(payload));
const cardMsg = { blocks: [{ type: "header", text: { text: "A card" } }, { type: "actions", elements: [] }] };

beforeEach(() => mockFetch());

test("health and 404", async () => {
  assert.equal((await worker.fetch(new Request(W + "/health"), env)).status, 200);
  assert.equal((await post("/nope", "x")).status, 404);
});

test("bad and stale signatures are rejected", async () => {
  assert.equal((await post("/slack/actions", "payload=%7B%7D", { "x-slack-signature": "v0=bad", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)) })).status, 401);
  assert.equal((await post("/slack/actions", "payload=%7B%7D", sign(env.SLACK_SIGNING_SECRET, "payload=%7B%7D", Math.floor(Date.now() / 1000) - 600))).status, 401);
  assert.equal(calls.length, 0);
});

test("Approve: buttons swap to pending, card-verdict triggered with the message pointer", async () => {
  await post("/slack/actions", action({ type: "block_actions", user: { id: "U1", username: "u" }, actions: [{ action_id: "approve_card", value: "card-1" }], channel: { id: "C1" }, container: { message_ts: "111.1" }, message: cardMsg }));
  const upd = slackCalls("chat.update")[0].body;
  assert.ok(!upd.blocks.some((b: any) => b.type === "actions"), "buttons removed");
  const t = triggers("card-verdict")[0].body.payload;
  assert.deepEqual([t.cardId, t.verdict, t.slack.channel, t.slack.ts], ["card-1", "approve", "C1", "111.1"]);
});

test("Reject opens a form with the source rating and another-angle fields; Rewrite doesn't", async () => {
  await post("/slack/actions", action({ type: "block_actions", trigger_id: "T1", user: { id: "U1" }, actions: [{ action_id: "reject_card", value: "card-1" }], channel: { id: "C1" }, container: { message_ts: "111.1" }, message: cardMsg }));
  const v = slackCalls("views.open")[0].body.view;
  assert.deepEqual(v.blocks.map((b: any) => b.block_id).filter(Boolean), ["why", "source", "angle"]);
  assert.equal(triggers("card-verdict").length, 0, "nothing triggered until the form is submitted");
  await post("/slack/actions", action({ type: "block_actions", trigger_id: "T2", user: { id: "U1" }, actions: [{ action_id: "rewrite_card", value: "card-1" }], channel: { id: "C1" }, container: { message_ts: "111.1" }, message: cardMsg }));
  assert.deepEqual(slackCalls("views.open")[1].body.view.blocks.map((b: any) => b.block_id).filter(Boolean), ["why"]);
});

test("Submitting the reject form carries note, rating, and another-angle", async () => {
  const res = await post("/slack/actions", action({
    type: "view_submission", user: { username: "u" },
    view: { callback_id: "card_verdict", private_metadata: JSON.stringify({ cardId: "card-1", verdict: "reject", channel: "C1", ts: "111.1" }),
      state: { values: { why: { text: { value: "meh" } }, source: { rating: { selected_option: { value: "good" } } }, angle: { another: { selected_options: [{ value: "yes" }] } } } } },
  }));
  assert.deepEqual(await res.json(), { response_action: "clear" });
  const t = triggers("card-verdict")[0].body.payload;
  assert.deepEqual([t.verdict, t.why, t.sourceRating, t.anotherAngle], ["reject", "meh", "good", true]);
});

test("Retro proposal buttons trigger apply-proposal", async () => {
  await post("/slack/actions", action({ type: "block_actions", user: { username: "u" }, actions: [{ action_id: "skip_proposal", value: "rule-1" }], channel: { id: "C1" }, container: { message_ts: "9.9" }, message: { blocks: [] } }));
  assert.deepEqual(triggers("apply-proposal")[0].body.payload.decision, "skip");
});

test("Events: url_verification, link drop, and things that must be ignored", async () => {
  const ev = (o: object) => JSON.stringify(o);
  let res = await post("/slack/events", ev({ type: "url_verification", challenge: "abc" }));
  assert.equal((await res.json()).challenge, "abc");
  await post("/slack/events", ev({ type: "event_callback", event: { type: "message", user: "U1", channel: "C1", ts: "5.5", text: "look <https://alpha.substack.com/p/x|this> ok" } }));
  assert.equal(slackCalls("reactions.add").length, 1);
  assert.deepEqual(triggers("intake")[0].body.payload.urls, ["https://alpha.substack.com/p/x"]);
  for (const e of [{ bot_id: "B1", text: "<https://a.com>" }, { thread_ts: "1.0", text: "<https://a.com>" }, { text: "no links here" }, { subtype: "message_changed", text: "<https://a.com>" }])
    await post("/slack/events", ev({ type: "event_callback", event: { type: "message", user: "U1", channel: "C1", ts: "6.6", ...e } }));
  const retry = ev({ type: "event_callback", event: { type: "message", user: "U1", channel: "C1", ts: "7.7", text: "<https://a.com>" } });
  await post("/slack/events", retry, { ...sign(env.SLACK_SIGNING_SECRET, retry), "x-slack-retry-num": "1" });
  assert.equal(triggers("intake").length, 1, "bots, threads, edits, no-link messages, and retries are ignored");
});

test("/ca help answers directly; other subcommands go to the slash-command task", async () => {
  const help = await (await post("/slack/commands", new URLSearchParams({ text: "help", response_url: "https://hooks.slack.com/x" }).toString())).json();
  assert.match(help.text, /\/ca health/);
  assert.equal(triggers("slash-command").length, 0);
  const r = await (await post("/slack/commands", new URLSearchParams({ text: "pin gtm ai", user_name: "u", channel_id: "C1", response_url: "https://hooks.slack.com/x" }).toString())).json();
  assert.match(r.text, /⏳/);
  assert.equal(triggers("slash-command")[0].body.payload.text, "pin gtm ai");
});
