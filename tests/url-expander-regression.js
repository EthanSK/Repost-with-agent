// Regression tests for the URL expander. Pure-function tests only — uses an
// injected `fetchImpl` to fake redirects without hitting the network. Run via
// `npm test`.
//
// Coverage:
//   1. No-op when no redirect happens (200 OK on first hop).
//   2. Single-hop expansion.
//   3. Multi-hop chain across well-known shorteners (lnkd.in → t.co → final).
//   4. Hits MAX_HOPS cap and returns the last URL with an error.
//   5. Redirect loop detection.
//   6. Timeout is fail-soft — returns original URL with error.
//   7. Network error is fail-soft.
//   8. HEAD-405 falls back to GET.
//   9. Missing Location header on 30x is treated as final.
//  10. expandUrlsInText — all URLs replaced; non-shortened URLs unchanged.
//  11. isShortener helper recognizes known hosts.
//  12. Smoke test for each known shortener prefix returning a fake redirect.

const assert = require("node:assert/strict");
const {
  expandUrl,
  expandUrlsInText,
  isShortener,
  KNOWN_SHORTENERS,
} = require("../dist/core/url-expander.js");

function makeFetch(routes) {
  // routes = Map<url, response or function returning response>
  // response = { status, headers: { location?: string } }
  return async function fakeFetch(url /* init */) {
    const handler = routes.get(url);
    if (!handler) {
      throw new Error(`fakeFetch: unknown URL ${url}`);
    }
    const r = typeof handler === "function" ? handler() : handler;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get: (key) => {
          if (!r.headers) return null;
          const lower = key.toLowerCase();
          for (const [k, v] of Object.entries(r.headers)) {
            if (k.toLowerCase() === lower) return v;
          }
          return null;
        },
      },
    };
  };
}

(async () => {
  // ---------- 1. No-op (final URL on first hop) ----------
  {
    const final = "https://example.com/article";
    const fetchImpl = makeFetch(new Map([[final, { status: 200 }]]));
    const r = await expandUrl(final, { fetchImpl });
    assert.equal(r.expandedUrl, final);
    assert.equal(r.hopCount, 0);
    assert.equal(r.expanded, false);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.chain, [final]);
  }

  // ---------- 2. Single-hop expansion ----------
  {
    const short = "https://lnkd.in/abc123";
    const long = "https://example.com/long-form-post";
    const fetchImpl = makeFetch(
      new Map([
        [short, { status: 301, headers: { location: long } }],
        [long, { status: 200 }],
      ])
    );
    const r = await expandUrl(short, { fetchImpl });
    assert.equal(r.expandedUrl, long);
    assert.equal(r.hopCount, 1);
    assert.equal(r.expanded, true);
    assert.deepEqual(r.chain, [short, long]);
  }

  // ---------- 3. Multi-hop chain ----------
  {
    const a = "https://lnkd.in/abc";
    const b = "https://t.co/xyz";
    const c = "https://bit.ly/finally";
    const final = "https://example.com/destination";
    const fetchImpl = makeFetch(
      new Map([
        [a, { status: 301, headers: { location: b } }],
        [b, { status: 302, headers: { location: c } }],
        [c, { status: 301, headers: { location: final } }],
        [final, { status: 200 }],
      ])
    );
    const r = await expandUrl(a, { fetchImpl });
    assert.equal(r.expandedUrl, final);
    assert.equal(r.hopCount, 3);
    assert.equal(r.expanded, true);
    assert.deepEqual(r.chain, [a, b, c, final]);
  }

  // ---------- 4. MAX_HOPS cap (default 5) ----------
  {
    const urls = Array.from({ length: 8 }, (_, i) => `https://hop-${i}.test/`);
    const routes = new Map();
    for (let i = 0; i < urls.length - 1; i += 1) {
      routes.set(urls[i], { status: 301, headers: { location: urls[i + 1] } });
    }
    routes.set(urls[urls.length - 1], { status: 200 });
    const fetchImpl = makeFetch(routes);
    const r = await expandUrl(urls[0], { fetchImpl, maxHops: 5 });
    assert.equal(r.hopCount, 5);
    assert.match(r.error || "", /Max hops/);
    // Should have walked through 5 hops then bailed.
    assert.equal(r.expandedUrl, urls[5]);
  }

  // ---------- 5. Redirect loop detection ----------
  {
    const a = "https://loop-a.test/";
    const b = "https://loop-b.test/";
    const fetchImpl = makeFetch(
      new Map([
        [a, { status: 301, headers: { location: b } }],
        [b, { status: 301, headers: { location: a } }],
      ])
    );
    const r = await expandUrl(a, { fetchImpl, maxHops: 5 });
    assert.match(r.error || "", /loop/i);
    // Should have caught the loop before hitting max-hops.
    assert.ok(r.hopCount < 5);
  }

  // ---------- 6. Timeout — fail-soft ----------
  {
    const u = "https://slow.test/";
    const fetchImpl = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const r = await expandUrl(u, { fetchImpl, timeoutMs: 100 });
    assert.equal(r.expandedUrl, u, "fail-soft: original URL preserved");
    assert.match(r.error || "", /Timeout|aborted/i);
  }

  // ---------- 7. Network error — fail-soft ----------
  {
    const u = "https://dead.test/";
    const fetchImpl = async () => {
      throw new Error("ENOTFOUND dead.test");
    };
    const r = await expandUrl(u, { fetchImpl });
    assert.equal(r.expandedUrl, u);
    assert.match(r.error || "", /ENOTFOUND/);
  }

  // ---------- 8. HEAD 405 → falls back to GET ----------
  {
    const a = "https://method-fussy.test/";
    const final = "https://example.com/final";
    let lastMethod;
    const fetchImpl = async (url, init) => {
      lastMethod = init.method;
      if (init.method === "HEAD") {
        return {
          ok: false,
          status: 405,
          headers: { get: () => null },
        };
      }
      return {
        ok: false,
        status: 301,
        headers: {
          get: (k) => (k.toLowerCase() === "location" ? final : null),
        },
      };
    };
    // For the second hop on `final`, the fake will keep returning 301 →
    // need a separate handler. Actually after the GET on `a` returns
    // location=final, expandUrl will fetch `final` next. We need that to
    // return 200.
    const fetchImplWithFinal = async (url, init) => {
      lastMethod = init.method;
      if (url === a) {
        if (init.method === "HEAD") {
          return { ok: false, status: 405, headers: { get: () => null } };
        }
        return {
          ok: false,
          status: 301,
          headers: { get: (k) => (k.toLowerCase() === "location" ? final : null) },
        };
      }
      if (url === final) {
        return { ok: true, status: 200, headers: { get: () => null } };
      }
      throw new Error(`unknown ${url}`);
    };
    const r = await expandUrl(a, { fetchImpl: fetchImplWithFinal });
    assert.equal(r.expandedUrl, final);
    assert.equal(r.expanded, true);
    // Last method on the final URL should be HEAD (it didn't return 405).
    void lastMethod;
  }

  // ---------- 9. 30x without Location → final ----------
  {
    const u = "https://no-location.test/";
    const fetchImpl = async () => ({
      ok: false,
      status: 301,
      headers: { get: () => null },
    });
    const r = await expandUrl(u, { fetchImpl });
    assert.equal(r.expandedUrl, u);
    // hopCount=0 because we never followed.
    assert.equal(r.hopCount, 0);
  }

  // ---------- 10. expandUrlsInText ----------
  {
    const short1 = "https://lnkd.in/abc";
    const short2 = "https://bit.ly/xyz";
    const long1 = "https://example.com/article";
    const long2 = "https://example.com/another";
    const text = `Check out ${short1} and also ${short2} (https://example.com/already-final)`;
    const fetchImpl = makeFetch(
      new Map([
        [short1, { status: 301, headers: { location: long1 } }],
        [short2, { status: 301, headers: { location: long2 } }],
        [long1, { status: 200 }],
        [long2, { status: 200 }],
        ["https://example.com/already-final", { status: 200 }],
      ])
    );
    const r = await expandUrlsInText(text, { fetchImpl });
    assert.ok(r.text.includes(long1));
    assert.ok(r.text.includes(long2));
    assert.ok(!r.text.includes(short1));
    assert.ok(!r.text.includes(short2));
    assert.ok(r.text.includes("https://example.com/already-final"));
    assert.equal(r.expansions.length, 3);
    const expanded = r.expansions.filter((e) => e.expanded);
    assert.equal(expanded.length, 2);
  }

  // ---------- 11. isShortener helper ----------
  {
    assert.equal(isShortener("https://lnkd.in/abc"), true);
    assert.equal(isShortener("https://t.co/abc"), true);
    assert.equal(isShortener("https://bit.ly/abc"), true);
    assert.equal(isShortener("https://example.com/article"), false);
    // Subdomains of known shorteners
    assert.equal(isShortener("https://www.lnkd.in/abc"), true);
    // Invalid URL
    assert.equal(isShortener("not a url"), false);
  }

  // ---------- 12. Smoke test for each known shortener ----------
  for (const host of KNOWN_SHORTENERS) {
    const short = `https://${host}/abc`;
    const final = `https://example.com/from-${host}`;
    const fetchImpl = makeFetch(
      new Map([
        [short, { status: 301, headers: { location: final } }],
        [final, { status: 200 }],
      ])
    );
    const r = await expandUrl(short, { fetchImpl });
    assert.equal(r.expandedUrl, final, `${host} should expand to final URL`);
    assert.equal(r.expanded, true);
  }

  console.log("url-expander regression passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
