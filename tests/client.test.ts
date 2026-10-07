/**
 * The client, against a faked archive.
 *
 * `fetch` is injected, so nothing here touches the network and every case — a CDN that
 * fails, a date the archive does not hold, a range full of holidays — can be provoked on
 * demand. What the *real* archive does is asserted separately in `live.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  COLUMNS,
  SessionNotFoundError,
  SymbolNotFoundError,
  cacheModeFor,
  createClient,
  memoryCache,
  noCache,
  type Cache,
} from "../src/index.js";

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
 * archive does not hold. The options each request carried are recorded beside the URLs so
 * the cache mode the client asks for can be asserted per path.
 */
function fakeArchive(files: Record<string, string>) {
  const requested: string[] = [];
  const inits: (RequestInit | undefined)[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const href = String(url);
    requested.push(href);
    inits.push(init);

    const marker = "/nepse-data";
    const at = href.indexOf(marker);
    const path = at === -1 ? href : href.slice(href.indexOf("/", at + marker.length) + 1);
    const body = files[path];

    return body === undefined
      ? new Response("Not Found", { status: 404 })
      : new Response(body, { status: 200 });
  }) as unknown as typeof fetch;

  return { fetchImpl, requested, inits };
}

/** The cache mode the client asked for the first request matching `needle`. */
function cacheModeUsed(
  requested: readonly string[],
  inits: readonly (RequestInit | undefined)[],
  needle: string,
): RequestCache | undefined {
  const at = requested.findIndex((url) => url.includes(needle));
  return at === -1 ? undefined : inits[at]?.cache;
}

const MANIFEST = JSON.stringify({
  latest: "2026-10-01",
  previous: "2026-09-30",
  sessions: 3,
  years: { "2026": 3 },
});

/** The archive's date list, as it really publishes one. */
const SESSIONS_INDEX = JSON.stringify(["2026-09-29", "2026-09-30", "2026-10-01"]);

const SYMBOLS = JSON.stringify({
  NABIL: { name: "Nabil Bank Limited", lastSeen: "2026-10-01" },
  ADBL: { name: "Agricultural Development Bank Limited", lastSeen: "2026-10-01" },
  OLD: { name: "Delisted Finance Limited", lastSeen: "2020-01-01" },
});

const ARCHIVE: Record<string, string> = {
  "data/latest.json": MANIFEST,
  "data/sessions.json": SESSIONS_INDEX,
  "data/symbols.json": SYMBOLS,
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

describe("the cache mode asked of the HTTP layer", () => {
  /**
   * The adapter cache and the `inFlight` map are this package's. The browser's HTTP cache
   * is not, and jsDelivr serves a branch ref with `max-age=604800` — so these assertions
   * are about the only layer that could serve a week-old `latest` while every test above
   * still passed.
   */
  it("revalidates the files that are rewritten, so a week-old copy cannot be served", async () => {
    const { fetchImpl, requested, inits } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.manifest();
    await client.sessions({ from: "2026-09-29", to: "2026-10-01" });
    await client.directory();

    for (const path of ["latest.json", "sessions.json", "symbols.json"]) {
      expect(cacheModeUsed(requested, inits, path), path).toBe("no-cache");
    }
  });

  it("leaves a session file to the HTTP cache, because it is written once", async () => {
    const { fetchImpl, requested, inits } = fakeArchive(ARCHIVE);
    await createClient({ fetch: fetchImpl }).session("2026-10-01");

    expect(cacheModeUsed(requested, inits, "2026-10-01.csv")).toBe("default");
  });

  it("revalidates a path it does not recognise, rather than trusting it", () => {
    // The safe direction to be wrong in: an unknown file is assumed to move.
    expect(cacheModeFor("data/series/NABIL.csv")).toBe("no-cache");
    expect(cacheModeFor("data/closes/2025.csv")).toBe("no-cache");
    expect(cacheModeFor("data/daily/2011/2011-06-13.csv")).toBe("default");
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

  it("asks the archive for its date list rather than probing every day", async () => {
    // The whole point of the index: with it, a range costs one request for the list plus
    // one per session. Without it, a third of the requests discover nothing.
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.sessions({ from: "2026-09-29", to: "2026-10-01" });

    expect(requested.filter((url) => url.endsWith("sessions.json"))).toHaveLength(1);
    // Three sessions for a three-day range: no request was spent on a day that is not one.
    expect(requested.filter((url) => url.endsWith(".csv"))).toHaveLength(3);
  });

  it("reports progress over the sessions in range", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const seen: Array<{ done: number; total: number }> = [];
    await client.sessions({
      from: "2026-09-28",
      to: "2026-10-01",
      onProgress: (progress) => seen.push({ done: progress.done, total: progress.total }),
    });

    // Three, not four: with the date list, the 28th is never a candidate.
    expect(seen).toHaveLength(3);
    expect(seen.at(-1)).toEqual({ done: 3, total: 3 });
  });

  it("uses the date list even when caching is switched off", async () => {
    // The bug this exists for: the fetcher wrote the list to the cache and then read it
    // back out. With `noCache()` the write goes nowhere, so a perfectly good fetch was
    // discarded and the client walked calendar days while believing it had the index —
    // slower, and invisible, because the fallback is designed to be correct.
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl, cache: noCache() });

    const dates = await client.sessionDates({ from: "2026-09-28", to: "2026-10-01" });

    expect(dates).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    // One request for the list, three for the sessions — not four calendar probes.
    expect(requested.filter((url) => url.endsWith(".csv"))).toHaveLength(0);
  });

  it("re-reads the date list once it expires, so a new session is not missed forever", async () => {
    // The bug this exists for: the first version cached the date list permanently, on the
    // reasoning that appending cannot invalidate the past. True, and beside the point —
    // the question a range asks is usually about dates near the end. A client that read
    // the list yesterday would have gone on believing today's session did not exist, for
    // the life of the cache, with no way to notice.
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl, manifestTtlMs: 0 });

    await client.sessionDates({ from: "2026-09-01", to: "2026-10-01" });
    await client.sessionDates({ from: "2026-09-01", to: "2026-10-01" });

    expect(requested.filter((url) => url.endsWith("sessions.json"))).toHaveLength(2);
  });

  it("keeps a session forever, because a session file cannot change", async () => {
    // The other half of the rule, asserted together with it so the two cannot drift.
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl, manifestTtlMs: 0 });

    await client.session("2026-10-01");
    await client.session("2026-10-01");

    expect(requested.filter((url) => url.endsWith("2026-10-01.csv"))).toHaveLength(1);
  });

  it("falls back to walking calendar days when the archive publishes no date list", async () => {
    // The path that cannot be wrong: it asks about every day and lets the archive answer.
    // Kept because a wrong answer here is a silently missing session, and the trading week
    // has changed once already.
    const withoutIndex = { ...ARCHIVE };
    delete withoutIndex["data/sessions.json"];

    const { fetchImpl, requested } = fakeArchive(withoutIndex);
    const client = createClient({ fetch: fetchImpl });

    const sessions = await client.sessions({ from: "2026-09-28", to: "2026-10-01" });

    expect(sessions.map((entry) => entry.date)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
    // Four calendar days asked about, one of them absent — the cost of having no index.
    expect(requested.filter((url) => url.endsWith(".csv"))).toHaveLength(4);
  });

  it("rejects a range that ends before it starts, on either path", async () => {
    const withIndex = fakeArchive(ARCHIVE);
    const withoutIndex = fakeArchive((() => {
      const copy = { ...ARCHIVE };
      delete copy["data/sessions.json"];
      return copy;
    })());

    for (const { fetchImpl } of [withIndex, withoutIndex]) {
      const client = createClient({ fetch: fetchImpl });
      await expect(client.sessions({ from: "2026-10-01", to: "2026-09-01" })).rejects.toThrow(
        /before it starts/,
      );
    }
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

describe("snapshot", () => {
  it("gives every scrip its day change, from the same two sessions a quote reads", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const market = await client.snapshot();

    expect(market.date).toBe("2026-10-01");
    expect(market.previousDate).toBe("2026-09-30");

    const nabil = market.rows.find((row) => row.symbol === "NABIL");
    expect(nabil?.close).toBe(566);
    expect(nabil?.change).toBe(-4);
    expect(nabil?.changePercent).toBeCloseTo(-0.7018, 3);
  });

  it("reports a flat scrip as unchanged, which is not the same as unknown", async () => {
    // ADBL closed at the same price twice. Zero is a fact; null would be the absence of one.
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const market = await createClient({ fetch: fetchImpl }).snapshot();

    const adbl = market.rows.find((row) => row.symbol === "ADBL");
    expect(adbl?.change).toBe(0);
    expect(adbl?.changePercent).toBe(0);
  });

  it("agrees with quote() for every scrip, because they read the same pair", async () => {
    // The single-scrip and whole-market answers must not drift; this is the assertion that
    // would catch it if the shared change maths were ever forked.
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const market = await client.snapshot();

    for (const row of market.rows) {
      const quote = await client.quote(row.symbol);
      expect(quote.change, row.symbol).toBe(row.change);
      expect(quote.changePercent, row.symbol).toBe(row.changePercent);
    }
  });

  it("costs three requests however many scrips are asked about", async () => {
    // What quote-per-holding would cost 3N. This is the whole point of the call.
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.snapshot();

    expect(requested).toHaveLength(3);
  });

  it("reports no change at all when the archive holds a single session", async () => {
    const { fetchImpl } = fakeArchive({
      ...ARCHIVE,
      "data/latest.json": JSON.stringify({
        latest: "2026-10-01",
        previous: null,
        sessions: 1,
        years: { "2026": 1 },
      }),
    });
    const market = await createClient({ fetch: fetchImpl }).snapshot();

    expect(market.previousDate).toBeNull();
    expect(market.rows.every((row) => row.change === null)).toBe(true);
  });
});

describe("series", () => {
  const RANGE = { from: "2026-09-29", to: "2026-10-01" };

  it("returns each scrip's series, and agrees with history() for one", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const both = await client.series(["NABIL", "ADBL"], RANGE);

    expect(await client.history("NABIL", RANGE)).toEqual(both.get("NABIL"));
    expect(await client.history("ADBL", RANGE)).toEqual(both.get("ADBL"));
    // ADBL was absent on the 29th, so it contributes no point rather than a null gap.
    expect(both.get("ADBL")?.map((point) => point.date)).toEqual(["2026-09-30", "2026-10-01"]);
  });

  it("parses each session once for many scrips, not once per scrip", async () => {
    // A session body is read from the cache and parsed exactly once per `readThrough` that
    // returns it, so counting body reads counts parses — which is the cost that `history`
    // per symbol repeats and this does not. Requests cannot show it: the bodies are cached,
    // so both paths fetch the same three files.
    const symbols = ["NABIL", "ADBL", "ACLBSL", "CHCL", "EBL", "SCB"];
    const bodyReads = (counter: { reads: number }): Cache => {
      const inner = memoryCache();
      return {
        get: async (key) => {
          if (key.startsWith("session/")) counter.reads += 1;
          return inner.get(key);
        },
        set: (key, value) => inner.set(key, value),
      };
    };

    const together = { reads: 0 };
    const perSymbol = { reads: 0 };

    await createClient({ fetch: fakeArchive(ARCHIVE).fetchImpl, cache: bodyReads(together) }).series(
      symbols,
      RANGE,
    );
    const oneAtATime = createClient({
      fetch: fakeArchive(ARCHIVE).fetchImpl,
      cache: bodyReads(perSymbol),
    });
    for (const symbol of symbols) await oneAtATime.history(symbol, RANGE);

    expect(together.reads).toBe(3);
    expect(perSymbol.reads).toBe(18);
  });

  it("keeps a key for a ticker the archive has never listed", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const found = await createClient({ fetch: fetchImpl }).series(["GOOGL"], RANGE);

    // Present and empty: a delisted holding should not look like a broken lookup.
    expect(found.has("GOOGL")).toBe(true);
    expect(found.get("GOOGL")).toEqual([]);
  });

  it("normalises case and whitespace and ignores blanks and duplicates", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const found = await createClient({ fetch: fetchImpl }).series(
      [" nabil ", "NABIL", "", "   "],
      RANGE,
    );

    expect([...found.keys()]).toEqual(["NABIL"]);
    expect(found.get("NABIL")).toHaveLength(3);
  });

  it("asks the archive for nothing when asked about nothing", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const found = await createClient({ fetch: fetchImpl }).series([], RANGE);

    expect(found.size).toBe(0);
    expect(requested).toHaveLength(0);
  });
});

describe("history and the archive's series file", () => {
  const RANGE = { from: "2026-09-29", to: "2026-10-01" };

  /** The same rows a session holds, for one ticker across dates. */
  function seriesBody(symbol: string, closes: Record<string, number>): string {
    const rows = Object.entries(closes).map(
      ([date, close]) =>
        `${date},${symbol},${close - 2},${close + 3},${close - 5},${close},1000,50000`,
    );
    return [HEADER, ...rows].join("\r\n") + "\r\n";
  }

  const NABIL = { "2026-09-29": 560, "2026-09-30": 570, "2026-10-01": 566 };
  const WITH_SERIES: Record<string, string> = {
    ...ARCHIVE,
    "data/series/NABIL.csv": seriesBody("NABIL", NABIL),
  };

  it("returns exactly what the session walk returns", async () => {
    // The assertion this whole feature has to satisfy: the shortcut and the long way round
    // are two independent paths to one fact, and they must agree.
    const viaSeries = await createClient({ fetch: fakeArchive(WITH_SERIES).fetchImpl }).history(
      "NABIL",
      RANGE,
    );
    const viaWalk = await createClient({ fetch: fakeArchive(ARCHIVE).fetchImpl }).history(
      "NABIL",
      RANGE,
    );

    expect(viaSeries).toEqual(viaWalk);
    expect(viaSeries).toHaveLength(3);
  });

  it("costs one request for a year's worth of sessions", async () => {
    const { fetchImpl, requested } = fakeArchive(WITH_SERIES);
    await createClient({ fetch: fetchImpl }).history("NABIL", RANGE);

    expect(requested.filter((url) => url.includes("data/series/"))).toHaveLength(1);
    expect(requested.filter((url) => url.includes("/data/daily/"))).toHaveLength(0);
  });

  it("filters the range locally rather than asking for less", async () => {
    const { fetchImpl, requested } = fakeArchive(WITH_SERIES);
    const client = createClient({ fetch: fetchImpl });

    const narrower = await client.history("NABIL", { from: "2026-09-30", to: "2026-10-01" });

    expect(narrower.map((point) => point.date)).toEqual(["2026-09-30", "2026-10-01"]);
    expect(requested.filter((url) => url.includes("data/series/"))).toHaveLength(1);
  });

  it("answers a second range for the same scrip without another request", async () => {
    const { fetchImpl, requested } = fakeArchive(WITH_SERIES);
    const client = createClient({ fetch: fetchImpl });

    await client.history("NABIL", RANGE);
    await client.history("NABIL", { from: "2026-10-01", to: "2026-10-01" });

    expect(requested.filter((url) => url.includes("data/series/"))).toHaveLength(1);
  });

  it("falls back to the sessions when the archive publishes no series", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const points = await createClient({ fetch: fetchImpl }).history("NABIL", RANGE);

    expect(points).toHaveLength(3);
    expect(requested.some((url) => url.includes("data/series/"))).toBe(true);
    expect(requested.filter((url) => url.includes("/data/daily/"))).toHaveLength(3);
  });

  it("falls back rather than throwing on a series it cannot read", async () => {
    // The file is a shortcut, so a broken one must cost speed and nothing else.
    const { fetchImpl } = fakeArchive({ ...ARCHIVE, "data/series/NABIL.csv": "not a series" });
    const points = await createClient({ fetch: fetchImpl }).history("NABIL", RANGE);

    expect(points).toHaveLength(3);
  });

  it("falls back when the series file cannot be reached", async () => {
    const archive = fakeArchive(ARCHIVE);
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("data/series/")) return new Response("boom", { status: 503 });
      return archive.fetchImpl(url as never, init);
    }) as unknown as typeof fetch;

    const points = await createClient({ fetch: fetchImpl, retries: 0 }).history("NABIL", RANGE);

    expect(points).toHaveLength(3);
  });

  it("remembers an absent series only until the archive might have published one", async () => {
    // The opposite of a session the market did not trade: this absence is expected to go
    // away, so it must not be cached forever.
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl, manifestTtlMs: 0 });

    await client.history("NABIL", RANGE);
    await client.history("NABIL", RANGE);

    expect(requested.filter((url) => url.includes("data/series/"))).toHaveLength(2);
  });

  it("does not build a path out of a ticker that is not one", async () => {
    // A typo or a scraped string should take the session walk to its usual answer, not
    // become a request for a series file that cannot exist.
    const { fetchImpl, requested } = fakeArchive(WITH_SERIES);
    const points = await createClient({ fetch: fetchImpl }).history("../NABIL", RANGE);

    expect(points).toEqual([]);
    expect(requested.filter((url) => url.includes("data/series/"))).toHaveLength(0);
  });

  it("reads a debenture whose ticker contains a slash", async () => {
    // `GBILD86/87` is one ticker, but as a path it would be a directory. The archive writes
    // it as `GBILD86-87.csv`, and the rows inside still name the ticker properly.
    const withBond: Record<string, string> = {
      ...ARCHIVE,
      "data/series/GBILD86-87.csv": seriesBody("GBILD86/87", {
        "2026-09-30": 1090,
        "2026-10-01": 1091,
      }),
    };

    const { fetchImpl, requested } = fakeArchive(withBond);
    const points = await createClient({ fetch: fetchImpl }).history("gbild86/87", RANGE);

    expect(points.map((point) => point.symbol)).toEqual(["GBILD86/87", "GBILD86/87"]);
    expect(requested.filter((url) => url.includes("data/series/GBILD86-87.csv"))).toHaveLength(1);
    // And never a path that treats the ticker as a directory.
    expect(requested.some((url) => /data\/series\/GBILD86\//.test(url))).toBe(false);
  });

  it("names a series file exactly as the archive does", async () => {
    // A contract with nepse-data's src/lib/series.ts, asserted through the public API
    // rather than by exporting the rule: a disagreement here sends every read to a file
    // that is not there, and falling back to the session walk looks like an archive that
    // simply publishes no series files.
    const cases: [symbol: string, file: string][] = [
      ["NABIL", "NABIL.csv"],
      ["ADBLB86", "ADBLB86.csv"],
      ["GBILD86/87", "GBILD86-87.csv"],
      ["NIFRAUR85/", "NIFRAUR85.csv"],
      ["N/A", "N-A.csv"],
    ];

    for (const [symbol, file] of cases) {
      const { fetchImpl, requested } = fakeArchive(WITH_SERIES);
      await createClient({ fetch: fetchImpl }).history(symbol, RANGE);

      const asked = requested.filter((url) => url.includes("data/series/"));
      expect(asked, symbol).toHaveLength(1);
      expect(asked[0]?.endsWith(`data/series/${file}`), symbol).toBe(true);
    }
  });

  it("takes the session walk for anything that is not a ticker", async () => {
    for (const notATicker of ["NABIL BANK", "../NABIL", "///"]) {
      const { fetchImpl, requested } = fakeArchive(WITH_SERIES);
      await createClient({ fetch: fetchImpl }).history(notATicker, RANGE);

      expect(requested.filter((url) => url.includes("data/series/")), notATicker).toHaveLength(0);
    }
  });

  it("refuses an empty symbol instead of searching for one", async () => {
    const { fetchImpl, requested } = fakeArchive(WITH_SERIES);

    await expect(createClient({ fetch: fetchImpl }).history("   ", RANGE)).rejects.toThrow(
      /A symbol is required/,
    );
    expect(requested).toHaveLength(0);
  });

  it("still refuses a range that ends before it starts, on the series path", async () => {
    const { fetchImpl, requested } = fakeArchive(WITH_SERIES);

    await expect(
      createClient({ fetch: fetchImpl }).history("NABIL", { from: "2026-10-01", to: "2026-09-01" }),
    ).rejects.toThrow(/before it starts/);
    expect(requested).toHaveLength(0);
  });
});

describe("sessionDates", () => {
  it("lists the sessions in a range without fetching any of them", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const dates = await client.sessionDates({ from: "2026-09-01", to: "2026-10-01" });

    expect(dates).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(requested.filter((url) => url.endsWith(".csv"))).toHaveLength(0);
  });

  it("reads the date list once across many ranges, because it only ever grows", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await client.sessionDates({ from: "2026-09-01", to: "2026-10-01" });
    await client.sessionDates({ from: "2026-09-29", to: "2026-09-30" });

    expect(requested.filter((url) => url.endsWith("sessions.json"))).toHaveLength(1);
  });
});

describe("the errors a caller can catch", () => {
  // The point of a named error is that somebody acts on it. `SessionNotFoundError` was
  // exported and documented for a year while `session()` actually threw a format error,
  // so a caller handling holidays caught nothing at all and had no way to notice.
  it("throws SessionNotFoundError for a day the market did not trade", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await expect(client.session("2026-09-28")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("throws SymbolNotFoundError for a ticker that is not listed", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    await expect(client.quote("NOSUCH")).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it("keeps the two apart, because they mean different things", async () => {
    // One is a day the exchange was shut; the other is a scrip that is suspended or
    // misspelt. A caller retrying the first wastes time, and one treating the second as
    // a holiday is simply wrong.
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const missingDay = await client.session("2026-09-28").catch((error: unknown) => error);
    const missingSymbol = await client.quote("NOSUCH").catch((error: unknown) => error);

    expect(missingDay).toBeInstanceOf(SessionNotFoundError);
    expect(missingSymbol).not.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("symbols", () => {
  it("lists what the latest session holds", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    expect(await client.symbols()).toEqual(["NABIL", "ADBL"]);
  });
});

describe("directory and names", () => {
  it("returns ticker to company name", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    const directory = await client.directory();

    expect(directory["NABIL"]?.name).toBe("Nabil Bank Limited");
    expect(directory["OLD"]?.lastSeen).toBe("2020-01-01");
  });

  it("looks a name up without caring about case", async () => {
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    expect(await client.name("nabil")).toBe("Nabil Bank Limited");
  });

  it("returns null for a ticker the archive has never named", async () => {
    // Rather than throwing: a missing name is not a broken lookup, and a caller that has
    // to catch an exception to fall back to the ticker will not bother.
    const { fetchImpl } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl });

    expect(await client.name("NOSUCH")).toBeNull();
  });

  it("is an empty directory, not an error, when none is published", async () => {
    const withoutDirectory = { ...ARCHIVE };
    delete withoutDirectory["data/symbols.json"];

    const { fetchImpl } = fakeArchive(withoutDirectory);
    const client = createClient({ fetch: fetchImpl });

    expect(await client.directory()).toEqual({});
    expect(await client.name("NABIL")).toBeNull();
  });

  it("re-reads the directory once it expires, so a new listing is not missed", async () => {
    // Same failure mode as the session list: scrips are added, so a copy cached forever
    // could never name a company listed after it was read.
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl, manifestTtlMs: 0 });

    await client.directory();
    await client.directory();

    expect(requested.filter((url) => url.endsWith("symbols.json"))).toHaveLength(2);
  });

  it("uses the directory even when caching is switched off", async () => {
    const { fetchImpl, requested } = fakeArchive(ARCHIVE);
    const client = createClient({ fetch: fetchImpl, cache: noCache() });

    expect(await client.name("NABIL")).toBe("Nabil Bank Limited");
    expect(requested.filter((url) => url.endsWith("symbols.json"))).toHaveLength(1);
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
