/**
 * The contract with the real archive.
 *
 * **Excluded unless `LIVE=1`.** `pnpm test` never runs this; `pnpm test:live` does.
 *
 * Every other test in this package asserts against bodies written by hand, which means
 * they assert the author's idea of the archive's format — exactly the thing that is wrong
 * when a reader silently stops working. These assert against the bytes the archive really
 * publishes, over the transport a consumer really uses, so a format change on that side
 * fails *here* rather than in somebody's application.
 *
 * Nothing here asserts a specific price, because prices move. It asserts shapes,
 * invariants and agreement between two independent paths to the same fact.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONCURRENCY, DEFAULT_HOSTS, createClient, createTransport, noCache } from "../src/index.js";

const client = createClient({ cache: noCache() });

/**
 * Network tests get a deadline that network tests can meet.
 *
 * Measured runs put a sixty-day range at well under a second, but the same call has been
 * seen take five while a CDN was having a slow minute. A tight timeout here would fail on
 * someone else's bad afternoon and say nothing about this code — and the parallel test
 * below already asserts the speed that actually matters, which is that fetching is not
 * serialised.
 */
const NETWORK_TEST_TIMEOUT_MS = 30_000;

describe("the real archive", () => {
  it("serves a manifest naming a recent session", async () => {
    const manifest = await client.manifest();

    expect(manifest.latest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.previous).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.sessions).toBeGreaterThan(3_000);
    expect(manifest.source).toMatch(/jsdelivr|raw\.githubusercontent/);

    // The archive has been maintained continuously since 2011; if `latest` were far in
    // the past the pipeline would have stopped, which is worth failing on.
    const ageDays = (Date.now() - Date.parse(`${manifest.latest}T00:00:00Z`)) / 86_400_000;
    expect(ageDays, `latest is ${manifest.latest}, ${ageDays.toFixed(1)} days old`).toBeLessThan(10);
  });

  it("parses the newest session with the shipped parser", async () => {
    const session = await client.latest();

    expect(session.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A full modern session is several hundred scrips. Well below that means the archive
    // published a partial day, which its own scraper refuses to do.
    expect(session.rows.length).toBeGreaterThan(100);

    for (const row of session.rows.slice(0, 50)) {
      expect(row.symbol).toMatch(/^[A-Z0-9]{1,20}$/);
      // Never NaN: a missed separator would produce one, and it would be invisible.
      for (const value of [row.open, row.high, row.low, row.close, row.volume, row.turnover]) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("agrees with the previous session about the day change", async () => {
    // Two independent paths to the same number: `quote` reads both sessions itself, and
    // this recomputes the change from `history` over the same two days.
    const manifest = await client.manifest();
    const latest = manifest.latest;
    const previous = manifest.previous;
    if (latest === null || previous === null) throw new Error("the archive holds one session");

    const symbol = (await client.latest()).rows[0]?.symbol;
    if (symbol === undefined) throw new Error("the newest session listed nothing");

    const quote = await client.quote(symbol);
    const series = await client.history(symbol, { from: previous, to: latest });

    expect(series.map((point) => point.date)).toEqual([previous, latest]);
    expect(series.at(-1)?.close).toBe(quote.quote.close);
    expect(series[0]?.close).toBe(quote.previousClose);
  });

  it(
    "reads one scrip the same way from a series file as from the sessions",
    { timeout: NETWORK_TEST_TIMEOUT_MS },
    async ({ skip }) => {
      // The shortcut and the long way round are two independent paths to one fact, so they
      // have to agree on real bytes and not only on fixtures. Where the archive publishes
      // no series file — which is where it starts — there is nothing to compare, and this
      // says so rather than passing quietly on a path it never took.
      const manifest = await client.manifest();
      if (manifest.latest === null) throw new Error("the archive is empty");

      const symbol = (await client.latest()).rows[0]?.symbol;
      if (symbol === undefined) throw new Error("the newest session listed nothing");

      // Asked of the transport directly, so whether the file exists is not decided by the
      // code this test is about.
      const published = await createTransport({ hosts: DEFAULT_HOSTS })
        .get(`data/series/${symbol}.csv`)
        .then(() => true)
        .catch(() => false);

      if (!published) {
        skip(`the archive publishes no series file for ${symbol} yet`);
        return;
      }

      const to = manifest.latest;
      const from = new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const range = { from, to };

      const viaSeries = await client.history(symbol, range);
      const viaWalk = (await client.sessions(range))
        .map((entry) => {
          const row = entry.rows.find((candidate) => candidate.symbol === symbol);
          return row === undefined ? null : { ...row, date: entry.date };
        })
        .filter((point) => point !== null);

      expect(viaSeries.length).toBeGreaterThan(0);
      expect(viaSeries).toEqual(viaWalk);
    },
  );

  it("reads a whole range and returns it ascending, without gaps", { timeout: NETWORK_TEST_TIMEOUT_MS }, async () => {
    const manifest = await client.manifest();
    if (manifest.latest === null) throw new Error("the archive is empty");

    // Sixty days back, so a clean month is covered whatever the trading week is.
    const to = manifest.latest;
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);

    const sessions = await client.sessions({ from, to });

    expect(sessions.length).toBeGreaterThan(20);
    expect(sessions.length).toBeLessThanOrEqual(61);

    const dates = sessions.map((entry) => entry.date);
    expect([...dates].sort()).toEqual(dates);
    for (const date of dates) {
      expect(date >= from && date <= to).toBe(true);
    }
  });

  it("finds every session in a range in parallel", { timeout: NETWORK_TEST_TIMEOUT_MS }, async () => {
    // Guards the concurrency path against a regression that would silently serialise it.
    const manifest = await client.manifest();
    if (manifest.latest === null) throw new Error("the archive is empty");

    const to = manifest.latest;
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);

    const started = Date.now();
    const sessions = await client.sessions({ from, to });
    const elapsed = Date.now() - started;

    expect(sessions.length).toBeGreaterThan(10);
    // Sequential fetching measures ~820 ms a file, so 31 calendar days would take ~25 s.
    // This is a loose bound; it exists to catch serialisation, not to benchmark.
    expect(elapsed, `took ${elapsed}ms at concurrency ${DEFAULT_CONCURRENCY}`).toBeLessThan(15_000);
  });

  it(
    "reads a year of the market the same way from closes files as from the sessions",
    { timeout: NETWORK_TEST_TIMEOUT_MS },
    async ({ skip }) => {
      // The same two-paths check as the series file above, for the other index: whatever a
      // consumer computes from closes() has to be what it would have computed from the
      // sessions. Where the archive publishes no closes file there is nothing to compare.
      const manifest = await client.manifest();
      if (manifest.latest === null) throw new Error("the archive is empty");

      const year = manifest.latest.slice(0, 4);

      const published = await createTransport({ hosts: DEFAULT_HOSTS })
        .get(`data/closes/${year}.csv`)
        .then(() => true)
        .catch(() => false);

      if (!published) {
        skip(`the archive publishes no closes file for ${year} yet`);
        return;
      }

      const to = manifest.latest;
      const from = new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const range = { from, to };

      const viaFiles = await client.closes(range);
      const viaSessions = (await client.sessions(range)).map((session) => ({
        date: session.date,
        closes: new Map(
          session.rows.flatMap((row) =>
            row.close === null ? [] : [[row.symbol, row.close] as [string, number]],
          ),
        ),
      }));

      expect(viaFiles.length).toBeGreaterThan(20);
      expect(viaFiles).toEqual(viaSessions);
    },
  );

  it("serves the exchange's own index levels", async () => {
    const levels = await client.indices();

    // The archive began publishing these on 2026-10-07, so an empty list means the artifact
    // is not reaching this client rather than that the market has no indices.
    expect(levels.length).toBeGreaterThan(5);

    const nepse = levels.find((level) => level.key === "nepse");
    expect(nepse?.name).toMatch(/nepse/i);
    expect(nepse?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nepse?.close).toBeGreaterThan(0);

    // Every level is keyed by something that could name a file, which is what makes the key
    // a usable argument to `indexHistory`.
    for (const level of levels) expect(level.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("agrees with itself about an index: levels and history are the same figure", async () => {
    // Two independent paths to one fact, which is the shape of assertion this file is for.
    // `indices()` reads data/indices/latest.json and `indexHistory()` reads the per-index
    // CSV, so a disagreement means one of the two artifacts is stale or was written wrong.
    const levels = await client.indices();
    const nepse = levels.find((level) => level.key === "nepse");
    expect(nepse).toBeDefined();
    if (nepse === undefined) return;

    const rows = await client.indexHistory("nepse", { from: nepse.date, to: nepse.date });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.close).toBe(nepse.close);
    expect(rows[0]?.change).toBe(nepse.change);
    expect(rows[0]?.turnover).toBe(nepse.turnover);
  });

  it("reports a key the archive does not publish as absent", async () => {
    await expect(
      client.indexHistory("not-an-index", { from: "2026-10-01", to: "2026-10-31" }),
    ).resolves.toEqual([]);
  });

  it("reports a date the archive does not hold as absent", async () => {
    // April 2020 is the safest genuinely empty period the archive has: NEPSE halted
    // trading for the COVID lockdown and the whole month has no sessions at all.
    //
    // A date more than a decade back would be the wrong choice — the first version of
    // this test used 1 January 2012, which *is* in the archive, because the market
    // traded Sundays then and this client was written after it stopped.
    await expect(client.session("2020-04-15")).rejects.toThrow(/no session for 2020-04-15/);
  });
});
