import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  defaultBrowser, browserForCall, openInBrowser, readBrowserJar, parseJar, cookiesFor, cookieHeader,
  userCookiesHint, realSys, type BrowserSys,
} from '../src/util/browsers.js';

type ExecResult = { code: number; stdout: string; stderr: string };

/** A machine with nothing on it but what a test hands it. */
function fakeSys(over: Partial<BrowserSys> & { run?: (cmd: string, args: string[]) => ExecResult } = {}): BrowserSys & { launched: string[][] } {
  const launched: string[][] = [];
  return {
    platform: 'darwin',
    home: mkdtempSync(join(tmpdir(), 'vem-bhome-')),
    exec: async (cmd, args) => {
      if (!over.run) throw new Error(`no such command: ${cmd}`);
      return over.run(cmd, args);
    },
    launch: async (cmd, args) => { launched.push([cmd, ...args]); return true; },
    detectBrowser: () => null,
    ...over,
    launched,
  };
}

/** A home whose LaunchServices preferences exist; plutil's output is what `handlers` says. */
function macWithDefault(handlers: Array<Record<string, string>>): BrowserSys & { launched: string[][] } {
  const sys = fakeSys({ run: (cmd) => ({ code: cmd === 'plutil' ? 0 : 1, stdout: JSON.stringify({ LSHandlers: handlers }), stderr: '' }) });
  const plist = join(sys.home, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, 'binary plist; plutil is faked');
  return sys;
}

describe('defaultBrowser', () => {
  it('reads the https handler from LaunchServices on macOS', async () => {
    expect(await defaultBrowser(macWithDefault([
      { LSHandlerContentType: 'public.html', LSHandlerRoleAll: 'org.mozilla.firefox' },
      { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome' },
    ]))).toBe('chrome');
    expect(await defaultBrowser(macWithDefault([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.apple.safari' }])))
      .toBe('safari');
  });

  it('is Safari when the user never changed it', async () => {
    // No preferences file at all, and a file with no web handler, both mean
    // the macOS default.
    expect(await defaultBrowser(fakeSys())).toBe('safari');
    expect(await defaultBrowser(macWithDefault([{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' }])))
      .toBe('safari');
  });

  it('is null for a default yt-dlp cannot read, rather than a guess', async () => {
    expect(await defaultBrowser(macWithDefault([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'company.thebrowser.browser' }])))
      .toBeNull();
  });

  it('reads xdg-settings on Linux and the UserChoice ProgId on Windows', async () => {
    const linux = (out: string) => fakeSys({ platform: 'linux', run: () => ({ code: 0, stdout: out, stderr: '' }) });
    expect(await defaultBrowser(linux('firefox_firefox.desktop\n'))).toBe('firefox');
    expect(await defaultBrowser(linux('google-chrome.desktop\n'))).toBe('chrome');
    expect(await defaultBrowser(linux('org.gnome.Epiphany.desktop\n'))).toBeNull();
    // No xdg-settings installed: unknown, not a crash.
    expect(await defaultBrowser(fakeSys({ platform: 'linux' }))).toBeNull();

    const reg = '\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    MSEdgeHTM\r\n';
    expect(await defaultBrowser(fakeSys({ platform: 'win32', run: () => ({ code: 0, stdout: reg, stderr: '' }) }))).toBe('edge');
  });
});

describe('browserForCall', () => {
  it('uses the default browser when yt-dlp can read it', async () => {
    const sys = macWithDefault([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.apple.safari' }]);
    sys.detectBrowser = () => 'chrome';
    // The machine this was written on: Safari the default, Chrome's profile
    // the first one detectBrowser finds. Reading Chrome there would poll a
    // browser the user never signs in to.
    expect(await browserForCall(sys)).toEqual({ name: 'safari', isDefault: true });
  });

  it('falls back to an installed one, marked as not the default, only when it must', async () => {
    const sys = macWithDefault([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'company.thebrowser.browser' }]);
    sys.detectBrowser = () => 'firefox';
    expect(await browserForCall(sys)).toEqual({ name: 'firefox', isDefault: false });
    sys.detectBrowser = () => null;
    expect(await browserForCall(sys)).toBeNull();
  });
});

describe('openInBrowser', () => {
  it('opens exactly the browser it reads from', async () => {
    const mac = fakeSys();
    await openInBrowser({ name: 'safari', isDefault: true }, 'https://yuanbao.tencent.com/', mac);
    expect(mac.launched).toEqual([['open', '-b', 'com.apple.safari', 'https://yuanbao.tencent.com/']]);

    const linux = fakeSys({ platform: 'linux' });
    await openInBrowser({ name: 'firefox', isDefault: true }, 'https://a.example/', linux);
    await openInBrowser({ name: 'chrome', isDefault: false }, 'https://a.example/', linux);
    expect(linux.launched).toEqual([['xdg-open', 'https://a.example/'], ['google-chrome', 'https://a.example/']]);
  });
});

describe('the cookies a browser would send', () => {
  const jar = [
    '# Netscape HTTP Cookie File',
    '.tencent.com\tTRUE\t/\tTRUE\t4102444800\thy_user\tU',
    '#HttpOnly_.tencent.com\tTRUE\t/\tTRUE\t4102444800\thy_token\tT',
    'yuanbao.tencent.com\tFALSE\t/api\tTRUE\t0\tsession\tS',
    'other.tencent.com\tFALSE\t/\tTRUE\t4102444800\thost_only_elsewhere\tX',
    '.tencent.com\tTRUE\t/\tFALSE\t1000000000\texpired\tE',
    '.tencent.com\tTRUE\t/admin\tTRUE\t4102444800\twrong_path\tP',
    '.youtube.com\tTRUE\t/\tTRUE\t4102444800\tSID\tY',
    'Extracting cookies from firefox',
  ].join('\n');
  const now = 1_800_000_000;

  it('keeps only what the target URL would get, most specific path first', () => {
    const got = cookiesFor(parseJar(jar), 'https://yuanbao.tencent.com/api/getuserinfo', now);
    expect(got.map((c) => c.name)).toEqual(['session', 'hy_user', 'hy_token']);
    expect(cookieHeader(got)).toBe('session=S; hy_user=U; hy_token=T');
  });

  it('never sends a Secure cookie over plain http', () => {
    expect(cookiesFor(parseJar(jar), 'http://yuanbao.tencent.com/api/getuserinfo', now)).toEqual([]);
  });

  it('keeps the first of a repeated name', () => {
    const dup = parseJar('.a.example\tTRUE\t/x\tFALSE\t0\tn\tdeep\n.a.example\tTRUE\t/\tFALSE\t0\tn\tshallow\n');
    expect(cookieHeader(cookiesFor(dup, 'https://a.example/x/y', now))).toBe('n=deep');
  });
});

describe('userCookiesHint', () => {
  it('names the browser, warns about the Keychain only where it will appear, and asks first', () => {
    const chrome = userCookiesHint({ name: 'chrome', isDefault: true }, 'darwin');
    expect(chrome).toMatch(/Ask the user whether to retry with userCookies: true/);
    expect(chrome).toMatch(/Chrome/);
    expect(chrome).toMatch(/Keychain/);
    expect(userCookiesHint({ name: 'safari', isDefault: true }, 'darwin')).not.toMatch(/Keychain/);
    expect(userCookiesHint({ name: 'chrome', isDefault: true }, 'linux')).not.toMatch(/Keychain/);
  });

  it('points at the cookie-file setting when there is no browser to read', () => {
    const none = userCookiesHint(null, 'darwin');
    expect(none).not.toMatch(/userCookies: true/);
    expect(none).toMatch(/VIDEO_EXTRACT_COOKIES_FILE/);
  });
});

function hasYtDlp(): boolean {
  try { execFileSync('yt-dlp', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe.skipIf(!hasYtDlp())('readBrowserJar against the real yt-dlp', () => {
  // A Firefox profile holding four made-up cookies. yt-dlp reads it exactly
  // as it would a real one, which pins the one fact this depends on: with no
  // URL it still writes the jar before exiting on the usage error.
  const profile = resolvePath('tests/fixtures/firefox-profile');

  it('returns the jar with no URL given, and filters to the site asked for', async () => {
    const r = await readBrowserJar(`firefox:${profile}`, realSys);
    if (!r.ok) throw new Error(r.error);
    const got = cookiesFor(parseJar(r.jar), 'https://yuanbao.tencent.com/api/getuserinfo', Date.now() / 1000);
    expect(cookieHeader(got)).toBe('hy_token=fixture-token-value; hy_user=fixture-user-value');
  }, 30_000);

  it('turns a missing store into a sentence, never yt-dlp output', async () => {
    const r = await readBrowserJar(`firefox:${join(tmpdir(), 'vem-no-such-profile')}`, realSys);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No cookie store was found for firefox/i);
    expect(r.error).not.toMatch(/Extracting|ERROR/);
  }, 30_000);
});

describe('the test-only launch guard', () => {
  it('stops realSys from starting anything while VIDEO_EXTRACT_NO_LAUNCH is set', async () => {
    // vitest.config.ts sets it for the whole suite; without it, a test that
    // forgot its fakes once opened a real sign-in page in the developer's Safari.
    expect(process.env['VIDEO_EXTRACT_NO_LAUNCH']).toBeTruthy();
    expect(await realSys.launch('true', [])).toBe(false);
    vi.stubEnv('VIDEO_EXTRACT_NO_LAUNCH', undefined);
    try {
      expect(await realSys.launch('true', [])).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
