import { loadLinkedInScrapeConfig } from "../../config.js";
import { SourceAdapter } from "../source.js";
import { PairRecord, SourceItem } from "../../core/types.js";
import { scrapeLinkedInPosts } from "../../linkedin-scraper.js";

export const linkedInSourceAdapter: SourceAdapter = {
  type: "linkedin-profile-activity",
  async test(pair: PairRecord) {
    const profileUrl = pair.source.profileUrl || pair.source.url;
    if (!profileUrl) {
      return {
        ok: false,
        status: "needs-config",
        message: "Pair is missing source.profileUrl/source.url for LinkedIn.",
      };
    }
    return {
      ok: true,
      status: "unknown",
      message: "LinkedIn uses the configured Playwright profile; preview confirms live login state.",
    };
  },
  async fetchCandidates(pair: PairRecord): Promise<SourceItem[]> {
    const profileUrl = pair.source.profileUrl || pair.source.url;
    if (!profileUrl) {
      return [];
    }
    const config = loadLinkedInScrapeConfig(profileUrl);
    const posts = await scrapeLinkedInPosts(config);
    return posts.map((post) => ({
      sourceItemId: post.url || undefined,
      canonicalUrl: post.url,
      text: post.text,
      metadata: {
        adapter: "linkedin-profile-activity",
      },
    }));
  },
};
