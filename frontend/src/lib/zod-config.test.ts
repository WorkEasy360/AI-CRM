import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Zod keeps its settings on globalThis; start each test from a pristine copy of both it and the module graph. */
function reset(): void {
  vi.resetModules();
  delete (globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig;
}

/** Replace the global `Function` constructor with one that records what it was asked to build. */
function watchFunctionConstructor(): { calls: unknown[][]; restore: () => void } {
  const original = globalThis.Function;
  const calls: unknown[][] = [];
  globalThis.Function = new Proxy(original, {
    construct(target, args, newTarget) {
      calls.push(args);
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, thisArg, args) {
      calls.push(args);
      return Reflect.apply(target, thisArg, args);
    },
  });
  return { calls, restore: () => void (globalThis.Function = original) };
}

function parseAnObject(z: typeof import("zod").z): void {
  const schema = z.object({ email: z.email(), name: z.string().min(1), age: z.number().optional() });
  expect(schema.safeParse({ email: "ada@example.com", name: "Ada" }).success).toBe(true);
  expect(schema.safeParse({ email: "nope", name: "" }).success).toBe(false);
}

describe("zod under a CSP without unsafe-eval", () => {
  let watcher: ReturnType<typeof watchFunctionConstructor>;

  beforeEach(() => {
    reset();
    watcher = watchFunctionConstructor();
  });
  afterEach(() => {
    watcher.restore();
    reset();
  });

  it("probes new Function() when nothing configures it (why the config exists)", async () => {
    const { z } = await import("zod");
    parseAnObject(z);
    expect(watcher.calls.length).toBeGreaterThan(0);
  });

  it("never calls the Function constructor once zod-config is imported, not even to probe", async () => {
    await import("@/lib/zod-config");
    const { z } = await import("zod");
    parseAnObject(z);
    expect(z.config().jitless).toBe(true);
    expect(watcher.calls).toEqual([]);
  });

  it("holds for the app's own schemas, which are built when their module loads", async () => {
    await import("@/lib/zod-config");
    const { inviteSchema } = await import("@/lib/validation");
    expect(inviteSchema.safeParse({ email: "ada@example.com", role: "sales_rep" }).success).toBe(true);
    expect(inviteSchema.safeParse({ email: "bad", role: "nobody" }).success).toBe(false);
    expect(watcher.calls).toEqual([]);
  });
});

/** `from "zod"`, `from 'zod'`, `from "zod/v4"`, `import "zod"`, `import("zod")` and `require("zod")`. */
const IMPORTS_ZOD = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']zod(?:\/[^"']*)?["']/;
const IMPORTS_CONFIG = /import\s*["']@\/lib\/zod-config["']/;

describe("every module that builds schemas configures zod first", () => {
  it("recognises every way of importing zod (the guard below is only as good as this)", () => {
    for (const line of [
      'import { z } from "zod";',
      "import { z } from 'zod';",
      'import * as z from "zod/v4";',
      "import { z } from 'zod/mini';",
      'import "zod";',
      'const { z } = require("zod");',
    ]) {
      expect(IMPORTS_ZOD.test(line), line).toBe(true);
    }
    for (const line of ['import { x } from "zodiac";', 'import "@/lib/zod-config";', 'import { z } from "@/lib/zod";']) {
      expect(IMPORTS_ZOD.test(line), line).toBe(false);
    }
    expect(IMPORTS_CONFIG.test("import '@/lib/zod-config';")).toBe(true);
  });

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("imports @/lib/zod-config wherever it imports zod", () => {
    const missing = sources(join(process.cwd(), "src"))
      .filter((path) => !path.endsWith("zod-config.ts"))
      .filter((path) => IMPORTS_ZOD.test(readFileSync(path, "utf8")))
      .filter((path) => !IMPORTS_CONFIG.test(readFileSync(path, "utf8")));
    expect(missing).toEqual([]);
  });
});
