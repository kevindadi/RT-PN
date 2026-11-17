// Stage the two engine CLIs as Tauri sidecars.
//
// Tauri expects `src-tauri/binaries/<name>-<target-triple>[.exe]` for every
// entry declared in `bundle.externalBin`; tauri-build copies them next to the
// app binary at build/dev time. The same files are reused by the portable
// package script.

import fs from "node:fs";
import path from "node:path";

import { bin, detectToolchain, ensureDir, exists, log, paths } from "./lib.mjs";

const toolchain = detectToolchain({ required: true });
const triple = toolchain.triple;
const suffix = bin("");

function stageSidecar(name, source) {
  if (!exists(source)) {
    throw new Error(`missing ${source}\n  run \`just engines\` first`);
  }
  const target = path.join(paths.sidecars, `${name}-${triple}${suffix}`);
  fs.copyFileSync(source, target);
  const size = (fs.statSync(target).size / (1024 * 1024)).toFixed(1);
  log(`staged ${name} -> ${target} (${size} MB)`);
  return target;
}

// Drop sidecars built for a different target triple so the bundler never picks
// up a stale binary.
function pruneStale(prefix) {
  if (!fs.existsSync(paths.sidecars)) return;
  for (const entry of fs.readdirSync(paths.sidecars)) {
    if (!entry.startsWith(`${prefix}-`) || entry === `${prefix}-${triple}${suffix}`) continue;
    fs.rmSync(path.join(paths.sidecars, entry), { force: true });
    log(`removed stale sidecar ${entry}`);
  }
}

try {
  ensureDir(paths.sidecars);
  stageSidecar("ptpn", path.join(paths.ptpnBuild, bin("ptpn")));
  stageSidecar("elf2tdg", path.join(paths.cargoTarget, "release", bin("elf2tdg")));
  pruneStale("ptpn");
  pruneStale("elf2tdg");
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  process.exit(1);
}

console.log(`\nSidecars for ${triple} staged in ${paths.sidecars}`);
