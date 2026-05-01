import {
  AuthHealth,
  DraftPost,
  PairRecord,
  SourceItem,
} from "../core/types.js";

export interface PublishResult {
  success: boolean;
  destinationId?: string;
  destinationUrl?: string;
  error?: string;
}

export interface DestinationLookupResult {
  /** True when the adapter is confident the draft is already on the destination. */
  exists: boolean;
  /** Optional destination URL of the existing post, when known. */
  url?: string;
  /** Optional destination id of the existing post, when known. */
  id?: string;
  /** Optional ISO timestamp when the existing post was created, when known. */
  postedAt?: string;
  /** Free-form reason describing how the match was made, for audit logs. */
  reason?: string;
}

export interface DestinationAdapter {
  type: string;
  test(pair: PairRecord): Promise<AuthHealth>;
  preview(item: SourceItem, pair: PairRecord): Promise<DraftPost>;
  /**
   * Optional live-publish hook. Implementations should return success only when
   * the post was actually submitted and confirmed by the destination platform.
   */
  publish?(
    item: SourceItem,
    draft: DraftPost,
    pair: PairRecord
  ): Promise<PublishResult>;
  /**
   * Optional lookup hook used by `pair backfill` to perform cross-state dedupe.
   * Given the *transformed* draft about to be posted, return whether an
   * effectively-equivalent post already exists on the destination. Adapters
   * that don't implement this fall back to local `posted.jsonl` dedupe only.
   *
   * Implementations should be defensive: hash the normalized draft text (lower
   * case, whitespace-collapsed, trailing-punctuation stripped) and match
   * against recent destination history. Network errors should be reported via
   * `reason` and `exists: false` (treat lookup failure as "unknown" — the
   * caller will not skip on the basis of a failed lookup).
   */
  findExistingPost?(
    draft: DraftPost,
    pair: PairRecord
  ): Promise<DestinationLookupResult>;
}
