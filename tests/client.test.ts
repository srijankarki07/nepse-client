/**
 * The client, against a faked archive.
 *
 * `fetch` is injected, so nothing here touches the network and every case — a CDN that
 * fails, a date the archive does not hold, a range full of holidays — can be provoked on
 * demand. What the *real* archive does is asserted separately in `live.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { COLUMNS, createClient, memoryCache, type Cache } from "../src/index.js";

const HEADER = COLUMNS.join(",");

function sessionBody(date: string, scrips: Record<string, number>): string {
  const rows = Object.entries(scrips).map(
    ([symbol, close]) => `${date},${symbol},${close - 2},${close + 3},${close - 5},${close},1000,50000`,
  );
  return [HEADER, ...rows].join("\r\n") + "\r\n";
}

/**
 * A fake archive: paths to bodies, plus a record of what was requested.
 *
 * Anything not in `files` answers 404, which is how the real hosts behave for a date the
 * archive does not hold.
 */
function fakeArchive(files: Record<string, string>) {
  const requested: string[] = [];

  const fetchImpl = (async (url: string) => {
    const href = String(url);
    requested.push(href);

    const marker = "/nepse-data";
    const at = href.indexOf(marker);
    const path = at === -1 ? href : href.slice(href.indexOf("/", at + marker.length) + 1);
    const body = files[path];

    return body === undefined
      ? new Response("Not Found", { status: 404 })
      : new Response(body, { status: 200 });
  }) as unknown as typeof fetch;

  return { fetchImpl, requested };
}

const MANIFEST = JSON.stringify({
  latest: "2026-10-01",
  previous: "2026-09-30",
  sessions: 3,
  years: { "2026": 3 },
});

const ARCHIVE: Record<string, string> = {
  "data/latest.json": MANIFEST,
  "data/daily/2026/2026-10-01.csv": sessionBody("2026-10-01", { NABIL: 566, ADBL: 307.5 }),
  "data/daily/2026/2026-09-30.csv": sessionBody("2026-09-30", { NABIL: 570, ADBL: 307.5 }),
  "data/daily/2026/2026-09-29.csv": sessionBody("2026-09-29", { NABIL: 560 }),
};

describe("manifest", () => {
  it("reads the index and names the host that served it", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const manifest = await client.manifest();

    expect(manifest.latest).toBe("2026-10-01");
    expect(manifest.previous).toBe("2026-09-30");
    expect(manifest.sessions).toBe(3);
    expect(manifest.source).toContain("jsdelivr");
  });

  it("is served from cache on the second call", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.manifest();
    await client.manifest();

    expect(requested.filter((url) => url.endsWith("latest.json"))).toHaveLength(1);
  });

  it("re-reads when asked to refresh", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.manifest();
    await client.manifest({ refresh: true });

    expect(requested.filter((url) => url.endsWith("latest.json"))).toHaveLength(2);
  });
});

describe("session", () => {
  it("reads one session by date", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const session = await client.session("2026-10-01");

    expect(session.date).toBe("2026-10-01");
    expect(session.rows.map((row) => row.symbol)).toEqual(["NABIL", "ADBL"]);
  });

  it("refuses a date that is not a date", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await expect(client.session("1 October")).rejects.toThrow(/not a YYYY-MM-DD/);
  });

  it("reports a day the market did not trade as an error, not an empty session", async () => {
    // The distinction matters: an empty session would read as "the market traded nothing".
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await expect(client.session("2026-09-28")).rejects.toThrow(/no session for 2026-09-28/);
  });

  it("does not ask again for a date it has already learned is absent", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.session("2026-09-28").catch(() => null);
    await client.session("2026-09-28").catch(() => null);

    expect(requested.filter((url) => url.includes("2026-09-28"))).toHaveLength(1);
  });
});

describe("caching", () => {
  it("never re-reads a session, because a session file never changes", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.session("2026-10-01");
    await client.session("2026-10-01");
    await client.session("2026-10-01");

    expect(requested.filter((url) => url.includes("2026-10-01"))).toHaveLength(1);
  });

  it("collapses concurrent requests for the same session into one", async () => {
    // Ten components on a page asking for the same day should make one request.
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await Promise.all([
      client.session("2026-10-01"),
      client.session("2026-10-01"),
      client.session("2026-10-01"),
    ]);

    expect(requested.filter((url) => url.includes("2026-10-01"))).toHaveLength(1);
  });

  it("works with an injected cache", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const cache: Cache = memoryCache();

    await createClient({ fetch: fetchImpl, cache }).session("2026-10-01");
    await createClient({ fetch: fetchImpl, cache }).session("2026-10-01");

    expect(requested.filter((url) => url.includes("2026-10-01"))).toHaveLength(1);
  });

  it("does not cache a network failure as though the date were absent", async () => {
    // A 503 is not a fact about the archive. Caching it would make a blip permanent.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("boom", { status: 503 })
        : new Response(ARCHIVE["data/daily/2026/2026-10-01.csv"] as string, { status: 200 });
    }) as unknown as typeof fetch;

    const client = createClient({ fetch: fetchImpl, retries: 0, hosts: ["https://one.example"] });

    await expect(client.session("2026-10-01")).rejects.toThrow();
    // The next call tries again rather than replaying the cached failure.
    await expect(client.session("2026-10-01")).resolves.toBeDefined();
  });
});

describe("latest", () => {
  it("reads the newest session, whole market", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const session = await client.latest();

    expect(session.date).toBe("2026-10-01");
    expect(session.rows).toHaveLength(2);
  });
});

describe("quote", () => {
  it("returns the close and the change against the previous session", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const quote = await client.quote("nabil");

    expect(quote.symbol).toBe("NABIL");
    expect(quote.date).toBe("2026-10-01");
    expect(quote.quote.close).toBe(566);
    expect(quote.previousClose).toBe(570);
    expect(quote.change).toBe(-4);
    expect(quote.changePercent).toBeCloseTo(-0.7018, 3);
  });

  it("reports no change when the previous close is unknown", async () => {
    // ADBL is absent from the earlier session, so there is no baseline — and a change
    // measured against nothing would be invented.
    const { fetchImpl } = fakeArchive({
      ...ARCHIVE,
      "data/daily/2026/2026-09-30.csv": sessionBody("2026-09-30", { NABIL: 570 }),
    });
    const client = createClient({ fetch: fetchImpl });

    const quote = await client.quote("ADBL");

    expect(quote.previousClose).toBeNull();
    expect(quote.change).toBeNull();
    expect(quote.changePercent).toBeNull();
  });

  it("never divides by a zero previous close", async () => {
    const { fetchImpl } = fakeArchive({
      ...ARCHIVE,
      "data/daily/2026/2026-09-30.csv": sessionBody("2026-09-30", { NABIL: 0 }),
    });
    const client = createClient({ fetch: fetchImpl });

    const quote = await client.quote("NABIL");

    expect(quote.changePercent).toBeNull();
  });

  it("says so when a scrip is not listed", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await expect(client.quote("NOSUCH")).rejects.toThrow(/not listed in the 2026-10-01 session/);
  });
});

describe("sessions and history", () => {
  it("returns only the days that traded, ascending", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    // 28 September is a Monday with no file: a hole the client must step over.
    const sessions = await client.sessions({ from: "2026-09-28", to: "2026-10-01" });

    expect(sessions.map((entry) => entry.date)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
  });

  it("reports progress over the whole calendar range, not just the hits", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const seen: Array<{ done: number; total: number }> = [];
    await client.sessions({
      from: "2026-09-28",
      to: "2026-10-01",
      onProgress: (progress) => seen.push({ done: progress.done, total: progress.total }),
    });

    expect(seen).toHaveLength(4);
    expect(seen.at(-1)).toEqual({ done: 4, total: 4 });
  });

  it("builds one scrip's series and omits days it did not trade", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const series = await client.history("ADBL", { from: "2026-09-29", to: "2026-10-01" });

    // ADBL is absent on the 29th, so it contributes no point rather than a gap of nulls.
    expect(series.map((point) => point.date)).toEqual(["2026-09-30", "2026-10-01"]);
    expect(series.map((point) => point.close)).toEqual([307.5, 307.5]);
  });

  it("refuses a range that ends before it starts", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await expect(client.sessions({ from: "2026-10-01", to: "2026-09-01" })).rejects.toThrow(
      /before it starts/,
    );
  });

  it("is cheap the second time, because absences are remembered too", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.sessions({ from: "2026-09-28", to: "2026-10-01" });
    const afterFirst = requested.length;
    await client.sessions({ from: "2026-09-28", to: "2026-10-01" });

    expect(requested.length).toBe(afterFirst);
  });
});

describe("symbols", () => {
  it("lists what the latest session holds", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    expect(await client.symbols()).toEqual(["NABIL", "ADBL"]);
  });
});

describe("hosts", () => {
  it("falls back to the origin when the CDN fails", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      const href = String(url);
      requested.push(href);

      if (href.includes("jsdelivr")) return new Response("nope", { status: 503 });
      return new Response(MANIFEST, { status: 200 });
    }) as unknown as typeof fetch;

    const client = createClient({ fetch: fetchImpl, retries: 0 });
    const manifest = await client.manifest();

    expect(manifest.source).toContain("raw.githubusercontent");
    expect(requested.some((url) => url.includes("jsdelivr"))).toBe(true);
  });

  it("does not try the second host for a date the archive does not hold", async () => {
    // Both hosts hold the same archive, so a 404 is an answer rather than a failure.
    const { fetchImpl, requested } = fakeArchive({});
    const client = createClient({ fetch: fetchImpl });

    await client.session("2026-01-01").catch(() => null);

    expect(requested).toHaveLength(1);
  });

  it("reports when no host can serve the archive", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const client = createClient({ fetch: fetchImpl, retries: 0 });

    await expect(client.manifest()).rejects.toThrow(/No archive host could serve/);
  });
});
