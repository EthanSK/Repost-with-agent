import { loadOAuth2Tokens, loadXCredentials } from "../../config.js";
import { DraftPost, PairRecord, SourceItem } from "../../core/types.js";
import { DestinationAdapter, PublishResult } from "../destination.js";
import { formatForX, postTweet } from "../../x-client.js";

const X_PREMIUM_LIMIT = parseInt(process.env.X_CHAR_LIMIT || "25000", 10);
const X_CLASSIC_LIMIT = 280;

export const xDestinationAdapter: DestinationAdapter = {
  type: "x-account",
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
};
