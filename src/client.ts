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
import {
  ArchiveFormatError,
  parseClosesCsv,
  parseSeriesCsv,
  parseSessionCsv,
} from "./csv.js";
import {
  SessionNotFoundError,
  SymbolNotFoundError,
  createTransport,
  mapWithConcurrency,
  type Transport,
  type TransportOptions,
} from "./transport.js";
import type {
  ArchiveManifest,
  DatedCloses,
  DatedQuote,
  ManifestResult,
  Quote,
  Session,
  SymbolDirectory,
} from "./types.js";

const MANIFEST_PATH = "data/latest.json";
const SESSIONS_PATH = "data/sessions.json";
const SYMBOLS_PATH = "data/symbols.json";
const MANIFEST_KEY = "manifest";
const SESSIONS_KEY = "sessions-index";
const SYMBOLS_KEY = "symbols-directory";

/**
 * Where a scrip's whole history lives, when the archive publishes one.
 *
 * Optional by design. The archive is free not to publish it, and a client that demanded it
 * would break against every archive that predates it — so its absence is a fallback, not an
 * error, and the session walk below stays the path that cannot be wrong.
 */
const SERIES_DIRECTORY = "data/series";

/** Where a year's whole-market closes live, when the archive publishes one. */
const CLOSES_DIRECTORY = "data/closes";

/** A ticker worth naming a file after: letters, digits, and the slash a bond code uses. */
const SERIES_TICKER = /^[A-Z0-9/]+$/;

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

/** One scrip in a {@link SnapshotResult}, with its day change. */
export interface SnapshotRow extends Quote {
  /** Absolute change against the previous session's close, or `null` when unknown. */
  change: number | null;
  /** Change as a percentage, or `null` for the reasons given on `QuoteResult`. */
  changePercent: number | null;
}

/** The whole market for the newest session, with every day change worked out. */
export interface SnapshotResult {
  /** The session the prices are from. */
  date: string;
  /** The session the changes are measured against, or `null` when there is only one. */
  previousDate: string | null;
  /** Every scrip the session listed, in the archive's order. */
  rows: SnapshotRow[];
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
  /**
   * Every scrip in the newest session, each with its day change.
   *
   * **This is what a market table, a portfolio or a watchlist should call.** `quote()`
   * costs three requests for one scrip, so a page holding twenty would spend sixty; this
   * spends the same three a single quote does and answers for every scrip at once, because
   * the two session files it reads already hold the whole market.
   */
  snapshot(): Promise<SnapshotResult>;
  /**
   * One scrip's series across a range. Only sessions that listed it appear.
   *
   * When the archive publishes `data/series/<TICKER>.csv` this is **one request** rather
   * than one per trading day in the range, and the file is read once and kept for the
   * mutable TTL, so every later range for the same scrip is answered from memory. Against
   * an archive without one, or when the file cannot be read, it falls back to walking the
   * sessions — the path that cannot be wrong.
   */
  history(symbol: string, range: RangeOptions): Promise<DatedQuote[]>;
  /**
   * Every scrip's closing price for every session in a range, ascending by date.
   *
   * **This is what a market-wide chart should read.** `sessions()` returns full rows and
   * costs one request per trading day, which is 231 requests and 4.13 MB for a year; this
   * costs **one request per calendar year the range covers**, about 450 KB each, because the
   * archive publishes a year of closes as a single wide file. An equal-weighted index, a
   * heatmap, or a portfolio's daily values can all be computed from what it returns.
   *
   * It carries closes only, by design. For one scrip with its open, high, low, volume and
   * turnover, use `history()`; for a handful of scrips, `series()`. **For more than two or
   * three, this is cheaper than `series()`**: a year of the whole market is one 450 KB
   * request, where three scrips would be three files of about 180 KB each.
   *
   * Scrips that did not trade, or that published no close, are **absent** from a date's map
   * rather than present with a `null`, so a caller cannot compute a ratio against nothing.
   *
   * When the archive publishes no closes file for a year in the range, it falls back to
   * walking the sessions for the whole range, which is the path that cannot be wrong.
   */
  closes(range: RangeOptions): Promise<DatedCloses[]>;
  /**
   * Several scrips' series across one range, in a single pass — what `history()` is for one
   * scrip.
   *
   * The difference is not cosmetic. Each session file is fetched once either way (they are
   * cached), but `history()` **parses** every one of them per call, so twenty scrips parse
   * the same bytes twenty times. That is the cost that appears when a caller moves from one
   * chart to a portfolio.
   *
   * Every requested ticker is a key in the result, with an empty array when the archive
   * never listed it — a delisted holding should not blank the rest of a portfolio, and an
   * absent key would be indistinguishable from a bug.
   */
  series(symbols: readonly string[], range: RangeOptions): Promise<Map<string, DatedQuote[]>>;
  /** Tickers listed in the latest session. */
  symbols(): Promise<string[]>;
  /**
   * Ticker to company name, for every scrip the archive has seen since it began
   * publishing names.
   *
   * Read this for a browsable list — a market table of bare tickers is hard to read, and
   * a symbol page needs something to put in its heading.
   *
   * **It is not complete, and cannot be.** Names are learned from the source page as
   * scrips appear, so a company that stopped trading before the archive started recording
   * names has prices here and no name. Check `lastSeen` against `manifest().latest` to
   * tell a delisted scrip from a live one.
   */
  directory(): Promise<SymbolDirectory>;
  /** The name for one ticker, or `null` when the archive has never recorded one. */
  name(symbol: string): Promise<string | null>;
  /**
   * Every archived session date within a range, ascending.
   *
   * Cheap — one request for the archive's date list, then a filter — and useful on its
   * own for a picker, a calendar, or a coverage chart. `sessions()` is built on it.
   *
   * Days the market was shut are simply absent, so a gap between two dates means the
   * exchange did not trade, never that the client skipped something.
   */
  sessionDates(range: { from: string; to: string }): Promise<string[]>;
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

/**
 * A ticker as the archive names its series file, or `null` when it is not one.
 *
 * Fourteen tickers in the archive contain a slash, because the source names a debenture
 * for the two years it covers: `GBILD86/87` is one ticker, but as a path it would be a
 * directory called `GBILD86` holding `87.csv`. So every run of characters outside
 * `A-Za-z0-9` becomes one `-`, and the result is upper-cased.
 *
 * The archive writes the same name from the same ticker
 * (`nepse-data/src/lib/series.ts`), and a test here asserts the two agree. This is the one
 * rule that could silently disagree, and its failure mode is quiet: every read would go to
 * a file that is not there and fall back to the slow path, which looks exactly like an
 * archive that publishes no series files at all.
 */
function seriesName(symbol: string): string | null {
  if (!SERIES_TICKER.test(symbol)) return null;

  const name = symbol
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase();

  // A ticker of nothing but slashes passes the pattern and names nothing.
  return name === "" ? null : name;
}

/**
 * Refuses a range that is not two usable dates in order.
 *
 * Shared, because a range is refused the same way whichever path serves it — and the
 * series path skips the session walk that used to be the only thing doing this check.
 */
function assertRange(range: { from: string; to: string }): void {
  assertDate(range.from, "range start");
  assertDate(range.to, "range end");

  if (range.from > range.to) {
    throw new ArchiveFormatError(
      `The range ends on ${range.to}, before it starts on ${range.from}.`,
    );
  }
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

/**
 * The change against a previous close, or `null`s when either side is unknown.
 *
 * Both sides must be known before a change is a fact. Reporting a fall against an absent
 * baseline would be an invented figure, and a percentage against a zero previous close is
 * not a number — rendering either as one would put something on screen that nothing
 * supports.
 *
 * It lives here, rather than inline in `quote`, because `snapshot` reports the same thing
 * for every scrip at once and the two must not drift apart.
 */
function changeAgainst(
  close: number | null,
  previousClose: number | null,
): { change: number | null; changePercent: number | null } {
  const change =
    close !== null && previousClose !== null ? Number((close - previousClose).toFixed(4)) : null;

  const changePercent =
    change !== null && previousClose !== null && previousClose !== 0
      ? Number(((change / previousClose) * 100).toFixed(4))
      : null;

  return { change, changePercent };
}

/**
 * The closing prices in a session, keyed by ticker.
 *
 * A scrip with no published close is left out rather than mapped to `null`, which is the same
 * thing the closes files do by leaving the cell empty: a caller is computing ratios, and a
 * scrip with no close has no ratio against the previous day.
 */
function closedIn(session: Session): Map<string, number> {
  const closes = new Map<string, number>();
  for (const row of session.rows) {
    if (row.close !== null) closes.set(row.symbol, row.close);
  }
  return closes;
}

export function createClient(options: ClientOptions = {}): NepseDataClient {
  const cache = options.cache ?? memoryCache();
  const transport: Transport = createTransport(options);
  const concurrency = options.concurrency ?? undefined;
  const manifestTtlMs = options.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS;

  /** In-flight reads, so ten components asking for one session make one request. */
  const inFlight = new Map<string, Promise<string>>();

  /** When the cached date list stops being trusted. See `readSessionDates`. */
  let sessionsFreshUntil = 0;

  /** The same, for the ticker directory. */
  let symbolsFreshUntil = 0;

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
      // A `SessionNotFoundError`, not a format error: nothing is malformed, the archive
      // simply holds no file for a day the market did not trade. Callers are told they
      // can catch this, so it has to be what actually arrives.
      throw new SessionNotFoundError(
        sessionPath(date),
        404,
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

  /**
   * The archive's list of session dates, or `null` when it does not publish one.
   *
   * ## Why this expires and a session file does not
   *
   * The rule is **immutable caches forever, mutable expires**, and the two are not the
   * same kind of thing. A session file is written once. The date list gains a date every
   * trading day, so caching it permanently would mean a client that read it yesterday
   * goes on believing today's session does not exist — for the life of that cache, with
   * no way to notice.
   *
   * It is easy to get wrong, because both feel like "the archive's data". The first
   * version of this cached the index forever and reasoned that appending cannot
   * invalidate the past — which is true, and beside the point, because the question a
   * range asks is usually about dates near the end.
   *
   * The CDN makes it sharper rather than softer: jsDelivr caches the branch, so for a
   * short window after the daily commit it can serve yesterday's list. Expiring is what
   * lets that correct itself.
   */
  async function readSessionDates(): Promise<string[] | null> {
    // The body is held here rather than read back out of the cache afterwards. Reading it
    // back looks equivalent and is not: with `noCache()` — which is a supported
    // configuration, and the one every live probe uses — the write goes nowhere and the
    // read always misses, so a successful fetch would be thrown away and the client would
    // fall back to calendar-walking while believing it had the index.
    let body = await cache.get(SESSIONS_KEY);

    if (body === null || Date.now() >= sessionsFreshUntil) {
      try {
        const fresh = await transport.get(SESSIONS_PATH);
        body = fresh;
        await cache.set(SESSIONS_KEY, fresh);
      } catch {
        // No date list published, or the CDN has not caught up with it yet. A cached copy
        // is used if there is one; otherwise the caller walks calendar days, which is the
        // path that cannot be wrong.
      }
      sessionsFreshUntil = Date.now() + manifestTtlMs;
    }

    if (body === null) return null;

    try {
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((entry): entry is string => typeof entry === "string");
    } catch {
      return null;
    }
  }

  /**
   * The sessions in a range.
   *
   * When the archive publishes its date list — which it does — this is exact: one request
   * for the list plus one per session, with nothing spent discovering that the market was
   * shut.
   *
   * If the list is ever absent the range is walked as calendar days instead. That path is
   * kept because it is the one that cannot be wrong: it asks about every day and lets the
   * archive answer. It is also what this client did before the date list existed.
   */
  async function datesIn(range: RangeOptions): Promise<string[]> {
    assertRange(range);

    const known = await readSessionDates();
    if (known === null) return eachDay(range.from, range.to);

    return known.filter((date) => date >= range.from && date <= range.to);
  }

  async function sessions(range: RangeOptions): Promise<Session[]> {
    const dates = await datesIn(range);
    let done = 0;

    const found = await mapWithConcurrency(
      dates,
      concurrency ?? 6,
      async (date) => {
        if (range.signal?.aborted === true) return null;

        const body = await readThrough(`session/${date}`, sessionPath(date));
        done += 1;
        range.onProgress?.({ done, total: dates.length, date });

        return body === null ? null : { date, rows: parseSessionCsv(body, date) };
      },
    );

    return found.filter((entry): entry is Session => entry !== null);
  }

  /**
   * The newest session and the one before it — what any "how did today go" question needs.
   *
   * Shared by `quote` and `snapshot` so that the single-scrip answer and the whole-market
   * answer are the same answer, by construction rather than by two implementations agreeing.
   *
   * A previous session that will not load is not a reason to fail: the changes go to `null`
   * and the prices still render, which is the call the consumer would otherwise write.
   */
  async function latestPair(): Promise<{
    date: string;
    current: Session;
    previous: Session | null;
  }> {
    const index = await manifest();

    if (index.latest === null) {
      throw new ArchiveFormatError("The archive is empty — it holds no sessions at all.");
    }

    const [current, previous] = await Promise.all([
      session(index.latest),
      index.previous === null
        ? Promise.resolve(null)
        : session(index.previous).catch(() => null),
    ]);

    return { date: index.latest, current, previous };
  }

  async function quote(symbol: string): Promise<QuoteResult> {
    const wanted = symbol.trim().toUpperCase();
    if (wanted === "") throw new ArchiveFormatError("A symbol is required.");

    const { date, current, previous } = await latestPair();

    const quoteRow = current.rows.find((row) => row.symbol === wanted);
    if (quoteRow === undefined) {
      throw new SymbolNotFoundError(
        wanted,
        `${wanted} is not listed in the ${date} session. It may be suspended, ` +
          "delisted, or misspelt.",
      );
    }

    const previousClose = previous?.rows.find((row) => row.symbol === wanted)?.close ?? null;

    // Both sides must be known before a change is a fact. Reporting a fall against an
    // absent baseline would be an invented figure.
    return {
      symbol: wanted,
      date,
      quote: quoteRow,
      previousClose,
      ...changeAgainst(quoteRow.close, previousClose),
    };
  }

  async function snapshot(): Promise<SnapshotResult> {
    const { date, current, previous } = await latestPair();

    // One lookup table for the previous closes, rather than the linear scan `quote` does:
    // that is the right cost for one scrip and the wrong one for every scrip.
    const previousCloses = new Map<string, number>();
    for (const row of previous?.rows ?? []) {
      if (row.close !== null) previousCloses.set(row.symbol, row.close);
    }

    return {
      date,
      previousDate: previous?.date ?? null,
      rows: current.rows.map((row) => ({
        ...row,
        ...changeAgainst(row.close, previousCloses.get(row.symbol) ?? null),
      })),
    };
  }

  async function series(
    symbols: readonly string[],
    range: RangeOptions,
  ): Promise<Map<string, DatedQuote[]>> {
    const wanted = new Set<string>();
    for (const symbol of symbols) {
      const cleaned = symbol.trim().toUpperCase();
      if (cleaned !== "") wanted.add(cleaned);
    }

    // Every ticker asked for is a key, so a caller's loop cannot fall off the end of a
    // portfolio because one holding is missing from the archive.
    const found = new Map<string, DatedQuote[]>();
    for (const symbol of wanted) found.set(symbol, []);

    if (wanted.size === 0) return found;

    // The sessions are parsed once here, which is the whole point: `history` per symbol
    // would parse these same bytes once per symbol.
    const all = await sessions(range);

    for (const entry of all) {
      for (const row of entry.rows) {
        const bucket = wanted.has(row.symbol) ? found.get(row.symbol) : undefined;
        if (bucket !== undefined) bucket.push({ ...row, date: entry.date });
      }
    }

    return found;
  }

  /**
   * A scrip's whole series once read, kept for the mutable TTL.
   *
   * Two things are remembered, and both matter: the **parsed rows**, because reading this
   * file is the entire point and parsing it again per call would give back part of what it
   * saves; and the **absence** of the file, because until the archive publishes series
   * files every call would otherwise spend a 404 discovering that again. A `null` value
   * means "asked, and there was nothing".
   *
   * It is held here rather than in the `Cache` deliberately, for the reason spelled out on
   * `readSessionDates`: with `noCache()` the write goes nowhere and the read always misses,
   * so a body read back out would be discarded and the client would quietly slide onto the
   * session walk while believing it was using the series.
   */
  const seriesMemo = new Map<string, { rows: DatedQuote[] | null; until: number }>();

  /**
   * The series file for a ticker, or `null` when the archive publishes none.
   *
   * ## Every failure here falls back rather than throwing
   *
   * This file is a shortcut over a path that already works, so the honest response to a
   * missing, malformed, or unreachable one is to walk the sessions and return the same
   * answer more slowly — never to fail a request that would otherwise have succeeded. The
   * session walk is loud about its own format errors, so a real breakage still surfaces;
   * what is swallowed is only the failure of the shortcut.
   */
  async function readSeries(symbol: string): Promise<DatedQuote[] | null> {
    const memo = seriesMemo.get(symbol);
    if (memo !== undefined && Date.now() < memo.until) return memo.rows;

    // Not a ticker the archive would have named a file after — a misspelling, or a string
    // with a path separator in it. The session walk answers it instead, and this costs
    // nothing, so there is no separate guard at the call site to keep in step.
    const name = seriesName(symbol);
    if (name === null) return null;

    try {
      const body = await transport.get(`${SERIES_DIRECTORY}/${name}.csv`);
      const rows = parseSeriesCsv(body, symbol);
      seriesMemo.set(symbol, { rows, until: Date.now() + manifestTtlMs });
      return rows;
    } catch (error) {
      // An archive that has no series for this ticker yet is worth remembering — but only
      // for the mutable TTL, because this is an absence that is expected to go away, which
      // is the opposite of a session the market did not trade.
      if (error instanceof Error && error.name === "SessionNotFoundError") {
        seriesMemo.set(symbol, { rows: null, until: Date.now() + manifestTtlMs });
      }
      // A network failure, or a file this client cannot read, is not a fact about the
      // archive and is deliberately not remembered: the next call tries again.
      return null;
    }
  }

  /**
   * A year's closes once read, kept for the mutable TTL, like the series files.
   *
   * A `null` value means "asked, and the archive publishes none for that year", which is
   * remembered only for the TTL: an archive is expected to start publishing these, and an
   * absence that outlived the fact would pin a client to the slow path forever.
   */
  const closesMemo = new Map<string, { rows: DatedCloses[] | null; until: number }>();

  /** The years a range touches, ascending. `2025-10-01` to `2026-02-01` is two. */
  function yearsIn(from: string, to: string): string[] {
    const first = Number(from.slice(0, 4));
    const last = Number(to.slice(0, 4));

    const years: string[] = [];
    for (let year = first; year <= last; year++) years.push(String(year));
    return years;
  }

  /** One year's closes file, or `null` when the archive publishes none. */
  async function readCloses(year: string): Promise<DatedCloses[] | null> {
    const memo = closesMemo.get(year);
    if (memo !== undefined && Date.now() < memo.until) return memo.rows;

    try {
      const body = await transport.get(`${CLOSES_DIRECTORY}/${year}.csv`);
      const rows = parseClosesCsv(body, year);
      closesMemo.set(year, { rows, until: Date.now() + manifestTtlMs });
      return rows;
    } catch (error) {
      // Only "the archive publishes no closes for this year" is worth remembering. A
      // network failure is not a fact about the archive, and the next call tries again.
      if (error instanceof Error && error.name === "SessionNotFoundError") {
        closesMemo.set(year, { rows: null, until: Date.now() + manifestTtlMs });
      }
      return null;
    }
  }

  async function closes(range: RangeOptions): Promise<DatedCloses[]> {
    assertRange(range);
    if (range.signal?.aborted === true) return [];

    const years = yearsIn(range.from, range.to);
    const perYear: DatedCloses[] = [];

    for (const [index, year] of years.entries()) {
      const rows = await readCloses(year);

      if (rows === null) {
        // A year the archive does not publish breaks the whole answer, not just that year:
        // it is a range, and a caller given a gap would compute a change across it as though
        // the market had been shut. The session walk covers every year correctly.
        return (await sessions(range)).map((session) => ({
          date: session.date,
          closes: closedIn(session),
        }));
      }

      perYear.push(...rows);
      range.onProgress?.({ done: index + 1, total: years.length, date: year });
    }

    return perYear
      .filter((row) => row.date >= range.from && row.date <= range.to)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  async function history(symbol: string, range: RangeOptions): Promise<DatedQuote[]> {
    const wanted = symbol.trim().toUpperCase();
    if (wanted === "") throw new ArchiveFormatError("A symbol is required.");

    assertRange(range);
    if (range.signal?.aborted === true) return [];

    const rows = await readSeries(wanted);

    if (rows !== null) {
      // The file is the whole history, so a range is a filter over it rather than a
      // request for less — one request either way, and the memo then answers every other
      // range for this scrip without another.
      const inRange = rows.filter((point) => point.date >= range.from && point.date <= range.to);

      // There is no per-session work to report, but a caller driving a progress bar
      // should be told the read is done rather than left watching it.
      range.onProgress?.({
        done: 1,
        total: 1,
        date: inRange.at(-1)?.date ?? range.to,
      });

      return inRange;
    }

    // One bucket of `series`, so a single scrip and a portfolio are filtered by the same
    // code and cannot disagree about which sessions count.
    return (await series([wanted], range)).get(wanted) ?? [];
  }

  async function symbols(): Promise<string[]> {
    const current = await latest();
    return current.rows.map((row) => row.symbol);
  }

  /**
   * The ticker directory.
   *
   * Expires like the session list rather than caching forever like a session, and for the
   * same reason: scrips are added to it, so a copy read yesterday is a copy that cannot
   * name a company listed today.
   *
   * An archive that publishes no directory is not an error. The names are a convenience
   * on top of the prices, so a missing file yields an empty object and the caller falls
   * back to tickers.
   */
  async function directory(): Promise<SymbolDirectory> {
    // Held here rather than read back from the cache afterwards, for the reason spelled
    // out on `readSessionDates`: with `noCache()` the write goes nowhere, and reading back
    // would discard a perfectly good fetch.
    let body = await cache.get(SYMBOLS_KEY);

    if (body === null || Date.now() >= symbolsFreshUntil) {
      try {
        const fresh = await transport.get(SYMBOLS_PATH);
        body = fresh;
        await cache.set(SYMBOLS_KEY, fresh);
      } catch {
        // Not published, or the CDN has not caught up. Whatever is cached is used; if
        // nothing is, the caller gets an empty directory.
      }
      symbolsFreshUntil = Date.now() + manifestTtlMs;
    }

    if (body === null) return {};

    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as SymbolDirectory;
    } catch {
      return {};
    }
  }

  async function name(symbol: string): Promise<string | null> {
    const wanted = symbol.trim().toUpperCase();
    if (wanted === "") return null;

    return (await directory())[wanted]?.name ?? null;
  }

  return {
    manifest,
    session,
    latest,
    sessions,
    quote,
    snapshot,
    history,
    closes,
    series,
    symbols,
    directory,
    name,
    sessionDates: (range) => datesIn({ from: range.from, to: range.to }),
  };
}
