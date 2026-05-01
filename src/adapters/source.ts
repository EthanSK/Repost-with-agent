import { AuthHealth, PairRecord, SourceItem } from "../core/types.js";

/**
 * Options for paginated source fetches. Used by `pair backfill` to walk back
 * through historical posts. The adapter is responsible for translating these
 * into platform-appropriate calls (scroll N times, hit a cursor endpoint,
 * iterate over pages, etc.). All fields are advisory — the adapter MAY return
 * fewer items than requested.
 */
export interface SourceFetchOptions {
  /** 1-based page index to fetch. Default: 1 (newest items). */
  page?: number;
  /** Hint for max items per page. Default: adapter-specific. */
  pageSize?: number;
  /** Optional opaque cursor returned by a previous fetch. */
  cursor?: string;
}

export interface SourceFetchResult {
  items: SourceItem[];
  /** Optional cursor the caller can use to fetch the next page. */
  nextCursor?: string;
  /** Whether the adapter believes more items exist beyond what was returned. */
  hasMore?: boolean;
}

export interface SourceAdapter {
  type: string;
  test(pair: PairRecord): Promise<AuthHealth>;
  fetchCandidates(pair: PairRecord): Promise<SourceItem[]>;
  /**
   * Optional paginated fetch. When present, callers (e.g. backfill) may walk
   * back through history one page at a time. Adapters without this method
   * fall back to fetchCandidates() and return a single-page result.
   */
  fetchPage?(
    pair: PairRecord,
    options: SourceFetchOptions
  ): Promise<SourceFetchResult>;
}
