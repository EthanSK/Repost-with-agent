import { scrapeLinkedInPosts, LinkedInPost } from "./linkedin-scraper.js";
import { formatForX, postTweet } from "./x-client.js";
import {
  postToFacebook,
  postToFacebookWithLink,
} from "./facebook-client.js";
import {
  addFbTrackerEntry,
  addTrackerEntry,
  isAlreadyPosted,
  isAlreadyPostedToFb,
  loadFbTracker,
  loadTracker,
  snippetForTracker,
} from "./tracker.js";
import { loadLegacySyncConfig } from "./config.js";

export async function runLegacySync(opts: {
  dryRun?: boolean;
  facebookOnly?: boolean;
  xOnly?: boolean;
}): Promise<void> {
  const config = loadLegacySyncConfig();
  console.log("=== Legacy LinkedIn -> X Sync ===\n");
  console.log("This command is preserved for compatibility. New setup should use `pair` commands.\n");

  const postToX = !opts.facebookOnly;
  const postToFb = config.facebookEnabled && !opts.xOnly;

  if (postToFb) {
    console.log("Facebook posting: ENABLED");
  }

  const posts = await scrapeLinkedInPosts(config);
  if (posts.length === 0) {
    console.log("No posts found on LinkedIn (or not logged in).");
    return;
  }

  const trackerEntries = loadTracker(config.trackerFilePath);
  const fbTrackerEntries = postToFb ? loadFbTracker(config.trackerFilePath) : [];
  console.log(`X tracker has ${trackerEntries.length} existing entries.`);
  if (postToFb) {
    console.log(`Facebook tracker has ${fbTrackerEntries.length} existing entries.`);
  }

  let newPostsForX: LinkedInPost[] = [];
  let newPostsForFb: LinkedInPost[] = [];

  if (postToX) {
    newPostsForX = posts.filter((p) => !isAlreadyPosted(trackerEntries, p.text));
    console.log(`Found ${newPostsForX.length} new post(s) for X.`);
  }
  if (postToFb) {
    newPostsForFb = posts.filter((p) => !isAlreadyPostedToFb(fbTrackerEntries, p.text));
    console.log(`Found ${newPostsForFb.length} new post(s) for Facebook.`);
  }

  if (newPostsForX.length === 0 && newPostsForFb.length === 0) {
    console.log("\nNothing new to post. All caught up!");
    return;
  }

  const allNewPostTexts = new Set<string>();
  for (const post of [...newPostsForX, ...newPostsForFb]) {
    allNewPostTexts.add(post.text);
  }
  const postsToSend = posts
    .filter((post) => allNewPostTexts.has(post.text))
    .reverse();

  let xSuccessCount = 0;
  let fbSuccessCount = 0;

  for (let i = 0; i < postsToSend.length; i++) {
    const post = postsToSend[i];
    const preview = post.text.slice(0, 100).replace(/\n/g, " ");
    const shouldPostToX = postToX && newPostsForX.some((p) => p.text === post.text);
    const shouldPostToFb = postToFb && newPostsForFb.some((p) => p.text === post.text);

    if (shouldPostToX) {
      const tweetText = formatForX(post.text);
      if (opts.dryRun) {
        console.log(`[DRY RUN] Would post to X: "${preview}..."`);
      } else {
        console.log(`Posting to X: "${preview}..."`);
        const result = await postTweet(config.x, tweetText);
        if (result.success && result.tweetId) {
          console.log(`  -> X: Success! https://x.com/i/status/${result.tweetId}`);
          addTrackerEntry(config.trackerFilePath, {
            linkedinSnippet: snippetForTracker(post.text),
            datePostedToX: new Date().toISOString(),
            xPostId: result.tweetId,
          });
          xSuccessCount++;
        } else {
          console.error(`  -> X: Failed: ${result.error}`);
        }
      }
    }

    if (shouldPostToFb && config.facebook) {
      if (opts.dryRun) {
        console.log(`[DRY RUN] Would post to Facebook: "${preview}..."`);
      } else {
        console.log(`Posting to Facebook: "${preview}..."`);
        const result = post.url
          ? await postToFacebookWithLink(config.facebook, post.text, post.url)
          : await postToFacebook(config.facebook, post.text);
        if (result.success && result.postId) {
          console.log(`  -> Facebook: Success! Post ID: ${result.postId}`);
          addFbTrackerEntry(config.trackerFilePath, {
            linkedinSnippet: snippetForTracker(post.text),
            datePostedToFb: new Date().toISOString(),
            fbPostId: result.postId,
          });
          fbSuccessCount++;
        } else {
          console.error(`  -> Facebook: Failed: ${result.error}`);
        }
      }
    }

    if (i < postsToSend.length - 1) {
      console.log("  Waiting 60 seconds...");
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
  }

  if (!opts.dryRun) {
    const parts: string[] = [];
    if (postToX) parts.push(`X: ${xSuccessCount}/${newPostsForX.length}`);
    if (postToFb) parts.push(`Facebook: ${fbSuccessCount}/${newPostsForFb.length}`);
    console.log(`\nDone. Cross-posted ${parts.join(", ")}.`);
    console.log(`Tracker: ${config.trackerFilePath}`);
  }
}

export async function runLegacyList(): Promise<void> {
  const config = loadLegacySyncConfig();
  console.log("=== Legacy LinkedIn -> X Status ===\n");
  console.log("This command is preserved for compatibility. New setup should use `pair` commands.\n");

  const trackerEntries = loadTracker(config.trackerFilePath);
  const fbTrackerEntries = config.facebookEnabled
    ? loadFbTracker(config.trackerFilePath)
    : [];

  console.log(`--- Already Posted to X (${trackerEntries.length} entries) ---`);
  if (trackerEntries.length === 0) {
    console.log("  (none)\n");
  } else {
    for (const entry of trackerEntries) {
      console.log(`  [${entry.datePostedToX}] ${entry.linkedinSnippet}`);
      console.log(`    -> https://x.com/i/status/${entry.xPostId}`);
    }
    console.log();
  }

  if (config.facebookEnabled) {
    console.log(`--- Already Posted to Facebook (${fbTrackerEntries.length} entries) ---`);
    if (fbTrackerEntries.length === 0) {
      console.log("  (none)\n");
    } else {
      for (const entry of fbTrackerEntries) {
        console.log(`  [${entry.datePostedToFb}] ${entry.linkedinSnippet}`);
        console.log(`    -> FB Post ID: ${entry.fbPostId}`);
      }
      console.log();
    }
  }

  console.log("Scraping LinkedIn for recent posts...\n");
  const posts = await scrapeLinkedInPosts(config);
  if (posts.length === 0) {
    console.log("No posts found on LinkedIn (or not logged in).");
    return;
  }

  const pendingX = posts.filter((p) => !isAlreadyPosted(trackerEntries, p.text));
  console.log(`--- Pending for X (${pendingX.length} posts) ---`);
  if (pendingX.length === 0) {
    console.log("  All caught up! Nothing to post to X.");
    return;
  }

  for (const post of pendingX) {
    console.log(`  - ${post.text.slice(0, 120).replace(/\n/g, " ")}...`);
    if (post.url) {
      console.log(`    ${post.url}`);
    }
  }
}

export async function runLegacyStart(opts: { interval: string }): Promise<void> {
  const intervalMs = parseInt(opts.interval, 10) * 60 * 1000;
  const intervalMin = parseInt(opts.interval, 10);

  console.log("=== Legacy LinkedIn -> X Continuous Sync ===");
  console.log("This command is preserved for compatibility. New setup should use `pair` commands.");
  console.log(`Checking every ${intervalMin} minutes. Press Ctrl+C to stop.\n`);

  const runSync = async () => {
    try {
      const config = loadLegacySyncConfig();
      const posts = await scrapeLinkedInPosts(config);
      if (posts.length === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] No posts found.`);
        return;
      }

      const trackerEntries = loadTracker(config.trackerFilePath);
      const newPosts = posts.filter((p) => !isAlreadyPosted(trackerEntries, p.text));
      if (newPosts.length === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] All caught up - nothing new to post.`);
        return;
      }

      console.log(`[${new Date().toLocaleTimeString()}] Found ${newPosts.length} new post(s). Cross-posting...`);
      for (let i = 0; i < newPosts.length; i++) {
        const post = newPosts[newPosts.length - 1 - i];
        const tweetText = formatForX(post.text);
        const result = await postTweet(config.x, tweetText);
        if (result.success && result.tweetId) {
          console.log(`  -> Success! https://x.com/i/status/${result.tweetId}`);
          addTrackerEntry(config.trackerFilePath, {
            linkedinSnippet: snippetForTracker(post.text),
            datePostedToX: new Date().toISOString(),
            xPostId: result.tweetId,
          });
        } else {
          console.error(`  -> Failed: ${result.error}`);
        }

        if (i < newPosts.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 60000));
        }
      }
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Error:`, (err as Error).message);
    }
  };

  await runSync();
  setInterval(runSync, intervalMs);
}
