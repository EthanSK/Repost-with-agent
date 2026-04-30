import {
  AuthHealth,
  DraftPost,
  PairRecord,
  SourceItem,
} from "../core/types.js";

export interface DestinationAdapter {
  type: string;
  test(pair: PairRecord): Promise<AuthHealth>;
  preview(item: SourceItem, pair: PairRecord): Promise<DraftPost>;
}
