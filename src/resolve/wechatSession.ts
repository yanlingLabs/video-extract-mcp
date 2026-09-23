import type { CookieUse, ResolveFailure, ResolveStatus } from '../types.js';
import {
  browserForCall, readBrowserJar, parseJar, cookiesFor, cookieHeader,
  browserLabel, promptsForKeychain, realSys, type BrowserChoice, type BrowserSys,
} from '../util/browsers.js';
import {
  presentSignIn, YUANBAO_SITE, DECLINED_MESSAGE, type SignInHandle, type SignInSite,
} from '../util/signInPage.js';
import { statusCallbacks } from '../status/context.js';

/**
 * Where a WeChat resolve gets its yuanbao.tencent.com session.
 *
 * Without userCookies: VIDEO_EXTRACT_WECHAT_COOKIE only, exactly as before --
 * the operator's standing configuration. With it, for that call: the
 * configured cookie if it still works, else the session this process last
 * obtained from the browser, else the browser's own cookie store, else a
 * sign-in page opened in that browser (src/util/signInPage.ts: a local page
 * saying why yuanbao, with a button to it) and the store polled until a
 * session appears or the wait runs out.
 *
 * ## Which cookie is "the right one"
 *
 * Whatever getuserinfo accepts. Every candidate goes through it before use,
 * and a 200 there also RENEWS the session: the response sets a fresh
 * `hy_token` whenever the one sent is old enough (measured: a weeks-old
 * configured cookie got a new 684-character token on every probe; a fresh
 * browser one got none). Earlier versions threw that renewal away, which is
 * the likeliest reason a pasted cookie "resets often" -- so the renewed
 * header is what the rest of the resolve uses, and what gets remembered.
 *
 * Measured on a real session: hy_token and hy_user are both required
 * (hy_token alone is 401); hy_source and the analytics cookies are not.
 * Everything the browser would send to getuserinfo is sent anyway, rather
 * than a hand-picked subset that would break on a rename.
 *
 * ## Permission is per call
 *
 * What this process remembers is the SESSION, so a second call does not
 * re-read the browser or re-prompt the Keychain. Permission is not
 * remembered: a call without userCookies never looks at that session.
 * Nothing here is ever written to disk, and no message ever carries a
 * cookie value.
 */

export const YUANBAO_HOME = 'https://yuanbao.tencent.com/';
export const USER_INFO_URL = 'https://yuanbao.tencent.com/api/getuserinfo';
export const SIGN_IN_WAIT_MS = 3 * 60_000;

/** A session header and where it came from. */
export interface Credential { header: string; origin: CookieUse }

/** getuserinfo's verdict. 'valid' carries the header with any renewal applied. */
export type SessionCheck =
  | { state: 'valid'; header: string }
  | { state: 'invalid' }
  | { state: 'unknown'; error: string };

export interface SessionDeps {
  envCookie(): string | null;
  check(header: string): Promise<SessionCheck>;
  sys: BrowserSys;
  now(): number;
  sleep(ms: number): Promise<void>;
  signInWaitMs: number;
  /** Puts the sign-in page in front of the user; null when nothing could be opened. */
  presentSignIn(
    site: SignInSite, browser: BrowserChoice, videoUrl: string, deadline: number, requester: string,
  ): Promise<SignInHandle | null>;
}

export type Acquired = { ok: true; cred: Credential } | { ok: false; failure: ResolveFailure };

const ASK_USER =
  'Ask the user whether to retry with userCookies: true -- for that call only, it uses their '
  + 'yuanbao.tencent.com session from their browser, opening the site there for them to sign in '
  + 'if there is none.';

// C0 controls and DEL cannot appear in a header value, and Node's fetch
// echoes an offending value into its error message (see wechat.ts callApi).
const INVALID_HEADER_VALUE_RE = /[\x00-\x08\x0A-\x1F\x7F]/;

function fail(status: Exclude<ResolveStatus, 'ok'>, cookies: CookieUse, message: string): Acquired {
  return { ok: false, failure: { status, resolvedBy: 'wechat', message, cookies } };
}

/**
 * The header with a response's Set-Cookie renewals applied. Deletions are
 * ignored on purpose: getuserinfo deletes the old host-only copy of each
 * cookie and sets a domain-wide one of the same name in the same response,
 * and a name-keyed header must keep the value, not drop it.
 */
export function applyRenewal(header: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const sc of setCookies) {
    const [pair = '', ...attrs] = sc.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const deletes = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a));
    if (!value || deletes || INVALID_HEADER_VALUE_RE.test(value)) continue;
    jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

type BrowserTry =
  | { kind: 'valid'; header: string }
  | { kind: 'unknown'; header: string }
  | { kind: 'invalid'; header: string }
  | { kind: 'missing' }
  | { kind: 'error'; error: string };

export class WeChatSession {
  private remembered: Credential | null = null;
  private inFlight: Promise<Acquired> | null = null;
  /** Every item waiting on inFlight, so each one's status shows the sign-in. */
  private readonly waiting = new Set<(stage: string) => void>();
  private signInOpen = false;

  constructor(private readonly deps: SessionDeps) {}

  /** Whether a cookie is configured -- a free check, no request. */
  hasConfigured(): boolean {
    return this.deps.envCookie() !== null;
  }

  /** Drops the remembered session, after yuanbao rejected it mid-resolve. */
  forget(header: string): void {
    if (this.remembered?.header === header) this.remembered = null;
  }

  /** `page` is only shown on the sign-in page, so the user sees what asked and who. */
  async acquire(
    userCookies: boolean, page: { videoUrl?: string; requester?: string } = {},
  ): Promise<Acquired> {
    const env = this.deps.envCookie();
    if (env) {
      const c = await this.deps.check(env);
      if (c.state === 'valid') return { ok: true, cred: { header: c.header, origin: 'wechat_cookie' } };
      // A probe that could not reach yuanbao is not a verdict on the cookie;
      // the resolve calls that follow will say what is actually wrong.
      if (c.state === 'unknown') return { ok: true, cred: { header: env, origin: 'wechat_cookie' } };
      if (!userCookies) {
        return fail('auth_expired', 'wechat_cookie',
          `yuanbao rejected the session in VIDEO_EXTRACT_WECHAT_COOKIE; it has expired. ${ASK_USER}`);
      }
    } else if (!userCookies) {
      return fail('auth_required', 'none',
        `WeChat Channels needs a signed-in yuanbao.tencent.com session, and none is configured. ${ASK_USER}`);
    }

    if (this.remembered) {
      const c = await this.deps.check(this.remembered.header);
      if (c.state === 'valid') {
        this.remembered = { ...this.remembered, header: c.header };
        return { ok: true, cred: this.remembered };
      }
      if (c.state === 'unknown') return { ok: true, cred: this.remembered };
      this.remembered = null;
    }

    const browser = await browserForCall(this.deps.sys);
    if (!browser) {
      return fail('auth_required', 'none',
        'userCookies was set, but no browser this server can read cookies from was found '
        + '(Safari, Chrome, Firefox, Edge, Brave, Chromium, Opera, Vivaldi). Setting '
        + 'VIDEO_EXTRACT_WECHAT_COOKIE is the alternative.');
    }
    // One browser read, and at most one sign-in page, however many items of
    // a batch arrive here together: they all wait on the same attempt.
    const onStage = statusCallbacks()?.onStage;
    if (onStage) this.waiting.add(onStage);
    if (this.signInOpen) onStage?.('waiting_for_sign_in');
    this.inFlight ??= this.fromBrowser(
      browser, page.videoUrl ?? YUANBAO_HOME, page.requester ?? 'Agent',
    ).finally(() => {
      this.inFlight = null;
      this.signInOpen = false;
    });
    try {
      return await this.inFlight;
    } finally {
      if (onStage) this.waiting.delete(onStage);
    }
  }

  private async fromBrowser(b: BrowserChoice, videoUrl: string, requester: string): Promise<Acquired> {
    const origin: CookieUse = `browser:${b.name}`;
    const label = browserLabel(b.name);
    const keep = (header: string): Acquired => {
      this.remembered = { header, origin };
      return { ok: true, cred: this.remembered };
    };

    const first = await this.tryBrowser(b, null);
    if (first.kind === 'valid') return keep(first.header);
    if (first.kind === 'unknown') return { ok: true, cred: { header: first.header, origin } };
    // A store the server may not read will not become readable by waiting.
    if (first.kind === 'error') return fail('auth_required', 'none', first.error);

    const deadline = this.deps.now() + this.deps.signInWaitMs;
    const page = await this.deps.presentSignIn(YUANBAO_SITE, b, videoUrl, deadline, requester);
    if (!page) {
      return fail('auth_required', 'none',
        `${label} has no signed-in yuanbao.tencent.com session, and could not be opened for signing in. `
        + `Ask the user to sign in at ${YUANBAO_HOME} in ${label}, then retry with userCookies: true.`);
    }
    this.signInOpen = true;
    for (const onStage of this.waiting) onStage('waiting_for_sign_in');

    // Chrome-family reads can each raise a Keychain prompt, and Chrome only
    // writes new cookies to disk about every 30 seconds anyway. The page's
    // "I've signed in" button cuts a wait short.
    const interval = promptsForKeychain(b.name) ? 15_000 : 5_000;
    // A header getuserinfo already refused is not sent again until it changes.
    let refused = first.kind === 'invalid' ? first.header : null;
    while (this.deps.now() < deadline) {
      const woke = await Promise.race([
        this.deps.sleep(Math.min(interval, Math.max(0, deadline - this.deps.now()))).then(() => 'tick' as const),
        page.nudge(),
      ]);
      if (woke === 'declined') {
        page.finish('declined');
        return fail('auth_required', 'none', DECLINED_MESSAGE);
      }
      const t = await this.tryBrowser(b, refused);
      if (t.kind === 'valid') {
        page.finish('signed_in');
        return keep(t.header);
      }
      if (t.kind === 'error') {
        page.finish('failed', t.error);
        return fail('auth_required', 'none', t.error);
      }
      if (t.kind === 'invalid') refused = t.header;
    }
    page.finish('timed_out');
    const minutes = Math.round(this.deps.signInWaitMs / 60_000);
    return fail('auth_required', 'none',
      `A page in ${label} asked the user to sign in to yuanbao.tencent.com, but no signed-in session `
      + `appeared within ${minutes} minute${minutes === 1 ? '' : 's'}. Ask the user to finish signing in `
      + 'there (the WeChat QR code, or a phone number), then retry with userCookies: true.');
  }

  private async tryBrowser(b: BrowserChoice, refused: string | null): Promise<BrowserTry> {
    const read = await readBrowserJar(b.name, this.deps.sys);
    if (!read.ok) return { kind: 'error', error: read.error };
    const nowSec = Math.floor(this.deps.now() / 1000);
    const usable = cookiesFor(parseJar(read.jar), USER_INFO_URL, nowSec)
      .filter((c) => !INVALID_HEADER_VALUE_RE.test(c.value));
    if (usable.length === 0) return { kind: 'missing' };
    const header = cookieHeader(usable);
    if (header === refused) return { kind: 'invalid', header };
    const c = await this.deps.check(header);
    if (c.state === 'valid') return { kind: 'valid', header: c.header };
    if (c.state === 'unknown') return { kind: 'unknown', header };
    return { kind: 'invalid', header };
  }
}

export function defaultSessionDeps(check: SessionDeps['check'], envCookie: SessionDeps['envCookie']): SessionDeps {
  return {
    envCookie,
    check,
    sys: realSys,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    signInWaitMs: SIGN_IN_WAIT_MS,
    presentSignIn: (site, browser, videoUrl, deadline, requester) =>
      presentSignIn(site, browser, videoUrl, deadline, requester, realSys),
  };
}
