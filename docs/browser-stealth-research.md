# Browser stealth research — making `chrome-devtools-mcp` undetectable for Google login

**Status:** research only, no fix applied yet.
**Author / dispatched-by:** Ethan (voice 6133, 2026-05-03).
**Goal:** decide which architectural path lets the agent drive Chrome via `chrome-devtools-mcp` without Google's anti-phishing guard / OAuth flow refusing the session because `navigator.webdriver === true`.

---

## 1. Root cause — confirmed

`navigator.webdriver` becomes `true` when **either** of these conditions holds in Chromium:

1. The browser was launched with `--enable-automation` (Puppeteer's default `LaunchArgs`; removable with `ignoreDefaultArgs: ['--enable-automation']`). Source: `puppeteer-core@24.42.0/src/node/ChromeLauncher.ts:226` adds it unconditionally.
2. The browser was launched with `--remote-debugging-port=<n>` — required for any CDP attach pattern (this is what `~/.claude/scripts/launch-agent-chrome.sh` does on port 19222 and what OpenClaw does on 18800). MDN / ZenRows confirm that `--remote-debugging-port` independently flips the bit, even when `--enable-automation` is absent. ([ZenRows: --disable-blink-features=AutomationControlled](https://www.zenrows.com/blog/disable-blink-features-automationcontrolled), MDN Navigator.webdriver).

The `--disable-blink-features=AutomationControlled` flag *partially* counteracts this — it disables the Blink feature gate that exposes the property — but several public reports indicate it is not always sufficient when the remote debugging port is also live.

**Important nuance:** Puppeteer-core itself (the library) does **not** inject any `navigator.webdriver = true` script. We grepped the entire `puppeteer-core@24.42.0` source — no `webdriver` write, no `Object.defineProperty(navigator, 'webdriver', ...)` anywhere. The flag comes from Chromium's `AutomationControlled` blink feature, which Chrome itself activates based on the launch flags above.

Empirical verification on Ethan's machine: the dedicated agent Chrome at port 19222 was launched without `--enable-automation` and without `--disable-blink-features=AutomationControlled`. `() => navigator.webdriver` via `evaluate_script` returned `true`. That matches the "remote-debugging-port alone is enough" failure mode.

**Why OpenClaw's raw-CDP browser shows `webdriver=false`:** OpenClaw launches Chrome with the same `--remote-debugging-port` flag but routes the CDP traffic through a custom `ws` client (`~/.openclaw/plugin-runtime-deps/.../dist/cdp.helpers-*.js`). Two plausible explanations:

- OC's launch line includes `--disable-blink-features=AutomationControlled` (worth re-checking — likely the real reason).
- OC never issues `Runtime.enable` against the page before reading `navigator.webdriver`, so the AutomationControlled blink feature stays dormant. The Rebrowser team has documented that `Runtime.enable` is itself a separate, detectable signal that anti-bot vendors fingerprint independently of `webdriver` ([Rebrowser blog](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)).

In Puppeteer's case, `puppeteer.connect()` calls `Page.enable` and `Runtime.enable` synchronously during `FrameManager.initialize()` (`puppeteer-core/src/cdp/FrameManager.ts:218-239`) the moment a target attaches. There's no public Puppeteer API to opt out.

**Playwright equivalent:** `chromium.connectOverCDP()` has the same problem — Playwright also issues `Runtime.enable` and presents the same surface. Not a useful pivot.

---

## 2. Survey of bypass techniques

### A. `puppeteer-extra` + `puppeteer-extra-plugin-stealth`

Drop-in wrapper that swaps the `puppeteer` import. Stealth plugin patches `navigator.webdriver`, `chrome.runtime`, `navigator.plugins`, `WebGL.vendor`, `navigator.languages`, the `iframe.contentWindow` proxy, the `media.codecs` mime-type list, the `accept-language` header, and `console.debug`. Implements `navigator.webdriver` evasion via ES6 Proxy on `Object.getPrototypeOf(navigator)` so `instanceof` tests still pass ([berstend/puppeteer-extra](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth)).

**Effectiveness against Google in May 2026:** mixed. Issue [berstend/puppeteer-extra#193](https://github.com/berstend/puppeteer-extra/issues/193) and [#588](https://github.com/berstend/puppeteer-extra/issues/588) document that Google's login page specifically still detects stealth-enabled Puppeteer in some setups, particularly headless. Headed mode + a real persistent profile is reportedly more reliable.

### B. Manual override via `Page.addScriptToEvaluateOnNewDocument`

```js
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});
```

Cheapest possible patch. Maps to one CDP call — `Page.addScriptToEvaluateOnNewDocument` — that fires the script before any page JS runs. Stealth plugin essentially does this plus a few prototype tweaks. Won't fix `Runtime.enable` fingerprinting on its own, but is enough for many sites that only check `navigator.webdriver`.

### C. CDP-flag tweaks

- `--disable-blink-features=AutomationControlled` on Chrome launch (we don't currently set this on port 19222).
- `ignoreDefaultArgs: ['--enable-automation']` is moot here because we already launch Chrome ourselves (Puppeteer doesn't add the flag in connect mode).
- `--disable-features=AutomationControlled` is the older alias for the same gate.

Combined effect: removes the Chromium-side webdriver flip in many cases, but `--remote-debugging-port` alone has been observed to still set it. Belt-and-suspenders approach (flag + runtime override) covers both planes.

### D. `rebrowser-patches`

Patches `puppeteer-core` directly via `npx rebrowser-patches@latest patch --packageName puppeteer-core`. Fixes:

- The `Runtime.Enable` leak (replaces with `addBinding` + isolated-world or enable/disable cycling).
- Renames the utility-world from `__puppeteer_utility_world__` to a generic name.
- Strips `//# sourceURL=pptr:...` markers.

Does **not** ship a `navigator.webdriver` evasion — they assume you'll combine with stealth or a launch flag for that. Strongest option for sites that fingerprint `Runtime.enable` (Cloudflare, DataDome) but probably overkill for Google login alone.

### E. `puppeteer-real-browser` / `rebrowser-puppeteer`

Pre-bundled stealth + rebrowser patches + Cloudflare Turnstile auto-solve. Author announced no further updates in Feb 2026; fork status uncertain.

### F. Fork Chromium (Browserbase pattern)

Browserbase patches Chromium itself to remove the `navigator.webdriter` blink binding entirely + the `HeadlessChrome` UA string. Out of scope for our use case — we'd need a custom Chrome build per OS.

### G. Existing community fork: `BenceBakos/chrome-devtools-mcp`

Confirmed via GitHub compare API: this fork is exactly **1 commit ahead, 430 commits behind** upstream (so heavily stale on everything else). Diff is minimal:

```diff
// src/browser.ts
- import {puppeteer} from './third_party/index.js';
+ import puppeteer from 'puppeteer-extra';
+ import StealthPlugin from 'puppeteer-extra-plugin-stealth';
+ puppeteer.use(StealthPlugin());

// package.json
+ "puppeteer-extra": "^3.3.6",
+ "puppeteer-extra-plugin-stealth": "^2.11.2",
+ "tsx": "^4.21.0",
```

That's it — three lines of code change plus deps. Same idea as path D below but already done. The fork being 430 commits behind upstream means we wouldn't actually use it directly; we'd reproduce the same patch on our local copy of v0.22.0.

---

## 3. Specifically for `chrome-devtools-mcp`

### Repo and architecture

- Repo: `ChromeDevTools/chrome-devtools-mcp`. Apache-2.0, maintained by Google.
- Loaded version on this machine: **v0.22.0** at `~/.claude/plugins/cache/claude-plugins-official/chrome-devtools-mcp/0.22.0/`.
- Uses `puppeteer-core@24.42.0` directly via `src/third_party/index.js` re-export.
- Connect mode is in `src/browser.ts:46-134` (`ensureBrowserConnected`); calls `puppeteer.connect({ browserURL })` or `{ browserWSEndpoint }`. Launch mode is `src/browser.ts:173-261` (`launch`); calls `puppeteer.launch({ pipe: true, ... })`.
- No exposed flag for stealth, `evaluateOnNewDocument`, or webdriver bypass — confirmed by reading `src/index.ts`, `src/browser.ts`, and the CLI generator.

### Upstream issue — yes

[ChromeDevTools/chrome-devtools-mcp#553 — "Stealth mode to circumvent bot detection"](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/553). Open since 2026-01, currently labeled `collecting-feedback, feature`. Twelve comments. **Maintainer (`@natorion`) has explicitly declined to add stealth features:**

> "To be clear, we have made the decision not to support stealth mode or anti-bot circumvention features at this time. ... this is a product decision, not a technical one. ... as the official Chrome DevTools MCP server, we have to weigh the implications of natively building features designed to bypass security protections."

So upstream is permanently a no-go. Any fix is on our side.

### Concrete patch options on top of v0.22.0

**Option 1 — minimal `evaluateOnNewDocument` injection on every new page.**

Add an event listener on the `Browser` returned by `ensureBrowserConnected` so every newly-attached page gets a webdriver-hiding preload script:

```ts
// inside src/browser.ts, after `browser = await puppeteer.connect(connectOptions);`
browser.on('targetcreated', async target => {
  if (target.type() !== 'page') return;
  const page = await target.page();
  if (!page) return;
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
});
// Also retroactively patch already-open pages
for (const page of await browser.pages()) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}
```

About **15 LOC** in `src/browser.ts`. No new deps.

**Option 2 — full stealth plugin (BenceBakos pattern).**

Swap the puppeteer import for `puppeteer-extra` + `puppeteer-extra-plugin-stealth`. About 5 LOC + 2 deps. Covers many more fingerprinting vectors than Option 1 but adds ~3 MB to `node_modules`.

**How to apply either patch in our environment:**

The chrome-devtools-mcp plugin lives in the Claude Code plugin cache (`~/.claude/plugins/cache/claude-plugins-official/chrome-devtools-mcp/0.22.0/`). Three deployment shapes possible:

a. **Patch in place + rebuild.** Edit `src/browser.ts`, run `npm install` (to add `puppeteer-extra` if Option 2) and `npm run build` against the cached install. Idempotent SessionStart hook can re-apply on plugin upgrade. Fragile because the cache dir is overwritten on plugin update.

b. **Fork repo + override `installPath` in `~/.claude/plugins/installed_plugins.json`.** Mirrors the existing agent-bridge dev-clone pattern from CLAUDE.md. Most maintainable but adds a long-term repo to maintain.

c. **`patch-package` + dev clone of the plugin.** Stores the diff as a patch file inside the plugin dir; re-applies on every install. Cleanest if we only need the 15-LOC injection.

---

## 4. Specifically for OpenClaw's raw-CDP approach

OpenClaw bypasses Puppeteer entirely. From `~/.openclaw/plugin-runtime-deps/openclaw-2026.4.26-da6bdffc3d96/dist/cdp.helpers-*.js`:

- `import WebSocket from "ws"` — uses node's `ws` library directly.
- Discovery via `GET /json/version` against `http://127.0.0.1:18800/`, parses `webSocketDebuggerUrl`.
- Direct WebSocket to that URL, sends JSON-RPC framed CDP messages (`{id, method, params}`).
- Issues only the methods it actually needs (`Page.navigate`, `Runtime.evaluate`, `Page.captureScreenshot`, `Input.dispatchKeyEvent`, etc.) — no eager `Page.enable` / `Runtime.enable` boilerplate.

**Replicating as a thin Node MCP server:** ~600-1000 LOC for a feature-comparable subset (navigation, evaluate, click, type, screenshot, network monitoring). Plus the MCP server harness. Plus per-tool input schemas. Real estimate: **40-80 hours** to reach feature parity with chrome-devtools-mcp's most-used tools, more for edge cases (download handling, dialog handling, iframe traversal, performance traces, network interception, accessibility snapshots — chrome-devtools-mcp has a lot).

**User-side experience deltas if we go this route:**

- Lose the chrome-devtools-mcp ecosystem (LCP debugging, performance traces, lighthouse audit, console message stream, network request introspection, take_snapshot a11y tree).
- Gain webdriver-false by default + opt-in CDP-domain enables.
- Gain control over *exactly* which CDP commands fire.

This is a real architectural commitment. Probably worth it long-term but not for this week.

---

## 5. Recommendation matrix

Five candidate paths.

### Path A — Pivot to OpenClaw for the live test

- **Effort:** 0-2 hours (just verify OC has the LinkedIn → X flow working).
- **Webdriver-false?** Yes (already empirically confirmed).
- **Google login likely to succeed?** Yes (Ethan has reported it works from OC).
- **Longevity:** Doesn't help future Repost-with-agent runs from Claude Code. Two parallel automation rigs to maintain.
- **Risks:** Splits the codebase between Claude harness and OC harness; reposting workflow has to live in two places.

### Path B — Patch `chrome-devtools-mcp` source with Option 1 (`evaluateOnNewDocument`)

- **Effort:** 2-4 hours (write patch, decide deployment shape b/c, smoke-test on a sannysoft.com or webdriver detector).
- **Webdriver-false?** Yes for the `navigator.webdriver` property check. Does not address `Runtime.enable` fingerprinting that Cloudflare/DataDome use, but Google login is mostly the simpler `navigator.webdriver` check.
- **Google login likely to succeed?** Probable. The "browser may not be secure" block on OAuth specifically references the webdriver flag — fixing that flag unblocks most Google flows. Some risk that Google has additional checks (TLS fingerprint, subtle Chrome behavioral signals) we'd discover only at test time.
- **Longevity:** Medium. Google can patch around `Object.defineProperty` overrides by checking the property descriptor or using an isolated world. But it's been the dominant cat-and-mouse for years; stealth plugin holds up reasonably well.
- **Risks:** Plugin cache dir gets overwritten on update — needs SessionStart hook to re-patch (or fork-and-installPath).

### Path C — Build a thin "raw CDP" MCP server (OpenClaw pattern)

- **Effort:** 40-80 hours (full feature parity with current chrome-devtools-mcp tools we use).
- **Webdriver-false?** Yes by design.
- **Google login likely to succeed?** Yes.
- **Longevity:** Best. We control every CDP method.
- **Risks:** Long lead time, maintenance burden.

### Path D — Install `puppeteer-extra-plugin-stealth` as a dependency override

- **Effort:** 2-4 hours (add to `package.json` of cached plugin, swap import in `browser.ts`, rebuild). Same shape as the BenceBakos fork's diff.
- **Webdriver-false?** Yes.
- **Google login likely to succeed?** Probable but reportedly weaker against Google specifically than against Cloudflare. Issues #193, #588 on `puppeteer-extra` document Google's login page detecting stealth in some setups.
- **Longevity:** Stealth plugin is actively maintained, but Google updates detection regularly. Cat-and-mouse.
- **Risks:** Same plugin-cache-overwrite issue as path B. Stealth plugin sometimes adds detectable side-effects of its own per [DataDome's research](https://datadome.co/bot-management-protection/detecting-headless-chrome-puppeteer-extra-plugin-stealth/).

### Path E — Hybrid: launcher tweak + Path B injection

- **Effort:** 3-5 hours.
- **What:** Add `--disable-blink-features=AutomationControlled` to `~/.claude/scripts/launch-agent-chrome.sh` (the launch flag plane) AND apply the Option 1 `evaluateOnNewDocument` patch (the runtime plane). Belt-and-suspenders.
- **Webdriver-false?** Yes — both planes flipped.
- **Google login likely to succeed?** Highest among paths B/D/E.
- **Longevity:** Same as B but with broader coverage. Still patches plugin cache.
- **Risks:** Same as B for the patch-cache overwrite. The launch-flag change is in our own script, so it's stable.

### Recommendation: **Path E (with Path A as a tactical fallback)**

Rationale:

- Path E gives the highest near-term success probability for the LinkedIn → X live test while also fixing future Repost-with-agent runs across the board.
- Path A is the right escape hatch if Path E hits an unexpected wall — we already have OpenClaw set up and Ethan has confirmed it works there.
- Path C is the right *long-term* answer but is way too much investment for a this-week deliverable.
- Path D alone (stealth plugin) is roughly equivalent to E in webdriver-flag bypass but adds heavier deps and has documented side-effects on Google specifically. Option 1's minimal `evaluateOnNewDocument` is leaner and more debuggable.

---

## 6. Concrete next-step plan (Path E)

When ready to apply the fix (separate ticket — this doc is research only):

1. **Launcher tweak** — add `--disable-blink-features=AutomationControlled` to the chrome args list in `~/.claude/scripts/launch-agent-chrome.sh:70-83`. Bonus: also add `--disable-features=AutomationControlled` (older alias). Drops both Chromium-side flips.

2. **MCP patch** — patch `~/.claude/plugins/cache/claude-plugins-official/chrome-devtools-mcp/0.22.0/src/browser.ts` `ensureBrowserConnected` to register a `targetcreated` listener that runs `page.evaluateOnNewDocument` with the webdriver override. Snippet:

   ```ts
   const STEALTH_PRELOAD = () => {
     Object.defineProperty(navigator, 'webdriver', { get: () => false });
   };
   browser.on('targetcreated', async (target) => {
     if (target.type() !== 'page') return;
     const page = await target.page();
     if (!page) return;
     try { await page.evaluateOnNewDocument(STEALTH_PRELOAD); } catch {}
   });
   for (const page of await browser.pages()) {
     try { await page.evaluateOnNewDocument(STEALTH_PRELOAD); } catch {}
   }
   ```

3. **Rebuild step** — run `npm run build` inside the cached plugin dir so the TypeScript change becomes the loaded `build/src/browser.js`.

4. **Re-apply hook** — extend `~/.claude/scripts/patch-chrome-devtools-mcp.sh` (already a SessionStart hook for the `--browserUrl` patch) to also apply the source patch + rebuild on the first session after any plugin upgrade. Keep it idempotent (grep for the marker comment before patching).

5. **Verification** — open the dedicated agent Chrome, run `evaluate_script` with `() => navigator.webdriter`, expect `false`. Then visit `https://bot.sannysoft.com` and screenshot the result table for a baseline. Both should pass.

6. **Live test** — proceed with the LinkedIn → X repost flow.

7. **Document the fix** — add a one-liner to global CLAUDE.md per Ethan's "every bug fix gets a comment + global note" rule, and bump Repost-with-agent to v4.4.0 with a CHANGELOG entry.

---

## 7. Open questions for Ethan

- **Should the patch be applied in-place (ephemeral, re-patched on SessionStart) or via a long-term fork hosted at `EthanSK/chrome-devtools-mcp` with an `installPath` override in `installed_plugins.json`?** Fork-and-override is cleaner but adds a maintained repo to the fleet. In-place patching is simpler but the SessionStart hook becomes more complex.
- **Do we care about `Runtime.enable` fingerprinting for the LinkedIn → X flow specifically?** If LinkedIn or X have Cloudflare/DataDome enabled (likely on their login-walls but not necessarily on the post-creation page), we may also need rebrowser-patches. Worth checking with one canary run before committing to the bigger patch.
- **Long-term: budget for Path C ("raw CDP" MCP server)?** Probably the right strategic answer once the fleet has stabilized. Could be a 1-2 week project.
- **Should the launcher also pre-pin a realistic `--user-agent` string?** The current launch passes Chrome's default UA, which is fine for Google login (it identifies as real Chrome). But if we ever want to fingerprint-match Ethan's main browser exactly, we'd need to read his real Chrome's UA and pass it.

---

## Citations

- [ChromeDevTools/chrome-devtools-mcp#553 — Stealth mode to circumvent bot detection](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/553)
- [BenceBakos/chrome-devtools-mcp fork (1 ahead, 430 behind)](https://github.com/BenceBakos/chrome-devtools-mcp)
- [Rebrowser blog — Runtime.Enable CDP detection](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)
- [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)
- [ZenRows — disable-blink-features=AutomationControlled](https://www.zenrows.com/blog/disable-blink-features-automationcontrolled)
- [Browserbase — Why we forked Chromium](https://www.browserbase.com/blog/chromium-fork-for-ai-automation)
- [puppeteer-extra-plugin-stealth on GitHub](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth)
- [DataDome — detecting puppeteer-extra-plugin-stealth](https://datadome.co/bot-management-protection/detecting-headless-chrome-puppeteer-extra-plugin-stealth/)
- [puppeteer-extra#193 — Detected by Google](https://github.com/berstend/puppeteer-extra/issues/193)
- [puppeteer-extra#588 — Stealth Plugin detected on Google Login page](https://github.com/berstend/puppeteer-extra/issues/588)
- [ZFC-Digital/puppeteer-real-browser](https://github.com/ZFC-Digital/puppeteer-real-browser)
- [Chromium issue 40158636 — navigator.webdriver === false when automation is not enabled](https://issues.chromium.org/issues/40158636)
- [MDN — Navigator.webdriver](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)
- Empirical: `puppeteer-core@24.42.0/src/node/ChromeLauncher.ts:226` (`--enable-automation` flag), `puppeteer-core/src/cdp/FrameManager.ts:218-239` (auto-issue of `Page.enable` + `Runtime.enable` on connect).
