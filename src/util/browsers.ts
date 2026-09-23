import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.js';
import { detectBrowser } from './cookies.js';

/**
 * The user's own browser, for a call that passed `userCookies: true`.
 *
 * "The user's browser" means their DEFAULT browser, not merely one that is
 * installed: a sign-in page is opened with it, and the cookies must then be
 * read from the same one -- open Safari and poll Chrome and the user signs in
 * where nobody is looking. This machine had exactly that shape (Safari the
 * default, Chrome's profile the one `detectBrowser()` found first). Only when
 * the default is one yt-dlp cannot read (Arc, for instance) does this fall
 * back to `detectBrowser()`, and then that browser is the one opened too.
 *
 * Cookies are read by yt-dlp (`--cookies-from-browser`), the extractor this
 * project already depends on: it knows every store format, Chrome's keychain
 * decryption and Safari's binarycookies, none of which is worth re-deriving.
 * Given no URL it still writes the jar and exits 2 (its close() saves
 * cookies on the way out of the usage error) -- pinned against the real
 * binary by tests/browsers.test.ts.
 */

export interface BrowserChoice {
  /** yt-dlp's name for it (`--cookies-from-browser NAME`). */
  name: string;
  /** False when the default browser was unreadable and this is the fallback. */
  isDefault: boolean;
}

/** Everything that touches the machine, injectable so tests need no browser. */
export interface BrowserSys {
  platform: NodeJS.Platform;
  home: string;
  /** Runs to completion. Rejects only when the command cannot be spawned. */
  exec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Starts a detached process; true once it spawned. Never rejects. */
  launch(cmd: string, args: string[]): Promise<boolean>;
  detectBrowser(): string | null;
}

export const realSys: BrowserSys = {
  platform: process.platform,
  // Read on use, like detectBrowser's own default, so HOME is never stale.
  get home() { return process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''; },
  exec: (cmd, args, timeoutMs) => run(cmd, args, { timeoutMs }),
  launch: (cmd, args) => new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('spawn', () => { child.unref(); resolve(true); });
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  }),
  detectBrowser: () => detectBrowser(),
};

const LABELS: Record<string, string> = {
  safari: 'Safari', chrome: 'Chrome', firefox: 'Firefox', brave: 'Brave', edge: 'Edge',
  chromium: 'Chromium', opera: 'Opera', vivaldi: 'Vivaldi', whale: 'Whale',
};

/** "Safari", for messages a person will read. */
export function browserLabel(name: string): string {
  return LABELS[name] ?? name;
}

/**
 * Every Chrome-family store is encrypted against the OS keyring, so reading
 * it shows a Keychain prompt on macOS -- once with "Always Allow", on every
 * read without it. Callers space their reads out accordingly.
 */
export function promptsForKeychain(name: string): boolean {
  return ['chrome', 'chromium', 'brave', 'edge', 'opera', 'vivaldi', 'whale'].includes(name);
}

/** LaunchServices bundle id -> yt-dlp name. Ids are stored lowercased. */
const MAC_BUNDLES: Record<string, string> = {
  'com.apple.safari': 'safari',
  'com.google.chrome': 'chrome',
  'org.mozilla.firefox': 'firefox',
  'com.brave.browser': 'brave',
  'com.microsoft.edgemac': 'edge',
  'org.chromium.chromium': 'chromium',
  'com.operasoftware.opera': 'opera',
  'com.vivaldi.vivaldi': 'vivaldi',
  'com.naver.whale': 'whale',
};

/** xdg-settings' desktop-file name, by prefix. */
const LINUX_DESKTOP: Array<[RegExp, string]> = [
  [/^firefox/i, 'firefox'], [/^google-chrome/i, 'chrome'], [/^chromium/i, 'chromium'],
  [/^brave/i, 'brave'], [/^microsoft-edge/i, 'edge'], [/^vivaldi/i, 'vivaldi'], [/^opera/i, 'opera'],
];
const LINUX_BIN: Record<string, string> = {
  firefox: 'firefox', chrome: 'google-chrome', chromium: 'chromium', brave: 'brave-browser',
  edge: 'microsoft-edge', vivaldi: 'vivaldi', opera: 'opera',
};

/** The https UserChoice ProgId, by prefix. */
const WIN_PROGID: Array<[RegExp, string]> = [
  [/^ChromeHTML/i, 'chrome'], [/^FirefoxURL/i, 'firefox'], [/^MSEdgeHTM/i, 'edge'],
  [/^BraveHTML/i, 'brave'], [/^VivaldiHTM/i, 'vivaldi'], [/^Opera/i, 'opera'], [/^ChromiumHTM/i, 'chromium'],
];
const WIN_EXE: Record<string, string> = {
  chrome: 'chrome', firefox: 'firefox', edge: 'msedge', brave: 'brave', vivaldi: 'vivaldi', opera: 'opera',
};

const MAC_LS_PLIST = 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist';

/**
 * The default browser's yt-dlp name, or null when it is one yt-dlp cannot
 * read or cannot be determined.
 */
export async function defaultBrowser(sys: BrowserSys = realSys): Promise<string | null> {
  try {
    if (sys.platform === 'darwin') {
      const plist = join(sys.home, MAC_LS_PLIST);
      // No LaunchServices override at all means the user never changed the
      // default, which on macOS is Safari.
      if (!existsSync(plist)) return 'safari';
      const r = await sys.exec('plutil', ['-convert', 'json', '-o', '-', plist], 10_000);
      if (r.code !== 0) return null;
      const handlers = (JSON.parse(r.stdout) as { LSHandlers?: Array<Record<string, unknown>> }).LSHandlers ?? [];
      const forScheme = (scheme: string) => handlers.find((h) => h['LSHandlerURLScheme'] === scheme);
      const h = forScheme('https') ?? forScheme('http');
      if (!h) return 'safari';
      const id = String(h['LSHandlerRoleAll'] ?? '').toLowerCase();
      return MAC_BUNDLES[id] ?? null;
    }
    if (sys.platform === 'linux') {
      const r = await sys.exec('xdg-settings', ['get', 'default-web-browser'], 10_000);
      const desktop = r.stdout.trim();
      return LINUX_DESKTOP.find(([re]) => re.test(desktop))?.[1] ?? null;
    }
    if (sys.platform === 'win32') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
      const r = await sys.exec('reg', ['query', key, '/v', 'ProgId'], 10_000);
      const progId = /ProgId\s+REG_SZ\s+(\S+)/i.exec(r.stdout)?.[1] ?? '';
      return WIN_PROGID.find(([re]) => re.test(progId))?.[1] ?? null;
    }
  } catch {
    // An unreadable preference is "unknown", never a failure of the call.
  }
  return null;
}

/** The browser a userCookies call reads from and opens, or null if none. */
export async function browserForCall(sys: BrowserSys = realSys): Promise<BrowserChoice | null> {
  const def = await defaultBrowser(sys);
  if (def) return { name: def, isDefault: true };
  const found = sys.detectBrowser();
  return found ? { name: found, isDefault: false } : null;
}

/** Opens `url` in that browser. True once the opener started. */
export async function openInBrowser(choice: BrowserChoice, url: string, sys: BrowserSys = realSys): Promise<boolean> {
  if (sys.platform === 'darwin') {
    const bundle = Object.entries(MAC_BUNDLES).find(([, n]) => n === choice.name)?.[0];
    return sys.launch('open', bundle ? ['-b', bundle, url] : [url]);
  }
  if (sys.platform === 'linux') {
    const bin = LINUX_BIN[choice.name];
    return choice.isDefault || !bin ? sys.launch('xdg-open', [url]) : sys.launch(bin, [url]);
  }
  if (sys.platform === 'win32') {
    const exe = WIN_EXE[choice.name];
    // '' is start's window-title argument; Node quotes it as "" on Windows.
    return sys.launch('cmd', ['/c', 'start', '', ...(choice.isDefault || !exe ? [] : [exe]), url]);
  }
  return false;
}

export type JarRead = { ok: true; jar: string } | { ok: false; error: string };

/**
 * The browser's whole cookie jar, in Netscape format.
 *
 * yt-dlp writes it to a file that does not exist yet, in a 0700 directory
 * removed before this returns. Not /dev/stdout: `--cookies FILE` is also
 * READ at startup when the file exists, and Node's stdout pipe is a socket,
 * so yt-dlp blocked reading its own output (a real hang, found by the test
 * against the real binary; a shell pipe hid it). The jar holds every session
 * the user has, so it is on disk only for the moment yt-dlp takes to exit.
 *
 * The error never carries yt-dlp's output: the jar can land there, and
 * stderr is reduced to the few causes a person can act on.
 */
export async function readBrowserJar(name: string, sys: BrowserSys = realSys): Promise<JarRead> {
  const label = browserLabel(name);
  const dir = mkdtempSync(join(tmpdir(), 'vem-browser-jar-'));
  const target = join(dir, 'cookies.txt');
  try {
    // 2 minutes: a Keychain prompt blocks yt-dlp until the user answers it.
    const r = await sys.exec('yt-dlp', [
      '--ignore-config', '--no-warnings', '--cookies-from-browser', name, '--cookies', target,
    ], 120_000);
    const jar = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (parseJar(jar).length > 0) return { ok: true, jar };
    if (/Extracted 0 cookies/.test(r.stdout + r.stderr)) return { ok: true, jar: '' };
    return { ok: false, error: jarReadError(label, r.stderr) };
  } catch {
    return { ok: false, error: 'yt-dlp could not be run to read browser cookies; is it installed?' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jarReadError(label: string, stderr: string): string {
  if (/Operation not permitted|PermissionError|Permission denied/i.test(stderr)) {
    return `The system refused access to ${label}'s cookies. On macOS, give the app running this `
      + 'server (the terminal, or the MCP client) Full Disk Access in System Settings > Privacy & Security.';
  }
  if (/could not find .*(cookie|profile)|no such file|does not exist/i.test(stderr)) {
    return `No cookie store was found for ${label}. It may never have been used on this account.`;
  }
  if (/keyring|keychain|decrypt|safe storage|password/i.test(stderr)) {
    return `${label}'s cookies could not be decrypted; the Keychain prompt was probably denied. `
      + 'Allowing it ("Always Allow" avoids repeats) lets the next attempt through.';
  }
  return `yt-dlp could not read ${label}'s cookies.`;
}

export interface JarCookie { domain: string; hostOnly: boolean; path: string; secure: boolean; expires: number; name: string; value: string; }

/** Netscape records, with yt-dlp's `#HttpOnly_` prefix understood. */
export function parseJar(jar: string): JarCookie[] {
  const out: JarCookie[] = [];
  for (const line of jar.split('\n')) {
    const bare = line.replace(/\r$/, '').replace(/^#HttpOnly_/, '');
    if (!bare || bare.startsWith('#')) continue;
    const f = bare.split('\t');
    if (f.length < 7) continue;
    const domain = f[0]!.toLowerCase();
    out.push({
      domain: domain.replace(/^\./, ''),
      hostOnly: !domain.startsWith('.') && f[1] !== 'TRUE',
      path: f[2] || '/',
      secure: f[3] === 'TRUE',
      expires: Number(f[4]) || 0,
      name: f[5]!,
      value: f.slice(6).join('\t'),
    });
  }
  return out;
}

/**
 * The cookies a browser would send with a request to `url` (RFC 6265 domain
 * and path matching, Secure only over https, expired ones dropped), longest
 * path first. Unrelated sites' cookies in the jar never make it out.
 */
export function cookiesFor(jar: JarCookie[], url: string, nowSec: number): JarCookie[] {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  return jar
    .filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`)))
    .filter((c) => u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
    .filter((c) => !c.secure || u.protocol === 'https:')
    .filter((c) => c.expires === 0 || c.expires > nowSec)
    .sort((a, b) => b.path.length - a.path.length);
}

/** A Cookie header value from those cookies; a repeated name keeps its first. */
export function cookieHeader(cookies: JarCookie[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of cookies) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join('; ');
}

/**
 * What to tell a caller whose request was refused with no cookies sent.
 * A question for the user, never an action: it reads their browser.
 * The Keychain warning is included because a prompt nobody predicted
 * looks like malware.
 */
export function userCookiesHint(choice: BrowserChoice | null, platform: NodeJS.Platform = process.platform): string {
  if (!choice) {
    return 'Signing in usually clears this, but no browser this server can read cookies from was found. '
      + 'VIDEO_EXTRACT_COOKIES_FILE can point at an exported cookie jar instead.';
  }
  const label = browserLabel(choice.name);
  const keychain = platform === 'darwin' && promptsForKeychain(choice.name)
    ? ` Reading ${label}'s cookies shows a macOS Keychain prompt the user must approve.`
    : '';
  return 'Signing in usually clears this. Ask the user whether to retry with userCookies: true -- '
    + `for that call only, it sends this site's cookies from their ${label}.${keychain}`;
}
