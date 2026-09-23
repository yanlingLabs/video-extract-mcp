import { describe, it, expect } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startSignInPage, presentSignIn, refusedSite, siteHost, YUANBAO_SITE, requesterLabel, type SignInSite,
} from '../src/util/signInPage.js';
import type { BrowserSys } from '../src/util/browsers.js';

/** A raw request, so Host and Origin can be set to what an attacker would send. */
function call(url: string, opts: { method?: string; host?: string; origin?: string } = {}) {
  const u = new URL(url);
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: u.port, path: u.pathname, method: opts.method ?? 'GET',
      headers: { host: opts.host ?? u.host, ...(opts.origin ? { origin: opts.origin } : {}) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SITE: SignInSite = { host: 'example.com', platform: 'Ex<b>ample', signInUrl: 'https://example.com/login' };

describe('the sign-in page', () => {
  it('says which site, why, and which video -- all escaped, nothing loaded from elsewhere', async () => {
    const video = 'https://example.com/v?a=<script>alert(1)</script>&b="x"';
    const p = await startSignInPage({ site: SITE, browserName: 'safari', videoUrl: video, deadline: Date.now() + 60_000, requester: 'Claude <Code>' });
    if (!p) throw new Error('page did not start');
    const r = await call(p.url);
    expect(r.status).toBe(200);
    // Who asked, for which video, whose cookies are missing, and where to sign in.
    expect(r.body).toContain('Claude &#60;Code&#62; is trying to download https://example.com/v?a=&#60;script&#62;');
    expect(r.body).toContain('using your browser cookies.');
    expect(r.body).not.toContain('Claude <Code>');
    expect(r.body).toContain('Cookies for example.com, required for the Ex&#60;b&#62;ample download, were not found.');
    expect(r.body).toContain('Please sign in to your desired account at:');
    expect(r.body).toMatch(/<a class="url" href="https:\/\/example\.com\/login"[^>]*>https:\/\/example\.com\/login<\/a>/);
    // And a way out.
    expect(r.body).toContain("[don't sign in]");
    expect(r.body).not.toContain('<script>alert(1)');
    expect(r.body).toContain('href="https://example.com/login"');
    // The only external URLs on the page are the sign-in link and the video it names.
    const external = [...r.body.matchAll(/https?:\/\/[^"'\s<]+/g)].map((m) => m[0]);
    expect(external.every((u) => u.startsWith('https://example.com/'))).toBe(true);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    p.handle.finish('failed');
  });

  it('answers only at its own address and path', async () => {
    const p = await startSignInPage({ site: SITE, browserName: 'safari', videoUrl: 'https://example.com/v', deadline: Date.now() + 60_000, requester: 'Claude Code' });
    if (!p) throw new Error('page did not start');
    // A DNS-rebinding page reaches the same socket under its own name.
    expect((await call(p.url, { host: 'evil.example:80' })).status).toBe(421);
    expect((await call(p.url.replace(/\/[0-9a-f]{32}$/, '/0123'))).status).toBe(404);
    expect(new URL(p.url).hostname).toBe('127.0.0.1');
    p.handle.finish('failed');
  });

  it('reports the wait and its end to the page', async () => {
    const p = await startSignInPage({ site: SITE, browserName: 'safari', videoUrl: 'https://example.com/v', deadline: Date.now() + 90_000, requester: 'Claude Code' });
    if (!p) throw new Error('page did not start');
    const before = JSON.parse((await call(`${p.url}/state`)).body) as { outcome: string; secondsLeft: number };
    expect(before.outcome).toBe('waiting');
    expect(before.secondsLeft).toBeGreaterThan(80);
    p.handle.finish('signed_in');
    const after = JSON.parse((await call(`${p.url}/state`)).body) as { outcome: string };
    expect(after.outcome).toBe('signed_in');
    // First outcome wins: a later one cannot overwrite what the page already showed.
    p.handle.finish('timed_out');
    expect((JSON.parse((await call(`${p.url}/state`)).body) as { outcome: string }).outcome).toBe('signed_in');
  });

  it('"I\'ve signed in" wakes the wait, but a post from another site does not', async () => {
    const p = await startSignInPage({ site: SITE, browserName: 'safari', videoUrl: 'https://example.com/v', deadline: Date.now() + 60_000, requester: 'Claude Code' });
    if (!p) throw new Error('page did not start');
    let woke: string | null = null;
    void p.handle.nudge().then((press) => { woke = press; });
    expect((await call(`${p.url}/done`, { method: 'POST', origin: 'https://evil.example' })).status).toBe(403);
    await new Promise((r) => setTimeout(r, 20));
    expect(woke).toBeNull();
    expect((await call(`${p.url}/done`, { method: 'POST', origin: new URL(p.url).origin })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(woke).toBe('signed_in');
    p.handle.finish('failed');
  });

  it('"Don\'t sign in" reports a decline, and the page shows it once finished', async () => {
    const p = await startSignInPage({ site: SITE, browserName: 'safari', videoUrl: 'https://example.com/v', deadline: Date.now() + 60_000, requester: 'Claude Code' });
    if (!p) throw new Error('page did not start');
    const pressed = p.handle.nudge();
    expect((await call(`${p.url}/decline`, { method: 'POST', origin: new URL(p.url).origin })).status).toBe(204);
    expect(await pressed).toBe('declined');
    p.handle.finish('declined');
    expect((JSON.parse((await call(`${p.url}/state`)).body) as { outcome: string }).outcome).toBe('declined');
  });

  it('finishing releases anything still waiting on the button', async () => {
    const p = await startSignInPage({ site: SITE, browserName: 'safari', videoUrl: 'https://example.com/v', deadline: Date.now() + 60_000, requester: 'Claude Code' });
    if (!p) throw new Error('page did not start');
    const waiting = p.handle.nudge();
    p.handle.finish('timed_out');
    await expect(waiting).resolves.toBe('declined');
  });
});

describe('presentSignIn', () => {
  const fakeSys = (opens: boolean) => {
    const launched: string[][] = [];
    const sys: BrowserSys = {
      platform: 'darwin', home: mkdtempSync(join(tmpdir(), 'vem-sph-')),
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      launch: async (cmd, args) => { launched.push([cmd, ...args]); return cmd === 'osascript' || opens; },
      detectBrowser: () => null,
    };
    return { sys, launched };
  };

  it('opens the local page, not the sign-in site, in the chosen browser, and asks osascript for a notification', async () => {
    const { sys, launched } = fakeSys(true);
    const h = await presentSignIn(YUANBAO_SITE, { name: 'safari', isDefault: true }, 'https://weixin.qq.com/sph/x', Date.now() + 60_000, 'Claude Code', sys);
    expect(h).not.toBeNull();
    expect(launched[0]!.slice(0, 3)).toEqual(['open', '-b', 'com.apple.safari']);
    expect(launched[0]![3]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect(launched[1]![0]).toBe('osascript');
    expect(launched[1]!.join(' ')).toContain('Claude Code needs you to sign in to yuanbao.tencent.com in Safari');
    // The page it opened is live and says why yuanbao.
    const page = await call(launched[0]![3]!);
    expect(page.body).toContain('Claude Code is trying to download https://weixin.qq.com/sph/x using your browser cookies.');
    expect(page.body).toContain('Cookies for yuanbao.tencent.com, required for the WeChat Channels download, were not found.');
    h!.finish('failed');
  });

  it('is null when the browser cannot be opened', async () => {
    const { sys } = fakeSys(false);
    expect(await presentSignIn(SITE, { name: 'safari', isDefault: true }, 'https://example.com/v', Date.now() + 60_000, 'Claude Code', sys)).toBeNull();
  });
});

describe('naming who asked', () => {
  it('uses the name the user knows for known clients, and something safe otherwise', () => {
    expect(requesterLabel('claude-code')).toBe('Claude Code');
    expect(requesterLabel('claude-ai')).toBe('Claude');
    expect(requesterLabel('cursor-vscode')).toBe('Cursor');
    expect(requesterLabel('my-agent 2.0')).toBe('my-agent 2.0');
    expect(requesterLabel('Claude Code')).toBe('Claude Code');
    expect(requesterLabel('<script>')).toBe('Agent');
    expect(requesterLabel(undefined)).toBe('Agent');
  });
});

describe('naming the site', () => {
  it('uses the name a person would', () => {
    expect(siteHost('https://www.youtube.com/watch?v=x')).toBe('youtube.com');
    expect(siteHost('https://youtu.be/x')).toBe('youtube.com');
    expect(siteHost('https://m.facebook.com/reel/1')).toBe('facebook.com');
    expect(siteHost('https://www.instagram.com/reel/1')).toBe('instagram.com');
  });

  it("points at the site's own sign-in page when it is known", () => {
    expect(refusedSite('https://www.instagram.com/reel/1')).toEqual({
      host: 'instagram.com', platform: 'Instagram', signInUrl: 'https://www.instagram.com/accounts/login/',
    });
    expect(refusedSite('https://youtu.be/abc').platform).toBe('YouTube');
  });

  it('falls back to the site itself when it is not', () => {
    expect(refusedSite('https://videos.example.org/watch/9')).toEqual({
      host: 'videos.example.org', platform: 'videos.example.org', signInUrl: 'https://videos.example.org/',
    });
  });
});
