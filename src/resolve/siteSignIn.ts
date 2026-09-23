import {
  readBrowserJar, parseJar, cookiesFor, promptsForKeychain, realSys, type BrowserChoice, type BrowserSys,
} from '../util/browsers.js';
import { presentSignIn, refusedSite, type SignInHandle, type SignInSite } from '../util/signInPage.js';
export { DECLINED_MESSAGE } from '../util/signInPage.js';
import { statusCallbacks } from '../status/context.js';

/**
 * The sign-in wait for a site yt-dlp was refused by, even with the user's
 * browser cookies (a userCookies call only).
 *
 * WeChat has an exact, cheap test for "signed in" (getuserinfo), so its wait
 * just polls that. A yt-dlp site has none, and the only real test -- running
 * the extraction again -- is a request to the platform, and repeated requests
 * are what provoke rate limiting. So a retry is spent only on a signal that
 * the user has signed in, never on a timer:
 * - the page's "I've signed in" button, or
 * - a cookie NAME for that site appearing in the browser that was not there
 *   before. Signing in adds session cookies (YouTube's SID family,
 *   Instagram's sessionid, X's auth_token); value churn alone does not count,
 *   because sites rotate analytics and session values constantly while a tab
 *   is open.
 * At most MAX_RETRIES, at least MIN_RETRY_GAP_MS apart for the cookie signal.
 */

export const SIGN_IN_WAIT_MS = 3 * 60_000;
export const MAX_RETRIES = 3;
export const MIN_RETRY_GAP_MS = 10_000;

export interface SiteSignInDeps {
  sys: BrowserSys;
  now(): number;
  sleep(ms: number): Promise<void>;
  waitMs: number;
  present(
    site: SignInSite, browser: BrowserChoice, videoUrl: string, deadline: number, requester: string,
  ): Promise<SignInHandle | null>;
}

export const realSiteSignInDeps: SiteSignInDeps = {
  sys: realSys,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  waitMs: SIGN_IN_WAIT_MS,
  present: (site, browser, videoUrl, deadline, requester) =>
    presentSignIn(site, browser, videoUrl, deadline, requester, realSys),
};

/** What one retry came back as. */
export type RetryVerdict = 'ok' | 'refused' | 'other';

export type SiteSignInOutcome =
  /** A retry succeeded; `last` is its result. */
  | 'signed_in'
  /** A retry failed some other way; `last` says how. */
  | 'other'
  /** Still refused after MAX_RETRIES signed-in attempts. */
  | 'gave_up'
  | 'timed_out'
  /** Nothing could be opened in the browser. */
  | 'not_opened'
  /** The user pressed "Don't sign in". */
  | 'declined';

export async function waitForSiteSignIn<R>(p: {
  videoUrl: string;
  browser: BrowserChoice;
  retry: () => Promise<R>;
  verdict: (r: R) => RetryVerdict;
  /** Named on the page: "Claude Code". */
  requester?: string;
  deps?: SiteSignInDeps;
}): Promise<{ outcome: SiteSignInOutcome; last: R | null; retries: number }> {
  const d = p.deps ?? realSiteSignInDeps;
  const site = refusedSite(p.videoUrl);

  // The names only -- which cookies exist for this site, never their values.
  const names = async (): Promise<Set<string> | null> => {
    const read = await readBrowserJar(p.browser.name, d.sys);
    if (!read.ok) return null;
    const nowSec = Math.floor(d.now() / 1000);
    return new Set(cookiesFor(parseJar(read.jar), p.videoUrl, nowSec).map((c) => c.name));
  };

  let baseline = await names();
  const deadline = d.now() + d.waitMs;
  const page = await d.present(site, p.browser, p.videoUrl, deadline, p.requester ?? 'Agent');
  if (!page) return { outcome: 'not_opened', last: null, retries: 0 };
  statusCallbacks()?.onStage?.('waiting_for_sign_in');

  const interval = promptsForKeychain(p.browser.name) ? 15_000 : 5_000;
  let retries = 0;
  let lastRetryAt = -Infinity;
  let last: R | null = null;
  while (d.now() < deadline) {
    const woke = await Promise.race([
      d.sleep(Math.min(interval, Math.max(0, deadline - d.now()))).then(() => 'tick' as const),
      page.nudge(),
    ]);
    if (woke === 'declined') {
      page.finish('declined');
      return { outcome: 'declined', last, retries };
    }
    let go = woke === 'signed_in';
    if (!go) {
      const now = await names();
      if (now && !baseline) baseline = now;
      go = !!now && !!baseline && [...now].some((n) => !baseline!.has(n))
        && d.now() - lastRetryAt >= MIN_RETRY_GAP_MS;
    }
    if (!go) continue;

    last = await p.retry();
    retries++;
    lastRetryAt = d.now();
    const v = p.verdict(last);
    if (v === 'ok') {
      page.finish('signed_in');
      return { outcome: 'signed_in', last, retries };
    }
    if (v === 'other') {
      page.finish('failed', `${site.host} answered, but the video still could not be fetched. `
        + 'Your assistant has the details.');
      return { outcome: 'other', last, retries };
    }
    if (retries >= MAX_RETRIES) {
      page.finish('failed', `${site.host} still refused the video after you signed in. This account `
        + 'may not have access to it.');
      return { outcome: 'gave_up', last, retries };
    }
    // Still refused: a further retry needs a further signal.
    baseline = (await names()) ?? baseline;
  }
  page.finish('timed_out');
  return { outcome: 'timed_out', last, retries };
}
