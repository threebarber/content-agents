/** Thin Apify REST client: run an actor synchronously and get its dataset items. */
const API = "https://api.apify.com/v2";

function token(): string {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw new Error("APIFY_TOKEN not set");
  return t;
}

export async function runActor<T = Record<string, unknown>>(actor: string, input: Record<string, unknown>, timeoutSecs = 280): Promise<T[]> {
  const res = await fetch(`${API}/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items?timeout=${timeoutSecs}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeoutSecs + 30) * 1000),
  });
  if (!res.ok) throw new Error(`apify ${actor} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return Array.isArray(data) ? (data as T[]) : [];
}

/** Month-to-date platform spend in USD (the free plan blocks at $5). */
export async function monthSpendUsd(): Promise<{ used: number; limit: number }> {
  const res = await fetch(`${API}/users/me/limits`, { headers: { authorization: `Bearer ${token()}` } });
  const d = (await res.json()).data;
  return { used: d?.current?.monthlyUsageUsd ?? 0, limit: d?.limits?.maxMonthlyUsageUsd ?? 5 };
}
