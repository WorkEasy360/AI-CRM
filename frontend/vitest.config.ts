import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Every file boots its own jsdom. Left unbounded, Vitest forks one worker per core (23 on a big
// laptop), and the resulting memory/CPU thrash is what made the full-directory run stall
// intermittently while single files passed. Bounded workers plus hard timeouts at every level turn
// a stall into a failed run with output instead of a hung process.
const workers = process.env.CI ? 2 : Math.max(1, Math.min(6, availableParallelism() - 1));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["tests/**", "node_modules/**", ".next/**", ".next-build/**"],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    pool: "forks",
    isolate: true,
    maxWorkers: workers,
    testTimeout: 15_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
    reporters: process.env.CI ? ["dot"] : ["default"],
    // A worker that never reports back is a bug, not a wait: fail loudly instead of idling.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
