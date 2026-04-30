import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

dotenv.config();

export const APP_NAME = "repost-with-agent";
export const LEGACY_APP_NAME = "linkedin-to-x";
export const DEFAULT_DATA_DIR = path.join(os.homedir(), `.${APP_NAME}`);
export const LEGACY_DATA_DIR = path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
export const DEFAULT_PLAYWRIGHT_PROFILE_DIR = path.join(
  os.homedir(),
  ".claude",
  "playwright-profile"
);

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface XOAuth2Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

export interface FacebookCredentials {
  pageId: string;
  accessToken: string;
}

export interface Config {
  x: XCredentials;
  xOAuth2?: XOAuth2Tokens;
  xClientId?: string;
  xClientSecret?: string;
  linkedin: {
    profileUrl: string;
  };
  facebook?: FacebookCredentials;
  facebookEnabled: boolean;
  playwrightProfileDir: string;
  dataDir: string;
  trackerFilePath: string;
}

export interface LinkedInScrapeConfig {
  linkedin: {
    profileUrl: string;
  };
  playwrightProfileDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error(`Copy .env.example to .env and fill in your credentials.`);
    process.exit(1);
  }
  return value;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function getRuntimeDataDir(): string {
  return process.env.REPOST_WITH_AGENT_DATA_DIR || DEFAULT_DATA_DIR;
}

export function getLegacyDataDir(): string {
  return LEGACY_DATA_DIR;
}

function getTokensPath(): string {
  return path.join(getRuntimeDataDir(), "x-tokens.json");
}

export function getLegacyTokensPath(): string {
  return path.join(getLegacyDataDir(), "x-tokens.json");
}

export function loadOAuth2Tokens(): XOAuth2Tokens | null {
  for (const tokensPath of [getTokensPath(), getLegacyTokensPath()]) {
    if (!fs.existsSync(tokensPath)) continue;
    try {
      return JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
    } catch {
      continue;
    }
  }
  return null;
}

export function saveOAuth2Tokens(tokens: XOAuth2Tokens): void {
  const tokensPath = getTokensPath();
  const dir = path.dirname(tokensPath);
  ensureDir(dir);
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), "utf-8");
}

export function loadLinkedInScrapeConfig(profileUrl?: string): LinkedInScrapeConfig {
  return {
    linkedin: {
      profileUrl: profileUrl || requireEnv("LINKEDIN_PROFILE_URL"),
    },
    playwrightProfileDir:
      process.env.PLAYWRIGHT_PROFILE_DIR || DEFAULT_PLAYWRIGHT_PROFILE_DIR,
  };
}

export function loadXCredentials(): XCredentials {
  return {
    apiKey: requireEnv("X_API_KEY"),
    apiSecret: requireEnv("X_API_SECRET"),
    accessToken: requireEnv("X_ACCESS_TOKEN"),
    accessTokenSecret: requireEnv("X_ACCESS_TOKEN_SECRET"),
  };
}

export function loadLegacySyncConfig(): Config {
  const dataDir = process.env.LINKEDIN_TO_X_DATA_DIR || getLegacyDataDir();
  ensureDir(dataDir);

  const facebookEnabled = process.env.FACEBOOK_ENABLED === "true";
  let facebook: FacebookCredentials | undefined;

  if (facebookEnabled) {
    const fbPageId = process.env.FB_PAGE_ID;
    const fbAccessToken = process.env.FB_ACCESS_TOKEN;
    if (!fbPageId || !fbAccessToken) {
      console.error(
        "FACEBOOK_ENABLED is true but FB_PAGE_ID or FB_ACCESS_TOKEN is missing."
      );
      console.error("Set these in your .env file or disable Facebook posting.");
      process.exit(1);
    }
    facebook = { pageId: fbPageId, accessToken: fbAccessToken };
  }

  return {
    x: loadXCredentials(),
    xOAuth2: loadOAuth2Tokens() ?? undefined,
    xClientId: process.env.X_CLIENT_ID,
    xClientSecret: process.env.X_CLIENT_SECRET,
    ...loadLinkedInScrapeConfig(),
    facebook,
    facebookEnabled,
    playwrightProfileDir:
      process.env.PLAYWRIGHT_PROFILE_DIR || DEFAULT_PLAYWRIGHT_PROFILE_DIR,
    dataDir,
    trackerFilePath: path.join(dataDir, "posted.md"),
  };
}
