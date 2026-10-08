/**
 * `@srijankarki44/nepse-data` — read NEPSE end-of-day prices from a maintained public archive.
 *
 * ```ts
 * import { createClient } from "@srijankarki44/nepse-data";
 *
 * const nepse = createClient();
 * const market = await nepse.latest();          // every scrip, newest session
 * const nabil = await nepse.quote("NABIL");     // with its day change
 * ```
 *
 * ## What this does not do
 *
 * It does not ship data, and it does not scrape. It reads a public archive at runtime,
 * which keeps the package small and means the data and the code version independently —
 * the archive is current the moment it is published, whatever version of this you have
 * installed.
 *
 * ## There is no live or intraday data
 *
 * The archive holds **closing prices only**, one file per trading session, published an
 * hour after the close. There is no tick data and no real-time feed, so nothing built on
 * this can show a live price. `manifest().latest` is the freshness signal.
 *
 * ## The data is not covered by this package's licence
 *
 * The code is MIT. The prices are the exchange's, republished by a third party, and this
 * package neither includes nor re-licenses them — see the README.
 */

export {
  createClient,
  type ClientOptions,
  type NepseDataClient,
  type QuoteResult,
  type RangeOptions,
  type SnapshotResult,
  type SnapshotRow,
} from "./client.js";

export {
  fileCache,
  localStorageCache,
  memoryCache,
  noCache,
  type Cache,
} from "./cache.js";

export {
  ArchiveUnavailableError,
  DEFAULT_CONCURRENCY,
  DEFAULT_HOSTS,
  SessionNotFoundError,
  SymbolNotFoundError,
  cacheModeFor,
  createTransport,
  mapWithConcurrency,
  type Transport,
  type TransportOptions,
} from "./transport.js";

export {
  ArchiveFormatError,
  COLUMNS,
  parseClosesCsv,
  parseSeriesCsv,
  parseSessionCsv,
} from "./csv.js";

export type {
  ArchiveManifest,
  DatedCloses,
  DatedQuote,
  ManifestResult,
  Quote,
  Session,
  SymbolDirectory,
  SymbolEntry,
} from "./types.js";
