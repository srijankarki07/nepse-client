# nepse-data

Read **NEPSE** end-of-day prices (every listed scrip, every trading session since 2011)
from a public archive that maintains itself.

```bash
npm install @srijankarki07/nepse-data
```

```ts
import { createClient } from "@srijankarki07/nepse-data";

const nepse = createClient();

const market = await nepse.latest();          // every scrip, newest session, one request
const nabil  = await nepse.quote("NABIL");    // with its day change
const year   = await nepse.history("NABIL", { from: "2025-10-01", to: "2026-10-01" });
```

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

A separate repository ([`srijankarki07/nepse-data`](https://github.com/srijankarki07/nepse-data)
— the archive, not this package) scrapes ShareSansar's end-of-day table once a day and
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
| `cache` | in-memory | `memoryCache()`, `localStorageCache()`, `fileCache(dir)`, `noCache()` |
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
> list, so a year costs **one request to learn which days traded, plus one per session**,
> about 230 for 2025, rather than the 366 a calendar walk would spend. Sessions are cached
> permanently once read, so the second call over the same range costs nothing at all.
>
> Where the archive publishes no date list, the client falls back to walking calendar days
> and probing each one. Slower, and kept because it is the path that cannot be wrong.

### `quote(symbol)`

The newest price with the day change worked out: `close`, `previousClose`, `change`,
`changePercent`.

A change is only reported when **both** sides are known. If the scrip did not trade in the
previous session, or the previous close was zero, these are `null` rather than a figure
computed against nothing.

### `history(symbol, { from, to })`

One scrip's series over a range. Sessions where it did not trade contribute no point,
never a `null` gap.

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

**Dates are the session's, never the clock.** The market is shut for holidays and its
trading week has changed, Sunday–Thursday until April 2026, Monday–Friday since. Nothing
here predicts which days trade; it asks.

**A `SessionNotFoundError` is usually a holiday**, not a bug. The message says so.

---

## Licence

MIT for the code (see `LICENSE`). The market data is not covered by it and is not
distributed with this package.
