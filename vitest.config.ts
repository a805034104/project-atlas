import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          // Fixture-based tests parse whole RuoYi repos; under full parallel load they need more than 5 s.
          testTimeout: 120_000,
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["packages/webview/**", "**/node_modules/**"],
        },
      },
      // React/jsdom component tests (their own Vite plugins + environment).
      "packages/webview/vitest.config.ts",
    ],
  },
});
