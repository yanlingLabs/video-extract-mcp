import { copyFileSync, accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Cookie passthrough for the yt-dlp resolver.
 *
 * One cookie jar covers every site yt-dlp handles -- cookies are scoped by
 * domain inside the jar, so a single file authenticates YouTube, Instagram,
 * Facebook, X, TikTok and the rest at once. This is the platform-sanctioned
 * answer to "sign in to confirm you're not a bot", and the only way to reach
 * age-restricted, members-only or followers-only media.
 *
 * WeChat is deliberately NOT covered here: it is our own resolver speaking a
 * different protocol with its own credential (VIDEO_EXTRACT_WECHAT_COOKIE),
 * and conflating the two would send one platform's credential to another.
 *
 * ## Environment only, never per-request
 *
 * The source is read from the environment and can never be supplied by a
 * caller. An agent that could name a cookie file could point this at any
 * readable path on the machine and have its contents sent to a remote host;
 * an agent that could name a browser could exfiltrate a live session. The
 * operator configures credentials, the caller does not.
 */

export type CookieSource =
  | { kind: 'none' }
  | { kind: 'file'; path: string }
  | { kind: 'browser'; spec: string }
  /**
   * `auto`: LAZY. No cookies on a normal request -- only after the platform
   * has actually refused one, at which point a browser is detected and the
   * request is retried once with its cookies.
   *
   * Deliberately different from naming a browser, which is eager. Reading a
   * cookie store has real costs a user should not pay on every public video:
   * a Keychain prompt on Chrome-family browsers, and the session rotation
   * that can eventually log you out of the site whose cookies were borrowed.
   * Spending that only when something is genuinely blocked is the whole
   * point of the mode.
   */
  | { kind: 'auto' };

/** A configured-but-unusable credential. Deliberately fatal -- see below. */
export class CookieConfigError extends Error {}

/** Browsers the installed yt-dlp accepts (`--cookies-from-browser BROWSER`). */
const BROWSERS = new Set([
  'brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale',
]);

/**
 * Resolves the configured cookie source, or throws CookieConfigError.
 *
 * Throwing rather than degrading is deliberate, and is the one place this
 * module departs from the project's usual "degrade visibly and continue".
 * A warning would have nowhere to go on the resolve path (ResolveItemResult
 * carries no warnings channel), so an unreadable jar would silently produce
 * UNAUTHENTICATED results -- the caller asked for a signed-in fetch and would
 * get an anonymous one, with public videos succeeding and private ones
 * failing as `auth_required`, pointing at the wrong cause entirely. A typo in
 * a path is worth failing loudly for; it is a broken setup, not a degradation.
 */
export function cookieSourceFromEnv(env: NodeJS.ProcessEnv = process.env): CookieSource {
  const file = env['VIDEO_EXTRACT_COOKIES_FILE']?.trim();
  const browser = env['VIDEO_EXTRACT_COOKIES_FROM_BROWSER']?.trim();

  // Explicit beats implicit when both are set: a file is a deliberate export,
  // a browser name is a standing default. Silently honouring both would let
  // yt-dlp merge two jars, which is not what either setting asks for.
  if (file) {
    try {
      accessSync(file, constants.R_OK);
    } catch {
      throw new CookieConfigError(
        `VIDEO_EXTRACT_COOKIES_FILE is set to "${file}", which does not exist or cannot be read. `
        + 'Fix the path, or unset the variable to fetch anonymously.',
      );
    }
    if (!statSync(file).isFile()) {
      throw new CookieConfigError(`VIDEO_EXTRACT_COOKIES_FILE is set to "${file}", which is not a file.`);
    }
    return { kind: 'file', path: file };
  }

  if (browser) {
    if (browser.toLowerCase() === 'auto') return { kind: 'auto' };
    // Spec is BROWSER[+KEYRING][:PROFILE][::CONTAINER]; only the leading name
    // is ours to check. Caught here so a typo reports itself rather than
    // arriving as a yt-dlp usage error buried in stderr.
    const name = browser.split(/[+:]/)[0]!.toLowerCase();
    if (!BROWSERS.has(name)) {
      throw new CookieConfigError(
        `VIDEO_EXTRACT_COOKIES_FROM_BROWSER is set to "${browser}", whose browser name "${name}" is not one `
        + `yt-dlp supports (${[...BROWSERS].join(', ')}).`,
      );
    }
    return { kind: 'browser', spec: browser };
  }

  return { kind: 'none' };
}

/**
 * Where each supported browser keeps the profile data yt-dlp reads.
 *
 * Detection is on the DATA directory, not on the installed application: a
 * browser that exists but has never been run has no cookie store, and
 * choosing it would turn "retry with cookies" into a confusing yt-dlp error.
 *
 * Firefox is first on purpose. Its cookie store is plain SQLite, so reading
 * it prompts for nothing; every Chrome-family browser encrypts cookies
 * against the OS keyring and triggers a Keychain (macOS) or keyring (Linux)
 * prompt the first time. Safari is last: its store is readable but sits
 * under macOS privacy protection, so it can fail for a background process
 * in ways the others do not.
 */
const BROWSER_DATA: Record<string, Partial<Record<NodeJS.Platform, string>>> = {
  firefox: {
    darwin: 'Library/Application Support/Firefox/Profiles',
    linux: '.mozilla/firefox',
    win32: 'AppData/Roaming/Mozilla/Firefox/Profiles',
  },
  chrome: {
    darwin: 'Library/Application Support/Google/Chrome',
    linux: '.config/google-chrome',
    win32: 'AppData/Local/Google/Chrome/User Data',
  },
  brave: {
    darwin: 'Library/Application Support/BraveSoftware/Brave-Browser',
    linux: '.config/BraveSoftware/Brave-Browser',
    win32: 'AppData/Local/BraveSoftware/Brave-Browser/User Data',
  },
  edge: {
    darwin: 'Library/Application Support/Microsoft Edge',
    linux: '.config/microsoft-edge',
    win32: 'AppData/Local/Microsoft/Edge/User Data',
  },
  chromium: {
    darwin: 'Library/Application Support/Chromium',
    linux: '.config/chromium',
    win32: 'AppData/Local/Chromium/User Data',
  },
  vivaldi: {
    darwin: 'Library/Application Support/Vivaldi',
    linux: '.config/vivaldi',
    win32: 'AppData/Local/Vivaldi/User Data',
  },
  safari: { darwin: 'Library/Cookies' },
};

/**
 * The browser `auto` will borrow cookies from, or null if none is present.
 * `home`/`platform` are injectable so this is testable without depending on
 * whatever the machine running the tests happens to have installed.
 */
export function detectBrowser(
  home: string = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => { try { accessSync(p, constants.R_OK); return true; } catch { return false; } },
): string | null {
  if (!home) return null;
  for (const [name, paths] of Object.entries(BROWSER_DATA)) {
    const rel = paths[platform];
    if (rel && exists(join(home, rel))) return name;
  }
  return null;
}

export interface PreparedCookies {
  /** yt-dlp arguments to splice into the invocation. Empty when unconfigured. */
  args: string[];
  /** Removes any temporary copy. Always call, best-effort, never throws. */
  dispose(): void;
}

/**
 * Turns a source into yt-dlp arguments.
 *
 * For a file this copies the jar to a private temp directory and passes the
 * COPY, because `--cookies FILE` does not only read it -- yt-dlp rewrites that
 * file on exit, merging in whatever cookies the session picked up (verified
 * directly: a hand-written jar came back with a yt-dlp banner and fresh
 * youtube.com entries appended). Handing it the user's own file would mean
 * this tool silently rewriting a credential it was only lent. The copy also
 * keeps the jar out of `destinationPath`, which for a URL source is the
 * caller's own output directory -- a credential must never be written there.
 *
 * The cost is that refreshed cookies are discarded rather than written back,
 * so a rotating session ages out of the file on the user's own schedule
 * rather than ours. That is the safer direction: we never touch their file.
 */
export function prepareCookies(source: CookieSource): PreparedCookies {
  // 'auto' contributes nothing to a first attempt -- that is what makes it
  // lazy. The retry path asks for a browser separately (retryBrowserFor).
  if (source.kind === 'none' || source.kind === 'auto') return { args: [], dispose: () => {} };
  if (source.kind === 'browser') {
    return { args: ['--cookies-from-browser', source.spec], dispose: () => {} };
  }

  // 0o700 dir: the copy is a credential for however long it lives.
  const dir = mkdtempSync(join(tmpdir(), 'vem-cookies-'));
  const copy = join(dir, 'cookies.txt');
  copyFileSync(source.path, copy);
  return {
    args: ['--cookies', copy],
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

/**
 * The browser to retry with after a refusal, or null when a retry would be
 * pointless. Only 'auto' ever returns one: every other configured source
 * already supplied its cookies on the first attempt, so retrying with the
 * same credentials would just repeat the same refusal, and an unconfigured
 * server must not reach for credentials nobody offered.
 */
export function retryBrowserFor(source: CookieSource): string | null {
  return source.kind === 'auto' ? detectBrowser() : null;
}

/**
 * What to tell a caller that hit a refusal with no cookies configured.
 *
 * A suggestion, never an action: enabling this reads the user's browser
 * credentials, which is theirs to allow. The Keychain warning is included
 * because it is the surprising part -- macOS prompts on first read for every
 * Chrome-family browser, and a prompt nobody predicted looks like malware.
 */
export function cookieSuggestion(): { message: string; command: string } | null {
  const browser = detectBrowser();
  if (!browser) return null;
  return {
    command: 'claude mcp add --scope user video-extract '
      + '-e VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto -- npx -y @yanlinglabs/video-extract-mcp',
    message: `Signing in usually clears this. Setting VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto lets this `
      + `server borrow cookies from ${browser} ONLY when a request is refused like this one -- not on `
      + 'ordinary requests. The command below re-registers the server with that setting for Claude Code '
      + '(adapt it for another MCP client); restart the client afterwards. Note that the first time '
      + 'cookies are read from a Chrome-family browser, macOS shows a Keychain prompt that must be '
      + 'approved, and that borrowing cookies from a browser you are signed into can eventually sign '
      + 'you out of that site.',
  };
}
