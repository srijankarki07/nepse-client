import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The live suite reaches the real CDN and is excluded unless LIVE is set, so the
    // default run is offline and deterministic. See tests/live.test.ts.
    exclude: process.env["LIVE"] === "1" ? [] : ["tests/live.test.ts"],
  },
});
