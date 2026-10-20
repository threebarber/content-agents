/**
 * Slack interactivity endpoint for content-agents.
 * /slack/actions  – card buttons (Approve now; Reject/Rewrite open a note modal) and retro proposal buttons
 * /slack/events   – a link or screenshot posted in the channel (or a DM) → `intake` task
 * /slack/commands – `/ca …` → `slash-command` task
 * Slack needs a response within 3s and a modal must open within 3s of the click, so that part lives here;
 * everything slow (git, LLM rewrites) runs in the Trigger.dev task.
 */
interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  TRIGGER_SECRET_KEY: string;
}

type Verdict = "approve" | "reject" | "rewrite";
type Meta = { cardId: string; verdict: Verdict; channel: string; ts: string };

async function verify(req: Request, body: string, secret: string): Promise<boolean> {
  const sig = req.headers.get("x-slack-signature");
  const ts = req.headers.get("x-slack-request-timestamp");
  if (!sig || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const hex = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function slack(env: Env, method: string, body: unknown): Promise<any> {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function trigger(env: Env, payload: Record<string, unknown>, taskId = "card-verdict"): Promise<void> {
  const r = await fetch(`https://api.trigger.dev/api/v1/tasks/${taskId}/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.TRIGGER_SECRET_KEY}` },
    body: JSON.stringify({ payload }),
  });
  if (!r.ok) throw new Error(`trigger ${r.status}: ${await r.text()}`);
}

/** Swap the buttons for a "working on it" line so the click feels instant. */
function pending(blocks: any[], line: string): any[] {
  return [...blocks.filter((b) => b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text: line }] }];
}

function modal(meta: Meta, title: string) {
  const rewrite = meta.verdict === "rewrite";
  return {
    type: "modal",
    callback_id: "card_verdict",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: rewrite ? "Rewrite idea" : "Reject idea" },
    submit: { type: "plain_text", text: rewrite ? "Rewrite" : "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${title.slice(0, 200)}*` } },
      {
        type: "input",
        block_id: "why",
        optional: !rewrite,
        label: { type: "plain_text", text: rewrite ? "What should change?" : "Why not? (optional, it learns from this)" },
        element: {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          placeholder: { type: "plain_text", text: rewrite ? "e.g. less negative, lead with the number, make it a how-to" : "e.g. too inside-baseball, not my voice, done to death" },
        },
      },
      // reject only: judge the source post separately from the idea
      ...(rewrite ? [] : [
        {
          type: "input",
          block_id: "source",
          optional: true,
          label: { type: "plain_text", text: "The post it riffed on was…" },
          element: {
            type: "radio_buttons",
            action_id: "rating",
            initial_option: { text: { type: "plain_text", text: "No opinion" }, value: "neutral" },
            options: [
              { text: { type: "plain_text", text: "Good post, bad idea" }, value: "good" },
              { text: { type: "plain_text", text: "Not worth riffing on" }, value: "bad" },
              { text: { type: "plain_text", text: "No opinion" }, value: "neutral" },
            ],
          },
        },
        {
          type: "input",
          block_id: "angle",
          optional: true,
          label: { type: "plain_text", text: "Want a different idea from the same post?" },
          element: { type: "checkboxes", action_id: "another", options: [{ text: { type: "plain_text", text: "Try another angle from this post" }, value: "yes" }] },
        },
      ]),
    ],
  };
}

/** Message events: a human posting a link or a screenshot becomes an intake run. */
async function events(env: Env, req: Request, body: string): Promise<Response> {
  const e = JSON.parse(body);
  if (e.type === "url_verification") return Response.json({ challenge: e.challenge });
  if (req.headers.get("x-slack-retry-num")) return new Response(""); // Slack retries if we were slow; first delivery already triggered
  const ev = e.event ?? {};
  if (e.type !== "event_callback" || ev.type !== "message" || ev.bot_id || ev.thread_ts) return new Response("");
  if (ev.subtype && ev.subtype !== "file_share") return new Response("");
  const text: string = ev.text ?? "";
  const urls = [...text.matchAll(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  const files = (ev.files ?? []).filter((f: any) => String(f.mimetype ?? "").startsWith("image/")).map((f: any) => ({ url: f.url_private, mimetype: f.mimetype, name: f.name }));
  if (!urls.length && !files.length) return new Response("");
  await slack(env, "reactions.add", { channel: ev.channel, timestamp: ev.ts, name: "eyes" });
  await trigger(env, { text, urls, files, channel: ev.channel, ts: ev.ts, user: ev.user }, "intake");
  return new Response("");
}

/** `/ca <subcommand>`: acknowledge immediately, do the work in a task, answer via response_url. */
async function command(env: Env, body: string): Promise<Response> {
  const f = new URLSearchParams(body);
  const text = (f.get("text") ?? "").trim();
  if (!text || text === "help") {
    return Response.json({
      response_type: "ephemeral",
      text: [
        "*content-agents commands*",
        "`/ca pin <term>` — always search this term on LinkedIn + X",
        "`/ca unpin <term>` — let the weekly re-derive decide",
        "`/ca terms` — what's being searched and how each term is doing",
        "`/ca source <url>` — follow a newsletter / LinkedIn profile / X account (starts as a candidate)",
        "`/ca ideate` — generate a fresh batch of idea cards now",
        "Or just paste a post link or screenshot in the channel and I'll riff on it.",
      ].join("\n"),
    });
  }
  await trigger(env, { text, user: f.get("user_name"), channel: f.get("channel_id"), response_url: f.get("response_url") }, "slash-command");
  return Response.json({ response_type: "ephemeral", text: `⏳ \`/ca ${text}\`` });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    const body = await req.text();
    if (!(await verify(req, body, env.SLACK_SIGNING_SECRET))) return new Response("bad signature", { status: 401 });

    if (url.pathname === "/slack/events") return events(env, req, body);
    if (url.pathname === "/slack/commands") return command(env, body);
    if (url.pathname !== "/slack/actions") return new Response("not found", { status: 404 });
    const payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}");

    if (payload.type === "block_actions" && ["accept_proposal", "skip_proposal"].includes(payload.actions?.[0]?.action_id)) {
      const a = payload.actions[0];
      const decision = a.action_id === "accept_proposal" ? "accept" : "skip";
      const channel = payload.channel?.id ?? payload.container?.channel_id;
      const ts = payload.container?.message_ts;
      await slack(env, "chat.update", { channel, ts, text: "Working…", blocks: pending(payload.message?.blocks ?? [], decision === "accept" ? "⏳ Applying…" : "⏳ Skipping…") });
      await trigger(env, { proposalId: a.value, decision, user: payload.user?.username }, "apply-proposal");
      return new Response("");
    }

    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      const id: string = action?.action_id ?? "";
      if (!["approve_card", "reject_card", "rewrite_card"].includes(id)) return new Response("");
      const verdict = id.replace("_card", "") as Verdict;
      const meta: Meta = { cardId: action.value, verdict, channel: payload.channel?.id ?? payload.container?.channel_id, ts: payload.container?.message_ts ?? payload.message?.ts };
      const blocks = payload.message?.blocks ?? [];
      if (verdict === "approve") {
        await slack(env, "chat.update", { channel: meta.channel, ts: meta.ts, text: "Approving…", blocks: pending(blocks, `⏳ Approving… (<@${payload.user?.id}>)`) });
        await trigger(env, { ...meta, slack: { channel: meta.channel, ts: meta.ts }, user: payload.user?.username });
      } else {
        const title = blocks[0]?.text?.text?.split("\n")[0]?.replace(/\*/g, "") ?? meta.cardId;
        await slack(env, "views.open", { trigger_id: payload.trigger_id, view: modal(meta, title) });
      }
      return new Response("");
    }

    if (payload.type === "view_submission" && payload.view?.callback_id === "card_verdict") {
      const meta: Meta = JSON.parse(payload.view.private_metadata);
      const v = payload.view.state?.values ?? {};
      const why: string = v.why?.text?.value ?? "";
      const sourceRating: string = v.source?.rating?.selected_option?.value ?? "neutral";
      const anotherAngle = (v.angle?.another?.selected_options ?? []).length > 0;
      const hist = await slack(env, "conversations.history", { channel: meta.channel, latest: meta.ts, inclusive: true, limit: 1 });
      const blocks = hist?.messages?.[0]?.blocks ?? [];
      const line = meta.verdict === "rewrite" ? `⏳ Rewriting… “${why}”` : `⏳ Rejecting…${why ? ` “${why}”` : ""}${anotherAngle ? " · another angle coming" : ""}`;
      await slack(env, "chat.update", { channel: meta.channel, ts: meta.ts, text: line, blocks: pending(blocks, line) });
      await trigger(env, { cardId: meta.cardId, verdict: meta.verdict, why, sourceRating, anotherAngle, slack: { channel: meta.channel, ts: meta.ts }, user: payload.user?.username });
      return Response.json({ response_action: "clear" });
    }

    return new Response("");
  },
};
