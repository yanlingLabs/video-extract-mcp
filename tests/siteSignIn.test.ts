import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  waitForSiteSignIn, MAX_RETRIES, SIGN_IN_WAIT_MS, type SiteSignInDeps, type RetryVerdict,
} from '../src/resolve/siteSignIn.js';
import { YtDlpResolver } from '../src/resolve/ytdlp.js';
import { runWithStatus } from '../src/status/context.js';

const VIDEO = 'https://www.youtube.com/watch?v=abc';
const jar = (...cookies: Array<[string, string]>) => ['# Netscape HTTP Cookie File',
  ...cookies.map(([n, v]) => `.youtube.com\tTRUE\t/\tTRUE\t4102444800\t${n}\t${v}`)].join('\n');
const SIGNED_OUT = jar(['VISITOR_INFO1_LIVE', 'a'], ['YSC', 'b']);
const SIGNED_OUT_CHURNED = jar(['VISITOR_INFO1_LIVE', 'a2'], ['YSC', 'b2']);
const SIGNED_IN = jar(['VISITOR_INFO1_LIVE', 'a'], ['YSC', 'b'], ['SID', 's'], ['LOGIN_INFO', 'l']);

interface Harness {
  deps: SiteSignInDeps;
  jars: string[];
  reads: number;
  presented: string[][];
  finished: string[];
  pressed: Array<(press: 'signed_in' | 'declined') => void>;
  cannotOpen?: boolean;
}

/** A virtual clock, a browser whose successive reads return `jars`, and a fake page. */
function harness(jars: string[], opts: { sleepForever?: boolean } = {}): Harness {
  let now = 1_800_000_000_000;
  const h: Harness = { jars, reads: 0, presented: [], finished: [], pressed: [], deps: undefined as unknown as SiteSignInDeps };
  h.deps = {
    sys: {
      platform: 'darwin', home: mkdtempSync(join(tmpdir(), 'vem-ssi-')),
      exec: async (_cmd, args) => {
        h.reads++;
        writeFileSync(args[args.indexOf('--cookies') + 1]!, h.jars[Math.min(h.reads - 1, h.jars.length - 1)]!);
        return { code: 2, stdout: '', stderr: '' };
      },
      launch: async () => true,
      detectBrowser: () => null,
    },
    now: () => now,
    sleep: opts.sleepForever ? () => new Promise<void>(() => {}) : async (ms) => { now += ms; },
    waitMs: SIGN_IN_WAIT_MS,
    present: async (site, browser, videoUrl) => {
      if (h.cannotOpen) return null;
      h.presented.push([site.host, browser.name, videoUrl]);
      return {
        nudge: () => new Promise<'signed_in' | 'declined'>((resolve) => { h.pressed.push(resolve); }),
        finish: (outcome) => { h.finished.push(outcome); },
      };
    },
  };
  return h;
}

/** A retry that answers each attempt from `verdicts`, counting attempts. */
function retries(verdicts: RetryVerdict[]) {
  let n = 0;
  return {
    get count() { return n; },
    retry: async () => verdicts[Math.min(n++, verdicts.length - 1)]!,
    verdict: (v: RetryVerdict) => v,
  };
}

const safari = { name: 'safari', isDefault: true };

describe('waitForSiteSignIn', () => {
  it('spends no request on the platform without a sign-in signal, then times out', async () => {
    const h = harness([SIGNED_OUT]);
    const r = retries(['ok']);
    const w = await waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps });
    expect(w.outcome).toBe('timed_out');
    expect(r.count).toBe(0);
    expect(h.presented).toEqual([['youtube.com', 'safari', VIDEO]]);
    expect(h.finished).toEqual(['timed_out']);
  });

  it('ignores cookie values changing: sites churn them constantly while a tab is open', async () => {
    const h = harness([SIGNED_OUT, SIGNED_OUT_CHURNED, SIGNED_OUT]);
    const r = retries(['ok']);
    await waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps });
    expect(r.count).toBe(0);
  });

  it('retries once a new cookie name appears for the site, and finishes the page', async () => {
    const h = harness([SIGNED_OUT, SIGNED_OUT, SIGNED_IN]);
    const r = retries(['ok']);
    const stages: string[] = [];
    const w = await runWithStatus({ onStage: (s) => stages.push(s) },
      () => waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps }));
    expect(w.outcome).toBe('signed_in');
    expect(r.count).toBe(1);
    expect(h.finished).toEqual(['signed_in']);
    expect(stages).toEqual(['waiting_for_sign_in']);
  });

  it("retries at once when the user presses \"I've signed in\"", async () => {
    const h = harness([SIGNED_OUT], { sleepForever: true });
    const r = retries(['ok']);
    const pending = waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps });
    await vi.waitFor(() => expect(h.pressed.length).toBe(1));
    h.pressed[0]!('signed_in');
    expect((await pending).outcome).toBe('signed_in');
    expect(r.count).toBe(1);
  });

  it(`gives up after ${MAX_RETRIES} refusals, however often the user presses`, async () => {
    const h = harness([SIGNED_OUT], { sleepForever: true });
    const r = retries(['refused']);
    const pending = waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps });
    for (let i = 1; i <= MAX_RETRIES; i++) {
      await vi.waitFor(() => expect(h.pressed.length).toBe(i));
      h.pressed[i - 1]!('signed_in');
    }
    const w = await pending;
    expect(w.outcome).toBe('gave_up');
    expect(r.count).toBe(MAX_RETRIES);
    expect(h.finished).toEqual(['failed']);
  });

  it('needs a further new cookie before retrying again after a refusal', async () => {
    // Signed in (a retry), still refused; then nothing new for the rest of the wait.
    const h = harness([SIGNED_OUT, SIGNED_IN]);
    const r = retries(['refused', 'ok']);
    const w = await waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps });
    expect(r.count).toBe(1);
    expect(w.outcome).toBe('timed_out');
  });

  it('stops on a different failure rather than retrying it', async () => {
    const h = harness([SIGNED_OUT, SIGNED_IN]);
    const r = retries(['other']);
    const w = await waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps });
    expect(w.outcome).toBe('other');
    expect(r.count).toBe(1);
  });

  it('"Don\'t sign in" ends the wait without a single request to the platform', async () => {
    const h = harness([SIGNED_OUT], { sleepForever: true });
    const r = retries(['ok']);
    const pending = waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps });
    await vi.waitFor(() => expect(h.pressed.length).toBe(1));
    h.pressed[0]!('declined');
    expect((await pending).outcome).toBe('declined');
    expect(r.count).toBe(0);
    expect(h.finished).toEqual(['declined']);
  });

  it('reports when nothing could be opened, without retrying', async () => {
    const h = harness([SIGNED_OUT]);
    h.cannotOpen = true;
    const r = retries(['ok']);
    const w = await waitForSiteSignIn({ videoUrl: VIDEO, browser: safari, retry: r.retry, verdict: r.verdict, deps: h.deps });
    expect(w.outcome).toBe('not_opened');
    expect(r.count).toBe(0);
  });
});

describe('the yt-dlp resolver with userCookies', () => {
  /** A fake yt-dlp that refuses until `signedIn` exists, logging each call. */
  function refusingUntilSignedIn() {
    const dir = mkdtempSync(join(tmpdir(), 'vem-ssibin-'));
    const signedIn = join(dir, 'signed-in');
    const log = join(dir, 'argv.log');
    writeFileSync(join(dir, 'yt-dlp'), [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      `if [ -f "${signedIn}" ]; then echo '{"title":"t","duration":5,"extractor":"youtube"}'; exit 0; fi`,
      'echo "ERROR: [youtube] abc: Sign in to confirm you\'re not a bot" >&2; exit 1',
    ].join('\n'));
    chmodSync(join(dir, 'yt-dlp'), 0o755);
    return { dir, signedIn, log };
  }

  it('shows the sign-in page after a refusal with the browser\'s cookies, and continues once signed in', async () => {
    const f = refusingUntilSignedIn();
    const prevPath = process.env['PATH'];
    const home = mkdtempSync(join(tmpdir(), 'vem-ssihome-'));
    mkdirSync(join(home, 'Library/Application Support/Chromium'), { recursive: true });
    mkdirSync(join(home, '.config/chromium'), { recursive: true });
    vi.stubEnv('HOME', home);
    process.env['PATH'] = `${f.dir}:${prevPath ?? ''}`;
    try {
      const h = harness([SIGNED_OUT], { sleepForever: true });
      const pending = new YtDlpResolver(h.deps).resolve(VIDEO, {
        workDir: mkdtempSync(join(tmpdir(), 'vem-ssiwork-')), returnVideo: false, userCookies: true,
      });
      await vi.waitFor(() => expect(h.pressed.length).toBe(1), { timeout: 10_000 });
      writeFileSync(f.signedIn, '');
      h.pressed[0]!('signed_in');
      const r = await pending;
      expect(r.status).toBe('ok');
      expect(r.cookies).toMatch(/^browser:/);
      expect(h.presented[0]![0]).toBe('youtube.com');
      const calls = readFileSync(f.log, 'utf8').trim().split('\n');
      expect(calls.length).toBe(2);
      expect(calls.every((c) => c.includes('--cookies-from-browser'))).toBe(true);
    } finally {
      process.env['PATH'] = prevPath;
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('never opens a page when the browser came from the configuration, not from userCookies', async () => {
    const f = refusingUntilSignedIn();
    const prevPath = process.env['PATH'];
    process.env['PATH'] = `${f.dir}:${prevPath ?? ''}`;
    vi.stubEnv('VIDEO_EXTRACT_COOKIES_FROM_BROWSER', 'firefox');
    try {
      const h = harness([SIGNED_OUT]);
      const r = await new YtDlpResolver(h.deps).resolve(VIDEO, {
        workDir: mkdtempSync(join(tmpdir(), 'vem-ssiwork-')), returnVideo: false,
      });
      expect(r.status).toBe('auth_required');
      expect(h.presented).toEqual([]);
      expect((r as { message: string }).message).toMatch(/not signed in to youtube\.com there/);
    } finally {
      process.env['PATH'] = prevPath;
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
