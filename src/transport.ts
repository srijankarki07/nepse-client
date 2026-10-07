/**
 * Getting bytes out of the archive.
 *
 * ## Two hosts, because one of them is a CDN
 *
 * jsDelivr serves the archive from an edge in Mumbai, which measured **28 ms** from Nepal
 * against 400 ms for `raw.githubusercontent.com`. It is the primary for that reason. Raw
 * is the origin, and it is the fallback: a CDN can be purged, can be having a bad minute,
 * or can be serving a cached copy older than the origin holds.
 *
 * Both were checked for CORS before this was written — `access-control-allow-origin: *`
 * on each — because without it a browser could not read the archive at all and the whole
 * design would have needed a server.
 *
 * ## Concurrency is 6 because 6 was measured
 *
 * Fetching 24 real sessions sequentially took 19.7 s. Six at a time took **0.31 s** —
 * 820 ms per file down to 13 ms. Twelve at a time was no faster, so 6 is the knee, and
 * going beyond it would only add sockets.
 *
 * ## A 404 is a fact, not a hiccup
 *
 * A missing session file means the archive does not hold that date — almost always
 * because the market did not trade. That is a different thing from a 503, and it is
 * raised as its own error rather than retried or turned into an empty result, because a
 * caller that mistook "no such session" for "a session with no prices" would read a
 * holiday as a market that traded nothing.
 */

/** A date the archive does not hold. Not retried. */
export class SessionNotFoundError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    /**
     * Why the caller thinks it is missing, when it knows better than the path does.
     *
     * The transport can only say "no file at this path"; a caller asking for a session
     * can say "the market did not trade that day", which is what the reader actually
     * needs. Without this the message describes an HTTP exchange instead of a market.
     */
    message?: string,
  ) {
    super(message ?? `The archive has nothing at ${path} (HTTP ${status}).`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * A ticker the archive does not list.
 *
 * Distinct from a missing session: one is a day the market was shut, the other is a scrip
 * that is suspended, delisted, or misspelt. A caller retrying the first would be wasting
 * its time, and a caller treating the second as a holiday would be wrong.
 */
export class SymbolNotFoundError extends Error {
  constructor(
    readonly symbol: string,
    message?: string,
  ) {
    super(message ?? `${symbol} is not in this session.`);
    this.name = "SymbolNotFoundError";
  }
}

/** The archive could not be reached, on any host, after retrying. */
export class ArchiveUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArchiveUnavailableError";
  }
}

export interface Transport {
  /** The body at `path`, or a thrown error. `path` is relative, e.g. `data/latest.json`. */
  get(path: string): Promise<string>;
  /** Hosts in order, so a caller can report which one answered. */
  readonly hosts: readonly string[];
  /** The host that served the most recent successful request. */
  readonly lastHost: string | null;
}

export interface TransportOptions {
  /** The default archive. Overridden mainly by tests. */
  hosts?: readonly string[];
  /** Injected so tests never touch the network. */
  fetch?: typeof fetch;
  /** How many requests may be in flight at once across this transport. */
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
}

export const DEFAULT_HOSTS = [
  "https://cdn.jsdelivr.net/gh/srijankarki07/nepse-data@main",
  "https://raw.githubusercontent.com/srijankarki07/nepse-data/main",
] as const;

/** Measured: twelve was no faster than six. */
export const DEFAULT_CONCURRENCY = 6;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

/**
 * Which fetch cache mode a path should be read with.
 *
 * ## There are three caches, and only two of them were being told what to do
 *
 * The `Cache` adapter and the client's `inFlight` map are this package's own. The third is
 * the browser's HTTP cache, underneath `fetch`, and it is the one that was lying.
 *
 * jsDelivr serves a branch ref with `cache-control: public, max-age=604800` — measured on
 * `latest.json`, `sessions.json` and `symbols.json`, the three files that move. A browser
 * may therefore reuse any of them for seven days *without revalidating*, and no option this
 * package accepts can override a layer it does not control: `manifestTtlMs` calls `fetch`
 * again and the HTTP cache answers from disk.
 *
 * That is a correctness problem rather than a performance one. A week-old `latest.json` is
 * a week-old close on screen, and a week-old `sessions.json` is a chart missing its newest
 * sessions — both silently, and both looking exactly like an archive that simply has no
 * newer data.
 *
 * So the policy is declared per path, and it is the same rule the adapter cache already
 * follows: **immutable caches hard, mutable revalidates.** `no-cache` does not mean "do not
 * cache" — it means "revalidate before reuse", and both hosts send an `ETag`, so an
 * unchanged file costs one conditional request answered with a `304` and a body of nothing.
 */
export function cacheModeFor(path: string): "default" | "no-cache" {
  // A session file is written once and never rewritten, so the HTTP cache may hold it for
  // as long as it likes. This tree carries every long-range read, which is where holding it
  // is worth the most.
  if (path.startsWith("data/daily/")) return "default";

  // Everything else is rewritten in place: the index, the date list, the ticker directory,
  // and the per-symbol series files. Revalidating is the safe default for a path this
  // package does not recognise, too.
  return "no-cache";
}

/** Runs `worker` over `items`, at most `limit` at a time, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;

      const item = items[index];
      if (item === undefined) return;

      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HTTP against the archive, with the fallback and retry policy above.
 *
 * Retries stay *within* a host and then move to the next one, so a host that is refusing
 * everything is abandoned after one round rather than being hammered twice per file
 * across a long history fetch.
 */
export function createTransport(options: TransportOptions = {}): Transport {
  const hosts = options.hosts ?? DEFAULT_HOSTS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;

  if (hosts.length === 0) throw new Error("At least one archive host is required.");

  let lastHost: string | null = null;

  async function getFromHost(host: string, path: string): Promise<string> {
    const response = await doFetch(`${host}/${path}`, {
      headers: { accept: "*/*" },
      // Stated per path rather than left to the browser's default, which for a branch ref
      // is a week. See `cacheModeFor`.
      cache: cacheModeFor(path),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 404 || response.status === 403) {
      // A 403 here means the path is wrong rather than the request being refused —
      // these hosts serve public files and do not authorise per request. Treating it
      // like a 404 keeps a typo from looking like a transient failure and being retried.
      throw new SessionNotFoundError(path, response.status);
    }

    if (!response.ok) {
      throw new ArchiveUnavailableError(`${host} returned ${response.status} for ${path}.`);
    }

    return response.text();
  }

  async function get(path: string): Promise<string> {
    let lastError: unknown = null;

    for (const host of hosts) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(200 * 2 ** (attempt - 1));

        try {
          const body = await getFromHost(host, path);
          lastHost = host;
          return body;
        } catch (error) {
          // A date the archive does not hold is not a failure to recover from: retrying
          // and trying the other host would waste two requests to learn the same thing.
          if (error instanceof SessionNotFoundError) throw error;
          lastError = error;
        }
      }
    }

    throw new ArchiveUnavailableError(
      `No archive host could serve ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { cause: lastError },
    );
  }

  return {
    get,
    hosts,
    get lastHost() {
      return lastHost;
    },
  };
}
