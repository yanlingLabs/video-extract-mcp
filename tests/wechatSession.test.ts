import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WeChatSession, applyRenewal, SIGN_IN_WAIT_MS, type SessionDeps, type SessionCheck, type Acquired,
} from '../src/resolve/wechatSession.js';
import { WeChatHeadlessResolver, checkSession } from '../src/resolve/wechat.js';
import { runWithStatus } from '../src/status/context.js';
import type { BrowserSys } from '../src/util/browsers.js';

afterEach(() => { vi.unstubAllGlobals(); });

// A value that must never appear in anything this module returns.
const SECRET = 'SECRET-hy-token-7f3a';
const GOOD = `hy_user=U; hy_token=${SECRET}`;
const RENEWED = 'hy_user=U; hy_token=RENEWED';

const jarWith = (...lines: string[]) => ['# Netscape HTTP Cookie File', ...lines].join('\n');
const SIGNED_IN = jarWith(
  `.tencent.com\tTRUE\t/\tTRUE\t4102444800\thy_user\tU`,
  `.tencent.com\tTRUE\t/\tTRUE\t4102444800\thy_token\t${SECRET}`,
  `.youtube.com\tTRUE\t/\tTRUE\t4102444800\tSID\tnot-for-yuanbao`,
);
const SIGNED_OUT = jarWith(`.tencent.com\tTRUE\t/\tFALSE\t4102444800\t_ga\tanalytics`);

interface Harness {
  deps: SessionDeps;
  reads: number;
  launched: string[][];
  checked: string[];
  /** What each successive browser read returns; the last one repeats. */
  jars: string[];
  readError?: string;
}

/**
 * A session over a fake machine: macOS, no LaunchServices override (so
 * Safari is the default), a virtual clock that sleep() advances, and a
 * getuserinfo that accepts exactly GOOD (renewing its token) and refuses
 * anything else.
 */
function harness(over: { env?: string | null; jars?: string[]; defaultBrowser?: 'chrome'; check?: SessionDeps['check'] } = {}): Harness {
  let now = 1_800_000_000_000;
  const h: Harness = {
    reads: 0, launched: [], checked: [], jars: over.jars ?? [SIGNED_OUT],
    deps: undefined as unknown as SessionDeps,
  };
  const sys: BrowserSys = {
    platform: 'darwin',
    home: mkdtempSync(join(tmpdir(), 'vem-shome-')),
    exec: async (cmd, args) => {
      if (cmd === 'plutil') {
        const id = over.defaultBrowser === 'chrome' ? 'com.google.chrome' : 'com.apple.safari';
        return { code: 0, stdout: JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: id }] }), stderr: '' };
      }
      if (cmd !== 'yt-dlp') throw new Error(`unexpected ${cmd}`);
      expect(args).toContain('--cookies-from-browser');
      h.reads++;
      if (h.readError) return { code: 1, stdout: '', stderr: h.readError };
      // Like yt-dlp: the jar goes to the --cookies file, never to stdout.
      writeFileSync(args[args.indexOf('--cookies') + 1]!, h.jars[Math.min(h.reads - 1, h.jars.length - 1)]!);
      return { code: 2, stdout: 'Extracting cookies from safari\n', stderr: 'yt-dlp: error: You must provide at least one URL.' };
    },
    launch: async (cmd, args) => { h.launched.push([cmd, ...args]); return true; },
    detectBrowser: () => null,
  };
  if (over.defaultBrowser === 'chrome') {
    // defaultBrowser() only runs plutil when the preferences file exists.
    const plist = join(sys.home, 'Library/Preferences/com.apple.LaunchServices');
    mkdirSync(plist, { recursive: true });
    writeFileSync(join(plist, 'com.apple.launchservices.secure.plist'), '');
  }
  h.deps = {
    envCookie: () => over.env ?? null,
    check: over.check ?? (async (header): Promise<SessionCheck> => {
      h.checked.push(header);
      return header === GOOD || header === RENEWED ? { state: 'valid', header: RENEWED } : { state: 'invalid' };
    }),
    sys,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    signInWaitMs: SIGN_IN_WAIT_MS,
  };
  return h;
}

function failureOf(a: Acquired) {
  if (a.ok) throw new Error('expected a failure');
  return a.failure;
}

describe('without userCookies: the configured cookie only, as before', () => {
  it('uses VIDEO_EXTRACT_WECHAT_COOKIE, renewed, and never touches the browser', async () => {
    const h = harness({ env: GOOD });
    const a = await new WeChatSession(h.deps).acquire(false);
    expect(a).toEqual({ ok: true, cred: { header: 'hy_user=U; hy_token=RENEWED', origin: 'wechat_cookie' } });
    expect(h.reads).toBe(0);
  });

  it('on an expired cookie, says to ask about userCookies instead of opening anything', async () => {
    const h = harness({ env: 'hy_token=stale' });
    const f = failureOf(await new WeChatSession(h.deps).acquire(false));
    expect(f.status).toBe('auth_expired');
    expect(f.cookies).toBe('wechat_cookie');
    expect(f.message).toMatch(/Ask the user whether to retry with userCookies: true/);
    expect(h.reads).toBe(0);
    expect(h.launched).toEqual([]);
  });

  it('with nothing configured, fails before any request', async () => {
    const h = harness();
    const f = failureOf(await new WeChatSession(h.deps).acquire(false));
    expect(f.status).toBe('auth_required');
    expect(f.cookies).toBe('none');
    expect(h.checked).toEqual([]);
    expect(h.reads).toBe(0);
  });
});

describe('with userCookies', () => {
  it('takes a signed-in session straight from the default browser, and only its yuanbao cookies', async () => {
    const h = harness({ jars: [SIGNED_IN] });
    const a = await new WeChatSession(h.deps).acquire(true);
    expect(a).toEqual({ ok: true, cred: { header: 'hy_user=U; hy_token=RENEWED', origin: 'browser:safari' } });
    // What went to getuserinfo is exactly what a browser would send it.
    expect(h.checked).toEqual([GOOD]);
    expect(h.launched).toEqual([]);
  });

  it('prefers a configured cookie that still works over reading the browser', async () => {
    const h = harness({ env: GOOD, jars: [SIGNED_IN] });
    const a = await new WeChatSession(h.deps).acquire(true);
    expect(a.ok && a.cred.origin).toBe('wechat_cookie');
    expect(h.reads).toBe(0);
  });

  it('remembers the session, not the permission', async () => {
    const h = harness({ jars: [SIGNED_IN] });
    const s = new WeChatSession(h.deps);
    await s.acquire(true);
    const again = await s.acquire(true);
    expect(again.ok && again.cred.origin).toBe('browser:safari');
    expect(h.reads).toBe(1); // no second browser read, so no second Keychain prompt
    // A later call without userCookies never sees what the browser gave.
    const without = failureOf(await s.acquire(false));
    expect(without.status).toBe('auth_required');
  });

  it('opens yuanbao in the browser it reads, waits, and continues once the user signs in', async () => {
    const h = harness({ jars: [SIGNED_OUT, SIGNED_OUT, SIGNED_OUT, SIGNED_IN] });
    const stages: string[] = [];
    const a = await runWithStatus({ onStage: (s) => stages.push(s) }, () => new WeChatSession(h.deps).acquire(true));
    expect(a.ok && a.cred.origin).toBe('browser:safari');
    expect(h.launched).toEqual([['open', '-b', 'com.apple.safari', 'https://yuanbao.tencent.com/']]);
    expect(stages).toEqual(['waiting_for_sign_in']);
    expect(h.reads).toBe(4);
  });

  it('gives up after the wait with a message the agent can pass on, and bounded polling', async () => {
    const h = harness({ jars: [SIGNED_OUT] });
    const f = failureOf(await new WeChatSession(h.deps).acquire(true));
    expect(f.status).toBe('auth_required');
    expect(f.cookies).toBe('none');
    expect(f.message).toMatch(/Opened https:\/\/yuanbao\.tencent\.com\/ in Safari/);
    expect(f.message).toMatch(/within 3 minutes/);
    expect(f.message).toMatch(/retry with userCookies: true/);
    expect(h.launched.length).toBe(1);
    // One read up front, then one every 5 seconds for 3 minutes.
    expect(h.reads).toBe(1 + SIGN_IN_WAIT_MS / 5_000);
  });

  it('does not re-send a refused session until it changes', async () => {
    const stale = jarWith(`.tencent.com\tTRUE\t/\tTRUE\t4102444800\thy_token\tdead`);
    const h = harness({ jars: [stale] });
    await new WeChatSession(h.deps).acquire(true);
    expect(h.checked).toEqual(['hy_token=dead']);
  });

  it('polls a Keychain-prompting browser three times less often', async () => {
    const h = harness({ jars: [SIGNED_OUT], defaultBrowser: 'chrome' });
    await new WeChatSession(h.deps).acquire(true);
    expect(h.launched).toEqual([['open', '-b', 'com.google.chrome', 'https://yuanbao.tencent.com/']]);
    expect(h.reads).toBe(1 + SIGN_IN_WAIT_MS / 15_000);
  });

  it('shares one browser read and one sign-in page among concurrent items', async () => {
    const h = harness({ jars: [SIGNED_OUT, SIGNED_IN] });
    const s = new WeChatSession(h.deps);
    const stages: string[] = [];
    const [a, b] = await Promise.all([
      runWithStatus({ onStage: (x) => stages.push(`a:${x}`) }, () => s.acquire(true)),
      runWithStatus({ onStage: (x) => stages.push(`b:${x}`) }, () => s.acquire(true)),
    ]);
    expect(a).toEqual(b);
    expect(h.launched.length).toBe(1);
    expect(h.reads).toBe(2);
    expect(stages.sort()).toEqual(['a:waiting_for_sign_in', 'b:waiting_for_sign_in']);
  });

  it('does not open a sign-in page when the store itself cannot be read', async () => {
    const h = harness();
    h.readError = "ERROR: [Errno 1] Operation not permitted: '/Users/x/Library/Containers/com.apple.Safari/...'";
    const f = failureOf(await new WeChatSession(h.deps).acquire(true));
    expect(f.message).toMatch(/Full Disk Access/);
    expect(h.launched).toEqual([]);
  });

  it('forgets a remembered session yuanbao later rejected', async () => {
    const h = harness({ jars: [SIGNED_IN] });
    const s = new WeChatSession(h.deps);
    const first = await s.acquire(true);
    if (!first.ok) throw new Error('setup');
    s.forget(first.cred.header);
    await s.acquire(true);
    expect(h.reads).toBe(2);
  });

  it('never puts a cookie value in any failure', async () => {
    const messages: string[] = [];
    for (const setup of [
      harness({ env: `hy_token=${SECRET}` }),
      harness({ jars: [jarWith(`.tencent.com\tTRUE\t/\tTRUE\t4102444800\thy_token\t${SECRET}x`)] }),
    ]) {
      for (const userCookies of [false, true]) {
        const a = await new WeChatSession(setup.deps).acquire(userCookies);
        if (!a.ok) messages.push(JSON.stringify(a.failure));
      }
    }
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) expect(m).not.toContain(SECRET);
  });
});

describe('applyRenewal', () => {
  it('takes the renewed token and ignores the deletion of the old host-only copy', () => {
    // The shape getuserinfo actually answered with (values replaced).
    const renewed = applyRenewal('_ga=1; hy_source=web; hy_token=old; hy_user=U', [
      'hy_user=; Path=/; Domain=yuanbao.tencent.com; Max-Age=0; Secure; SameSite=None',
      'hy_user=U; Path=/; Domain=tencent.com; Max-Age=5184000; Secure; SameSite=None',
      'hy_token=; Path=/; Domain=yuanbao.tencent.com; Max-Age=0; HttpOnly; Secure; SameSite=None',
      'hy_token=new; Path=/; Domain=tencent.com; Max-Age=5184000; HttpOnly; Secure; SameSite=None',
    ]);
    expect(renewed).toBe('_ga=1; hy_source=web; hy_token=new; hy_user=U');
  });

  it('ignores an expiring Set-Cookie even when it carries a value', () => {
    expect(applyRenewal('hy_token=live', ['hy_token=deleted; Path=/; Max-Age=0'])).toBe('hy_token=live');
  });

  it('is the identity without renewals', () => {
    expect(applyRenewal('a=1; b=2', [])).toBe('a=1; b=2');
  });
});

describe('the resolver uses the renewed session', () => {
  it('sends getuserinfo\'s fresh token to the parse call, and reports where the session came from', async () => {
    const seen: Record<string, string> = {};
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      seen[url] = new Headers(init?.headers).get('cookie') ?? '';
      if (url.endsWith('/api/getuserinfo')) {
        return new Response(JSON.stringify({ userId: 'u', anonUser: { isAnon: false } }), {
          status: 200,
          headers: [['set-cookie', 'hy_token=FRESH; Path=/; Domain=tencent.com; Max-Age=5184000']],
        });
      }
      return new Response('{}', { status: 404 });
    }));
    const h = harness({ env: 'hy_user=U; hy_token=aging', check: checkSession });
    const r = await new WeChatHeadlessResolver(new WeChatSession(h.deps))
      .resolve('https://weixin.qq.com/sph/abc', { workDir: mkdtempSync(join(tmpdir(), 'vem-wr-')), returnVideo: true });
    expect(seen['https://yuanbao.tencent.com/api/getuserinfo']).toBe('hy_user=U; hy_token=aging');
    expect(seen['https://yuanbao.tencent.com/api/weixin/get_parse_result']).toBe('hy_user=U; hy_token=FRESH');
    expect(r.status).toBe('not_found');
    expect(r.cookies).toBe('wechat_cookie');
  });

  it('a metadata-only call without userCookies stays free: no request at all', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({ env: GOOD, check: checkSession });
    const r = await new WeChatHeadlessResolver(new WeChatSession(h.deps))
      .resolve('https://weixin.qq.com/sph/abc', { workDir: tmpdir(), returnVideo: false });
    expect(r.status).toBe('ok');
    expect(r.cookies).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a metadata-only call WITH userCookies acquires the session, so the download finds it ready', async () => {
    const h = harness({ jars: [SIGNED_IN] });
    const r = await new WeChatHeadlessResolver(new WeChatSession(h.deps))
      .resolve('https://weixin.qq.com/sph/abc', { workDir: tmpdir(), returnVideo: false, userCookies: true });
    expect(r.status).toBe('ok');
    expect(r.cookies).toBe('browser:safari');
    expect(h.reads).toBe(1);
  });
});
