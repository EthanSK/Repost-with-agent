import { loadOAuth2Tokens, loadXCredentials } from "../../config.js";
import { DraftPost, PairRecord, SourceItem } from "../../core/types.js";
import {
  DestinationAdapter,
  DestinationLookupResult,
  PublishResult,
} from "../destination.js";
import { fetchRecentTweets, formatForX, postTweet } from "../../x-client.js";

const X_PREMIUM_LIMIT = parseInt(process.env.X_CHAR_LIMIT || "25000", 10);
const X_CLASSIC_LIMIT = 280;

/**
 * Normalize destination text for fuzzy duplicate matching. Collapses
 * whitespace, lowercases, strips trailing punctuation, and removes URL
 * trailing slashes / query fragments. Two drafts whose normalized form match
 * are treated as the same post.
 */
export function normalizeForDestinationMatch(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, (url) =>
      url.replace(/[)\]>.,;!?]+$/, "").replace(/\/$/, "")
    )
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?]+$/g, "")
    .trim()
    .toLowerCase();
}

export const xDestinationAdapter: DestinationAdapter = {
  type: "x-account",
  // X (classic) hard limit. Drafts longer than this trigger the
  // `--overlength-strategy` policy in `pair backfill` / publish paths
  // (skip-too-long by default, or smart-truncate when the user opts in).
  // Note: when X Premium credentials are present, x-client.postTweet()
  // will already split longer drafts into a thread up to X_PREMIUM_LIMIT.
  // We keep maxLength at the classic 280 because the orchestrator-level
  // truncate strategy is conservative and intended for the NON-Premium
  // path; users who want long drafts published as threads can leave the
  // strategy at "skip" and rely on x-client's threading logic.
  maxLength: X_CLASSIC_LIMIT,
  async test(_pair: PairRecord) {
    const hasOAuth1 =
      Boolean(process.env.X_API_KEY) &&
      Boolean(process.env.X_API_SECRET) &&
      Boolean(process.env.X_ACCESS_TOKEN) &&
      Boolean(process.env.X_ACCESS_TOKEN_SECRET);
    const hasOAuth2 = Boolean(loadOAuth2Tokens());

    if (!hasOAuth1 && !hasOAuth2) {
      return {
        ok: false,
        status: "needs-config",
        message: "No X credentials detected. Preview still works; publishing remains disabled.",
      };
    }

    return {
      ok: true,
      status: "ok",
      message: hasOAuth2
        ? "X OAuth2 token file is present."
        : "X OAuth1 environment variables are present.",
    };
  },
  async preview(item: SourceItem, _pair: PairRecord): Promise<DraftPost> {
    const text = formatForX(item.text, item.canonicalUrl || undefined);
    const warnings: string[] = [];
    if (!item.canonicalUrl) {
      warnings.push("Source item has no canonical URL; dedupe relies on source ID/content hash.");
    }
    if (text.length > X_PREMIUM_LIMIT) {
      warnings.push(
        `Draft (${text.length} chars) exceeds X Premium limit (${X_PREMIUM_LIMIT}); x-client will post as a thread.`
      );
    } else if (text.length > X_CLASSIC_LIMIT) {
      warnings.push(
        `Draft (${text.length} chars) exceeds classic X limit (${X_CLASSIC_LIMIT}); needs X Premium on the destination account or it will be threaded.`
      );
    }
    return {
      destinationType: "x-account",
      text,
      warnings,
      metadata: {
        formatter: "formatForX",
        chars: text.length,
      },
    };
  },
  async publish(_item: SourceItem, draft: DraftPost, _pair: PairRecord): Promise<PublishResult> {
    const creds = loadXCredentials();
    const result = await postTweet(creds, draft.text);
    if (result.success && result.tweetId) {
      return {
        success: true,
        destinationId: result.tweetId,
        destinationUrl: `https://x.com/i/status/${result.tweetId}`,
      };
    }
    return { success: false, error: result.error || "Unknown publish error" };
  },
  async findExistingPost(
    draft: DraftPost,
    _pair: PairRecord
  ): Promise<DestinationLookupResult> {
    try {
      const tokens = loadOAuth2Tokens();
      if (!tokens) {
        return {
          exists: false,
          reason: "No OAuth2 token available; cannot query destination history.",
        };
      }
      // Fetch the most recent tweets from the authenticated user. We compare
      // the *first segment* of the draft (everything before the trailing
      // source URL) since X collapses URLs to t.co aliases, which would never
      // match the LinkedIn URL exactly.
      const draftHead = stripTrailingUrl(draft.text);
      const target = normalizeForDestinationMatch(draftHead);
      // Don't let an empty/very-short normalized form ever match -- avoid
      // false positives on near-empty drafts.
      if (target.length < 24) {
        return {
          exists: false,
          reason: "Draft too short for fuzzy destination match.",
        };
      }
      const tweets = await fetchRecentTweets(tokens.accessToken, 100);
      for (const tweet of tweets) {
        const tweetHead = stripTrailingUrl(tweet.text);
        const candidate = normalizeForDestinationMatch(tweetHead);
        if (candidate.length === 0) continue;
        if (candidate === target) {
          return {
            exists: true,
            id: tweet.id,
            url: `https://x.com/i/status/${tweet.id}`,
            postedAt: tweet.created_at,
            reason: "Exact normalized match against destination tweet history.",
          };
        }
        // Fuzzy: candidate is a prefix of target or target is a prefix of
        // candidate (handles cases where X truncated or LinkedIn was
        // slightly edited). Require enough overlap to avoid false positives.
        const minLen = Math.min(candidate.length, target.length);
        if (minLen >= 80) {
          if (candidate.startsWith(target.slice(0, minLen)) || target.startsWith(candidate.slice(0, minLen))) {
            return {
              exists: true,
              id: tweet.id,
              url: `https://x.com/i/status/${tweet.id}`,
              postedAt: tweet.created_at,
              reason: "Prefix match against destination tweet history (>=80 chars).",
            };
          }
        }
      }
      return {
        exists: false,
        reason: `No match in last ${tweets.length} destination tweets.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        exists: false,
        reason: `Destination lookup failed: ${message}. Treating as unknown.`,
      };
    }
  },
};

function stripTrailingUrl(text: string): string {
  // Remove a trailing URL line we know we add ourselves (e.g. the LinkedIn
  // canonical URL). Keep the body for fuzzy matching.
  return text
    .replace(/\n\nhttps?:\/\/\S+\s*$/, "")
    .replace(/\n+https?:\/\/\S+\s*$/, "")
    .replace(/\s+https?:\/\/\S+\s*$/, "")
    .trim();
}
