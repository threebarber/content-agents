/**
 * Slack interactivity endpoint for content-agents.
 * Approve → trigger `card-verdict` now. Reject / Rewrite → open a modal for a note, trigger on submit.
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

async function trigger(env: Env, payload: Record<string, unknown>): Promise<void> {
  const r = await fetch("https://api.trigger.dev/api/v1/tasks/card-verdict/trigger", {
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
    ],
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
    if (req.method !== "POST" || url.pathname !== "/slack/actions") return new Response("not found", { status: 404 });

    const body = await req.text();
    if (!(await verify(req, body, env.SLACK_SIGNING_SECRET))) return new Response("bad signature", { status: 401 });
    const payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}");

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
      const why: string = payload.view.state?.values?.why?.text?.value ?? "";
      const hist = await slack(env, "conversations.history", { channel: meta.channel, latest: meta.ts, inclusive: true, limit: 1 });
      const blocks = hist?.messages?.[0]?.blocks ?? [];
      const line = meta.verdict === "rewrite" ? `⏳ Rewriting… “${why}”` : `⏳ Rejecting…${why ? ` “${why}”` : ""}`;
      await slack(env, "chat.update", { channel: meta.channel, ts: meta.ts, text: line, blocks: pending(blocks, line) });
      await trigger(env, { cardId: meta.cardId, verdict: meta.verdict, why, slack: { channel: meta.channel, ts: meta.ts }, user: payload.user?.username });
      return Response.json({ response_action: "clear" });
    }

    return new Response("");
  },
};
