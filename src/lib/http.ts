const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 content-agents/0.1";

export async function getJson<T = unknown>(url: string, init: RequestInit = {}, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
        redirect: "follow",
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new HttpError(res.status, url);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) throw new HttpError(res.status, url, "non-json");
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function getText(url: string): Promise<{ status: number; text: string; finalUrl: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  return { status: res.status, text: await res.text(), finalUrl: res.url };
}

export class HttpError extends Error {
  constructor(public status: number, public url: string, public reason = "") {
    super(`HTTP ${status} ${reason} ${url}`.trim());
  }
}

export function htmlToText(html: string, max = 15_000): { text: string; truncated: boolean } {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = t.length > max;
  if (truncated) t = t.slice(0, max);
  return { text: t, truncated };
}

export function extractLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="(https?:\/\/[^"#?]+)/g)) out.add(m[1]);
  return [...out];
}
