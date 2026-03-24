import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: { NODE_ENV: "test" },
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.integration.test.ts", "node_modules/**"],
  },
});
