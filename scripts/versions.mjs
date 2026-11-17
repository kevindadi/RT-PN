// Write the build manifest with the exact engine pins and tool versions used
// for the current build.
//
//   build/versions.json                     always
//   dist/rt-pn-portable/versions.json       when the portable package exists
//
// scripts/package-portable.mjs reuses the same manifest generator so the
// portable zip contains it as well.

import path from "node:path";

import { detectToolchain, exists, log, paths } from "./lib.mjs";
import { collectManifest, writeManifest } from "./manifest.mjs";

const toolchain = detectToolchain({ required: true });
const manifest = collectManifest(toolchain);

writeManifest(paths.versions, manifest);
log(`wrote ${paths.versions}`);

const portableManifest = path.join(paths.portable, "versions.json");
if (exists(paths.portable)) {
  writeManifest(portableManifest, manifest);
  log(`wrote ${portableManifest}`);
}

console.log(
  `\nengine pins: prioritized-tpn=${manifest.engines["prioritized-tpn"].describe ?? "?"} ` +
    `elf2tdg=${manifest.engines.elf2tdg.describe ?? "?"}`,
);
