import { AuthHealth, PairRecord, SourceItem } from "../core/types.js";

export interface SourceAdapter {
  type: string;
  test(pair: PairRecord): Promise<AuthHealth>;
  fetchCandidates(pair: PairRecord): Promise<SourceItem[]>;
}
