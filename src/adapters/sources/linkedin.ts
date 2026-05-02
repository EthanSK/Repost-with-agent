import { loadLinkedInScrapeConfig } from "../../config.js";
import { SourceAdapter, SourceFetchOptions, SourceFetchResult } from "../source.js";
import { PairRecord, SourceItem } from "../../core/types.js";
import { scrapeLinkedInPosts } from "../../linkedin-scraper.js";

const DEFAULT_PAGE_SIZE = 10;
// Each scroll iteration triggers LinkedIn's infinite-scroll loader. Empirically
// each scroll yields ~3-6 additional posts, but the first batch (no scrolls)
// already produces ~10. We size scrolls so that requesting `pageSize`
// items needs ~SCROLLS_PER_PAGE_SIZE_BLOCK extra scrolls. Fix v2.6.0:
// previously we computed `page * SCROLLS_PER_PAGE` which produced too few
// scrolls for `--pages 2` and stopped early because `hasMore` evaluated false
// when the slice exactly equaled the loaded count.
const SCROLLS_PER_PAGE_SIZE_BLOCK = 4;

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
    // FIX (v2.6.0): the previous implementation re-fetched on every page,
    // and it set `hasMore = (allItems.length > start + slice.length)`. Page 1
    // typically loaded exactly 10 items, slice was [0..10), so allItems.length
    // (10) > 0 + 10 was FALSE — and the backfill caller bailed before page 2
    // ever ran. Even when page 2 did run, `page * SCROLLS_PER_PAGE = 6` scrolls
    // didn't reliably surface ~20 posts.
    //
    // New strategy: aggregate scroll across the full requested span. We always
    // load up to `page * pageSize` posts in a single scroll burst proportional
    // to the *total* requested set, slice the appropriate window for THIS
    // page, and report `hasMore = true` whenever the underlying scrape filled
    // its quota (the caller's `--pages N` loop is the real upper bound).
    const totalNeeded = page * pageSize;
    // Scroll budget: 1 baseline + N blocks per pageSize. e.g. pageSize=10,
    // page=2 → totalNeeded=20 → 1 + (20/10)*4 = 9 scrolls. Empirically this
    // surfaces 18-25 posts on a typical timeline.
    const scrollIterations =
      1 + Math.ceil(totalNeeded / pageSize) * SCROLLS_PER_PAGE_SIZE_BLOCK;
    const config = loadLinkedInScrapeConfig(profileUrl);
    const posts = await scrapeLinkedInPosts(config, {
      maxPosts: totalNeeded,
      scrollIterations,
    });

    const allItems = postsToItems(posts);
    const start = (page - 1) * pageSize;
    const slice = allItems.slice(start, start + pageSize);
    // Trust the caller's `--pages N` request: if we returned a full slice for
    // this page, signal hasMore so the caller will fetch the next page.
    // Returning fewer items than requested does mean "no more" — only then do
    // we definitively cap.
    const filledFullPage = slice.length === pageSize;
    return {
      items: slice,
      hasMore: filledFullPage,
    };
  },
};
