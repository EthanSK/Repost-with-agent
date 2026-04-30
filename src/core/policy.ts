import { PairPolicy } from "./types.js";

export const DEFAULT_POLICY: PairPolicy = {
  requirePreviewBeforeFirstLiveRun: true,
  maxItemsPerRun: 1,
  minDelayBetweenPostsMinutes: 60,
  preferOfficialApi: true,
  blockOnUncertainDuplicate: true,
};

export function normalizePolicy(policy?: Partial<PairPolicy>): PairPolicy {
  return {
    ...DEFAULT_POLICY,
    ...policy,
  };
}
