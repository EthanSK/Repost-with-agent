import { loadLinkedInScrapeConfig } from "../../config.js";
import { SourceAdapter, SourceFetchOptions, SourceFetchResult } from "../source.js";
import { PairRecord, SourceItem } from "../../core/types.js";
import { scrapeLinkedInPosts } from "../../linkedin-scraper.js";

const DEFAULT_PAGE_SIZE = 10;
// Each scroll triggers LinkedIn's infinite-scroll loader, yielding ~5-10
// additional posts. We pick a number of scrolls proportional to the requested
// page so deeper pages have enough buffer to actually surface those items.
const SCROLLS_PER_PAGE = 3;

function postsToItems(
  posts: Array<{ text: string; url: string | null }>
): SourceItem[] {
  return posts.map((post) => ({
    sourceItemId: post.url || undefined,
    canonicalUrl: post.url,
    text: post.text,
    metadata: {
      adapter: "linkedin-profile-activity",
    },
  }));
}

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
    return postsToItems(posts);
  },
  async fetchPage(
    pair: PairRecord,
    options: SourceFetchOptions
  ): Promise<SourceFetchResult> {
    const profileUrl = pair.source.profileUrl || pair.source.url;
    if (!profileUrl) {
      return { items: [], hasMore: false };
    }
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
    // To return page N, we need to load enough posts to fill (page * pageSize).
    // We always return the full prefix and let the caller slice by page.
    const totalNeeded = page * pageSize;
    const config = loadLinkedInScrapeConfig(profileUrl);
    const posts = await scrapeLinkedInPosts(config, {
      maxPosts: totalNeeded,
      scrollIterations: page * SCROLLS_PER_PAGE,
    });

    const allItems = postsToItems(posts);
    const start = (page - 1) * pageSize;
    const slice = allItems.slice(start, start + pageSize);
    return {
      items: slice,
      hasMore: allItems.length > start + slice.length,
    };
  },
};
