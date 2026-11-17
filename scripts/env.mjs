// Toolchain doctor: resolves cmake/ninja/MinGW/vcpkg/rustc and checks that the
// engine submodules are checked out. Run through `just doctor` or `just setup`.

import fs from "node:fs";
import path from "node:path";

import { bin, detectToolchain, envValue, paths, tryCapture } from "./lib.mjs";

const strict = process.argv.includes("--check");
const toolchain = detectToolchain({ required: false });

function versionOf(command, args) {
  if (!command) return null;
  return tryCapture(command, args)?.split(/\r?\n/)[0] ?? null;
}

function row(label, value, hint) {
  const shown = value ?? "-";
  console.log(`  ${label.padEnd(10)} ${shown}${value ? "" : `   (${hint})`}`);
}

console.log("\nRT-PN toolchain");
console.log("---------------");
console.log(`  host       ${process.platform} ${process.arch} / ${toolchain.triple ?? "unknown triple"}`);
row("cmake", toolchain.cmake, "set CMAKE in .env.local");
row("ninja", toolchain.ninja, "set NINJA in .env.local");
row(
  "c++",
  toolchain.cxxToolchain === "msvc"
    ? `MSVC (${toolchain.msvc.install})`
    : toolchain.mingwBin
      ? `MinGW (${toolchain.mingwBin})`
      : null,
  "install the Visual Studio C++ build tools",
);
row(
  "c++ triplet",
  toolchain.cxxToolchain === "msvc"
    ? "x64-windows-static"
    : toolchain.cxxToolchain === "mingw"
      ? "x64-mingw-static"
      : null,
  "see the C++ toolchain row",
);
row("vcpkg", toolchain.vcpkgRoot, "set VCPKG_ROOT in .env.local");
row("rustc", toolchain.rustc, "install the Rust toolchain");
row("cargo", toolchain.cargo, "install the Rust toolchain");

const gxx = toolchain.mingwBin ? path.join(toolchain.mingwBin, bin("g++")) : null;
for (const [label, file, args] of [
  ["cmake ver", toolchain.cmake, ["--version"]],
  ["ninja ver", toolchain.ninja, ["--version"]],
  ["msvc ver", null, null],
  ["g++ ver", gxx, ["--version"]],
]) {
  if (label === "msvc ver") {
    if (toolchain.msvc) {
      console.log(`  ${label.padEnd(10)} VCTools ${envValue(toolchain.msvc.env, "VCToolsVersion")}`);
    }
    continue;
  }
  const value = versionOf(file, args);
  if (value) console.log(`  ${label.padEnd(10)} ${value}`);
}

if (toolchain.cxxToolchain === "mingw") {
  console.log("\nnote: MinGW is selected for the C++ engine (RT_PN_CXX=mingw). The");
  console.log("      CLion-bundled MinGW 15.2 cannot link `-static`, so the release");
  console.log("      ptpn.exe will not be self-contained; install the VS C++ build");
  console.log("      tools to use the default static MSVC build.");
}

console.log("\nEngines");
console.log("-------");
const engines = [
  ["prioritized-tpn", paths.ptpnEngine, "CMakeLists.txt"],
  ["elf2tdg", paths.elf2tdgEngine, "Cargo.toml"],
];
let enginesReady = true;
for (const [name, dir, marker] of engines) {
  const ready = fs.existsSync(path.join(dir, marker));
  enginesReady &&= ready;
  console.log(`  ${name.padEnd(16)} ${ready ? dir : "MISSING - run `just setup`"}`);
}

const problems = [...toolchain.missing];
if (!enginesReady) problems.push("engine submodules are not checked out (run `just setup`)");

if (problems.length > 0) {
  console.log(`\n${strict ? "error" : "warning"}: ${problems.length} problem(s)`);
  for (const problem of problems) console.log(`  - ${problem}`);
  if (strict) process.exit(1);
} else {
  console.log("\nAll build tools and engine checkouts are ready.");
}
