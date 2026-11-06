import { z } from "zod";

/**
 * Zod 4 builds a code-generated fast path for object schemas, and decides whether that is possible by
 * probing `new Function("")`. Under our CSP (`script-src` without `'unsafe-eval'`) the probe throws, Zod
 * swallows it, and the browser still reports a blocked `eval` violation. `jitless` skips the probe and the
 * generated path (`jit && allowsEval.value` short-circuits in zod/v4/core/schemas.js), at the cost of a few
 * microseconds per parse; form validation does not notice. The CSP is not weakened.
 *
 * The flag is read when an object schema is *created*, so this module must be evaluated before any schema
 * is built: every file that imports "zod" imports this one too (enforced by zod-config.test.ts), and the
 * root provider imports it as well.
 */
z.config({ jitless: true });
