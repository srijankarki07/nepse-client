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

import type { DatedCloses, DatedIndexLevel, DatedQuote, Quote } from "./types.js";

/**
 * The index format's column order. Exported so a consumer can assert against it, and so a
 * reader can see at a glance that it is not the archive's session order.
 */
export const INDEX_COLUMNS = [
  "date",
  "open",
  "high",
  "low",
  "close",
  "change",
  "percentChange",
  "turnover",
] as const;

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
 * One year's closes file: `data/closes/<YEAR>.csv`, when the archive publishes one.
 *
 * This is the one file here that is **not** in the session format. It is wide where the
 * others are long: one row per date and one column per ticker, which is what makes a year of
 * the whole market fit in about 450 KB instead of the megabytes the same facts occupy as
 * session files. The columns are the tickers listed at any point in the year, and a cell is
 * empty for a scrip that did not trade that day.
 *
 * So the checks differ accordingly. There is no fixed field count to assert, because the
 * count is however many tickers that year saw; what is asserted instead is that every row
 * agrees with the header about how many columns there are, and that the file describes the
 * year that was asked for. The second is the same guard the session reader applies to its
 * date and the series reader to its ticker: a file served under another year's name would
 * otherwise be filed under the wrong one.
 *
 * Empty cells are skipped rather than kept as anything. A close that was not published has no
 * ratio against the previous day, so a caller must not be able to count it as one.
 */
export function parseClosesCsv(csv: string, expectedYear: string): DatedCloses[] {
  const lines = csv.split(/\r?\n/).filter((line) => line !== "");
  const header = lines[0];

  if (header === undefined) {
    throw new ArchiveFormatError(
      "The body held no closes rows. An empty year is not something the archive publishes " +
        "— a year the market did not trade has no file at all.",
    );
  }

  const columns = header.split(",");
  const first = columns[0]?.trim();

  // A session file is the one thing that could reach here by mistake, and it would parse
  // without complaint: its header also starts with `date` and names more than one column, so
  // every row would read as a date plus seven tickers called "symbol", "open" and so on.
  // Refusing it by name is cheaper than trusting that nothing ever mixes the paths up.
  if (header.trim() === COLUMNS.join(",")) {
    throw new ArchiveFormatError(
      "This is a session file, not a closes file. The archive serves closes at " +
        "data/closes/<YEAR>.csv and sessions at data/daily/<YEAR>/<DATE>.csv.",
    );
  }

  if (first !== "date" || columns.length < 2) {
    throw new ArchiveFormatError(
      `A closes header must start with "date" and name at least one ticker, but reads ` +
        `"${header.slice(0, 60)}". The archive's format has changed, or this is not a ` +
        "closes file.",
    );
  }

  // The ticker names are taken once, so a row is read by position rather than by rebuilding
  // the mapping for every date.
  const symbols = columns.slice(1).map((symbol) => symbol.trim());

  const rows: DatedCloses[] = [];

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fields = line.split(",");

    if (fields.length !== columns.length) {
      throw new ArchiveFormatError(
        `A closes row has ${fields.length} columns, expected ${columns.length} to match the ` +
          "header. The archive's format has changed, or the file is damaged.",
      );
    }

    const date = (fields[0] ?? "").trim();
    if (!DATE_PATTERN.test(date)) {
      throw new ArchiveFormatError(`A closes row carries an unusable date: "${date}".`);
    }

    if (!date.startsWith(`${expectedYear}-`)) {
      throw new ArchiveFormatError(
        `Asked for ${expectedYear} but the file describes ${date}. The archive returned the ` +
          "wrong year, so none of these closes belong to the dates requested.",
      );
    }

    const closes = new Map<string, number>();
    for (let column = 0; column < symbols.length; column++) {
      const symbol = symbols[column];
      if (symbol === undefined || symbol === "") continue;

      const value = parseNumber(fields[column + 1] ?? "");
      if (value !== null) closes.set(symbol, value);
    }

    rows.push({ date, closes });
  }

  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
/**
 * One scrip's series file: `data/series/<TICKER>.csv`, when the archive publishes one.
 *
 * The rows are the whole history, so a caller filters them to the range it wants. They are
 * sorted by date here rather than trusted to arrive in order, because a chart's points must
 * be in date order whatever the file looks like — and because `history()` has to return the
 * same thing from this path as from the session walk, which is ascending by construction.
 */
/**
 * One index's history: `data/indices/<key>.csv`, when the archive publishes one.
 *
 * The shortest format here, and the only one whose columns are all numbers. Eight of them,
 * fixed, in the order the header names:
 *
 * ```csv
 * date,open,high,low,close,change,percentChange,turnover
 * 2026-10-07,2579,2579.1,2565.22,2572.34,-6.38,-0.24,3748080303.07
 * ```
 *
 * The header is checked **exactly** rather than by width, which is a departure from the
 * closes reader next door. That reader can afford to be loose because its rows carry tickers,
 * so a wrong file turns into tickers named `open` and `close`. Here every column is a number,
 * so a session or closes file served at this path would parse into plausible nonsense: seven
 * numbers per row that look like a level, a change and a turnover and are not. Comparing the
 * header against a constant is the only thing that catches it.
 *
 * ## What this cannot check, and why
 *
 * Nothing in these rows names the index, so unlike a session file (checked against its date)
 * or a series file (checked against its ticker) there is no in-file evidence that this is the
 * index that was asked for. The key is a property of the file's *name*, not of its contents.
 * `data/latest.json` and `data/symbols.json` have the same property and are read the same way.
 * What the checks below do catch is a file in a different format, a damaged row, and a row
 * dated to something that is not a date.
 */
export function parseIndexCsv(csv: string): DatedIndexLevel[] {
  const lines = csv.split(/\r?\n/).filter((line) => line !== "");
  const header = lines[0];

  if (header === undefined) {
    throw new ArchiveFormatError(
      "The body held no index rows. An empty index is not something the archive publishes " +
        "— an index with no history has no file at all.",
    );
  }

  if (header.trim() !== INDEX_COLUMNS.join(",")) {
    throw new ArchiveFormatError(
      `An index header reads "${header.slice(0, 60)}" where ` +
        `"${INDEX_COLUMNS.join(",")}" was expected. The archive's format has changed, or ` +
        "this is not an index file.",
    );
  }

  const rows: DatedIndexLevel[] = [];

  for (let index = 1; index < lines.length; index++) {
    const fields = (lines[index] ?? "").split(",");

    if (fields.length !== INDEX_COLUMNS.length) {
      throw new ArchiveFormatError(
        `An index row has ${fields.length} columns, expected ${INDEX_COLUMNS.length} to match ` +
          "the header. The archive's format has changed, or the file is damaged.",
      );
    }

    const date = (fields[0] ?? "").trim();
    if (!DATE_PATTERN.test(date)) {
      throw new ArchiveFormatError(`An index row carries an unusable date: "${date}".`);
    }

    rows.push({
      date,
      open: parseNumber(fields[1] ?? ""),
      high: parseNumber(fields[2] ?? ""),
      low: parseNumber(fields[3] ?? ""),
      close: parseNumber(fields[4] ?? ""),
      change: parseNumber(fields[5] ?? ""),
      percentChange: parseNumber(fields[6] ?? ""),
      turnover: parseNumber(fields[7] ?? ""),
    });
  }

  if (rows.length === 0) {
    // The same rule the other two readers apply: an empty file is not something the archive
    // publishes. An index with no history has no file at all, so a header with nothing under
    // it means something went wrong rather than that the index is new.
    throw new ArchiveFormatError(
      "The body held no index rows. An empty index is not something the archive publishes " +
        "— an index with no history has no file at all.",
    );
  }

  // Sorted here rather than trusted to arrive in order, so a chart's points ascend whatever
  // the file looks like. The archive writes them ascending already; this is a guarantee.
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

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
