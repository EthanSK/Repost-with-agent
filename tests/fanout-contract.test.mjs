import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const TERMINAL_STATUSES = new Set([
  'posted',
  'already-posted',
  'caught-up',
  'skipped-rule',
  'skipped-by-policy',
]);

function isExplicitBlock(destination) {
  return (
    destination.status === 'blocked' &&
    Boolean(destination.category) &&
    Boolean(destination.reason) &&
    Boolean(destination.nextAction)
  );
}

function isTerminal(destination) {
  return TERMINAL_STATUSES.has(destination.status) || isExplicitBlock(destination);
}

function summarizeFanout(destinations) {
  const missing = destinations.filter((destination) => !isTerminal(destination));
  if (missing.length > 0) {
    return {
      status: 'partial',
      pendingPairIds: missing.map((destination) => destination.pairId),
      blockedPairIds: destinations
        .filter((destination) => destination.status === 'blocked')
        .map((destination) => destination.pairId),
    };
  }

  const blockedPairIds = destinations
    .filter((destination) => destination.status === 'blocked')
    .map((destination) => destination.pairId);

  if (blockedPairIds.length > 0) {
    return { status: 'blocked', pendingPairIds: [], blockedPairIds };
  }

  return { status: 'complete', pendingPairIds: [], blockedPairIds: [] };
}

function hasSourceUrlLeak({ draftText, canonicalSourceUrl, sourcePlatform = 'linkedin' }) {
  if (!draftText) return false;

  if (canonicalSourceUrl && draftText.includes(canonicalSourceUrl)) {
    return true;
  }

  if (sourcePlatform === 'linkedin') {
    return /linkedin\.com\/feed\/update\//i.test(draftText) || /urn:li:activity:/i.test(draftText);
  }

  return false;
}

function normalizeLivePostText(text) {
  return String(text ?? '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function livePostTextMatches({ intendedDraftText, observedLiveText }) {
  return normalizeLivePostText(intendedDraftText) === normalizeLivePostText(observedLiveText);
}

function enabledDestinationPairs({ pairs, sourcePlatform, sourceProfileUrl }) {
  return pairs
    .filter((pair) => pair.enabled === true)
    .filter((pair) => pair.source?.platform === sourcePlatform)
    .filter((pair) => !sourceProfileUrl || pair.source?.profileUrl === sourceProfileUrl)
    .map((pair) => ({
      pairId: pair.id,
      destinationPlatform: pair.destination.platform,
      destinationAccountHint: pair.destination.accountHint,
      status: 'planned',
      terminal: false,
    }));
}

function planFanout({ pairs, sourceItem, existingProofPairIds = [], skippedRulePairIds = [], blocked = {} }) {
  return enabledDestinationPairs({
    pairs,
    sourcePlatform: sourceItem.platform,
    sourceProfileUrl: sourceItem.profileUrl,
  }).map((destination) => {
    if (existingProofPairIds.includes(destination.pairId)) {
      return { ...destination, status: 'already-posted', terminal: true, reason: 'existing proof' };
    }

    if (skippedRulePairIds.includes(destination.pairId)) {
      return { ...destination, status: 'skipped-rule', terminal: true, ruleId: 'test-rule' };
    }

    if (blocked[destination.pairId]) {
      return { ...destination, status: 'blocked', ...blocked[destination.pairId] };
    }

    return destination;
  });
}

const pairs = [
  {
    id: 'linkedin-to-x',
    enabled: true,
    source: { platform: 'linkedin', profileUrl: 'https://linkedin.example/in/ethan' },
    destination: { platform: 'x', accountHint: '@ethan' },
  },
  {
    id: 'linkedin-to-bluesky',
    enabled: true,
    source: { platform: 'linkedin', profileUrl: 'https://linkedin.example/in/ethan' },
    destination: { platform: 'bluesky', accountHint: 'ethan.bsky.social' },
  },
  {
    id: 'linkedin-to-threads',
    enabled: true,
    source: { platform: 'linkedin', profileUrl: 'https://linkedin.example/in/ethan' },
    destination: { platform: 'threads', accountHint: '@ethan' },
  },
  {
    id: 'linkedin-to-facebook',
    enabled: true,
    source: { platform: 'linkedin', profileUrl: 'https://linkedin.example/in/ethan' },
    destination: { platform: 'facebook', accountHint: 'Ethan Page' },
  },
  {
    id: 'linkedin-to-disabled-destination',
    enabled: false,
    source: { platform: 'linkedin', profileUrl: 'https://linkedin.example/in/ethan' },
    destination: { platform: 'mastodon', accountHint: '@ethan@example.social' },
  },
  {
    id: 'x-to-bluesky',
    enabled: true,
    source: { platform: 'x', profileUrl: 'https://x.example/ethan' },
    destination: { platform: 'bluesky', accountHint: 'ethan.bsky.social' },
  },
];

const sourceItem = {
  platform: 'linkedin',
  profileUrl: 'https://linkedin.example/in/ethan',
  sourceItemId: 'urn:li:activity:7000',
};

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('source fanout enumerates all enabled destinations for the selected source only', () => {
  const destinations = enabledDestinationPairs({
    pairs,
    sourcePlatform: 'linkedin',
    sourceProfileUrl: 'https://linkedin.example/in/ethan',
  });

  assert.deepEqual(
    destinations.map((destination) => destination.pairId),
    ['linkedin-to-x', 'linkedin-to-bluesky', 'linkedin-to-threads', 'linkedin-to-facebook'],
  );
});

test('already-posted destinations are terminal while missing destinations stay planned', () => {
  const destinations = planFanout({
    pairs,
    sourceItem,
    existingProofPairIds: ['linkedin-to-x'],
  });

  const byPair = Object.fromEntries(destinations.map((destination) => [destination.pairId, destination]));
  assert.equal(byPair['linkedin-to-x'].status, 'already-posted');
  assert.equal(isTerminal(byPair['linkedin-to-x']), true);
  assert.equal(byPair['linkedin-to-bluesky'].status, 'planned');
  assert.equal(isTerminal(byPair['linkedin-to-bluesky']), false);
});

test('unattempted enabled destination makes the source item partial with resume data', () => {
  const destinations = [
    { pairId: 'linkedin-to-x', status: 'posted' },
    { pairId: 'linkedin-to-bluesky', status: 'posted' },
    { pairId: 'linkedin-to-threads', status: 'caught-up' },
    { pairId: 'linkedin-to-facebook', status: 'unattempted' },
  ];

  assert.deepEqual(summarizeFanout(destinations), {
    status: 'partial',
    pendingPairIds: ['linkedin-to-facebook'],
    blockedPairIds: [],
  });
});

test('all done requires every destination to have a terminal status', () => {
  const completeDestinations = [
    { pairId: 'linkedin-to-x', status: 'posted' },
    { pairId: 'linkedin-to-bluesky', status: 'already-posted' },
    { pairId: 'linkedin-to-threads', status: 'caught-up' },
    { pairId: 'linkedin-to-facebook', status: 'skipped-rule' },
  ];

  assert.deepEqual(summarizeFanout(completeDestinations), {
    status: 'complete',
    pendingPairIds: [],
    blockedPairIds: [],
  });

  const incompleteDestinations = completeDestinations.with(3, {
    pairId: 'linkedin-to-facebook',
    status: 'failed',
    error: 'browser closed before compose',
  });

  assert.equal(summarizeFanout(incompleteDestinations).status, 'partial');
});

test('explicit blocks are closed as blocked, but incomplete blocks stay partial', () => {
  const destinations = planFanout({
    pairs,
    sourceItem,
    existingProofPairIds: ['linkedin-to-x', 'linkedin-to-bluesky', 'linkedin-to-threads'],
    blocked: {
      'linkedin-to-facebook': {
        category: 'needs-login',
        reason: 'Facebook session expired in the OpenClaw browser profile',
        nextAction: 'Ethan logs into Facebook in OpenClaw profile, then resume this source item',
      },
    },
  });

  assert.deepEqual(summarizeFanout(destinations), {
    status: 'blocked',
    pendingPairIds: [],
    blockedPairIds: ['linkedin-to-facebook'],
  });

  const incompleteBlock = destinations.map((destination) =>
    destination.pairId === 'linkedin-to-facebook'
      ? { pairId: destination.pairId, status: 'blocked', reason: 'missing next action' }
      : destination,
  );

  assert.equal(summarizeFanout(incompleteBlock).status, 'partial');
});

test('source fanout manifest template is valid JSON and visibly partial when a destination is unattempted', () => {
  const template = JSON.parse(
    readFileSync(join(root, 'templates/source-fanout-manifest.json.template'), 'utf8'),
  );

  assert.equal(template.schemaVersion, 1);
  assert.equal(template.status, 'partial');
  assert.equal(template.source.platform, 'linkedin');
  assert.deepEqual(template.resume.pendingPairIds, ['linkedin-to-facebook']);
  assert.equal(
    summarizeFanout(template.destinations).status,
    'partial',
    'template must not look complete while Facebook is unattempted',
  );
});

test('docs and skill state that a scheduled source backfill slot is one source-item fanout', () => {
  const docs = readFileSync(join(root, 'docs/source-fanout.md'), 'utf8');
  const skill = readFileSync(join(root, 'skills/repost-source-fanout/SKILL.md'), 'utf8');

  assert.match(docs, /one source item/i);
  assert.match(docs, /all enabled destination/i);
  assert.match(skill, /It is \*\*not\*\* four independent destination jobs/i);
  assert.match(skill, /Never mark a source item `complete` merely because one destination posted/i);
});

test('source fanout notifications are one aggregate message, not per-platform pings', () => {
  const sourceFanoutSkill = readFileSync(join(root, 'skills/repost-source-fanout/SKILL.md'), 'utf8');
  const notifySkill = readFileSync(join(root, 'skills/repost-notify/SKILL.md'), 'utf8');
  const backfillCommand = readFileSync(join(root, 'commands/backfill.md'), 'utf8');

  assert.match(sourceFanoutSkill, /Do \*\*not\*\* send one message per platform/i);
  assert.match(sourceFanoutSkill, /one source item gets one\s+aggregate message after all enabled destinations/i);
  assert.match(notifySkill, /one message per source post containing all platform outcomes/i);
  assert.match(backfillCommand, /not one message per platform/i);
});

test('source URL leak guard blocks LinkedIn canonical URLs in public drafts', () => {
  assert.equal(
    hasSourceUrlLeak({
      canonicalSourceUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000/',
      draftText: 'Native destination copy\n\nhttps://www.linkedin.com/feed/update/urn:li:activity:7000/',
    }),
    true,
  );

  assert.equal(
    hasSourceUrlLeak({
      canonicalSourceUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000/',
      draftText: 'Native destination copy only',
    }),
    false,
  );
});

test('live post text proof gate rejects malformed composer fragments', () => {
  const intendedDraftText = `How do you come up with ideas to make with agents?\n\nI start by automating a manual flow. As I prompt the narrow version, I usually realise it wants to be a general purpose app, with one sliver covering my own need.\n\nThen I open source it.`;

  assert.equal(
    livePostTextMatches({
      intendedDraftText,
      observedLiveText: `How do you come up with ideas to make with agents?\n\n\nI start by automating a manual flow. As I prompt the narrow version, I usually realise it wants to be a general purpose app, with one sliver covering my own need.\n\nThen I open source it.`,
    }),
    true,
  );

  assert.equal(
    livePostTextMatches({
      intendedDraftText,
      observedLiveText: `Then I open source it.\n\nThen I open source it.sliver covering my own need.\n\nThen I open source it.`,
    }),
    false,
  );
});

test('docs require a fail-closed source URL leak guard before publishing', () => {
  const runSkill = readFileSync(join(root, 'skills/repost-run/SKILL.md'), 'utf8');
  const urlExpandSkill = readFileSync(join(root, 'skills/repost-url-expand/SKILL.md'), 'utf8');
  const sourceFanoutSkill = readFileSync(join(root, 'skills/repost-source-fanout/SKILL.md'), 'utf8');

  assert.match(runSkill, /Mandatory source URL leak guard/i);
  assert.match(runSkill, /source-url-leak-guard/i);
  assert.match(urlExpandSkill, /source URL leak guard/i);
  assert.match(sourceFanoutSkill, /source-url-leak-guard/i);
});

test('docs require live destination text proof before success state', () => {
  const runSkill = readFileSync(join(root, 'skills/repost-run/SKILL.md'), 'utf8');
  const sourceFanoutSkill = readFileSync(join(root, 'skills/repost-source-fanout/SKILL.md'), 'utf8');
  const backfillSkill = readFileSync(join(root, 'skills/repost-backfill/SKILL.md'), 'utf8');
  const xDocs = readFileSync(join(root, 'docs/destinations/x.md'), 'utf8');
  const sourceFanoutDocs = readFileSync(join(root, 'docs/source-fanout.md'), 'utf8');
  const stateDocs = readFileSync(join(root, 'docs/state-files.md'), 'utf8');

  assert.match(runSkill, /Mandatory live-post text proof gate/i);
  assert.match(runSkill, /pair\.publish\.live_text_mismatch/i);
  assert.match(runSkill, /posted-malformed/i);
  assert.match(sourceFanoutSkill, /live-post text proof gate/i);
  assert.match(backfillSkill, /live-post text proof gate/i);
  assert.match(xDocs, /Hard proof gate/i);
  assert.match(sourceFanoutDocs, /live text did not match the intended draft/i);
  assert.match(stateDocs, /global\.publish\.malformed/i);
});

test('docs require compaction to be destination-wide and UI-feedback gated', () => {
  const runSkill = readFileSync(join(root, 'skills/repost-run/SKILL.md'), 'utf8');
  const stateDocs = readFileSync(join(root, 'docs/state-files.md'), 'utf8');
  const xDocs = readFileSync(join(root, 'docs/destinations/x.md'), 'utf8');
  const blueskyDocs = readFileSync(join(root, 'docs/destinations/bluesky.md'), 'utf8');
  const threadsDocs = readFileSync(join(root, 'docs/destinations/threads.md'), 'utf8');
  const facebookDocs = readFileSync(join(root, 'docs/destinations/facebook.md'), 'utf8');

  assert.match(runSkill, /Destination-wide Ethan rule/i);
  assert.doesNotMatch(runSkill, /X-specific Ethan rule/i);
  for (const docs of [stateDocs, xDocs, blueskyDocs, threadsDocs, facebookDocs]) {
    assert.match(docs, /live UI|live destination composer UI|destination UI/i);
    assert.match(docs, /only compact|do \*\*not\*\* pre-compact|Do not compact solely/i);
  }
});

console.log('fanout contract tests passed');
