import { defineConfig } from "vitest/config";

// Minimal vitest config for the Stocksie frontend.
//
// `environment: "node"` because the pure modules under test (lib/bestValue.ts)
// have no DOM dependency. If browser-env tests are added later, split them into
// a project or set `environment: "jsdom"` per-file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
