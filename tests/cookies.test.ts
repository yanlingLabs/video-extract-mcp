import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  cookieSourceFromEnv, prepareCookies, detectBrowser, retryBrowserFor, CookieConfigError,
} from '../src/util/cookies.js';
import { YtDlpResolver } from '../src/resolve/ytdlp.js';

const JAR = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\t9999999999\tSID\tsecret-value\n';

function jarFile(): string {
  const p = join(mkdtempSync(join(tmpdir(), 'vem-jar-')), 'cookies.txt');
  writeFileSync(p, JAR);
  return p;
}

describe('cookieSourceFromEnv', () => {
  it('is "none" when nothing is configured, and treats blanks as unset', () => {
    expect(cookieSourceFromEnv({}).kind).toBe('none');
    expect(cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FILE: '   ' }).kind).toBe('none');
    expect(cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: '  ' }).kind).toBe('none');
  });

  it('accepts a readable jar file', () => {
    const p = jarFile();
    expect(cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FILE: p })).toEqual({ kind: 'file', path: p });
  });

  it('accepts a browser name, including a profile/keyring spec', () => {
    expect(cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'firefox' }))
      .toEqual({ kind: 'browser', spec: 'firefox' });
    // BROWSER[+KEYRING][:PROFILE] -- only the leading name is ours to validate.
    expect(cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'chrome:Default' }).kind).toBe('browser');
    expect(cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'Chrome+gnomekeyring' }).kind).toBe('browser');
  });

  it('THROWS rather than silently fetching anonymously when the jar is missing', () => {
    // The whole reason this is fatal: there is no warnings channel on the
    // resolve path, so degrading here would produce unauthenticated results
    // for a caller who explicitly configured a credential -- public videos
    // succeeding, private ones failing as auth_required, and the real cause
    // (a typo) invisible.
    const missing = join(tmpdir(), 'vem-no-such-jar-8f21', 'cookies.txt');
    expect(() => cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FILE: missing })).toThrow(CookieConfigError);
    // The message must name the variable AND the path, or it is not actionable.
    expect(() => cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FILE: missing }))
      .toThrow(/VIDEO_EXTRACT_COOKIES_FILE/);
    expect(() => cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FILE: missing })).toThrow(new RegExp(missing));
  });

  it('throws when the path is a directory rather than a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-jardir-'));
    expect(() => cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FILE: dir })).toThrow(CookieConfigError);
  });

  it('throws on a browser yt-dlp does not support, naming what is valid', () => {
    expect(() => cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'netscape' }))
      .toThrow(/netscape/);
    expect(() => cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'netscape' }))
      .toThrow(/firefox/);   // lists the supported set
  });

  it('prefers an explicit file over a standing browser default', () => {
    const p = jarFile();
    const got = cookieSourceFromEnv({
      VIDEO_EXTRACT_COOKIES_FILE: p, VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'firefox',
    });
    // Passing both to yt-dlp would merge two jars, which is not what either
    // setting asks for.
    expect(got).toEqual({ kind: 'file', path: p });
  });
});

describe('prepareCookies', () => {
  it('produces no arguments when unconfigured', () => {
    expect(prepareCookies({ kind: 'none' }).args).toEqual([]);
  });

  it('passes a browser spec straight through', () => {
    expect(prepareCookies({ kind: 'browser', spec: 'firefox' }).args)
      .toEqual(['--cookies-from-browser', 'firefox']);
  });

  it('passes a COPY of the jar, never the caller\'s own file', () => {
    // yt-dlp does not merely read --cookies FILE: it rewrites that file on
    // exit, merging in cookies the session picked up (verified directly
    // against the installed yt-dlp -- a hand-written jar came back with a
    // yt-dlp banner and fresh youtube.com entries appended). Handing over the
    // user's own file would mean silently rewriting a credential we were only
    // lent.
    const original = jarFile();
    const c = prepareCookies({ kind: 'file', path: original });
    expect(c.args[0]).toBe('--cookies');
    const passed = c.args[1]!;
    expect(passed).not.toBe(original);
    expect(readFileSync(passed, 'utf8')).toBe(JAR);   // same content...
    expect(dirname(passed)).not.toBe(dirname(original));  // ...different place
    c.dispose();
  });

  it('simulates yt-dlp rewriting the jar and proves the original survives', () => {
    // Mutating the COPY the way yt-dlp mutates what it is given; the user's
    // file must be untouched afterwards. This is the property the copy exists
    // for, so it is asserted directly rather than inferred from the paths.
    const original = jarFile();
    const c = prepareCookies({ kind: 'file', path: original });
    writeFileSync(c.args[1]!, '# rewritten by yt-dlp\n');
    expect(readFileSync(original, 'utf8')).toBe(JAR);
    c.dispose();
  });

  it('dispose() removes the copy, and is safe to call twice', () => {
    const c = prepareCookies({ kind: 'file', path: jarFile() });
    const passed = c.args[1]!;
    expect(existsSync(passed)).toBe(true);
    c.dispose();
    expect(existsSync(passed)).toBe(false);
    expect(() => c.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wiring: what yt-dlp is actually invoked with.
// ---------------------------------------------------------------------------

let prevPath: string | undefined;
let prevFile: string | undefined;
let prevBrowser: string | undefined;
afterEach(() => {
  if (prevPath !== undefined) process.env['PATH'] = prevPath;
  for (const [k, v] of [['VIDEO_EXTRACT_COOKIES_FILE', prevFile], ['VIDEO_EXTRACT_COOKIES_FROM_BROWSER', prevBrowser]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  prevPath = prevFile = prevBrowser = undefined;
});

function stubEnv(file?: string, browser?: string): void {
  prevFile = process.env['VIDEO_EXTRACT_COOKIES_FILE'];
  prevBrowser = process.env['VIDEO_EXTRACT_COOKIES_FROM_BROWSER'];
  if (file) process.env['VIDEO_EXTRACT_COOKIES_FILE'] = file;
  else delete process.env['VIDEO_EXTRACT_COOKIES_FILE'];
  if (browser) process.env['VIDEO_EXTRACT_COOKIES_FROM_BROWSER'] = browser;
  else delete process.env['VIDEO_EXTRACT_COOKIES_FROM_BROWSER'];
}

/** Fake yt-dlp that records its argv and exits non-zero (we only want the argv). */
function fakeYtDlp(): { binDir: string; log: string; workDir: string } {
  const binDir = mkdtempSync(join(tmpdir(), 'vem-ckbin-'));
  const workDir = mkdtempSync(join(tmpdir(), 'vem-ckwork-'));
  const log = join(binDir, 'argv.log');
  const bin = join(binDir, 'yt-dlp');
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(bin, 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
  return { binDir, log, workDir };
}

describe('the resolver actually passes cookies to yt-dlp', () => {
  it('sends --cookies pointing at a copy, and removes that copy afterwards', async () => {
    const jar = jarFile();
    const f = fakeYtDlp();
    stubEnv(jar);

    await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, returnVideo: false });

    const argv = readFileSync(f.log, 'utf8');
    expect(argv).toContain('--cookies');
    const passed = /--cookies (\S+)/.exec(argv)![1]!;
    expect(passed).not.toBe(jar);          // never the caller's file
    expect(existsSync(passed)).toBe(false); // disposed even though resolve FAILED
    // And never written into the caller's output directory.
    expect(readdirSync(f.workDir)).not.toContain('cookies.txt');
    expect(readFileSync(jar, 'utf8')).toBe(JAR);   // original intact
  }, 30_000);

  it('sends --cookies-from-browser when that is what is configured', async () => {
    const f = fakeYtDlp();
    stubEnv(undefined, 'firefox');
    await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, returnVideo: false });
    expect(readFileSync(f.log, 'utf8')).toContain('--cookies-from-browser firefox');
  }, 30_000);

  it('sends no cookie flags at all when nothing is configured', async () => {
    const f = fakeYtDlp();
    stubEnv();
    await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, returnVideo: false });
    const argv = readFileSync(f.log, 'utf8');
    expect(argv).not.toContain('--cookies');
  }, 30_000);

  it('fails with an actionable message, and never runs yt-dlp, on a bad path', async () => {
    // Not merely "returns a failure": yt-dlp must not be invoked at all, so a
    // misconfigured credential cannot quietly produce an anonymous fetch.
    const f = fakeYtDlp();
    stubEnv(join(tmpdir(), 'vem-absent-jar-77', 'cookies.txt'));

    const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, returnVideo: false });

    expect(r.status).toBe('extractor_failed');
    expect((r as { message: string }).message).toMatch(/VIDEO_EXTRACT_COOKIES_FILE/);
    expect(existsSync(f.log)).toBe(false);   // yt-dlp never ran
  }, 30_000);

  it('never puts the credential into the argv it logs for a browser source', async () => {
    // A browser spec is a name, not a secret -- but the FILE case must never
    // leak jar CONTENTS into an argument, only a path.
    const jar = jarFile();
    const f = fakeYtDlp();
    stubEnv(jar);
    await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, returnVideo: false });
    expect(readFileSync(f.log, 'utf8')).not.toContain('secret-value');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// auto: lazy borrowing, and the suggestion when nothing is configured.
// ---------------------------------------------------------------------------

describe('detectBrowser', () => {
  const exists = (present: string[]) => (p: string) => present.some((s) => p.endsWith(s));

  it('prefers firefox, whose store needs no keychain approval', () => {
    // Ordering is the whole value: every Chrome-family browser prompts on
    // first read, firefox does not. Picking chrome when firefox is available
    // means an OS dialog nobody expected.
    const got = detectBrowser('/home/u', 'linux',
      exists(['.mozilla/firefox', '.config/google-chrome']));
    expect(got).toBe('firefox');
  });

  it('falls through to whatever IS present', () => {
    expect(detectBrowser('/home/u', 'linux', exists(['.config/BraveSoftware/Brave-Browser']))).toBe('brave');
    expect(detectBrowser('/Users/u', 'darwin', exists(['Library/Application Support/Google/Chrome']))).toBe('chrome');
  });

  it('returns null when no supported browser has ever run', () => {
    expect(detectBrowser('/home/u', 'linux', () => false)).toBeNull();
  });

  it('detects on the DATA directory, not the installed app', () => {
    // A browser installed but never launched has no cookie store; choosing it
    // turns "retry with cookies" into a confusing yt-dlp error.
    expect(detectBrowser('/Users/u', 'darwin', exists(['/Applications/Google Chrome.app']))).toBeNull();
  });

  it('returns null rather than guessing when HOME is unset', () => {
    expect(detectBrowser('', 'linux', () => true)).toBeNull();
  });
});

describe('cookieSourceFromEnv: auto', () => {
  it('recognises auto, case-insensitively, as its own mode', () => {
    expect(cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'auto' })).toEqual({ kind: 'auto' });
    expect(cookieSourceFromEnv({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'AUTO' })).toEqual({ kind: 'auto' });
  });

  it('contributes NO arguments to a normal request', () => {
    // The point of lazy: an ordinary public video costs no keychain prompt
    // and no borrowed session.
    expect(prepareCookies({ kind: 'auto' }).args).toEqual([]);
  });

  it('is the only source that offers a retry browser', () => {
    // An eagerly-configured source already sent its cookies on the attempt
    // that just failed; retrying with the same credentials repeats it.
    expect(retryBrowserFor({ kind: 'browser', spec: 'chrome' })).toBeNull();
    expect(retryBrowserFor({ kind: 'file', path: '/x' })).toBeNull();
    expect(retryBrowserFor({ kind: 'none' })).toBeNull();
  });
});

describe('the lazy retry', () => {
  /** Fake yt-dlp that fails with a 403 unless --cookies-from-browser is present. */
  function refusingUnlessCookies(): { binDir: string; log: string; workDir: string } {
    const binDir = mkdtempSync(join(tmpdir(), 'vem-lazybin-'));
    const workDir = mkdtempSync(join(tmpdir(), 'vem-lazywork-'));
    const log = join(binDir, 'argv.log');
    const bin = join(binDir, 'yt-dlp');
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      'case " $* " in',
      '  *" --cookies-from-browser "*)',
      `    echo '{"title":"t","duration":5,"extractor":"youtube"}'; exit 0 ;;`,
      '  *)',
      '    echo "ERROR: unable to download video data: HTTP Error 403: Forbidden" >&2; exit 1 ;;',
      'esac',
    ].join('\n'));
    chmodSync(bin, 0o755);
    prevPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
    return { binDir, log, workDir };
  }

  it('retries once with browser cookies after a refusal, and succeeds', async () => {
    const f = refusingUnlessCookies();
    stubEnv(undefined, 'auto');
    const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, returnVideo: false });

    const calls = readFileSync(f.log, 'utf8').trim().split('\n');
    expect(calls.length).toBe(2);
    expect(calls[0]).not.toContain('--cookies-from-browser');   // first attempt is anonymous
    expect(calls[1]).toContain('--cookies-from-browser');       // second borrows
    expect(r.status).toBe('ok');
  }, 30_000);

  it('does NOT retry when a browser was already named, since it would repeat', async () => {
    const f = refusingUnlessCookies();
    stubEnv(undefined, 'chrome');
    await new YtDlpResolver().resolve('https://example.invalid/v', { workDir: f.workDir, returnVideo: false });
    // Exactly one call: it already carried cookies.
    expect(readFileSync(f.log, 'utf8').trim().split('\n').length).toBe(1);
  }, 30_000);

  it('never borrows for a failure cookies cannot fix', async () => {
    // DRM is not about who is asking. Spending a keychain prompt on it would
    // be pure cost.
    const binDir = mkdtempSync(join(tmpdir(), 'vem-drmbin-'));
    const workDir = mkdtempSync(join(tmpdir(), 'vem-drmwork-'));
    const log = join(binDir, 'argv.log');
    writeFileSync(join(binDir, 'yt-dlp'),
      `#!/bin/sh\necho "$@" >> "${log}"\necho "ERROR: This video is DRM protected" >&2\nexit 1\n`);
    chmodSync(join(binDir, 'yt-dlp'), 0o755);
    prevPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
    stubEnv(undefined, 'auto');

    const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir, returnVideo: false });
    expect(readFileSync(log, 'utf8').trim().split('\n').length).toBe(1);
    expect(r.status).toBe('unsupported');
  }, 30_000);
});

describe('the suggestion when nothing is configured', () => {
  it('offers a command on a refusal, and says a keychain prompt may appear', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'vem-sugbin-'));
    const workDir = mkdtempSync(join(tmpdir(), 'vem-sugwork-'));
    writeFileSync(join(binDir, 'yt-dlp'),
      '#!/bin/sh\necho "ERROR: unable to download video data: HTTP Error 403: Forbidden" >&2\nexit 1\n');
    chmodSync(join(binDir, 'yt-dlp'), 0o755);
    prevPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
    stubEnv();

    const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir, returnVideo: false });
    const f = r as { status: string; message: string; suggestedCommand?: string };
    expect(f.status).toBe('rate_limited');
    expect(f.suggestedCommand).toContain('VIDEO_EXTRACT_COOKIES_FROM_BROWSER=auto');
    // The surprising part must be stated BEFORE it happens.
    expect(f.message).toMatch(/keychain/i);
    // And the command must reach the message too -- the analyze path carries
    // only a reason string, so a structured field alone would not reach it.
    expect(f.message).toContain(f.suggestedCommand!);
  }, 30_000);

  it('offers nothing for a failure cookies cannot fix', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'vem-nosugbin-'));
    const workDir = mkdtempSync(join(tmpdir(), 'vem-nosugwork-'));
    writeFileSync(join(binDir, 'yt-dlp'), '#!/bin/sh\necho "ERROR: Video unavailable" >&2\nexit 1\n');
    chmodSync(join(binDir, 'yt-dlp'), 0o755);
    prevPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
    stubEnv();

    const r = await new YtDlpResolver().resolve('https://example.invalid/v', { workDir, returnVideo: false });
    expect((r as { suggestedCommand?: string }).suggestedCommand).toBeUndefined();
  }, 30_000);
});
