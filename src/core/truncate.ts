/**
 * Smart truncation for drafts that exceed a destination's character limit.
 *
 * Used by the backfill / publish paths when `--overlength-strategy truncate`
 * is requested AND the destination adapter declares a `maxLength`. The
 * algorithm:
 *
 *   1. If `draft.length <= maxLength`: return the draft unchanged.
 *   2. Otherwise, search backwards for a sentence boundary (`. `, `! `, `? `)
 *      within the first `maxLength - 1` chars.
 *   3. If no sentence boundary is found, fall back to the last word boundary
 *      (whitespace) within `maxLength - 1`.
 *   4. If that also fails (single super-long token), hard-cut at
 *      `maxLength - 1`.
 *   5. Strip trailing whitespace + leftover punctuation, then append "…"
 *      (single ellipsis char) to land at exactly `maxLength`.
 *
 * Returns `{ text, truncated, original_chars }` so callers can report the
 * action in audit events.
 */

const ELLIPSIS = "…"; // "…" — single Unicode char, .length === 1

export interface TruncateResult {
  /** The (possibly) truncated text. */
  text: string;
  /** True iff the input was actually shortened. */
  truncated: boolean;
  /** Original input length, regardless of whether truncation happened. */
  originalChars: number;
}

/**
 * Smart-truncate `draft` to fit within `maxLength` characters (inclusive of a
 * trailing ellipsis when truncation happens).
 */
export function truncate(draft: string, maxLength: number): TruncateResult {
  const originalChars = draft.length;
  if (!Number.isFinite(maxLength) || maxLength <= 1) {
    // Pathological maxLength — return draft unchanged + flagged not truncated.
    // Caller is expected to validate maxLength upstream.
    return { text: draft, truncated: false, originalChars };
  }
  if (originalChars <= maxLength) {
    return { text: draft, truncated: false, originalChars };
  }

  // We reserve 1 char for the ellipsis. Effective body limit:
  const bodyLimit = maxLength - 1;
  // Slice candidate is the first `bodyLimit` chars; we then walk back for a
  // boundary inside that slice.
  const candidate = draft.slice(0, bodyLimit);

  // 1. Last sentence boundary inside `candidate`.
  // We look for the last occurrence of `. `, `! `, or `? ` and cut AFTER the
  // punctuation but BEFORE the space (so the punctuation stays in the post).
  const sentenceMatches = [
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? "),
  ];
  const sentenceCutAt = Math.max(...sentenceMatches);
  let body: string;
  if (sentenceCutAt >= 0) {
    // +1 to keep the punctuation, drop the trailing space.
    body = candidate.slice(0, sentenceCutAt + 1);
  } else {
    // 2. Last word boundary (any whitespace).
    const wordMatch = candidate.match(/\s+\S*$/);
    if (wordMatch && wordMatch.index !== undefined && wordMatch.index > 0) {
      body = candidate.slice(0, wordMatch.index);
    } else {
      // 3. Single long token — hard cut.
      body = candidate;
    }
  }

  // 4. Strip trailing whitespace + punctuation that would look ugly before
  // the ellipsis. Keep word characters and closing brackets/quotes intact.
  body = body.replace(/[\s.,;:!?\-—–]+$/u, "");

  return {
    text: body + ELLIPSIS,
    truncated: true,
    originalChars,
  };
}
