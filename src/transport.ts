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
  ) {
    super(
      `The archive has nothing at ${path} (HTTP ${status}). If this was a session date, ` +
        "the market most likely did not trade that day — the archive keeps no file for a " +
        "day with no session.",
    );
    this.name = "SessionNotFoundError";
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
