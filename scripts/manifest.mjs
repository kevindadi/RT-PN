// Build-manifest collection shared by scripts/versions.mjs and
// scripts/package-portable.mjs. The manifest records the exact engine commits
// and host tool versions used for a release.

import fs from "node:fs";
import path from "node:path";

import { ensureDir, envValue, paths, readJson, tryCapture } from "./lib.mjs";

function gitInfo(dir) {
  const sha = tryCapture("git", ["-C", dir, "rev-parse", "HEAD"]);
  const describe = tryCapture("git", ["-C", dir, "describe", "--tags", "--always"]);
  const branch = tryCapture("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  return { sha, describe, branch };
}

function elf2tdgVersion() {
  const manifest = path.join(paths.elf2tdgEngine, "Cargo.toml");
  if (!fs.existsSync(manifest)) return null;
  const match = /\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/.exec(
    fs.readFileSync(manifest, "utf8"),
  );
  return match?.[1] ?? null;
}

function toolVersion(command, args) {
  if (!command) return null;
  const output = tryCapture(command, args);
  return output ? output.split(/\r?\n/)[0] : null;
}

export function collectManifest(toolchain) {
  const packageJson = readJson(path.join(paths.root, "package.json"));
  const tauriConf = readJson(path.join(paths.root, "src-tauri", "tauri.conf.json"));
  return {
    name: "rt-pn",
    version: tauriConf.version ?? packageJson.version,
    builtAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    targetTriple: toolchain.triple,
    engines: {
      "prioritized-tpn": {
        ...gitInfo(paths.ptpnEngine),
        build: `CMake / ${toolchain.cxxToolchain === "msvc" ? "MSVC static" : "MinGW static"}`,
      },
      elf2tdg: {
        ...gitInfo(paths.elf2tdgEngine),
        version: elf2tdgVersion(),
        build: "cargo release",
      },
    },
    tools: {
      node: process.version,
      rustc: toolVersion(toolchain.rustc, ["--version"]),
      cmake: toolVersion(toolchain.cmake, ["--version"]),
      ninja: toolVersion(toolchain.ninja, ["--version"]),
      vcpkgTriplet: toolchain.cxxToolchain === "msvc" ? "x64-windows-static" : "x64-mingw-static",
      msvcTools: toolchain.msvc ? envValue(toolchain.msvc.env, "VCToolsVersion") : null,
    },
  };
}

export function writeManifest(file, manifest) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
