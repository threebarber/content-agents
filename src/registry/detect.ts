import type { SourceType } from "../../schemas/source.js";
import { SHORTENERS } from "../lib/http.js";

export type Detected = { type: SourceType; url: string; kind: "source" | "post"; key: string };

/** Classify a URL or handle into a source type and whether it points at a source (home) or a single post. */
export function detect(input: string): Detected | null {
  let raw = input.trim();
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(raw) && raw.startsWith("@")) {
    return { type: "x", url: `https://x.com/${raw.slice(1)}`, kind: "source", key: raw.slice(1).toLowerCase() };
  }
  if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.host.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");

  if (host.endsWith("linkedin.com")) {
    if (/^\/in\/[^/]+/.test(path)) return { type: "linkedin", url: `https://www.linkedin.com${path.match(/^\/in\/[^/]+/)![0]}/`, kind: "source", key: path.split("/")[2].toLowerCase() };
    if (/^\/company\/[^/]+/.test(path)) return { type: "linkedin", url: `https://www.linkedin.com${path.match(/^\/company\/[^/]+/)![0]}/`, kind: "source", key: path.split("/")[2].toLowerCase() };
    if (/^\/(posts|feed\/update|pulse)\//.test(path)) return { type: "linkedin", url: raw, kind: "post", key: path };
    return null;
  }
  if (host === "x.com" || host === "twitter.com") {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 1) return { type: "x", url: `https://x.com/${parts[0]}`, kind: "source", key: parts[0].toLowerCase() };
    if (parts[1] === "status") return { type: "x", url: `https://x.com/${parts[0]}/status/${parts[2]}`, kind: "post", key: parts[2] };
    return null;
  }
  // Substack profiles and app post links: substack.com/@handle, substack.com/@handle/p-<id>, substack.com/home/post/p-<id>
  if (host === "substack.com") {
    const postId = path.match(/\/p-(\d+)$/)?.[1];
    if (postId) return { type: "substack", url: `https://substack.com/home/post/p-${postId}`, kind: "post", key: `postid:${postId}` };
    const handle = path.match(/^\/@([^/]+)$/)?.[1];
    if (handle) return { type: "substack", url: `https://substack.com/@${handle.toLowerCase()}`, kind: "source", key: handle.toLowerCase() };
  }
  // Substack app/share links: open.substack.com/pub/<pub>/p/<slug> (iOS/Android share sheet) and /pub/<pub>
  if (host === "open.substack.com" || (host === "substack.com" && path.startsWith("/pub/"))) {
    const m = path.match(/^\/pub\/([^/]+)(?:\/p\/([^/]+))?/);
    if (!m) return null;
    const pub = m[1].toLowerCase();
    return m[2]
      ? { type: "substack", url: `https://${pub}.substack.com/p/${m[2]}`, kind: "post", key: `${pub}.substack.com` }
      : { type: "substack", url: `https://${pub}.substack.com`, kind: "source", key: pub };
  }
  if (host.endsWith("substack.com") || ((path.startsWith("/p/") || path === "/archive") && !SHORTENERS.includes(host))) {
    const home = `https://${host}`;
    if (host === "substack.com") return null; // substack.com/@user profiles not supported yet
    return path.startsWith("/p/")
      ? { type: "substack", url: raw.replace(/[?#].*$/, ""), kind: "post", key: host }
      : { type: "substack", url: home, kind: "source", key: host.replace(/\.substack\.com$/, "") };
  }
  if (host.endsWith("hashnode.dev")) return { type: "hashnode", url: `https://${host}`, kind: path ? "post" : "source", key: host };
  // Unknown host: treat as a possible substack-on-custom-domain or RSS; resolver will probe.
  return { type: "rss", url: `https://${host}`, kind: path && path !== "/" ? "post" : "source", key: host };
}
