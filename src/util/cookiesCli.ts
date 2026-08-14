import { readFileSync } from 'node:fs';
import { cookieSourceFromEnv, CookieConfigError, type CookieSource } from './cookies.js';

/**
 * `video-extract cookies` -- answers "is my cookie setup actually working?"
 * without ever printing a cookie's value.
 *
 * It exists because the failure it diagnoses is silent. An export that saved
 * the wrong format, or covers the wrong site, or expired last week, does not
 * announce itself: the next analyze_video simply comes back `auth_required`
 * or `rate_limited`, pointing at the video rather than at the jar. That is the
 * same silent-misconfiguration class the rest of this project keeps killing.
 *
 * Reports observations only -- domains, counts, expiry times -- and never a
 * verdict like "working" or "healthy". Whether a jar covering only
 * .youtube.com is correct depends on what the caller wanted from it, which
 * this command cannot know.
 */

export interface DomainSummary {
  domain: string;
  cookies: number;
  /** Soonest expiry among this domain's cookies, ms since epoch. */
  soonestExpiry: number | null;
  /** Cookies with no expiry: valid until the browser session ends. */
  sessionCookies: number;
}

export interface JarSummary {
  domains: DomainSummary[];
  total: number;
  /** Lines that were not parseable as Netscape cookie records. */
  malformed: number;
}

/**
 * Parses a Netscape cookie jar into per-domain counts. Values are read but
 * never retained -- only the field count is checked, so nothing secret can
 * reach a summary, a log, or a caller by accident.
 *
 * `#HttpOnly_` is a real record prefix, not a comment: Chrome-family exports
 * mark http-only cookies that way, and treating it as a comment silently
 * drops exactly the session cookies that matter most.
 */
export function summarizeJar(text: string): JarSummary {
  const byDomain = new Map<string, DomainSummary>();
  let total = 0;
  let malformed = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const record = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
    if (record.startsWith('#')) continue;

    const f = record.split('\t');
    // domain, includeSubdomains, path, secure, expiry, name, value.
    // A 6-field line is a valid empty-valued cookie; fewer is not a record.
    if (f.length < 6) { malformed++; continue; }

    const domain = f[0]!;
    const expiry = Number(f[4]);
    const entry = byDomain.get(domain)
      ?? { domain, cookies: 0, soonestExpiry: null, sessionCookies: 0 };
    entry.cookies++;
    if (!Number.isFinite(expiry) || expiry === 0) {
      entry.sessionCookies++;
    } else {
      const ms = expiry * 1000;
      entry.soonestExpiry = entry.soonestExpiry === null ? ms : Math.min(entry.soonestExpiry, ms);
    }
    byDomain.set(domain, entry);
    total++;
  }

  return {
    domains: [...byDomain.values()].sort((a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain)),
    total,
    malformed,
  };
}

/** "in 23 days" / "12 hours ago" -- a fact about the timestamp, not a judgment. */
function relative(ms: number, now: number): string {
  const d = ms - now;
  const abs = Math.abs(d);
  const unit = abs >= 86_400_000 ? ['day', 86_400_000] as const
    : abs >= 3_600_000 ? ['hour', 3_600_000] as const
      : ['minute', 60_000] as const;
  const n = Math.max(1, Math.round(abs / unit[1]));
  const plural = n === 1 ? unit[0] : `${unit[0]}s`;
  return d >= 0 ? `expires in ${n} ${plural}` : `EXPIRED ${n} ${plural} ago`;
}

function describeSource(source: CookieSource): string {
  if (source.kind === 'file') return `cookie jar: ${source.path}`;
  if (source.kind === 'browser') return `cookie source: browser "${source.spec}"`;
  return 'no cookie source configured';
}

export function runCookiesCli(
  argv: string[], out: (line: string) => void, env: NodeJS.ProcessEnv = process.env, now = Date.now(),
): number {
  const json = argv.includes('--json');

  let source: CookieSource;
  try {
    source = cookieSourceFromEnv(env);
  } catch (e) {
    // The configured-but-broken case this command exists to surface.
    if (e instanceof CookieConfigError) {
      if (json) out(JSON.stringify({ configured: true, error: e.message }, null, 2));
      else out(`cookie configuration error: ${e.message}`);
      return 1;
    }
    throw e;
  }

  if (source.kind === 'none') {
    if (json) { out(JSON.stringify({ configured: false }, null, 2)); return 0; }
    out(describeSource(source));
    out('  Set VIDEO_EXTRACT_COOKIES_FILE to a Netscape-format jar, or');
    out('  VIDEO_EXTRACT_COOKIES_FROM_BROWSER to a browser name (chrome, firefox, safari, ...).');
    out('  Public media does not need either.');
    return 0;
  }

  if (source.kind === 'browser') {
    // Deliberately not inspected. Reading the store means asking yt-dlp to
    // extract it, which needs a URL and therefore a network request -- a
    // diagnostic should not quietly fetch something, and should not decrypt
    // a live browser profile just to be reassuring. Report what is known.
    if (json) { out(JSON.stringify({ configured: true, kind: 'browser', browser: source.spec }, null, 2)); return 0; }
    out(describeSource(source));
    out('  Contents are read by yt-dlp at request time, so there is nothing on disk to inspect here.');
    out('  Cookies covering whatever that browser is logged into will be used.');
    return 0;
  }

  let text: string;
  try {
    text = readFileSync(source.path, 'utf8');
  } catch (e) {
    out(`cookie jar: ${source.path}`);
    out(`  could not be read: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const summary = summarizeJar(text);

  if (json) {
    out(JSON.stringify({
      configured: true, kind: 'file', path: source.path,
      total: summary.total, malformed: summary.malformed,
      domains: summary.domains.map((d) => ({
        domain: d.domain,
        cookies: d.cookies,
        sessionCookies: d.sessionCookies,
        soonestExpiry: d.soonestExpiry === null ? null : new Date(d.soonestExpiry).toISOString(),
        expired: d.soonestExpiry !== null && d.soonestExpiry < now,
      })),
    }, null, 2));
    return summary.total === 0 ? 1 : 0;
  }

  out(describeSource(source));

  if (summary.total === 0) {
    // The commonest real failure: a JSON export, or a browser's own format,
    // saved under a .txt name. Worth naming explicitly -- "0 cookies" alone
    // sends people looking at their login rather than at their exporter.
    out('  NO COOKIES FOUND. The file has no Netscape-format records.');
    const head = text.trimStart()[0];
    if (head === '[' || head === '{') {
      out('  It looks like JSON. yt-dlp needs the Netscape/"cookies.txt" format --');
      out('  re-export choosing that format rather than JSON.');
    }
    if (summary.malformed > 0) out(`  ${summary.malformed} line(s) were not parseable as cookie records.`);
    return 1;
  }

  const width = Math.max(...summary.domains.map((d) => d.domain.length));
  for (const d of summary.domains) {
    const when = d.soonestExpiry === null
      ? `${d.sessionCookies} session cookie(s), no expiry`
      : relative(d.soonestExpiry, now);
    const noun = d.cookies === 1 ? 'cookie ' : 'cookies';
    out(`  ${d.domain.padEnd(width)}  ${String(d.cookies).padStart(3)} ${noun}  ${when}`);
  }
  const expired = summary.domains.filter((d) => d.soonestExpiry !== null && d.soonestExpiry < now).length;
  const tail = expired > 0 ? `, ${expired} with expired cookies` : '';
  out(`  ${summary.domains.length} domain(s), ${summary.total} cookie${summary.total === 1 ? '' : 's'}${tail}`);
  if (summary.malformed > 0) out(`  ${summary.malformed} line(s) were not parseable as cookie records.`);
  return 0;
}
