import * as fs from "fs";

export interface TrackerEntry {
  linkedinSnippet: string;
  datePostedToX: string;
  xPostId: string;
  /** Comma-separated list of platforms this post was cross-posted to (e.g. "x", "x,facebook") */
  platforms?: string;
  /** Facebook post ID if posted to Facebook */
  fbPostId?: string;
}

const HEADER = `# Repost-with-agent Legacy X Tracker

This file tracks legacy posts that have been cross-posted to X.
Do not delete this file — it is used for deduplication.

| LinkedIn Post Snippet | Date Posted to X | X Post ID |
|---|---|---|`;

export function loadTracker(filePath: string): TrackerEntry[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const entries: TrackerEntry[] = [];

    for (const line of lines) {
      // Match table rows: | snippet | date | id |
      const match = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
      if (match && match[1] !== "LinkedIn Post Snippet" && match[1] !== "---") {
        entries.push({
          linkedinSnippet: match[1],
          datePostedToX: match[2],
          xPostId: match[3],
        });
      }
    }

    return entries;
  } catch {
    return [];
  }
}

export function saveTracker(filePath: string, entries: TrackerEntry[]): void {
  const rows = entries.map(
    (e) => `| ${e.linkedinSnippet} | ${e.datePostedToX} | ${e.xPostId} |`
  );
  const content = HEADER + "\n" + rows.join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
}

export function addTrackerEntry(
  filePath: string,
  entry: TrackerEntry
): void {
  const entries = loadTracker(filePath);
  entries.push(entry);
  saveTracker(filePath, entries);
}

/**
 * Update an existing tracker entry (matched by linkedinSnippet).
 * Used to update the entry after posting to additional platforms (e.g. Facebook).
 */
export function updateTrackerEntry(
  filePath: string,
  linkedinSnippet: string,
  updates: Partial<TrackerEntry>
): void {
  const entries = loadTracker(filePath);
  const needle = normalizeSnippet(linkedinSnippet);
  for (const entry of entries) {
    if (normalizeSnippet(entry.linkedinSnippet) === needle) {
      Object.assign(entry, updates);
      break;
    }
  }
  saveTracker(filePath, entries);
}

export function isAlreadyPosted(
  entries: TrackerEntry[],
  postText: string
): boolean {
  const needle = normalizeSnippet(postText);
  return entries.some((e) => normalizeSnippet(e.linkedinSnippet) === needle);
}

export function normalizeSnippet(text: string): string {
  return text
    .replace(/\\\|/g, "|")   // unescape pipes from tracker format
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.{3}$/, "")   // strip trailing "..." from tracker truncation
    .slice(0, 97)
    .toLowerCase();
}

export function snippetForTracker(text: string): string {
  // Escape pipes for markdown table, truncate to 100 chars
  const clean = text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
  if (clean.length > 100) {
    return clean.slice(0, 97) + "...";
  }
  return clean;
}

/**
 * Separate tracker for Facebook posts — stored as JSON alongside the markdown tracker.
 * This avoids breaking the existing markdown table format.
 */
export interface FacebookTrackerEntry {
  linkedinSnippet: string;
  datePostedToFb: string;
  fbPostId: string;
}

export function getFbTrackerPath(trackerFilePath: string): string {
  return trackerFilePath.replace(/\.md$/, "-facebook.json");
}

export function loadFbTracker(trackerFilePath: string): FacebookTrackerEntry[] {
  const fbPath = getFbTrackerPath(trackerFilePath);
  if (!fs.existsSync(fbPath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(fbPath, "utf-8"));
  } catch {
    return [];
  }
}

export function addFbTrackerEntry(
  trackerFilePath: string,
  entry: FacebookTrackerEntry
): void {
  const entries = loadFbTracker(trackerFilePath);
  entries.push(entry);
  const fbPath = getFbTrackerPath(trackerFilePath);
  fs.writeFileSync(fbPath, JSON.stringify(entries, null, 2), "utf-8");
}

export function isAlreadyPostedToFb(
  entries: FacebookTrackerEntry[],
  postText: string
): boolean {
  const needle = normalizeSnippet(postText);
  return entries.some((e) => normalizeSnippet(e.linkedinSnippet) === needle);
}
