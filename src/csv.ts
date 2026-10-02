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
 */

import type { Quote } from "./types.js";

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

/**
 * One session file's rows.
 *
 * `expectedDate` is optional so the parser can be used on a body whose session is not
 * known in advance, but every caller in this package passes it: the whole point is to
 * refuse a file that is not the session it was asked for.
 */
export function parseSessionCsv(csv: string, expectedDate?: string): Quote[] {
  const lines = csv.split(/\r?\n/);

  const rows: Quote[] = [];
  let sawHeader = false;
  let sawAnyRow = false;

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

    if (expectedDate !== undefined && date !== expectedDate) {
      throw new ArchiveFormatError(
        `Asked for ${expectedDate} but the file describes ${date}. The archive returned ` +
          "the wrong session, so none of these prices belong to the date requested.",
      );
    }

    const symbol = (fields[SYMBOL_FIELD] ?? "").trim().toUpperCase();
    if (symbol === "") {
      // A row with no ticker carries no information; the archive has never published one,
      // but skipping is safer than emitting a nameless quote.
      continue;
    }

    sawAnyRow = true;

    rows.push({
      symbol,
      open: parseNumber(fields[OPEN_FIELD] ?? ""),
      high: parseNumber(fields[HIGH_FIELD] ?? ""),
      low: parseNumber(fields[LOW_FIELD] ?? ""),
      close: parseNumber(fields[CLOSE_FIELD] ?? ""),
      volume: parseNumber(fields[VOLUME_FIELD] ?? ""),
      turnover: parseNumber(fields[TURNOVER_FIELD] ?? ""),
    });
  }

  if (!sawAnyRow) {
    // Distinguished from "a session with no rows", which does not exist: a session the
    // market did not trade simply has no file, and asking for one is a 404.
    throw new ArchiveFormatError(
      "The body held no session rows. An empty session is not something the archive " +
        "publishes — a day the market did not trade has no file at all.",
    );
  }

  return rows;
}
