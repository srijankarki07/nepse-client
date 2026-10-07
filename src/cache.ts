/**
 * Caching, and why it can be permanent.
 *
 * ## The archive is append-only, so a session file never changes
 *
 * This is the property the whole cache design rests on, and it is the archive's own
 * guarantee rather than a guess about TTLs: a session is written once and never touched
 * again. `2011-06-13.csv` has held the same bytes since the day it was created.
 *
 * So **session files are cached forever** and never revalidated. Only the manifest
 * expires, because it is the one file that moves — and it moves once a day at most. That
 * is a stronger and simpler rule than any TTL: the data's own immutability decides the
 * policy.
 *
 * The one case where a cached session could go stale is a *correction* — the archive
 * rewriting a day it got wrong. That has not happened, and if it does the answer is a
 * cache-busting version bump, not a shorter TTL that would slow every read forever to
 * guard against something that does not occur.
 *
 * ## Values are strings
 *
 * Keys map to the raw body. Parsing is cheap and keeping the cache dumb means an adapter
 * is a few lines and needs to know nothing about the format.
 */

/** A key/value store. Async because the filesystem adapter has to be. */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** A cache that remembers nothing. What you get when caching is switched off. */
export function noCache(): Cache {
  return {
    get: async () => null,
    set: async () => {},
  };
}

/**
 * The default: a `Map` that lives as long as the client does.
 *
 * Enough for a server process and for a single page session. A browser that reloads
 * loses it, which is what {@link localStorageCache} is for.
 */
export function memoryCache(): Cache {
  const store = new Map<string, string>();

  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

/** How much of the quota this cache will use, in UTF-16 bytes. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Where the write order and size of each key is kept.
 *
 * Namespaced because it shares storage with the entries themselves, and the client's keys
 * are bare strings like `session/2026-10-01`.
 */
const INDEX_KEY = "nepse-data:cache-index";

/** One tracked key: its name, and what it costs of the budget. */
type CacheEntry = [key: string, bytes: number];

/** What a string costs, which is what a quota measures: two bytes per unit. */
function utf16Bytes(key: string, value: string): number {
  return 2 * (key.length + value.length);
}

/**
 * Every key already in storage, for a cache written before the bookkeeping existed.
 *
 * Sizes have to be read back for these, which is the one O(n) read in this adapter and
 * happens once per storage area rather than once per write.
 */
function adopt(store: Storage): CacheEntry[] {
  const adopted: CacheEntry[] = [];

  try {
    for (let at = 0; at < store.length; at++) {
      const key = store.key(at);
      if (key === null || key === INDEX_KEY) continue;
      adopted.push([key, utf16Bytes(key, store.getItem(key) ?? "")]);
    }
  } catch {
    return [];
  }

  return adopted;
}

/**
 * Survives a reload, for browsers.
 *
 * Storage can throw rather than merely fail — a private window, a blocked origin, a full
 * quota — and every operation here swallows that and degrades to a miss. A cache that
 * breaks the application when it is unavailable is worse than no cache, and none of this
 * data is expensive enough to fail over.
 *
 * ## The quota is smaller than the ranges this cache is asked to hold
 *
 * A full session is around 18 KB and a year is about 230 of them, so a yearly range is
 * **~4 MB of compact strings — roughly 8 MB of UTF-16**, against a per-origin quota that is
 * typically 5 MB. A range that long therefore does not fit, at any point, at any budget.
 *
 * The first version of this wrote until the quota refused and then silently stopped
 * storing, which is the worst of both: the caller is told nothing, "cached forever" becomes
 * false somewhere in the middle of a range, and which half survived depends on network
 * timing. So writes are now **budgeted and evicted oldest-first** — the cache holds the
 * most recent keys that fit and says so by what it keeps, rather than by failing quietly.
 *
 * Evicting is cheap here because the browser's HTTP cache sits underneath and holds the
 * same files for a week on its own; a re-read after an eviction is answered from disk, not
 * from the network. **That HTTP cache is the layer that actually carries a reload** — this
 * one is for keys the HTTP cache cannot help with, and for hosts that send no cache headers.
 */
export function localStorageCache(options: { maxBytes?: number } = {}): Cache {
  // Counted in UTF-16 bytes, against a typical 5 MB per-origin quota. Leaving a quarter of
  // it free keeps a write from being the thing that discovers the limit.
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const storage = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      // Accessing the property itself can throw on a blocked origin.
      return null;
    }
  };

  /** The write order and size of each key, so eviction needs no reads of the values. */
  const readIndex = (): CacheEntry[] => {
    const store = storage();
    if (store === null) return [];

    let raw: string | null = null;
    try {
      raw = store.getItem(INDEX_KEY);
    } catch {
      return [];
    }

    // No bookkeeping yet: adopt whatever is already there, so a cache written by an earlier
    // version is evictable rather than occupying the quota for good.
    if (raw === null) return adopt(store);

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is CacheEntry =>
          Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number",
      );
    } catch {
      return [];
    }
  };

  return {
    get: async (key) => {
      try {
        return storage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: async (key, value) => {
      const store = storage();
      if (store === null) return;

      try {
        store.setItem(key, value);
      } catch {
        // Full, or blocked. A miss next time is the correct outcome.
        return;
      }

      const index = readIndex().filter(([existing]) => existing !== key);
      index.push([key, utf16Bytes(key, value)]);

      let total = index.reduce((sum, [, size]) => sum + size, 0);
      while (total > maxBytes && index.length > 1) {
        const oldest = index.shift();
        if (oldest === undefined) break;
        total -= oldest[1];
        try {
          store.removeItem(oldest[0]);
        } catch {
          // It leaves the index either way, which is what stops the loop.
        }
      }

      try {
        store.setItem(INDEX_KEY, JSON.stringify(index));
      } catch {
        // The bookkeeping itself did not fit. The next write rebuilds it by adopting.
      }
    },
  };
}

/**
 * A directory on disk, for Node.
 *
 * `node:fs` is imported dynamically so that importing this package in a browser does not
 * try to resolve a Node builtin. The module is only ever loaded when this adapter is
 * actually constructed.
 *
 * Keys are hashed into filenames because a key is a URL path and a path is not a
 * filename — it contains slashes, and on some systems characters that are not legal.
 */
export async function fileCache(directory: string): Promise<Cache> {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const path = await import("node:path");

  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });

  const fileFor = (key: string) =>
    path.join(root, `${createHash("sha256").update(key).digest("hex")}.txt`);

  return {
    get: async (key) => {
      try {
        return await readFile(fileFor(key), "utf8");
      } catch {
        return null;
      }
    },
    set: async (key, value) => {
      try {
        await writeFile(fileFor(key), value, "utf8");
      } catch {
        // A full or read-only disk is a cache miss next time, not a failure now.
      }
    },
  };
}
