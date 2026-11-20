// Every advisory ignored by `pnpm audit` (package.json pnpm.auditConfig.ignoreGhsas) must be recorded in
// audit-exceptions.json with an owner and a review date (null only for an acceptance older than this check),
// and fails CI once that date has passed.
//   node scripts/audit-exceptions.mjs            # the CI check
//   node scripts/audit-exceptions.mjs --ids      # the ignored IDs, one per line (Dependency watch)
import { readFileSync } from "node:fs";

const ignored = JSON.parse(readFileSync("package.json", "utf8")).pnpm?.auditConfig?.ignoreGhsas ?? [];
if (process.argv[2] === "--ids") {
  for (const id of ignored) console.log(id);
  process.exit(0);
}
const records = JSON.parse(readFileSync("audit-exceptions.json", "utf8"));
const now = new Date();
let failed = false;
for (const id of ignored) {
  const record = records[id];
  if (!record?.owner || record.reviewBy === undefined) {
    console.log(`${id} is ignored by pnpm audit but has no owner and review date in audit-exceptions.json`);
    failed = true;
  } else if (record.reviewBy && now > new Date(`${record.reviewBy}T23:59:59Z`)) {
    console.log(`${id}: acceptance expired on ${record.reviewBy} (owner: ${record.owner}), review it`);
    failed = true;
  } else {
    const until = record.reviewBy ? `until ${record.reviewBy}` : "with no review date";
    console.log(`${id}: accepted ${until} (owner: ${record.owner}): ${record.package}`);
  }
}
for (const id of Object.keys(records)) {
  if (!ignored.includes(id)) console.log(`${id} is recorded but no longer ignored: delete its record`);
}
if (failed) process.exit(1);
