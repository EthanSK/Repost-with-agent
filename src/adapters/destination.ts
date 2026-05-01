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
}
