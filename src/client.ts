/**
 * The client: everything a consumer calls, in one place.
 *
 * ## Finding which days traded
 *
 * The manifest says how many sessions the archive holds and how they fall across years,
 * but it does not list dates. So a range is walked as calendar days and the days with no
 * file are skipped.
 *
 * **That is deliberate rather than lazy.** The obvious shortcut — skip Saturdays and
 * Sundays — is a prediction about someone else's business calendar, and it is a prediction
 * that has already been wrong: NEPSE traded Sunday to Thursday until 5 April 2026 and
 * Monday to Friday from 10 April, and a client that had hard-coded the old week would have
 * silently missed every Friday for months. Walking every day costs requests and cannot be
 * wrong.
 *
 * A day with no file is remembered as having none, so the cost is paid once per date per
 * cache rather than on every call. The first history query over a year spends about 365
 * requests to return ~240 sessions; the second spends none.
 *
 * ## What caches and what does not
 *
 * Session files are immutable and cached forever. The manifest is the only thing that
 * moves, so it is the only thing with a lifetime. Negative results — a date with no
 * session — are cached as firmly as positive ones, because "the market did not trade on
 * 14 October 2018" is as permanent a fact as the session that did.
 */

import { type Cache, memoryCache } from "./cache.js";
import { ArchiveFormatError, parseSessionCsv } from "./csv.js";
import { mapWithConcurrency, createTransport, type Transport, type TransportOptions } from "./transport.js";
import type {
  ArchiveManifest,
  DatedQuote,
  ManifestResult,
  Quote,
  Session,
} from "./types.js";

const MANIFEST_PATH = "data/latest.json";
const MANIFEST_KEY = "manifest";

/** How long a manifest may be reused. It changes at most once a day. */
const DEFAULT_MANIFEST_TTL_MS = 5 * 60 * 1000;

/** A session the archive does not hold. Cached so the probe is paid once. */
const NO_SESSION = "";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export interface ClientOptions extends TransportOptions {
  cache?: Cache;
  manifestTtlMs?: number;
}

export interface RangeOptions {
  /** First session, inclusive. */
  from: string;
  /** Last session, inclusive. */
  to: string;
  /** Called after each session resolves, for progress on a long range. */
  onProgress?: (progress: { done: number; total: number; date: string }) => void;
  /** Stop early. Useful for a caller that has navigated away. */
  signal?: AbortSignal;
}

/** The newest price for a scrip, with the day change already worked out. */
export interface QuoteResult {
  symbol: string;
  /** The session the price is from. */
  date: string;
  quote: Quote;
  /** The previous session's close, or `null` when the archive holds only one session. */
  previousClose: number | null;
  /** Absolute change against the previous close, or `null` when it is unknown. */
  change: number | null;
  /**
   * Change as a percentage, or `null`.
   *
   * `null` rather than `Infinity` or `NaN` when the previous close was zero or absent —
   * a percentage against nothing is not a number, and rendering it as one would invent a
   * figure.
   */
  changePercent: number | null;
}

export interface NepseDataClient {
  /** The index. Read this first; everything else follows from it. */
  manifest(options?: { refresh?: boolean }): Promise<ManifestResult>;
  /** One session by date. Throws `SessionNotFoundError` if the market did not trade. */
  session(date: string): Promise<Session>;
  /** The most recent session. */
  latest(): Promise<Session>;
  /** Every session in a range, ascending. Days the market was shut are skipped. */
  sessions(range: RangeOptions): Promise<Session[]>;
  /** The newest price for one scrip, with its day change. */
  quote(symbol: string): Promise<QuoteResult>;
  /** One scrip's series across a range. Only sessions that listed it appear. */
  history(symbol: string, range: RangeOptions): Promise<DatedQuote[]>;
  /** Tickers listed in the latest session. */
  symbols(): Promise<string[]>;
}

function assertDate(value: string, what: string): string {
  if (!DATE_PATTERN.test(value)) {
    throw new ArchiveFormatError(`"${value}" is not a YYYY-MM-DD date (${what}).`);
  }
  return value;
}

function sessionPath(date: string): string {
  return `data/daily/${date.slice(0, 4)}/${date}.csv`;
}

/** Every calendar day from `from` to `to`, inclusive. */
function eachDay(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);

  if (start > end) {
    throw new ArchiveFormatError(`The range ends on ${to}, before it starts on ${from}.`);
  }

  const days: string[] = [];
  for (let time = start; time <= end; time += MS_PER_DAY) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

export function createClient(options: ClientOptions = {}): NepseDataClient {
  const cache = options.cache ?? memoryCache();
  const transport: Transport = createTransport(options);
  const concurrency = options.concurrency ?? undefined;
  const manifestTtlMs = options.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS;

  /** In-flight reads, so ten components asking for one session make one request. */
  const inFlight = new Map<string, Promise<string>>();

  /** Reads through the cache, collapsing concurrent misses onto one request. */
  async function readThrough(key: string, path: string): Promise<string | null> {
    const cached = await cache.get(key);
    if (cached !== null) return cached === NO_SESSION ? null : cached;

    const existing = inFlight.get(key);
    if (existing !== undefined) {
      const body = await existing;
      return body === NO_SESSION ? null : body;
    }

    const request = (async () => {
      try {
        const body = await transport.get(path);
        await cache.set(key, body);
        return body;
      } catch (error) {
        // Only "the archive has no such date" is worth remembering. A network failure is
        // not a fact about the archive and must not be cached as one.
        if (error instanceof Error && error.name === "SessionNotFoundError") {
          await cache.set(key, NO_SESSION);
          return NO_SESSION;
        }
        throw error;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, request);
    const body = await request;
    return body === NO_SESSION ? null : body;
  }

  async function manifest(options2: { refresh?: boolean } = {}): Promise<ManifestResult> {
    if (options2.refresh !== true) {
      const cached = await cache.get(MANIFEST_KEY);
      if (cached !== null) {
        try {
          const envelope = JSON.parse(cached) as { at: number; body: string; source: string };
          if (Date.now() - envelope.at < manifestTtlMs) {
            return { ...(JSON.parse(envelope.body) as ArchiveManifest), source: envelope.source };
          }
        } catch {
          // A cache entry this client cannot read is a miss, not a failure.
        }
      }
    }

    const body = await transport.get(MANIFEST_PATH);
    const source = transport.lastHost ?? "unknown";

    let parsed: ArchiveManifest;
    try {
      parsed = JSON.parse(body) as ArchiveManifest;
    } catch {
      throw new ArchiveFormatError("The archive index is not valid JSON.");
    }

    // The index is what every other call is built on, so a malformed one is refused here
    // rather than turning into a request for a date that cannot exist.
    if (parsed.latest !== null && !DATE_PATTERN.test(parsed.latest)) {
      throw new ArchiveFormatError(
        `The archive index names an unusable latest date: "${parsed.latest}".`,
      );
    }

    await cache.set(MANIFEST_KEY, JSON.stringify({ at: Date.now(), body, source }));

    return { ...parsed, source };
  }

  async function session(date: string): Promise<Session> {
    assertDate(date, "session date");

    const body = await readThrough(`session/${date}`, sessionPath(date));
    if (body === null) {
      throw new ArchiveFormatError(
        `The archive has no session for ${date}. The market did not trade that day, or ` +
          "the date is outside the archive.",
      );
    }

    return { date, rows: parseSessionCsv(body, date) };
  }

  async function latest(): Promise<Session> {
    const index = await manifest();
    if (index.latest === null) {
      throw new ArchiveFormatError("The archive is empty — it holds no sessions at all.");
    }
    return session(index.latest);
  }

  async function sessions(range: RangeOptions): Promise<Session[]> {
    assertDate(range.from, "range start");
    assertDate(range.to, "range end");

    const days = eachDay(range.from, range.to);
    let done = 0;

    const found = await mapWithConcurrency(
      days,
      concurrency ?? 6,
      async (date) => {
        if (range.signal?.aborted === true) return null;

        const body = await readThrough(`session/${date}`, sessionPath(date));
        done += 1;
        range.onProgress?.({ done, total: days.length, date });

        return body === null ? null : { date, rows: parseSessionCsv(body, date) };
      },
    );

    return found.filter((entry): entry is Session => entry !== null);
  }

  async function quote(symbol: string): Promise<QuoteResult> {
    const index = await manifest();

    const wanted = symbol.trim().toUpperCase();
    if (wanted === "") throw new ArchiveFormatError("A symbol is required.");

    if (index.latest === null) {
      throw new ArchiveFormatError("The archive is empty — it holds no sessions at all.");
    }

    const [current, previous] = await Promise.all([
      session(index.latest),
      index.previous === null
        ? Promise.resolve(null)
        : session(index.previous).catch(() => null),
    ]);

    const quoteRow = current.rows.find((row) => row.symbol === wanted);
    if (quoteRow === undefined) {
      throw new ArchiveFormatError(
        `${wanted} is not listed in the ${index.latest} session. It may be suspended, ` +
          "delisted, or misspelt.",
      );
    }

    const previousClose = previous?.rows.find((row) => row.symbol === wanted)?.close ?? null;
    const close = quoteRow.close;

    // Both sides must be known before a change is a fact. Reporting a fall against an
    // absent baseline would be an invented figure.
    const change =
      close !== null && previousClose !== null ? Number((close - previousClose).toFixed(4)) : null;
    const changePercent =
      change !== null && previousClose !== null && previousClose !== 0
        ? Number(((change / previousClose) * 100).toFixed(4))
        : null;

    return { symbol: wanted, date: index.latest, quote: quoteRow, previousClose, change, changePercent };
  }

  async function history(symbol: string, range: RangeOptions): Promise<DatedQuote[]> {
    const wanted = symbol.trim().toUpperCase();
    if (wanted === "") throw new ArchiveFormatError("A symbol is required.");

    const all = await sessions(range);

    return all
      .map((entry) => {
        const row = entry.rows.find((quote2) => quote2.symbol === wanted);
        return row === undefined ? null : ({ ...row, date: entry.date } satisfies DatedQuote);
      })
      .filter((entry): entry is DatedQuote => entry !== null);
  }

  async function symbols(): Promise<string[]> {
    const current = await latest();
    return current.rows.map((row) => row.symbol);
  }

  return { manifest, session, latest, sessions, quote, history, symbols };
}
