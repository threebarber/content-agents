/**
 * Minimal Slack client for outbound messages. Uses the bot token (xoxb) of the content-agents app
 * (manifest in slack-app/). No SDK: two endpoints are all we need.
 */
const API = "https://slack.com/api";

type Block = Record<string, unknown>;

async function call<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new Error(`slack ${method}: ${json.error}`);
  return json;
}

/** Resolve "#name" to a channel id (public channels only); ids pass through. Joins the channel if needed. */
export async function resolveChannel(nameOrId: string): Promise<string> {
  if (/^[CG][A-Z0-9]{8,}$/.test(nameOrId)) return nameOrId;
  const name = nameOrId.replace(/^#/, "");
  let cursor: string | undefined;
  do {
    const r = await call<{ channels: { id: string; name: string; is_member: boolean }[]; response_metadata?: { next_cursor?: string } }>("conversations.list", {
      types: "public_channel",
      limit: 200,
      exclude_archived: true,
      cursor,
    });
    const hit = r.channels.find((c) => c.name === name);
    if (hit) {
      if (!hit.is_member) await call("conversations.join", { channel: hit.id }).catch(() => {});
      return hit.id;
    }
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  throw new Error(`no public channel named #${name}`);
}

export async function postMessage(channel: string, text: string, blocks?: Block[], threadTs?: string): Promise<{ ts: string; channel: string }> {
  const id = await resolveChannel(channel);
  const r = await call<{ ts: string; channel: string }>("chat.postMessage", {
    channel: id,
    text,
    ...(blocks ? { blocks } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
  return { ts: r.ts, channel: r.channel };
}

/** Convenience: markdown section blocks from an array of paragraphs. */
export function sections(...paragraphs: string[]): Block[] {
  return paragraphs.map((p) => ({ type: "section", text: { type: "mrkdwn", text: p.slice(0, 2900) } }));
}
