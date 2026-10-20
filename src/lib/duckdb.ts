import { DuckDBInstance } from "@duckdb/node-api";
import { statePath } from "./paths.js";

/** Query the JSONL item store with DuckDB. `items` is a view over data/items/<type>/*.jsonl. */
export async function withDb<T>(fn: (q: (sql: string) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const glob = statePath("data", "items", "*", "*.jsonl").replace(/'/g, "''");
  await conn.run(`CREATE VIEW items AS SELECT * FROM read_json_auto('${glob}', union_by_name=true, filename=true)`);
  const q = async (sql: string) => {
    const r = await conn.runAndReadAll(sql);
    return r.getRowObjectsJson() as Record<string, unknown>[];
  };
  try {
    return await fn(q);
  } finally {
    conn.closeSync();
  }
}

/** Per-author engagement z-score: how far a post sits from that author's own mean (likes+comments). */
export const TOP_BY_Z = (n = 20, type = "substack") => `
WITH base AS (
  SELECT id, source_id, author, title, url, published_at,
         coalesce(metrics.likes,0) + 2*coalesce(metrics.comments,0) AS eng
  FROM items WHERE type = '${type}' AND NOT paywalled
), stats AS (
  SELECT source_id, avg(eng) AS mu, stddev_samp(eng) AS sd, count(*) AS n FROM base GROUP BY source_id
)
SELECT b.author, b.title, b.eng, round((b.eng - s.mu) / nullif(s.sd,0), 2) AS z, s.n AS author_posts, b.published_at::date AS published, b.url
FROM base b JOIN stats s USING (source_id)
WHERE s.n >= 3 AND s.sd > 0
ORDER BY z DESC NULLS LAST LIMIT ${n}`;
