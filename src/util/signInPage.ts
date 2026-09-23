import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { openInBrowser, browserLabel, realSys, type BrowserChoice, type BrowserSys } from './browsers.js';

/**
 * The page a userCookies call opens when it needs the user to sign in.
 *
 * Opening the sign-in site directly was alarming in practice: a yuanbao.tencent.com
 * login appearing out of nowhere means nothing to someone who asked for a WeChat
 * video. A first, card-style version with buttons and explanations still "looked
 * like a scam" to its first real user. What it is now is the user's own design:
 * plain monospace text on an empty page, like a terminal, saying who is trying
 * to download what ("Claude Code" -- the MCP client's own name, which a phishing
 * page could not know), which site's cookies are missing, and the sign-in URL in
 * green. Two text controls: "I've signed in" (the only retry signal an arbitrary
 * site has) and "don't sign in", which ends the wait at once.
 *
 * Opened in the same browser the cookies are then read from (browserForCall), so
 * the user signs in exactly where the server looks.
 *
 * It holds no credential and never will: the cookies are read from the browser's
 * own store, never through this page. It is still a local web server, so:
 * - bound to 127.0.0.1, at a random port and an unguessable path;
 * - the Host header must be that exact address (a DNS-rebinding page cannot
 *   reach it under another name), and each POST also checks Origin;
 * - a strict Content-Security-Policy with no external resources at all;
 * - every value put in the page is escaped;
 * - unref'd, like the status endpoint, so it can never hold the process open,
 *   and closed LINGER_MS after the wait ends.
 */

export interface SignInSite {
  /** Whose cookies are needed, as a person would say it: "yuanbao.tencent.com", "youtube.com". */
  host: string;
  /** What is being downloaded from: "WeChat Channels", "YouTube". */
  platform: string;
  /** Where to sign in: the site's own sign-in page when known, else its home page. */
  signInUrl: string;
}

export type SignInOutcome = 'signed_in' | 'timed_out' | 'failed' | 'declined';

/** What the user pressed on the page. */
export type PagePress = 'signed_in' | 'declined';

export interface SignInHandle {
  /** Resolves on the user's next press on the page. Never rejects. */
  nudge(): Promise<PagePress>;
  /** Ends the wait on the page; `detail` is shown as-is (never a cookie). */
  finish(outcome: SignInOutcome, detail?: string): void;
}

/** What the caller tells the agent when the user pressed "Don't sign in". */
export const DECLINED_MESSAGE =
  'The user chose not to sign in: they pressed "Don\'t sign in" on the sign-in page. Do not retry '
  + 'with userCookies unless they ask you to.';

/**
 * How long a finished page keeps answering. The page asks every 2 seconds, so
 * this only has to outlast one poll; the tab itself stays open, since a page
 * may not close a tab it did not open, and says it has finished.
 */
const LINGER_MS = 15_000;

/** "youtube.com" for a video URL: what a person would call the site. */
export function siteHost(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  return host === 'youtu.be' ? 'youtube.com' : host;
}

/**
 * Platform names and sign-in pages for the sites people most often hit a
 * login wall on. Anything else falls back to its host and its home page --
 * the user's instruction was "the raw website url if we don't know".
 */
const KNOWN_SITES: Record<string, { platform: string; signInUrl: string }> = {
  'youtube.com': { platform: 'YouTube', signInUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F' },
  'instagram.com': { platform: 'Instagram', signInUrl: 'https://www.instagram.com/accounts/login/' },
  'tiktok.com': { platform: 'TikTok', signInUrl: 'https://www.tiktok.com/login' },
  'x.com': { platform: 'X', signInUrl: 'https://x.com/i/flow/login' },
  'twitter.com': { platform: 'X', signInUrl: 'https://x.com/i/flow/login' },
  'facebook.com': { platform: 'Facebook', signInUrl: 'https://www.facebook.com/login' },
  'twitch.tv': { platform: 'Twitch', signInUrl: 'https://www.twitch.tv/login' },
  'vimeo.com': { platform: 'Vimeo', signInUrl: 'https://vimeo.com/log_in' },
  'reddit.com': { platform: 'Reddit', signInUrl: 'https://www.reddit.com/login' },
  'bilibili.com': { platform: 'Bilibili', signInUrl: 'https://passport.bilibili.com/login' },
};

/** The sign-in page for a site yt-dlp was refused by. */
export function refusedSite(videoUrl: string): SignInSite {
  const host = siteHost(videoUrl);
  const known = KNOWN_SITES[host];
  return {
    host,
    platform: known?.platform ?? host,
    signInUrl: known?.signInUrl ?? `${new URL(videoUrl).protocol}//${new URL(videoUrl).host}/`,
  };
}

/**
 * WeChat Channels is resolved through Tencent Yuanbao, whose sign-in is a
 * dialog on its home page -- there is no sign-in URL of its own.
 */
export const YUANBAO_SITE: SignInSite = {
  host: 'yuanbao.tencent.com',
  platform: 'WeChat Channels',
  signInUrl: 'https://yuanbao.tencent.com/',
};

/**
 * The name to show for whoever asked, from the MCP client's own clientInfo.name.
 * Known clients get the name their users know; anything else plain-looking is
 * shown as sent (escaped on the page regardless), and the rest is just "Agent".
 */
export function requesterLabel(clientName: string | undefined): string {
  const n = (clientName ?? '').trim();
  const known: Array<[RegExp, string]> = [
    [/^claude[-_ ]?code/i, 'Claude Code'], [/^claude/i, 'Claude'], [/cursor/i, 'Cursor'],
    [/windsurf/i, 'Windsurf'], [/visual studio code|^vscode/i, 'VS Code'], [/codex/i, 'Codex'],
  ];
  const hit = known.find(([re]) => re.test(n));
  if (hit) return hit[1];
  return /^[\w .\-]{1,40}$/.test(n) ? n : 'Agent';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface PageState { outcome: SignInOutcome | 'waiting'; detail: string }

/**
 * Starts the page server. Null when it cannot listen, so the caller can fall
 * back to opening the sign-in site itself.
 */
export async function startSignInPage(p: {
  site: SignInSite; browserName: string; videoUrl: string; deadline: number; requester: string;
  now?: () => number;
}): Promise<{ url: string; handle: SignInHandle } | null> {
  const now = p.now ?? (() => Date.now());
  const token = randomBytes(16).toString('hex');
  const nonce = randomBytes(12).toString('base64');
  const state: PageState = { outcome: 'waiting', detail: '' };
  let waiters: Array<(press: PagePress) => void> = [];
  let port = 0;
  const sockets = new Set<Socket>();

  const press = (what: PagePress) => {
    const ready = waiters;
    waiters = [];
    for (const wake of ready) wake(what);
  };

  const srv = createServer((req, res) => {
    try {
      route(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  const route = (req: IncomingMessage, res: ServerResponse) => {
    const self = `127.0.0.1:${port}`;
    // DNS rebinding: a hostile page that points some name at 127.0.0.1 still
    // sends ITS name here. Only this exact address is served.
    if (req.headers.host !== self) { res.writeHead(421).end(); return; }
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === `/${token}`) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; `
          + `script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; `
          + "frame-ancestors 'none'",
      });
      res.end(renderPage(p.site, browserLabel(p.browserName), p.videoUrl, p.requester, nonce));
      return;
    }
    if (req.method === 'GET' && path === `/${token}/state`) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        outcome: state.outcome,
        detail: state.detail,
        secondsLeft: Math.max(0, Math.round((p.deadline - now()) / 1000)),
      }));
      return;
    }
    const action = req.method === 'POST' && path === `/${token}/done` ? 'signed_in'
      : req.method === 'POST' && path === `/${token}/decline` ? 'declined' : null;
    if (action) {
      // A cross-site form post would carry its own Origin; only this page's passes.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${self}`) { res.writeHead(403).end(); return; }
      press(action);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  };

  srv.on('connection', (socket) => {
    socket.unref();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const listening = await new Promise<boolean>((resolve) => {
    srv.once('error', () => resolve(false));
    srv.listen(0, '127.0.0.1', () => resolve(true));
  });
  if (!listening) return null;
  srv.on('error', () => { /* a later accept error must not throw */ });
  srv.unref();
  const addr = srv.address();
  port = addr && typeof addr === 'object' ? addr.port : 0;

  const close = () => {
    srv.close();
    for (const s of sockets) s.destroy();
  };
  const handle: SignInHandle = {
    nudge: () => new Promise<PagePress>((resolve) => { waiters.push(resolve); }),
    finish: (outcome, detail = '') => {
      if (state.outcome !== 'waiting') return;
      state.outcome = outcome;
      state.detail = detail;
      // Anything still waiting on a press is released; the wait is over.
      press('declined');
      setTimeout(close, LINGER_MS).unref();
    },
  };
  return { url: `http://127.0.0.1:${port}/${token}`, handle };
}

/**
 * Opens the sign-in page in the user's browser, or failing that the sign-in
 * site itself, and tries to post a macOS notification in case the browser
 * opens behind other windows. Null only when nothing could be opened at all.
 */
export async function presentSignIn(
  site: SignInSite, browser: BrowserChoice, videoUrl: string, deadline: number, requester: string,
  sys: BrowserSys = realSys,
): Promise<SignInHandle | null> {
  const page = await startSignInPage({ site, browserName: browser.name, videoUrl, deadline, requester });
  const opened = await openInBrowser(browser, page ? page.url : site.signInUrl, sys);
  if (!opened) {
    page?.handle.finish('failed');
    return null;
  }
  if (sys.platform === 'darwin') {
    const text = `${requester} needs you to sign in to ${site.host} in ${browserLabel(browser.name)}.`;
    void sys.launch('osascript', ['-e', `display notification ${JSON.stringify(text)} with title "video-extract"`]);
  }
  // Without the page there is nothing to press; the wait still polls.
  return page ? page.handle : { nudge: () => new Promise<PagePress>(() => {}), finish: () => {} };
}

function renderPage(site: SignInSite, browser: string, videoUrl: string, requester: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>video-extract: sign-in needed</title>
<style nonce="${nonce}">
  :root { --bg:#ffffff; --ink:#1d1d1d; --dim:#8a8a8a; --url:#1a8a2e; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1e1e1e; --ink:#e6e6e6; --dim:#8d8d8d; --url:#4fd06a; --bad:#ff6b5e; }
  }
  html, body { margin:0; background:var(--bg); color:var(--ink); }
  body { min-height:100vh; box-sizing:border-box; display:flex; align-items:center; justify-content:center;
    padding:24px 20px; font:14px/1.6 "SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Mono", Consolas, monospace; }
  main { max-width:104ch; min-width:0; overflow-wrap:anywhere; text-align:center; }
  /* A little smaller than the rest, and balanced, so a wrapped sentence splits
     into even lines instead of leaving one word on the last. */
  .msg { font-size:13px; text-wrap:balance; }
  .link { margin-bottom:4.8em; }
  #status { margin-bottom:0; }
  /* A blank line between every row, like separate lines of terminal output. */
  p { margin:0 0 1.6em; }
  p:last-child { margin-bottom:0; }
  a.url { color:var(--url); text-decoration:underline; text-underline-offset:3px; }
  /* Green brackets on hover, reserved in the layout so nothing shifts;
     inline-block keeps the link's underline off them. */
  a.url::before, a.url::after { display:inline-block; color:var(--url); visibility:hidden; }
  a.url::before { content:"[\\00a0"; }
  a.url::after { content:"\\00a0]"; }
  a.url:hover::before, a.url:hover::after, a.url:focus-visible::before, a.url:focus-visible::after { visibility:visible; }
  .dim { color:var(--dim); }
  .ok { color:var(--url); } .bad { color:var(--bad); }
  button { font:inherit; color:var(--dim); background:none; border:0; padding:0; cursor:pointer; }
  button:hover:not([disabled]) { color:var(--ink); }
  button[disabled] { cursor:default; opacity:.5; }
</style>
</head>
<body>
<main>
<p class="msg">${esc(requester)} is trying to download ${esc(videoUrl)} using your browser cookies.</p>
<p class="msg">Cookies for ${esc(site.host)}, required for the ${esc(site.platform)} download, were not found.</p>
<p class="msg">Please sign in to your desired account at:</p>
<p class="link"><a class="url" href="${esc(site.signInUrl)}" target="_blank" rel="noopener noreferrer">${esc(site.signInUrl)}</a></p>
<p class="dim" id="status">waiting for sign-in…</p>
<p class="dim"><button id="done" type="button">[I've signed in]</button>&nbsp;&nbsp;<button id="decline" type="button">[don't sign in]</button></p>
</main>
<script nonce="${nonce}">
  const base = location.pathname;
  const status = document.getElementById('status');
  const done = document.getElementById('done');
  const decline = document.getElementById('decline');
  let over = false;
  let checkingUntil = 0;
  const show = (text, cls) => { status.textContent = text; status.className = cls || 'dim'; };
  const end = () => { over = true; done.disabled = true; decline.disabled = true; };
  done.addEventListener('click', async () => {
    if (over) return;
    done.disabled = true;
    checkingUntil = Date.now() + 4000;
    show('checking…');
    try { await fetch(base + '/done', { method: 'POST' }); } catch {}
    setTimeout(() => { if (!over) done.disabled = false; }, 4000);
  });
  decline.addEventListener('click', async () => {
    if (over) return;
    end();
    show('stopping…');
    try { await fetch(base + '/decline', { method: 'POST' }); } catch {}
  });
  async function poll() {
    try {
      const s = await (await fetch(base + '/state', { cache: 'no-store' })).json();
      if (s.outcome === 'signed_in') { end(); show('signed in. you can close this tab.', 'ok'); }
      else if (s.outcome === 'declined') { end(); show('stopped. you can close this tab.'); }
      else if (s.outcome === 'timed_out') { end(); show('timed out. you can close this tab.', 'bad'); }
      else if (s.outcome === 'failed') { end(); show((s.detail || 'that did not work.') + ' you can close this tab.', 'bad'); }
      else if (Date.now() >= checkingUntil) {
        const m = Math.floor(s.secondsLeft / 60), sec = String(s.secondsLeft % 60).padStart(2, '0');
        show('waiting for sign-in… ' + m + ':' + sec + ' left');
      }
      if (over) return;
    } catch {
      if (!over) show('this page has finished. you can close this tab.');
      end();
      return;
    }
    setTimeout(poll, 2000);
  }
  poll();
</script>
</body>
</html>
`;
}
