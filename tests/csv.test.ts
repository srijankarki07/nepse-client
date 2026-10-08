/**
 * The parser, against the contract the archive publishes.
 *
 * These fixtures are written by hand and the archive's shape is real, which is the
 * reverse of the usual arrangement on purpose: the *live* suite asserts that this parser
 * still reads what the archive actually serves. What is tested here is what the parser
 * does when the archive is wrong, which a live test cannot provoke.
 */

import { describe, expect, it } from "vitest";

import {
  ArchiveFormatError,
  COLUMNS,
  parseClosesCsv,
  parseSeriesCsv,
  parseSessionCsv,
} from "../src/index.js";

const HEADER = COLUMNS.join(",");

/** One row, in the archive's column order. */
function row(
  date: string,
  symbol: string,
  values: Partial<Record<"open" | "high" | "low" | "close" | "volume" | "turnover", string>> = {},
): string {
  const v = (name: keyof typeof values, fallback: string) => values[name] ?? fallback;
  return [
    date,
    symbol,
    v("open", "100"),
    v("high", "110"),
    v("low", "90"),
    v("close", "105"),
    v("volume", "1000"),
    v("turnover", "105000.5"),
  ].join(",");
}

function body(...rows: string[]): string {
  return [HEADER, ...rows].join("\r\n") + "\r\n";
}

describe("parseSessionCsv", () => {
  it("reads a session", () => {
    const rows = parseSessionCsv(body(row("2026-10-01", "NABIL")), "2026-10-01");

    expect(rows).toEqual([
      {
        symbol: "NABIL",
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 1000,
        turnover: 105_000.5,
      },
    ]);
  });

  it("reads every scrip, not just one", () => {
    const rows = parseSessionCsv(
      body(row("2026-10-01", "NABIL"), row("2026-10-01", "ADBL"), row("2026-10-01", "ACLBSL")),
      "2026-10-01",
    );

    expect(rows.map((entry) => entry.symbol)).toEqual(["NABIL", "ADBL", "ACLBSL"]);
  });

  it("treats an empty field as absent, never as zero", () => {
    // The archive writes a missing value as an empty field. Reading it as 0 would turn
    // "this scrip did not trade" into "it traded at nothing", which is a different claim.
    const rows = parseSessionCsv(
      body(row("2026-10-01", "HALTED", { high: "", close: "", volume: "" })),
      "2026-10-01",
    );

    expect(rows[0]?.high).toBeNull();
    expect(rows[0]?.close).toBeNull();
    expect(rows[0]?.volume).toBeNull();
    // The values that *were* published are still numbers.
    expect(rows[0]?.open).toBe(100);
  });

  it("treats a lone dash as absent", () => {
    const rows = parseSessionCsv(body(row("2026-10-01", "X", { high: "-" })), "2026-10-01");
    expect(rows[0]?.high).toBeNull();
  });

  it("reads a negative number rather than discarding it", () => {
    const rows = parseSessionCsv(body(row("2026-10-01", "X", { close: "-5.5" })), "2026-10-01");
    expect(rows[0]?.close).toBe(-5.5);
  });

  it("refuses a row whose column count changed", () => {
    // The check that makes a format change fail here instead of quietly reading whatever
    // slid into the close column's position.
    const mangled = [HEADER, "2026-10-01,NABIL,100,110,90,105,1000"].join("\r\n");

    expect(() => parseSessionCsv(mangled)).toThrow(ArchiveFormatError);
    expect(() => parseSessionCsv(mangled)).toThrow(/expected 8/);
  });

  it("refuses a header whose column count changed", () => {
    const mangled = ["date,symbol,open,high,low,close,volume", row("2026-10-01", "NABIL")].join("\r\n");

    expect(() => parseSessionCsv(mangled)).toThrow(/header has 7 columns/);
  });

  it("refuses a file describing a different session than the one asked for", () => {
    // The source has served another day's table under a requested date before; this is
    // what stops that being filed under the wrong day.
    const wrongDay = body(row("2026-09-30", "NABIL"));

    expect(() => parseSessionCsv(wrongDay, "2026-10-01")).toThrow(/describes 2026-09-30/);
  });

  it("refuses a body with no rows at all", () => {
    // Distinct from a session with no scrips, which does not exist — a day the market did
    // not trade has no file.
    expect(() => parseSessionCsv(HEADER)).toThrow(/no session rows/);
    expect(() => parseSessionCsv("")).toThrow(/no session rows/);
  });

  it("refuses an unusable date", () => {
    expect(() => parseSessionCsv(body(row("01-10-2026", "NABIL")))).toThrow(/unusable date/);
  });

  it("reads LF terminators as well as CRLF", () => {
    // The archive writes CRLF, but a file that has been through a normalising tool is
    // still readable and the difference carries no meaning.
    const lf = [HEADER, row("2026-10-01", "NABIL")].join("\n") + "\n";
    expect(parseSessionCsv(lf, "2026-10-01")).toHaveLength(1);
  });

  it("upper-cases the ticker", () => {
    const rows = parseSessionCsv(body(row("2026-10-01", "nabil")), "2026-10-01");
    expect(rows[0]?.symbol).toBe("NABIL");
  });
});

describe("parseClosesCsv", () => {
  const closesFile = (...lines: string[]) => lines.join("\r\n") + "\r\n";

  it("reads a date into a ticker-to-close lookup", () => {
    const rows = parseClosesCsv(closesFile("date,ADBL,NABIL", "2026-09-30,307.5,570"), "2026");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe("2026-09-30");
    expect([...(rows[0]?.closes ?? [])]).toEqual([
      ["ADBL", 307.5],
      ["NABIL", 570],
    ]);
  });

  it("leaves an empty cell out instead of reading it as zero", () => {
    // The scrip did not trade, or published no close. Either way it has no ratio against the
    // previous day, and a zero would invent one.
    const rows = parseClosesCsv(closesFile("date,ADBL,NABIL", "2026-09-30,,570"), "2026");

    expect(rows[0]?.closes.has("ADBL")).toBe(false);
    expect(rows[0]?.closes.get("NABIL")).toBe(570);
  });

  it("puts the dates in order whatever order the file is in", () => {
    const rows = parseClosesCsv(
      closesFile("date,NABIL", "2026-10-01,566", "2026-09-30,570"),
      "2026",
    );

    expect(rows.map((row) => row.date)).toEqual(["2026-09-30", "2026-10-01"]);
  });

  it("refuses a file describing another year", () => {
    // The same guard the session reader applies to its date and the series reader to its
    // ticker: a file served under the wrong name would be filed under the wrong year.
    expect(() => parseClosesCsv(closesFile("date,NABIL", "2025-12-31,500"), "2026")).toThrow(
      /describes 2025-12-31/,
    );
  });

  it("refuses a row that disagrees with the header about the column count", () => {
    expect(() =>
      parseClosesCsv(closesFile("date,ADBL,NABIL", "2026-09-30,307.5"), "2026"),
    ).toThrow(/has 2 columns, expected 3/);
  });

  it("refuses a session file served where a closes file was expected", () => {
    // It would otherwise parse happily: its header also starts with `date`, and every row
    // would read as a date plus tickers named "symbol", "open" and so on.
    const session = closesFile(HEADER, row("2026-09-30", "NABIL"));

    expect(() => parseClosesCsv(session, "2026")).toThrow(/This is a session file/);
  });

  it("refuses a header that is not a closes header", () => {
    expect(() => parseClosesCsv(closesFile("symbol,NABIL", "2026-09-30,570"), "2026")).toThrow(
      /must start with "date"/,
    );
  });

  it("refuses an unusable date", () => {
    expect(() => parseClosesCsv(closesFile("date,NABIL", "30-09-2026,570"), "2026")).toThrow(
      /unusable date/,
    );
  });

  it("refuses a body with no rows at all", () => {
    expect(() => parseClosesCsv("", "2026")).toThrow(/no closes rows/);
  });
});

describe("COLUMNS", () => {
  it("is the archive's documented order", () => {
    // Asserted because this is a contract with another repository, not a local choice.
    expect(COLUMNS).toEqual([
      "date",
      "symbol",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "turnover",
    ]);
  });
});

describe("parseSeriesCsv", () => {
  it("reads one scrip's whole history", () => {
    const series = parseSeriesCsv(
      body(row("2026-09-30", "NABIL"), row("2026-10-01", "NABIL")),
      "NABIL",
    );

    expect(series.map((point) => point.date)).toEqual(["2026-09-30", "2026-10-01"]);
    expect(series.map((point) => point.close)).toEqual([105, 105]);
  });

  it("puts the points in date order whatever order the file is in", () => {
    // A chart's x-axis must ascend, and `history()` has to return the same thing from this
    // path as from the session walk, which is ascending by construction.
    const series = parseSeriesCsv(
      body(row("2026-10-01", "NABIL"), row("2026-09-29", "NABIL"), row("2026-09-30", "NABIL")),
      "NABIL",
    );

    expect(series.map((point) => point.date)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
  });

  it("refuses a series belonging to another ticker", () => {
    // The same guard the session reader applies to dates: a file served under the wrong
    // name would file one company's prices under another's, and nothing downstream could
    // tell.
    const wrongScrip = body(row("2026-10-01", "ADBL"));

    expect(() => parseSeriesCsv(wrongScrip, "NABIL")).toThrow(/describes ADBL/);
    expect(() => parseSeriesCsv(wrongScrip, "NABIL")).toThrow(ArchiveFormatError);
  });

  it("matches the ticker without caring about case", () => {
    const series = parseSeriesCsv(body(row("2026-10-01", "nabil")), "nabil");
    expect(series).toHaveLength(1);
  });

  it("refuses a row whose column count changed", () => {
    const mangled = [HEADER, "2026-10-01,NABIL,100,110,90,105,1000"].join("\r\n");
    expect(() => parseSeriesCsv(mangled, "NABIL")).toThrow(/expected 8/);
  });

  it("refuses a body with no rows at all", () => {
    expect(() => parseSeriesCsv(HEADER, "NABIL")).toThrow(/no series rows/);
    expect(() => parseSeriesCsv("", "NABIL")).toThrow(/no series rows/);
  });

  it("keeps an empty field absent rather than zero", () => {
    const series = parseSeriesCsv(
      body(row("2026-10-01", "HALTED", { high: "", volume: "" })),
      "HALTED",
    );

    expect(series[0]?.high).toBeNull();
    expect(series[0]?.volume).toBeNull();
    expect(series[0]?.close).toBe(105);
  });
});
