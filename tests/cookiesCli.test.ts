import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeJar, runCookiesCli } from '../src/util/cookiesCli.js';

const NOW = 1_800_000_000_000;          // fixed clock: no wall-time flake
const SEC = (msFromNow: number): number => Math.floor((NOW + msFromNow) / 1000);
const DAY = 86_400_000;

function jar(lines: string[]): string {
  const p = join(mkdtempSync(join(tmpdir(), 'vem-ckcli-')), 'cookies.txt');
  writeFileSync(p, ['# Netscape HTTP Cookie File', ...lines].join('\n') + '\n');
  return p;
}
const line = (domain: string, expiry: number, name: string, value = 'SUPERSECRETVALUE'): string =>
  `${domain}\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${value}`;

/** Captures output lines the way the CLI's own `out` callback receives them. */
function run(env: NodeJS.ProcessEnv, argv: string[] = []): { code: number; text: string } {
  const lines: string[] = [];
  const code = runCookiesCli(argv, (l) => lines.push(l), env, NOW);
  return { code, text: lines.join('\n') };
}

describe('summarizeJar', () => {
  it('groups by domain and counts cookies', () => {
    const s = summarizeJar([
      line('.youtube.com', SEC(10 * DAY), 'SID'),
      line('.youtube.com', SEC(20 * DAY), 'HSID'),
      line('.x.com', SEC(5 * DAY), 'auth_token'),
    ].join('\n'));
    expect(s.total).toBe(3);
    expect(s.domains.map((d) => [d.domain, d.cookies])).toEqual([['.youtube.com', 2], ['.x.com', 1]]);
  });

  it('reports the SOONEST expiry per domain, since that is what expires first', () => {
    const s = summarizeJar([
      line('.youtube.com', SEC(30 * DAY), 'SID'),
      line('.youtube.com', SEC(2 * DAY), 'HSID'),
    ].join('\n'));
    expect(s.domains[0]!.soonestExpiry).toBe((NOW + 2 * DAY) - ((NOW + 2 * DAY) % 1000));
  });

  it('treats #HttpOnly_ as a RECORD, not a comment', () => {
    // Chrome-family exports mark http-only cookies this way, and those are
    // exactly the session cookies that matter. Skipping them as comments
    // would report an empty jar for a perfectly good export.
    const s = summarizeJar(`#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t${SEC(DAY)}\tsessionid\tv`);
    expect(s.total).toBe(1);
    expect(s.domains[0]!.domain).toBe('.instagram.com');
  });

  it('skips real comments and blank lines without counting them as malformed', () => {
    const s = summarizeJar(['# Netscape HTTP Cookie File', '', '# a note', line('.a.com', SEC(DAY), 'x')].join('\n'));
    expect(s.total).toBe(1);
    expect(s.malformed).toBe(0);
  });

  it('counts unparseable lines rather than silently dropping them', () => {
    const s = summarizeJar(['not a cookie line', 'also\tnot\tone', line('.a.com', SEC(DAY), 'x')].join('\n'));
    expect(s.total).toBe(1);
    expect(s.malformed).toBe(2);
  });

  it('treats expiry 0 as a session cookie, not as 1970', () => {
    // A session cookie has no expiry; reporting it as "EXPIRED 55 years ago"
    // would send someone re-exporting a jar that is actually fine.
    const s = summarizeJar(line('.a.com', 0, 'tmp'));
    expect(s.domains[0]!.sessionCookies).toBe(1);
    expect(s.domains[0]!.soonestExpiry).toBeNull();
  });
});

describe('video-extract cookies', () => {
  it('NEVER prints a cookie value', () => {
    // The single property that matters most: this command exists to be run
    // and pasted into an issue.
    const p = jar([line('.youtube.com', SEC(10 * DAY), 'SID', 'SUPERSECRETVALUE')]);
    const plain = run({ VIDEO_EXTRACT_COOKIES_FILE: p });
    const asJson = run({ VIDEO_EXTRACT_COOKIES_FILE: p }, ['--json']);
    expect(plain.text).not.toContain('SUPERSECRETVALUE');
    expect(asJson.text).not.toContain('SUPERSECRETVALUE');
    // Names are not printed either -- they are not needed to answer
    // "does this jar cover the site I want, and is it current?"
    expect(plain.text).not.toContain('SID');
  });

  it('reports domains and expiry for a healthy jar, exit 0', () => {
    const p = jar([
      line('.youtube.com', SEC(23 * DAY), 'SID'),
      line('.instagram.com', SEC(3 * DAY), 'sessionid'),
    ]);
    const r = run({ VIDEO_EXTRACT_COOKIES_FILE: p });
    expect(r.code).toBe(0);
    expect(r.text).toContain('.youtube.com');
    expect(r.text).toContain('expires in 23 days');
    expect(r.text).toContain('.instagram.com');
    expect(r.text).toContain('2 domain(s), 2 cookies');
  });

  it('says EXPIRED for a jar that has gone stale, and counts it', () => {
    const p = jar([line('.youtube.com', SEC(-5 * DAY), 'SID')]);
    const r = run({ VIDEO_EXTRACT_COOKIES_FILE: p });
    expect(r.text).toContain('EXPIRED 5 days ago');
    expect(r.text).toContain('1 with expired cookies');
  });

  it('names the JSON-export mistake specifically, exit 1', () => {
    // "0 cookies" alone sends people looking at their login. The actual
    // cause is almost always an exporter set to JSON.
    const p = join(mkdtempSync(join(tmpdir(), 'vem-ckjson-')), 'cookies.txt');
    writeFileSync(p, '[{"domain":".youtube.com","name":"SID","value":"x"}]');
    const r = run({ VIDEO_EXTRACT_COOKIES_FILE: p });
    expect(r.code).toBe(1);
    expect(r.text).toContain('NO COOKIES FOUND');
    expect(r.text).toMatch(/looks like JSON/i);
    expect(r.text).toMatch(/Netscape/);
  });

  it('surfaces a bad path as a configuration error, exit 1', () => {
    const r = run({ VIDEO_EXTRACT_COOKIES_FILE: '/nope/does-not-exist.txt' });
    expect(r.code).toBe(1);
    expect(r.text).toContain('VIDEO_EXTRACT_COOKIES_FILE');
    expect(r.text).toContain('/nope/does-not-exist.txt');
  });

  it('explains how to configure when nothing is set, exit 0', () => {
    // Unconfigured is a valid state, not a failure: public media needs none.
    const r = run({});
    expect(r.code).toBe(0);
    expect(r.text).toContain('no cookie source configured');
    expect(r.text).toContain('VIDEO_EXTRACT_COOKIES_FILE');
    expect(r.text).toMatch(/Public media does not need/i);
  });

  it('reports a browser source honestly, without decrypting anything', () => {
    const r = run({ VIDEO_EXTRACT_COOKIES_FROM_BROWSER: 'firefox' });
    expect(r.code).toBe(0);
    expect(r.text).toContain('firefox');
    // Must not imply it inspected a store it deliberately did not read.
    expect(r.text).toMatch(/nothing on disk to inspect|read by yt-dlp at request time/);
  });

  it('emits machine-readable JSON with --json', () => {
    const p = jar([line('.youtube.com', SEC(10 * DAY), 'SID')]);
    const r = run({ VIDEO_EXTRACT_COOKIES_FILE: p }, ['--json']);
    const d = JSON.parse(r.text) as {
      configured: boolean; kind: string; total: number;
      domains: Array<{ domain: string; cookies: number; expired: boolean; soonestExpiry: string }>;
    };
    expect(d.configured).toBe(true);
    expect(d.kind).toBe('file');
    expect(d.total).toBe(1);
    expect(d.domains[0]!.domain).toBe('.youtube.com');
    expect(d.domains[0]!.expired).toBe(false);
    expect(new Date(d.domains[0]!.soonestExpiry).getTime()).toBeGreaterThan(NOW);
  });

  it('carries no verdict words, matching the status channel\'s rule', () => {
    // Same discipline as /status: observations, never judgments. The reader
    // decides whether a jar covering only youtube.com is what they wanted.
    const p = jar([line('.youtube.com', SEC(10 * DAY), 'SID')]);
    const r = run({ VIDEO_EXTRACT_COOKIES_FILE: p });
    for (const verdict of ['healthy', 'stale', 'stuck', 'looks good', 'working', 'valid']) {
      expect(r.text.toLowerCase()).not.toContain(verdict);
    }
  });
});
