/**
 * The localStorage adapter, and the budget it now keeps.
 *
 * `localStorage` does not exist in Node, so these install a stand-in and take it away
 * again. The cases that matter are the ones that used to be silent: a range too long to
 * fit, a quota that refuses a write, and a storage area that an earlier version filled
 * before any of this bookkeeping existed.
 */

import { afterEach, describe, expect, it } from "vitest";

import { localStorageCache } from "../src/index.js";

const ORIGINAL = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (ORIGINAL === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", ORIGINAL);
  }
});

/** As much of the `Storage` interface as the adapter uses. */
function fakeStorage(options: { refuseWrites?: boolean } = {}) {
  const map = new Map<string, string>();

  const storage = {
    get length() {
      return map.size;
    },
    key: (at: number) => [...map.keys()][at] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options.refuseWrites === true) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  };

  return { storage, map };
}

function install(storage: unknown): void {
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

/** A key and value that cost exactly `bytes` of the budget. */
const KEY = "k";
const value = (bytes: number) => "x".repeat(bytes / 2 - KEY.length);

describe("localStorageCache", () => {
  it("reads back what it stored", async () => {
    const { storage } = fakeStorage();
    install(storage);

    const cache = localStorageCache();
    await cache.set("session/2026-10-01", "date,symbol\n2026-10-01,NABIL\n");

    expect(await cache.get("session/2026-10-01")).toContain("NABIL");
    expect(await cache.get("session/2026-10-02")).toBeNull();
  });

  it("evicts the oldest keys rather than filling the quota and stopping", async () => {
    // The behaviour this replaces: writes past the quota failed silently, so an
    // arbitrarily-timed prefix of a long range survived and the rest re-fetched forever.
    const { storage, map } = fakeStorage();
    install(storage);

    const cache = localStorageCache({ maxBytes: 500 });
    for (const key of ["a", "b", "c", "d", "e"]) {
      await cache.set(key, value(196));
    }

    expect(map.has("a"), "oldest evicted").toBe(false);
    expect(map.has("b"), "oldest evicted").toBe(false);
    expect(map.has("c"), "oldest evicted").toBe(false);
    expect(await cache.get("d")).not.toBeNull();
    expect(await cache.get("e")).not.toBeNull();
  });

  it("keeps the budget rather than letting the index grow without bound", async () => {
    const { storage } = fakeStorage();
    install(storage);

    const cache = localStorageCache({ maxBytes: 1_000 });
    for (let at = 0; at < 40; at++) {
      await cache.set(`session/${at}`, value(196));
    }

    // The bookkeeping is included in what is measured, so a long run must not creep past
    // the budget by accumulating index entries for keys it already dropped.
    const raw = await cache.get("nepse-data:cache-index");
    const index = JSON.parse(raw ?? "[]") as [string, number][];
    const total = index.reduce((sum, [, size]) => sum + size, 0);

    expect(total).toBeLessThanOrEqual(1_000);
    expect(index.length).toBeLessThanOrEqual(5);
  });

  it("never drops the only key it holds, even when it exceeds the budget", async () => {
    // A single value larger than the budget can still be cached — evicting it would mean
    // never caching that file at all, which is worse than being briefly over.
    const { storage } = fakeStorage();
    install(storage);

    const cache = localStorageCache({ maxBytes: 100 });
    await cache.set("big", value(400));

    expect(await cache.get("big")).not.toBeNull();
  });

  it("treats a refused write as a miss next time, not a failure now", async () => {
    const { storage } = fakeStorage({ refuseWrites: true });
    install(storage);

    const cache = localStorageCache();
    await expect(cache.set("key", "value")).resolves.toBeUndefined();
    expect(await cache.get("key")).toBeNull();
  });

  it("degrades to a miss when there is no storage at all", async () => {
    // The server during a static export, a private window, a blocked origin.
    Reflect.deleteProperty(globalThis, "localStorage");

    const cache = localStorageCache();
    await expect(cache.set("key", "value")).resolves.toBeUndefined();
    expect(await cache.get("key")).toBeNull();
  });

  it("adopts keys written before it kept a budget, so they can still be evicted", async () => {
    // Upgrading should not leave a cache full of entries that are invisible to eviction.
    const { storage, map } = fakeStorage();
    map.set("legacy/old", value(196));
    map.set("legacy/older", value(196));
    install(storage);

    const cache = localStorageCache({ maxBytes: 400 });
    await cache.set("fresh", value(196));

    expect(map.has("legacy/old")).toBe(false);
    expect(map.has("legacy/older")).toBe(false);
    expect(await cache.get("fresh")).not.toBeNull();
  });
});
