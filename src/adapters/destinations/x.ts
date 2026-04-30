import { loadOAuth2Tokens } from "../../config.js";
import { DraftPost, PairRecord, SourceItem } from "../../core/types.js";
import { DestinationAdapter } from "../destination.js";
import { formatForX } from "../../x-client.js";

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
    if (text.length > 280) {
      warnings.push("Draft exceeds classic X length; x-client thread mode would be needed for live posting.");
    }
    return {
      destinationType: "x-account",
      text,
      warnings,
      metadata: {
        formatter: "formatForX",
      },
    };
  },
};
