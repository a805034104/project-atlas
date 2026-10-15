import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["packages/webview/**", "**/node_modules/**"],
        },
      },
      // React/jsdom component tests (their own Vite plugins + environment).
      "packages/webview/vitest.config.ts",
    ],
  },
});
