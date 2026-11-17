// Remove generated build outputs. Engine checkouts, node_modules and installed
// release artifacts in dist/ (except the portable folder) are kept.

import fs from "node:fs";

import { log, paths } from "./lib.mjs";

const targets = [
  paths.build,
  paths.sidecars,
  paths.portable,
];

for (const target of targets) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    log(`removed ${target}`);
  }
}

console.log("\nClean.");
