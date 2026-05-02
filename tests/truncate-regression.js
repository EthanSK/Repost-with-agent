// Unit tests for the smart-truncate helper used by `pair backfill
// --overlength-strategy truncate`. Run via `npm test`.
const assert = require("node:assert/strict");

const { truncate } = require("../dist/core/truncate.js");

const ELLIPSIS = "…";

// ---------- 1. Empty input is a no-op ----------
{
  const r = truncate("", 280);
  assert.equal(r.text, "");
  assert.equal(r.truncated, false);
  assert.equal(r.originalChars, 0);
}

// ---------- 2. Exact length match returns input unchanged ----------
{
  const text = "a".repeat(280);
  const r = truncate(text, 280);
  assert.equal(r.text, text);
  assert.equal(r.truncated, false);
  assert.equal(r.originalChars, 280);
  assert.equal(r.text.length, 280);
}

// ---------- 3. Below limit returns input unchanged ----------
{
  const text = "Short tweet under the cap.";
  const r = truncate(text, 280);
  assert.equal(r.text, text);
  assert.equal(r.truncated, false);
}

// ---------- 4. Sentence-boundary truncation ----------
{
  const text =
    "First sentence ends here. Second sentence runs on for many more characters. Third sentence pushes us well past the cap and should be cut.";
  // Full length is well over 80. Cap at 80; expect truncation at the period
  // after "First sentence ends here" since "Second sentence..." starts after
  // the ". ".
  const r = truncate(text, 80);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 80, `text length ${r.text.length} should be <= 80`);
  assert.ok(r.text.endsWith(ELLIPSIS), `expected ellipsis, got "${r.text}"`);
  // Last meaningful character before the ellipsis should be the sentence
  // ender's content (no trailing space).
  assert.ok(
    /sentence ends here(\.)?…$/.test(r.text) ||
      /runs on for many more characters(\.)?…$/.test(r.text),
    `unexpected truncation point: "${r.text}"`
  );
}

// ---------- 5. Word-boundary fallback (no sentence boundary) ----------
{
  const text =
    "this string has no sentence punctuation at all but it does have many word boundaries that we can use as cut points instead";
  const r = truncate(text, 50);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 50, `text length ${r.text.length} should be <= 50`);
  assert.ok(r.text.endsWith(ELLIPSIS));
  // Last char before the ellipsis must NOT be whitespace.
  const beforeEllipsis = r.text.slice(0, -1);
  assert.ok(
    !/\s$/.test(beforeEllipsis),
    `text ends with whitespace before ellipsis: "${r.text}"`
  );
}

// ---------- 6. Single long token with no boundary — hard cut ----------
{
  const text = "a".repeat(500);
  const r = truncate(text, 100);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 100);
  assert.ok(r.text.endsWith(ELLIPSIS));
  // Should be 99 'a' + 1 ellipsis.
  assert.equal(r.text.slice(0, -1), "a".repeat(99));
}

// ---------- 7. Trailing punctuation stripped before ellipsis ----------
{
  const text =
    "Some text with content; followed by more, words! And punctuation? everywhere here";
  // Cap at 40 — we should land near "with content;" or "by more,"; the
  // truncate helper strips trailing punctuation/whitespace before the ellipsis.
  const r = truncate(text, 40);
  assert.equal(r.truncated, true);
  const last = r.text.slice(-2, -1);
  assert.ok(
    !/[\s.,;:!?\-—–]/.test(last),
    `char before ellipsis should not be punctuation/whitespace, got "${last}" (full: "${r.text}")`
  );
  assert.ok(r.text.endsWith(ELLIPSIS));
  assert.ok(r.text.length <= 40);
}

// ---------- 8. Output never exceeds maxLength ----------
{
  for (const cap of [10, 50, 100, 280, 500]) {
    const text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.";
    const r = truncate(text, cap);
    if (text.length > cap) {
      assert.ok(
        r.text.length <= cap,
        `cap=${cap}: output length ${r.text.length} > cap`
      );
      assert.equal(r.truncated, true);
    } else {
      assert.equal(r.truncated, false);
    }
  }
}

// ---------- 9. originalChars always set ----------
{
  const r1 = truncate("short", 280);
  assert.equal(r1.originalChars, 5);
  const r2 = truncate("a".repeat(1000), 280);
  assert.equal(r2.originalChars, 1000);
}

// ---------- 10. Pathological maxLength (<=1) returns input unchanged ----------
{
  const r1 = truncate("hello world", 1);
  assert.equal(r1.text, "hello world");
  assert.equal(r1.truncated, false);
  const r2 = truncate("hello", 0);
  assert.equal(r2.text, "hello");
  assert.equal(r2.truncated, false);
}

// ---------- 11. Sentence boundary preserved with multiple sentences ----------
{
  // Realistic LinkedIn-style paragraph followed by a URL trailer.
  const text =
    "I shipped a thing today. It works great. Here is why: lots of testing and a careful design pass. Then I wrote it up.";
  const r = truncate(text, 60);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 60);
  assert.ok(r.text.endsWith(ELLIPSIS));
  // We expect the cut to be at one of the sentence boundaries; the exact
  // boundary depends on where 60 chars lands, but at minimum the last char
  // before the ellipsis should be alphanumeric or a sentence-ending punctuation.
  assert.ok(/[A-Za-z0-9.!?]…$/.test(r.text), `bad cut: "${r.text}"`);
}

console.log("truncate regression passed");
