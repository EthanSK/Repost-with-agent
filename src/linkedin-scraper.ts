import { chromium, type BrowserContext, type Page } from "playwright";
import * as https from "https";
import * as http from "http";
import { LinkedInScrapeConfig } from "./config.js";

export interface LinkedInPost {
  text: string;
  url: string | null;
}

const MAX_POSTS = 10;

/** Follow redirects to resolve shortened URLs (lnkd.in, bit.ly, etc.) */
async function resolveRedirect(url: string): Promise<string> {
  // For lnkd.in specifically, fetch HTML and parse the interstitial page
  if (url.includes("lnkd.in")) {
    return resolveLinkedInShortUrl(url);
  }
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.request(url, { method: "HEAD", timeout: 5000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(url);
      }
    });
    req.on("error", () => resolve(url));
    req.on("timeout", () => { req.destroy(); resolve(url); });
    req.end();
  });
}

/** LinkedIn's lnkd.in shortener serves an HTML interstitial page instead of an HTTP redirect.
 *  The real destination URL is in an <a> tag with data-tracking-control-name="external_url_click". */
async function resolveLinkedInShortUrl(url: string): Promise<string> {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.request(url, { method: "GET", timeout: 8000 }, (res) => {
      // Handle HTTP redirects first (in case LinkedIn changes behavior)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
        return;
      }
      let html = "";
      res.on("data", (chunk: Buffer) => { html += chunk.toString(); });
      res.on("end", () => {
        // Look for the external URL in the interstitial page
        const match = html.match(/data-tracking-control-name="external_url_click"[^>]*href="([^"]+)"/);
        if (match && match[1]) {
          resolve(match[1]);
        } else {
          // Fallback: try og:url or any redirect meta tag
          const ogMatch = html.match(/<meta[^>]*property="og:url"[^>]*content="([^"]+)"/);
          if (ogMatch && ogMatch[1] && !ogMatch[1].includes("linkedin.com")) {
            resolve(ogMatch[1]);
          } else {
            resolve(url);
          }
        }
      });
    });
    req.on("error", () => resolve(url));
    req.on("timeout", () => { req.destroy(); resolve(url); });
    req.end();
  });
}

export async function scrapeLinkedInPosts(config: LinkedInScrapeConfig): Promise<LinkedInPost[]> {
  const profileUrl = config.linkedin.profileUrl.replace(/\/$/, "");
  const activityUrl = `${profileUrl}/recent-activity/all/`;

  console.log(`Launching browser with profile: ${config.playwrightProfileDir}`);
  console.log(`Navigating to: ${activityUrl}`);

  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(config.playwrightProfileDir, {
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: { width: 1280, height: 900 },
    });

    const page = context.pages()[0] || await context.newPage();

    await page.goto(activityUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for the feed to load
    await page.waitForTimeout(3000);

    // Check if we're redirected to login
    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
      console.error("Not logged in to LinkedIn. Please log in using the persistent browser profile first.");
      console.error(`Profile dir: ${config.playwrightProfileDir}`);
      console.error("You can log in by running a Playwright session manually or via Claude's browser.");
      return [];
    }

    // Scroll down a bit to load more posts
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(2000);

    const posts = await extractPosts(page);
    console.log(`Extracted ${posts.length} post(s) (max ${MAX_POSTS}).`);

    return posts;
  } catch (err) {
    console.error("Error scraping LinkedIn:", err);
    return [];
  } finally {
    if (context) {
      await context.close();
    }
  }
}

async function extractPosts(page: Page): Promise<LinkedInPost[]> {
  const posts = await page.evaluate((maxPosts: number) => {
    const results: Array<{ text: string; url: string | null }> = [];

    // LinkedIn post containers
    const postContainers = document.querySelectorAll(".feed-shared-update-v2");

    for (const container of postContainers) {
      if (results.length >= maxPosts) break;

      // Skip reposts/shares — look for "reposted this" indicator
      const headerText = container.querySelector(".update-components-header")?.textContent || "";
      const socialActionText = container.querySelector(".feed-shared-header")?.textContent || "";
      const fullHeaderArea = container.querySelector(".update-components-actor")?.textContent || "";
      const containerText = container.textContent || "";

      // Check for repost indicators
      const isRepost =
        headerText.toLowerCase().includes("reposted") ||
        socialActionText.toLowerCase().includes("reposted") ||
        // Check for "reposted this" anywhere near the top of the post
        containerText.slice(0, 300).toLowerCase().includes("reposted this") ||
        containerText.slice(0, 300).toLowerCase().includes("reposted");

      // Also check if the author is not Ethan (the profile owner)
      const actorName = container.querySelector(".update-components-actor__name")?.textContent?.trim() || "";
      const isNotOwner = actorName &&
        !actorName.toLowerCase().includes("ethan") &&
        !actorName.toLowerCase().includes("sarif-kattan") &&
        !actorName.toLowerCase().includes("ethansk");

      if (isRepost || isNotOwner) {
        continue;
      }

      // Extract text content — try multiple selectors, filter for spans with real content
      let text = "";

      const textSelectors = [
        ".feed-shared-inline-show-more-text span[dir='ltr']",
        ".feed-shared-update-v2__commentary span[dir='ltr']",
        ".update-components-text span[dir='ltr']",
      ];

      for (const selector of textSelectors) {
        if (text) break;
        const spans = container.querySelectorAll(selector);
        const parts: string[] = [];
        for (const span of spans) {
          // Use innerText to preserve line breaks from <br> tags
          const content = (span as HTMLElement).innerText?.trim() || "";
          if (content.length > 20) {
            parts.push(content);
          }
        }
        if (parts.length > 0) {
          text = parts.join("\n").trim();
        }
      }

      // Extract links from the post — collect shortened URLs to resolve later
      const linkElements = container.querySelectorAll(
        ".feed-shared-inline-show-more-text a[href], .feed-shared-update-v2__commentary a[href], .update-components-text a[href]"
      );
      const linksToResolve: Array<{ linkText: string; href: string }> = [];
      for (const link of linkElements) {
        const href = (link as HTMLAnchorElement).href;
        const linkText = link.textContent?.trim() || "";
        if (linkText && href) {
          linksToResolve.push({ linkText, href });
        }
      }

      if (!text) continue;

      // Extract post URL from the activity URN or share link
      let url: string | null = null;
      const urnAttr = container.getAttribute("data-urn");
      if (urnAttr) {
        const activityMatch = urnAttr.match(/activity:(\d+)/);
        if (activityMatch) {
          url = `https://www.linkedin.com/feed/update/urn:li:activity:${activityMatch[1]}/`;
        }
      }

      // Also check for share links
      if (!url) {
        const shareLink = container.querySelector("a[href*='/feed/update/']");
        if (shareLink) {
          url = (shareLink as HTMLAnchorElement).href;
        }
      }

      results.push({ text, url, linksToResolve } as any);
    }

    return results;
  }, MAX_POSTS) as Array<{ text: string; url: string | null; linksToResolve: Array<{ linkText: string; href: string }> }>;

  // Post-process: resolve shortened LinkedIn URLs (lnkd.in) to actual destinations
  console.log("Resolving shortened URLs...");
  const resolvedPosts: LinkedInPost[] = [];
  for (const post of posts) {
    let text = post.text;
    if (post.linksToResolve && post.linksToResolve.length > 0) {
      for (const { linkText, href } of post.linksToResolve) {
        // Only process links whose href is an actual URL
        if (!href.startsWith("http://") && !href.startsWith("https://")) continue;

        // Skip any LinkedIn internal links (hashtags, profiles, company pages, etc.)
        if (href.includes("linkedin.com")) continue;

        // Only resolve known URL shorteners
        const isShortener = /\b(lnkd\.in|bit\.ly|t\.co|goo\.gl|tinyurl\.com|ow\.ly|buff\.ly)\b/.test(href);
        let resolvedUrl = href;
        if (isShortener) {
          resolvedUrl = await resolveRedirect(href);
        }

        // If it resolved to a LinkedIn URL, remove the lnkd.in link text from the post
        if (resolvedUrl.includes("linkedin.com")) {
          if (linkText && text.includes(linkText) && /^https?:\/\//.test(linkText)) {
            text = text.replace(linkText, "").replace(/\n{3,}/g, "\n\n").trim();
          }
          continue;
        }

        // Only replace link text that itself looks like a URL (starts with http:// or https://)
        // This prevents replacing text like "AGENTS.md" which LinkedIn wraps as links
        if (linkText && text.includes(linkText) && /^https?:\/\//.test(linkText)) {
          text = text.replace(linkText, resolvedUrl);
        }
      }
    }
    resolvedPosts.push({ text, url: post.url });
  }

  return resolvedPosts;
}
