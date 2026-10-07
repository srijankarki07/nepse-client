/**
 * Reading the archive's CSV.
 *
 * ## This mirrors a contract it does not own
 *
 * The columns, their order and the empty-vs-zero rule are the archive's, documented in
 * that repository's README. This parser exists so a change there fails *here*, loudly,
 * rather than producing a plausible-looking wrong number.
 *
 * Two checks do that work, and both are deliberate:
 *
 *   - **The field count is verified on every row.** If the archive ever adds or reorders
 *     a column, every row stops parsing and the caller gets an error, rather than `close`
 *     quietly reading whatever moved into its position.
 *   - **The date is verified against the session that was asked for**, when the caller
 *     knows it. A file served under the wrong name — which the archive's own scraper has
 *     caught the source doing — would otherwise be filed under a date it does not belong
 *     to, and nothing downstream could tell.
 *
 * ## An empty field is not a zero
 *
 * A halted scrip has no high price and the archive writes an empty field. Parsing that as
 * `0` would turn "unknown" into "traded at nothing", which is a different and false claim.
 *
 * ## CRLF is expected but not required
 *
 * The archive writes CRLF (RFC 4180, and `.gitattributes` stops git rewriting it). Lines
 * are split on either ending here, because being strict about it would fail on a file
 * that had been through a tool that normalised it, and the difference carries no meaning.
 *
 * ## A series file is the same rows, grouped by scrip
 *
 * `data/series/<TICKER>.csv`, when the archive publishes one, holds a single scrip's rows
 * for its whole history in this same eight-column shape. It is read by the same loop, so
 * the two cannot disagree about what a valid row is; what differs is the check applied to
 * each row — a session row is verified against the date that was asked for, a series row
 * against the ticker.
 */

import type { DatedQuote, Quote } from "./types.js";

/** The archive's column order. Exported so a consumer can assert against it. */
export const COLUMNS = [
  "date",
  "symbol",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "turnover",
] as const;

const FIELD_COUNT = COLUMNS.length;
const DATE_FIELD = 0;
const SYMBOL_FIELD = 1;
const OPEN_FIELD = 2;
const HIGH_FIELD = 3;
const LOW_FIELD = 4;
const CLOSE_FIELD = 5;
const VOLUME_FIELD = 6;
const TURNOVER_FIELD = 7;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

/** Thrown when a body is not a session file this client understands. */
export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}

/**
 * A published number, or `null`.
 *
 * A missing value is an empty field, a lone dash, or anything else that is not a number —
 * all of which mean "not published" rather than zero.
 */
function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || !NUMBER_PATTERN.test(trimmed)) return null;

  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** One parsed row, with the session it belongs to. */
interface ParsedRow {
  date: string;
  quote: Quote;
}

interface RowChecks {
  /** Refuse a row that is not from this session. */
  expectedDate?: string;
  /** Refuse a row that is not this scrip. */
  expectedSymbol?: string;
  /** What to say when the body held no rows at all — it differs by what was being read. */
  emptyMessage: string;
}

/**
 * The row loop, shared by both readers.
 *
 * A series file is the same eight columns in the same order, so the structural checks —
 * the header, the field count, the usable date — are the same checks, and having one copy
 * of them is what stops the two readers disagreeing about what a valid row is. The wording
 * of those errors names the session format, which is the format a series file is in.
 */
function parseRows(csv: string, checks: RowChecks): ParsedRow[] {
  const lines = csv.split(/\r?\n/);

  const rows: ParsedRow[] = [];
  let sawHeader = false;

  for (const line of lines) {
    if (line.trim() === "") continue;

    const fields = line.split(",");

    // The header is recognised by its date column reading `date` rather than a date, so
    // it is skipped rather than counted as a malformed row. It must come first.
    if (!sawHeader) {
      sawHeader = true;
      if (fields[DATE_FIELD]?.trim() === "date") {
        if (fields.length !== FIELD_COUNT) {
          throw new ArchiveFormatError(
            `The session header has ${fields.length} columns, expected ${FIELD_COUNT} ` +
              `(${COLUMNS.join(", ")}).`,
          );
        }
        continue;
      }
      // No header at all: fall through and read this line as data.
    }

    if (fields.length !== FIELD_COUNT) {
      throw new ArchiveFormatError(
        `A session row has ${fields.length} columns, expected ${FIELD_COUNT}. ` +
          "The archive's format has changed, or this is not a session file.",
      );
    }

    const date = (fields[DATE_FIELD] ?? "").trim();
    if (!DATE_PATTERN.test(date)) {
      throw new ArchiveFormatError(`A session row carries an unusable date: "${date}".`);
    }

    if (checks.expectedDate !== undefined && date !== checks.expectedDate) {
      throw new ArchiveFormatError(
        `Asked for ${checks.expectedDate} but the file describes ${date}. The archive returned ` +
          "the wrong session, so none of these prices belong to the date requested.",
      );
    }

    const symbol = (fields[SYMBOL_FIELD] ?? "").trim().toUpperCase();
    if (symbol === "") {
      // A row with no ticker carries no information; the archive has never published one,
      // but skipping is safer than emitting a nameless quote.
      continue;
    }

    // The same guard as the date above, for the other thing a file can be wrong about: a
    // series served under another ticker's name would file one company's prices under
    // another's, and nothing downstream could tell.
    if (checks.expectedSymbol !== undefined && symbol !== checks.expectedSymbol) {
      throw new ArchiveFormatError(
        `Asked for ${checks.expectedSymbol} but the file describes ${symbol}. The archive ` +
          "returned another scrip's series, so none of these prices belong to the ticker " +
          "requested.",
      );
    }

    rows.push({
      date,
      quote: {
        symbol,
        open: parseNumber(fields[OPEN_FIELD] ?? ""),
        high: parseNumber(fields[HIGH_FIELD] ?? ""),
        low: parseNumber(fields[LOW_FIELD] ?? ""),
        close: parseNumber(fields[CLOSE_FIELD] ?? ""),
        volume: parseNumber(fields[VOLUME_FIELD] ?? ""),
        turnover: parseNumber(fields[TURNOVER_FIELD] ?? ""),
      },
    });
  }

  if (rows.length === 0) {
    // Distinguished from "a session with no rows", which does not exist: a session the
    // market did not trade simply has no file, and asking for one is a 404.
    throw new ArchiveFormatError(checks.emptyMessage);
  }

  return rows;
}

/**
 * One session file's rows.
 *
 * `expectedDate` is optional so the parser can be used on a body whose session is not
 * known in advance, but every caller in this package passes it: the whole point is to
 * refuse a file that is not the session it was asked for.
 */
export function parseSessionCsv(csv: string, expectedDate?: string): Quote[] {
  const rows = parseRows(csv, {
    expectedDate,
    emptyMessage:
      "The body held no session rows. An empty session is not something the archive " +
      "publishes — a day the market did not trade has no file at all.",
  });

  // The session is the caller's own frame, so it is not repeated on every row.
  return rows.map((row) => row.quote);
}

/**
 * One scrip's series file: `data/series/<TICKER>.csv`, when the archive publishes one.
 *
 * The rows are the whole history, so a caller filters them to the range it wants. They are
 * sorted by date here rather than trusted to arrive in order, because a chart's points must
 * be in date order whatever the file looks like — and because `history()` has to return the
 * same thing from this path as from the session walk, which is ascending by construction.
 */
export function parseSeriesCsv(csv: string, expectedSymbol: string): DatedQuote[] {
  const wanted = expectedSymbol.trim().toUpperCase();

  const rows = parseRows(csv, {
    expectedSymbol: wanted,
    emptyMessage:
      "The body held no series rows. An empty series is not something the archive " +
      "publishes — a ticker with no history has no file at all.",
  });

  return rows
    .map((row) => ({ ...row.quote, date: row.date }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
