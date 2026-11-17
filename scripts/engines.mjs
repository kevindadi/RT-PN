// Build the two analysis engines:
//   ptpn      C++17 / CMake + Ninja + vcpkg (release: MSVC, static CRT + static
//             Boost -> a single self-contained ptpn.exe for the Tauri sidecar)
//   elf2tdg   Rust / cargo (release, locked)
//
// Usage: node scripts/engines.mjs [all|ptpn|elf2tdg] [--fresh]
//
// The C++ toolchain defaults to MSVC (matches the Rust/Tauri toolchain and is
// the only one that yields a fully static binary here). RT_PN_CXX=mingw
// selects the MinGW fallback; note that the CLion-bundled MinGW 15.2 currently
// cannot link `-static` at all, so the fallback is for diagnostics, not release.

import fs from "node:fs";
import path from "node:path";

import {
  bin,
  detectToolchain,
  ensureDir,
  envValue,
  exists,
  gitTlsEnv,
  log,
  paths,
  run,
  scratchEnv,
  tryCapture,
  warn,
} from "./lib.mjs";

const target = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
const freshRequested = process.argv.includes("--fresh");
const toolchain = detectToolchain({ required: true });

const VCPKG_TRIPLET = toolchain.cxxToolchain === "msvc" ? "x64-windows-static" : "x64-mingw-static";

function buildPtpnMsvc() {
  const { msvc } = toolchain;
  const toolchainFile = path.join(toolchain.vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake");
  // PTPN_BUILD_TESTING=1 configures a second tree that also builds the gtest
  // suites (ctest needs them); the release tree stays test-free and fast.
  const testing = process.env.PTPN_BUILD_TESTING === "1";
  const buildDir = testing ? path.join(paths.build, "ptpn-test") : paths.ptpnBuild;
  const cacheFile = path.join(buildDir, "CMakeCache.txt");

  // Switching C++ toolchains or triplets invalidates the whole build tree: a
  // half-reused cache would mix MSVC and MinGW artefacts.
  let fresh = freshRequested;
  if (!fresh && fs.existsSync(cacheFile)) {
    const cache = fs.readFileSync(cacheFile, "utf8");
    fresh ||= !cache.includes(`VCPKG_TARGET_TRIPLET:STRING=${VCPKG_TRIPLET}`);
    fresh ||= /g\+\+\.exe|gcc\.exe/i.test(cache);
  }
  if (fresh && fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  ensureDir(buildDir);

  const configureArgs = [
    "-S", paths.ptpnEngine,
    "-B", buildDir,
    "-G", "Ninja",
    `-DCMAKE_MAKE_PROGRAM=${toolchain.ninja}`,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
    `-DVCPKG_TARGET_TRIPLET=${VCPKG_TRIPLET}`,
    "-DVCPKG_MANIFEST_MODE=ON",
    // Static C runtime for the vcpkg x64-windows-static dependencies.
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
    // Some FetchContent dependencies still declare cmake_minimum_required < 3.5,
    // which CMake 4 rejects unless the compatibility floor is lowered.
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    testing ? "-DBUILD_TESTING=ON" : "-DBUILD_TESTING=OFF",
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
  ];

  // The vcvars environment uses its own casing (`Path`, `Include`, ...); drop
  // any PATH variant and set one canonical entry that keeps Ninja first.
  const baseEnv = {};
  for (const [key, value] of Object.entries(msvc.env)) {
    if (key.toUpperCase() !== "PATH") baseEnv[key] = value;
  }
  const env = {
    ...baseEnv,
    ...scratchEnv(),
    ...gitTlsEnv,
    VCPKG_ROOT: toolchain.vcpkgRoot,
    VCPKG_DEFAULT_TRIPLET: VCPKG_TRIPLET,
    PATH: [
      path.dirname(toolchain.ninja),
      envValue(msvc.env, "PATH") ?? "",
    ].join(path.delimiter),
  };

  run(toolchain.cmake, configureArgs, { env });
  run(toolchain.cmake, ["--build", buildDir, "--parallel"], { env });

  if (testing) {
    run("ctest", ["--test-dir", buildDir, "--output-on-failure"], {
      env,
      cwd: paths.ptpnEngine,
    });
  }

  const binary = path.join(buildDir, bin("ptpn"));
  if (!exists(binary)) throw new Error(`build finished but ${binary} is missing`);
  verifyStaticMsvc(msvc, binary);
}

function buildPtpnMingw() {
  const compiler = path.join(toolchain.mingwBin, bin("g++"));
  const cCompiler = path.join(toolchain.mingwBin, bin("gcc"));
  const toolchainFile = path.join(toolchain.vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake");
  const cacheFile = path.join(paths.ptpnBuild, "CMakeCache.txt");

  let fresh = freshRequested;
  if (!fresh && fs.existsSync(cacheFile)) {
    const cache = fs.readFileSync(cacheFile, "utf8");
    fresh ||= !cache.includes(`VCPKG_TARGET_TRIPLET:STRING=${VCPKG_TRIPLET}`);
    fresh ||= /cl\.exe|MSVC/i.test(cache);
  }
  if (fresh && fs.existsSync(paths.ptpnBuild)) {
    fs.rmSync(paths.ptpnBuild, { recursive: true, force: true });
  }
  ensureDir(paths.ptpnBuild);

  warn("using the MinGW fallback toolchain (RT_PN_CXX=mingw); full -static links may fail");
  const configureArgs = [
    "-S", paths.ptpnEngine,
    "-B", paths.ptpnBuild,
    "-G", "Ninja",
    `-DCMAKE_MAKE_PROGRAM=${toolchain.ninja}`,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_C_COMPILER=${cCompiler}`,
    `-DCMAKE_CXX_COMPILER=${compiler}`,
    `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
    `-DVCPKG_TARGET_TRIPLET=${VCPKG_TRIPLET}`,
    "-DVCPKG_MANIFEST_MODE=ON",
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    "-DCMAKE_EXE_LINKER_FLAGS=-static -static-libgcc -static-libstdc++",
    "-DBUILD_TESTING=OFF",
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
  ];

  const env = {
    ...scratchEnv(),
    ...gitTlsEnv,
    VCPKG_ROOT: toolchain.vcpkgRoot,
    VCPKG_DEFAULT_TRIPLET: VCPKG_TRIPLET,
    PATH: [
      toolchain.mingwBin,
      path.dirname(toolchain.ninja),
      process.env.PATH ?? "",
    ].join(path.delimiter),
  };

  run(toolchain.cmake, configureArgs, { env });
  run(toolchain.cmake, ["--build", paths.ptpnBuild, "--parallel"], { env });

  const binary = path.join(paths.ptpnBuild, bin("ptpn"));
  if (!exists(binary)) throw new Error(`build finished but ${binary} is missing`);
  verifyStaticMingw(binary);
}

// A static MSVC build must not import the VC++ runtime or any Boost DLL.
function verifyStaticMsvc(msvc, binary) {
  const dumpbin = path.join(
    envValue(msvc.env, "VCToolsInstallDir") ?? "",
    "bin",
    "Hostx64",
    "x64",
    "dumpbin.exe",
  );
  if (!exists(dumpbin)) {
    warn("dumpbin not found; skipping the static import check");
    return;
  }
  const dump = tryCapture(dumpbin, ["/dependents", binary]);
  if (!dump) {
    warn("dumpbin failed; skipping the static import check");
    return;
  }
  const unwanted = /^(vcruntime|msvcp|ucrtbase|concrt|boost_|libstdc|libgcc|libwinpthread)/i;
  const imported = [...dump.matchAll(/^\s+(\S+\.dll)\s*$/gim)]
    .map((match) => match[1])
    .filter((dll) => unwanted.test(dll));
  if (imported.length > 0) {
    warn(`ptpn still imports non-system DLLs: ${[...new Set(imported)].join(", ")}`);
  } else {
    log("ptpn.exe is statically linked (system DLLs only)");
  }
}

// The MinGW fallback should leave only Windows system DLLs.
function verifyStaticMingw(binary) {
  if (!toolchain.objdump) {
    warn("objdump not found; skipping the static import check");
    return;
  }
  const dump = tryCapture(toolchain.objdump, ["-p", binary]);
  if (!dump) {
    warn("objdump failed; skipping the static import check");
    return;
  }
  const systemDll =
    /^(kernel32|kernelbase|user32|advapi32|shell32|ole32|oleaut32|ws2_32|psapi|msvcrt|api-ms-win|ntdll|bcrypt|crypt32|secur32|iphlpapi|userenv|version|winmm|gdi32|comdlg32|shlwapi|pdb|dbghelp|ucrtbase)/i;
  const imported = [...dump.matchAll(/DLL Name:\s*(\S+)/gi)]
    .map((match) => match[1])
    .filter((dll) => !systemDll.test(dll));
  if (imported.length > 0) {
    warn(`ptpn still imports non-system DLLs: ${[...new Set(imported)].join(", ")}`);
  } else {
    log("ptpn.exe is statically linked (system DLLs only)");
  }
}

function buildElf2tdg() {
  if (!fs.existsSync(path.join(paths.elf2tdgEngine, "Cargo.toml"))) {
    throw new Error(`missing engine checkout: ${paths.elf2tdgEngine} (run \`just setup\`)`);
  }
  ensureDir(paths.build);
  run(
    toolchain.cargo,
    [
      "build",
      "--manifest-path", path.join(paths.elf2tdgEngine, "Cargo.toml"),
      "-p", "elf2tdg",
      "--release",
      "--locked",
    ],
    { env: { CARGO_TARGET_DIR: paths.cargoTarget, ...scratchEnv() } },
  );
  const binary = path.join(paths.cargoTarget, "release", bin("elf2tdg"));
  if (!exists(binary)) throw new Error(`build finished but ${binary} is missing`);
}

try {
  if (target === "all" || target === "ptpn") {
    if (!fs.existsSync(path.join(paths.ptpnEngine, "CMakeLists.txt"))) {
      throw new Error(`missing engine checkout: ${paths.ptpnEngine} (run \`just setup\`)`);
    }
    if (toolchain.cxxToolchain === "msvc") buildPtpnMsvc();
    else buildPtpnMingw();
  }
  if (target === "all" || target === "elf2tdg") buildElf2tdg();
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  process.exit(1);
}

console.log("\nEngines built:");
if (target === "all" || target === "ptpn") {
  console.log(`  ptpn    ${path.join(paths.ptpnBuild, bin("ptpn"))} (${toolchain.cxxToolchain})`);
}
if (target === "all" || target === "elf2tdg") {
  console.log(`  elf2tdg ${path.join(paths.cargoTarget, "release", bin("elf2tdg"))}`);
}
