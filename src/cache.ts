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

/**
 * Survives a reload, for browsers.
 *
 * Storage can throw rather than merely fail — a private window, a blocked origin, a full
 * quota — and every operation here swallows that and degrades to a miss. A cache that
 * breaks the application when it is unavailable is worse than no cache, and none of this
 * data is expensive enough to fail over.
 *
 * The quota is real: a full session is around 20 KB and localStorage is typically 5 MB,
 * so a few hundred sessions fit. Writes that overflow simply stop landing.
 */
export function localStorageCache(): Cache {
  return {
    get: async (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: async (key, value) => {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Full, or blocked. A miss next time is the correct outcome.
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
