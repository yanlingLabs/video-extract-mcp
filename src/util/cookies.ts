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
  | { kind: 'browser'; spec: string };

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
  if (source.kind === 'none') return { args: [], dispose: () => {} };
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
