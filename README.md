# nepse-data

Read **NEPSE** end-of-day prices (every listed scrip, every trading session since 2011)
from a public archive that maintains itself.

```bash
npm install @srijankarki44/nepse-data
```

```ts
import { createClient } from "@srijankarki44/nepse-data";

const nepse = createClient();

const market = await nepse.latest();          // every scrip, newest session, one request
const nabil  = await nepse.quote("NABIL");    // with its day change
const year   = await nepse.history("NABIL", { from: "2025-10-01", to: "2026-10-01" });
```

There is a [live demo](https://stocks.srijankarki7.com.np) built on this package.

No API key. No signup. No server. No scraping at runtime. No rate limit you have to think
about. It reads a static archive over a CDN, so it works the same in a browser, in Node,
in a serverless function and in a build step.

---

## What it is, and what it is not

**It is an end-of-day market browser.** The archive holds closing prices only, one file
per trading session, published about an hour after the close.

**It is not a live feed and cannot become one.** There is no tick data and no intraday
data in this source, so nothing built on this package can show a current price. If you
need live prices, this is the wrong package and no amount of caching will change that.

**It does not bundle data.** The package is a query layer. `npm install` gets you a few
kilobytes of TypeScript; the prices are fetched at runtime and are current the moment the
archive publishes them, whatever version of this you have installed. That is deliberate,
npm versions are immutable, and a data-carrying package would need republishing daily.

## Where the data comes from

A separate repository ([`srijankarki07/nepse-data`](https://github.com/srijankarki07/nepse-data),
the archive rather than this package) scrapes ShareSansar's end-of-day table once a day and
commits one CSV per session. It has run on a schedule since October 2026, holds
**3,596 sessions from 2011 to today**, and its files are append-only: a session, once
written, never changes.

Two things follow from that, and both are load-bearing here:

- **Session files are cached forever.** They cannot change, so there is no TTL to guess at.
  Only the index expires.
- **A day the market did not trade has no file.** Ask for one and you get an error, not an
  empty session, "no session" and "a session where nothing traded" are different facts and
  the package keeps them apart.

Read that repository's README for the format, and its `Provenance` section for the
licensing position. The short version: **the code here is MIT; the data is not covered by
it.**

## The API

### `createClient(options?)`

| option | default | |
| --- | --- | --- |
| `cache` | in-memory | `memoryCache()`, `localStorageCache({ maxBytes })`, `fileCache(dir)`, `noCache()` |
| `concurrency` | `6` | requests in flight at once |
| `manifestTtlMs` | `300_000` | how long the index may be reused |
| `hosts` | jsDelivr, then raw GitHub | in order |
| `fetch` | global `fetch` | inject for testing |

### `manifest()`

The index: `{ latest, previous, sessions, years, source }`. Read this first,
`latest` is the freshness signal, and it is the only field that moves day to day.

### `session(date)` · `latest()`

One session, whole market: `{ date, rows }`. `latest()` is the newest.

### `sessions({ from, to, onProgress?, signal? })`

Every session in a calendar range, ascending. Days the market was shut are skipped.

> **This is the expensive call**, though less so than it was. The archive publishes a date
> list, so a year costs **one request to learn which days traded, plus one per session**. That
> is **231 requests and 4.13 MB** for a year, returning 230 sessions. Sessions are
> cached permanently once read, so the second call over the same range costs nothing at all.
>
> It is the right call only when you want the **whole market** across a range. For one
> scrip use `history()`, for a handful use `series()`, and for the newest prices alone use
> `snapshot()`.
>
> Where the archive publishes no date list, the client falls back to walking calendar days
> and probing each one. Slower, and kept because it is the path that cannot be wrong.

### `quote(symbol)`

The newest price with the day change worked out: `close`, `previousClose`, `change`,
`changePercent`.

A change is only reported when **both** sides are known. If the scrip did not trade in the
previous session, or the previous close was zero, these are `null` rather than a figure
computed against nothing.

### `snapshot()`

Every scrip in the newest session, each with its day change: `{ date, previousDate, rows }`.

**This is what a market table, a portfolio or a watchlist should call.** `quote()` costs
three requests for one scrip, so a page holding twenty of them would spend sixty;
`snapshot()` spends the same three and answers for all of them, because the two session
files it reads already hold the whole market. Measured against the archive as it stands:
**3 requests, 37 KB, 359 scrips, 341 of them with a computable change.**

The change rules are `quote()`'s, from the same code: `null` unless both sides are known,
`0` when the price genuinely did not move.

### `history(symbol, { from, to })`

One scrip's series over a range. Sessions where it did not trade contribute no point,
never a `null` gap.

When the archive publishes `data/series/<TICKER>.csv` (one scrip's whole history in the
same eight columns as a session file, ascending by date), this becomes **one request**
instead of one per trading day: measured over a year, 231 requests and 4.13 MB become one
request for the file. The file is read once and kept for `manifestTtlMs`, so every later
range for the same scrip is answered from memory rather than the network.

A ticker is not always a filename. Fourteen of them contain a slash, because the source
names a debenture for the two years it covers: `GBILD86/87` is written as
`data/series/GBILD86-87.csv`, and the rows inside still carry the real ticker. The rule is
that every run of characters outside `A-Za-z0-9` becomes one `-`, and both this package and
the archive apply it, with a test on this side asserting that the two agree.

An archive that publishes no series files, or one whose file cannot be read, falls back
to walking the sessions, which is the path that cannot be wrong. A series file served under
the wrong ticker is refused rather than believed, the same way a session file describing
another day is.

### `series(symbols, { from, to })`

Several scrips' series in a single pass, as a `Map` from ticker to that ticker's points.

The sessions are parsed **once** for the whole set. `history()` per symbol fetches the same
files (they are cached) but parses them again for every symbol, which is the cost that
turns up when a caller moves from one chart to a portfolio. Measured over a year: five
symbols cost **137 ms** here against **636 ms** as five `history()` calls, and the gap
grows with the set.

Every ticker asked for is a key in the result, with an empty array when the archive never
listed it. A delisted holding should not blank the rest of a portfolio, and an absent key
would be indistinguishable from a bug.

### `symbols()`

Tickers listed in the latest session.

### `directory()` · `name(symbol)`

Ticker to **company name**, plus the last session each appeared in. `NABIL` is
Nabil Bank Limited. Use it for a browsable list; a market table of bare tickers is hard
to read.

Compare `lastSeen` against `manifest().latest`: equal means the scrip is still trading,
and a date well behind it means the company stopped.

> **It is not complete, and cannot be.** Names are learned from the source page as scrips
> appear, so a company that stopped trading before the archive began recording names has
> prices here and no name. Recovering those would mean re-reading fifteen years of pages
> for companies that no longer exist. `name()` returns `null` rather than throwing, so
> falling back to the ticker is one line.

### `sessionDates({ from, to })`

Which days in a range actually traded. One request (the archive publishes its date list),
then a filter.

Useful on its own for a picker or a coverage chart, and worth knowing about because it is
what makes `sessions()` and `history()` cheap: the days the market was shut are never
asked about.

## Notes that will save you time

**Concurrency is 6 because 6 was measured.** Fetching 24 sessions sequentially takes
19.7 s; six at a time takes 0.31 s. Twelve is no faster.

**Nulls are real.** A halted scrip has no high price, and the archive writes an empty
field. This package returns `null`, never `0`, because a zero high price is a claim that
it traded at nothing.

**The index, the date list and the directory are re-fetched conditionally, on purpose.**
Those three are the only files the archive rewrites. jsDelivr serves a branch with
`cache-control: max-age=604800`, so a browser would otherwise reuse a week-old `latest.json`
without asking: a week-old close on screen, and a chart missing its newest sessions, with
nothing to indicate it. Session files are immutable and are still cached hard. The
revalidation is a conditional request both hosts answer with `304` and no body, so it costs
a round trip and no bytes.

**`localStorageCache` has a budget, and a year does not fit in it.** A session is about
18 KB and a year is about 230 of them, so a yearly range is roughly 8 MB of UTF-16 against a
per-origin quota of about 5 MB. It therefore evicts oldest-first to a `maxBytes` budget
(4 MiB by default) instead of failing silently partway through. What actually carries a
reload is the browser's own HTTP cache, which holds these files for a week regardless.

**Dates are the session's, never the clock.** The market is shut for holidays and its
trading week has changed, Sunday–Thursday until April 2026, Monday–Friday since. Nothing
here predicts which days trade; it asks.

**A `SessionNotFoundError` is usually a holiday**, not a bug. The message says so.

---

## Licence

MIT for the code (see `LICENSE`). The market data is not covered by it and is not
distributed with this package.
