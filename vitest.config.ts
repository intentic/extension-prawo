import { defineConfig } from "vitest/config";

/* The suites use describe/it/expect as globals, as they did under bun's runner in the monorepo. */
export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
        globals: true,
        testTimeout: 20_000,
    },
});
