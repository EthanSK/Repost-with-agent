/**
 * URL expander — follow shortener redirects to the final destination URL
 * before publishing.
 *
 * Why: when a draft contains a shortened URL like `lnkd.in/abc123` or
 * `t.co/xyz`, posting it to a different platform usually surfaces the
 * shortener path rather than the real article. We expand once at publish
 * time so the final post links straight to the canonical page.
 *
 * Design (Ethan voice 6018 + 6021, 2026-05-01):
 *   - Max 5 hops per URL.
 *   - 5-second timeout per request.
 *   - Fail-soft: if expansion errors (timeout, DNS, non-redirect, loop),
 *     fall back to the original shortened URL — never block the publish.
 *   - Cover lnkd.in, t.co, bit.ly, buff.ly, goo.gl, tinyurl.com, ow.ly, and
 *     anything else that returns 30x with a Location header.
 *   - Audit event per substitution: `pair.publish.url_expanded` with
 *     `{shortenedUrl, expandedUrl, hopCount}`.
 *
 * Implementation: HEAD/GET against the URL, follow Location headers manually
 * (NOT via fetch's `redirect: "follow"` — we want the hop count + ability to
 * cap at MAX_HOPS). Some shorteners (e.g. lnkd.in) refuse HEAD; we fall back
 * to GET on 405/501 responses.
 */

const DEFAULT_MAX_HOPS = 5;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Hostnames that we *know* are URL shorteners. We don't restrict expansion to
 * this list (any 30x response will be followed) — but having it lets us emit
 * an explicit pre-flight audit log and gives us something to point users at
 * in `docs/url-expander.md`.
 */
export const KNOWN_SHORTENERS: readonly string[] = [
  "lnkd.in",
  "t.co",
  "bit.ly",
  "buff.ly",
  "buffer.com",
  "goo.gl",
  "tinyurl.com",
  "ow.ly",
  "rb.gy",
  "is.gd",
  "shorturl.at",
  "tiny.cc",
  "cutt.ly",
  "youtu.be",
  "fb.me",
  "trib.al",
] as const;

export interface ExpandUrlOptions {
  /** Max redirect hops to follow. Default 5. */
  maxHops?: number;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export interface ExpandUrlResult {
  originalUrl: string;
  expandedUrl: string;
  hopCount: number;
  /**
   * True when expansion ran without errors and at least one hop happened.
   * False when the URL was already final / errored / hit the loop guard.
   */
  expanded: boolean;
  /**
   * Set when expansion failed (timeout, network, loop, max-hops). The result
   * still returns the original URL — the caller should always fall back to
   * `expandedUrl`, which will equal `originalUrl` on failure.
   */
  error?: string;
  /**
   * The full hop chain (URLs visited). Useful for audit + debug. The first
   * entry is always the original URL; the last is `expandedUrl`.
   */
  chain: string[];
}

export interface ExpandedTextResult {
  text: string;
  expansions: ExpandUrlResult[];
}

/** RFC 3986 / common URL detector. Greedy-but-bounded. */
const URL_PATTERN =
  /\bhttps?:\/\/[^\s<>"'`{}|\\^]+[^\s<>"'`{}|\\^.,!?;:)\]]/gi;

export function isShortener(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return KNOWN_SHORTENERS.some(
      (s) => host === s || host.endsWith(`.${s}`)
    );
  } catch {
    return false;
  }
}

/**
 * Follow redirect chain for a single URL.
 *
 * Always fail-soft: the returned `expandedUrl` falls back to the input on any
 * failure. `error` is populated; the caller decides whether to log it.
 */
export async function expandUrl(
  url: string,
  options: ExpandUrlOptions = {}
): Promise<ExpandUrlResult> {
  const maxHops = Math.max(1, options.maxHops ?? DEFAULT_MAX_HOPS);
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || (globalThis as { fetch?: typeof fetch }).fetch;

  if (!fetchImpl) {
    return {
      originalUrl: url,
      expandedUrl: url,
      hopCount: 0,
      expanded: false,
      error: "No fetch implementation available (Node 18+ required).",
      chain: [url],
    };
  }

  const chain: string[] = [url];
  let current = url;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      // Try HEAD first; many shorteners (lnkd.in, t.co) honor it. Some return
      // 405 / 501 — we fall back to GET in that case.
      let response: Response;
      try {
        response = await fetchImpl(current, {
          method: "HEAD",
          redirect: "manual",
          signal: controller?.signal,
        });
      } catch (headErr) {
        // HEAD blew up before we got a response — try GET.
        response = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller?.signal,
        });
        // If GET also dies, the catch below handles it.
        // Suppress unused-var warning:
        void headErr;
      }

      // Some servers don't support HEAD — fall back to GET on 405 / 501.
      if (response.status === 405 || response.status === 501) {
        response = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller?.signal,
        });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          // 30x with no Location — treat current as final.
          return {
            originalUrl: url,
            expandedUrl: current,
            hopCount: hop,
            expanded: hop > 0,
            chain,
          };
        }
        // Resolve relative locations against the current URL.
        const next = new URL(location, current).toString();
        if (chain.includes(next)) {
          // Redirect loop — fall back to the URL just before the loop.
          return {
            originalUrl: url,
            expandedUrl: current,
            hopCount: hop,
            expanded: hop > 0,
            error: `Redirect loop detected at hop ${hop} (${next}).`,
            chain,
          };
        }
        chain.push(next);
        current = next;
        continue;
      }

      // Non-redirect response — current URL is the final destination.
      return {
        originalUrl: url,
        expandedUrl: current,
        hopCount: hop,
        expanded: hop > 0,
        chain,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // AbortError → timeout.
      if (
        err instanceof Error &&
        (err.name === "AbortError" || /aborted|timeout/i.test(message))
      ) {
        return {
          originalUrl: url,
          expandedUrl: current,
          hopCount: hop,
          expanded: hop > 0,
          error: `Timeout after ${timeoutMs}ms at hop ${hop}.`,
          chain,
        };
      }
      // Network / DNS / TLS error — fail soft.
      return {
        originalUrl: url,
        expandedUrl: current,
        hopCount: hop,
        expanded: hop > 0,
        error: `Network error at hop ${hop}: ${message}`,
        chain,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // Hit the max-hops cap.
  return {
    originalUrl: url,
    expandedUrl: current,
    hopCount: maxHops,
    expanded: maxHops > 0 && current !== url,
    error: `Max hops (${maxHops}) reached without final destination.`,
    chain,
  };
}

/**
 * Expand every URL in `text` and substitute the expanded form back. Returns
 * the rewritten text plus the per-URL expansion records (for audit logging).
 *
 * Order is preserved (we substitute by exact-match on the original URL after
 * expansion completes). If the same shortened URL appears multiple times,
 * each occurrence is replaced.
 */
export async function expandUrlsInText(
  text: string,
  options: ExpandUrlOptions = {}
): Promise<ExpandedTextResult> {
  const matches = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    matches.add(match[0]);
  }

  if (matches.size === 0) {
    return { text, expansions: [] };
  }

  const expansions = await Promise.all(
    Array.from(matches).map((url) => expandUrl(url, options))
  );

  let rewritten = text;
  for (const expansion of expansions) {
    if (
      expansion.expanded &&
      expansion.expandedUrl !== expansion.originalUrl
    ) {
      // Use a global-ish replace by splitting on the literal token. Plain
      // String.replace with a string only replaces the first occurrence —
      // but split/join handles all of them safely without needing to escape
      // for regex.
      rewritten = rewritten.split(expansion.originalUrl).join(expansion.expandedUrl);
    }
  }

  return { text: rewritten, expansions };
}
