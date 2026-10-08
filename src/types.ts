/**
 * The shapes this client reads and returns.
 *
 * ## Prices are numbers, not minor units
 *
 * The archive publishes plain decimal numbers and this returns them unchanged. The
 * sibling Bachat Khata backend converts to integer minor units because it does ledger
 * arithmetic; a market browser only ever displays them, so the round trip would add a
 * unit without adding accuracy. `null` still means "not published", never zero — a
 * halted scrip has no high price, and a zero would be a claim it traded at nothing.
 */

/** One scrip's session. Every price is in NPR, as the archive publishes it. */
export interface Quote {
  /** The NEPSE ticker, upper-cased. */
  symbol: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** Shares traded. */
  volume: number | null;
  /** Total value traded, in NPR. */
  turnover: number | null;
}

/** A quote with the session it belongs to. What `history` returns. */
export interface DatedQuote extends Quote {
  /** The trading session, `YYYY-MM-DD`. */
  date: string;
}

/**
 * One session's closing prices, keyed by ticker. What `closes` returns, one per date.
 *
 * A `Map` rather than an array of quotes, because this is the shape the arithmetic wants:
 * the equal-weighted index is the mean of each scrip's day-on-day ratio, so what a caller
 * needs for a date is a lookup from ticker to close, and nothing else.
 *
 * Scrips that did not trade that day, and scrips that traded without publishing a close, are
 * both **absent** rather than present with a `null`. Neither has a ratio against the previous
 * day, so neither may be counted as one, and an absent key cannot be accidentally summed.
 */
export interface DatedCloses {
  /** The trading session, `YYYY-MM-DD`. */
  date: string;
  /** Ticker to closing price, in NPR. */
  closes: Map<string, number>;
}

/** Every scrip the archive lists for one session. */
export interface Session {
  /** The trading session, `YYYY-MM-DD`, taken from the file's own rows. */
  date: string;
  /**
   * The session's scrips, in the order the archive publishes them (sorted by symbol).
   *
   * A session can legitimately be small: in 2011 the whole market was under a hundred
   * scrips and some days had five.
   */
  rows: Quote[];
}

/**
 * `data/latest.json` — the index, and the only thing that changes day to day.
 *
 * Read this first. A directory tree cannot be listed over jsDelivr or
 * `raw.githubusercontent.com`, so without it there is no way to learn which date to ask
 * for.
 */
export interface ArchiveManifest {
  /** The most recent session, or `null` when the archive is empty. */
  latest: string | null;
  /**
   * The session before `latest`.
   *
   * `null` only when the archive holds a single session — it is *not* "yesterday". The
   * market is shut several days a week and for holidays, so the previous session is
   * found by looking, not by subtracting a day.
   */
  previous: string | null;
  /** How many sessions the archive holds. */
  sessions: number;
  /** Sessions per year, keyed by year. */
  years: Record<string, number>;
}

/**
 * The manifest, plus which host answered.
 *
 * The archive's own manifest carries no timestamp — deliberately, so that an unchanged
 * archive produces a byte-identical file and the daily job can see there is nothing to
 * commit. `latest` is therefore the only freshness signal, and it moves only when the
 * market does. `source` is added by this client so a caller can tell whether jsDelivr or
 * the origin answered, which matters when a CDN is serving something stale.
 */
export interface ManifestResult extends ArchiveManifest {
  /** The host that served the manifest. */
  source: string;
}

/** One scrip in the directory. */
export interface SymbolEntry {
  /** The company's name, as the source publishes it. */
  name: string;
  /**
   * The most recent session this ticker appeared in.
   *
   * Compare against `manifest().latest`: equal means the scrip is still trading. A date
   * well behind it means it stopped — which is the difference between a delisted company
   * and one that never existed.
   */
  lastSeen: string;
}

/** Ticker to entry. What `directory()` returns. */
export type SymbolDirectory = Record<string, SymbolEntry>;
