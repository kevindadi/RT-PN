// Shared helpers for the RT-PN build scripts.
//
// Everything here is dependency-free Node (>= 20) so the same scripts run from
// `just`, from npm scripts, and in CI without an install step.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const isWindows = process.platform === "win32";

/** Binary name with the platform extension (`ptpn` / `ptpn.exe`). */
export function bin(name) {
  return isWindows ? `${name}.exe` : name;
}

export const paths = {
  root,
  engines: path.join(root, "engines"),
  ptpnEngine: path.join(root, "engines", "prioritized-tpn"),
  elf2tdgEngine: path.join(root, "engines", "elf2tdg"),
  build: path.join(root, "build"),
  ptpnBuild: path.join(root, "build", "ptpn"),
  cargoTarget: path.join(root, "build", "cargo"),
  smoke: path.join(root, "build", "smoke"),
  e2e: path.join(root, "build", "e2e"),
  versions: path.join(root, "build", "versions.json"),
  sidecars: path.join(root, "src-tauri", "binaries"),
  tauriTarget: path.join(root, "src-tauri", "target"),
  dist: path.join(root, "dist"),
  portable: path.join(root, "dist", "rt-pn-portable"),
};

// Git for Windows uses schannel by default, which can fail in restricted
// shells. The OpenSSL backend is always available and works everywhere we run.
export const gitTlsEnv = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.sslBackend",
  GIT_CONFIG_VALUE_0: "openssl",
};

export function log(message) {
  console.log(`\n== ${message}`);
}

export function warn(message) {
  console.warn(`warning: ${message}`);
}

export function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Environment for native toolchains that write scratch files to %TEMP%.
 * Agent harnesses and CI runners sometimes redirect TEMP to a short-lived
 * directory, which breaks MSVC (D8050/LNK1104) writes.
 */
export function scratchEnv() {
  const dir = path.join(paths.build, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return {
    TEMP: dir,
    TMP: dir,
    // Keep MSVC diagnostics in English: cc-rs parses /showIncludes output,
    // which otherwise leaks into the log on localized installs.
    VSLANG: "1033",
  };
}

export function exists(file) {
  return typeof file === "string" && file.length > 0 && fs.existsSync(file);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Run a command with inherited stdio; exit the script on failure. */
export function run(command, args = [], options = {}) {
  log([command, ...args].join(" "));
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    die(`failed to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`${command} exited with code ${result.status ?? "unknown"}`);
  }
  return result;
}

/** Run a command and capture stdout; exit the script on failure. */
export function capture(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    shell: false,
  });
  if (result.error) {
    die(`failed to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`${command} ${args.join(" ")} failed:\n${(result.stderr || "").trim()}`);
  }
  return (result.stdout || "").trim();
}

/** Run a command and return stdout, or null when it cannot run/fails. */
export function tryCapture(command, args = [], options = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
      shell: false,
    });
    if (result.error || result.status !== 0) return null;
    return (result.stdout || "").trim();
  } catch {
    return null;
  }
}

/** Parse a simple KEY=VALUE env file if it exists. Existing env wins. */
export function loadEnvLocal() {
  const file = path.join(root, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** Locate an executable on PATH. */
export function which(name) {
  const extensions = isWindows
    ? ["", ".exe", ".cmd", ".bat", ".ps1"]
    : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

function firstFile(candidates) {
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

function firstDir(candidates, predicate) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && predicate(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** CLion installations that may carry a bundled CMake/Ninja/MinGW. */
function clionInstallations() {
  const installs = [];
  if (process.env.CLION_HOME) installs.push(process.env.CLION_HOME);

  const roots = [
    "E:/Jetbrains",
    "C:/Program Files/JetBrains",
    path.join(os.homedir(), "AppData", "Local", "Programs"),
  ];
  for (const base of roots) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && /^clion/i.test(entry.name)) {
        installs.push(path.join(base, entry.name));
      }
    }
  }
  return installs.sort().reverse();
}

function visualStudioCmakeCandidates() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!fs.existsSync(vswhere)) return [];
  const install = tryCapture(vswhere, ["-latest", "-products", "*", "-property", "installationPath"]);
  if (!install) return [];
  return [
    path.join(
      install,
      "Common7",
      "IDE",
      "CommonExtensions",
      "Microsoft",
      "CMake",
      "CMake",
      "bin",
      "cmake.exe",
    ),
  ];
}

function detectTriple(rustc) {
  const hostTuple = tryCapture(rustc, ["--print", "host-tuple"]);
  if (hostTuple) return hostTuple;
  const verbose = tryCapture(rustc, ["-vV"]) ?? "";
  const match = /^host:\s*(\S+)$/m.exec(verbose);
  if (match) return match[1];
  die("cannot determine the host target triple: rustc not found (set RUSTC in .env.local)");
}

/**
 * Windows environment variables are case-insensitive, but plain JS objects are
 * not (`set` may print `Path=...` while callers ask for `PATH`). This lookup
 * normalizes the key name.
 */
export function envValue(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

let cachedMsvc;

/** Visual Studio installations that carry the C++ build tools (via vswhere). */
export function visualStudioInstallations() {
  const vswhere = path.join(
    process.env.VSWHERE ??
      path.join(
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
        "Microsoft Visual Studio",
        "Installer",
        "vswhere.exe",
      ),
  );
  if (!fs.existsSync(vswhere)) return [];
  const output = tryCapture(vswhere, [
    "-latest",
    "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ]);
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The environment produced by `vcvars64.bat`: cl.exe on PATH plus INCLUDE/LIB.
 * Cached because it spawns cmd.exe and is needed by both the doctor and the
 * engine build. The batch file is invoked through a generated .cmd file because
 * cmd.exe quoting rules inside a single spawn argument are not reliable.
 */
export function msvcEnvironment() {
  if (cachedMsvc !== undefined) return cachedMsvc;
  const installations = visualStudioInstallations();
  if (process.env.RT_PN_DEBUG) {
    console.error(`[debug] vswhere installations: ${JSON.stringify(installations)}`);
  }
  for (const install of installations) {
    const vcvars = path.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
    if (!fs.existsSync(vcvars)) continue;

    const script = path.join(os.tmpdir(), `rt-pn-vcvars-${process.pid}.cmd`);
    fs.writeFileSync(
      script,
      ["@echo off", `call "${vcvars}" >nul 2>&1`, "if errorlevel 1 exit /b 1", "set", ""].join("\r\n"),
      "utf8",
    );
    let output = null;
    try {
      const result = spawnSync("cmd.exe", ["/c", script], {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        shell: false,
      });
      if (process.env.RT_PN_DEBUG) {
        console.error(
          `[debug] vcvars capture: status=${result.status} error=${result.error?.message ?? "-"} ` +
            `stdout=${(result.stdout ?? "").length}B stderr=${(result.stderr ?? "").slice(0, 120)}`,
        );
      }
      if (result.status === 0) output = (result.stdout ?? "").trim();
    } finally {
      fs.rmSync(script, { force: true });
    }
    if (!output) continue;

    const env = {};
    for (const line of output.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    // INCLUDE/LIB and a Hostx64 compiler directory both prove the environment
    // was actually captured.
    const hasInclude = typeof envValue(env, "INCLUDE") === "string" && envValue(env, "INCLUDE").length > 0;
    const hasCompiler = /Hostx64[\\/]x64/i.test(envValue(env, "PATH") ?? "");
    if (!hasInclude || !hasCompiler) continue;

    cachedMsvc = { install, vcvars, env };
    return cachedMsvc;
  }
  cachedMsvc = null;
  return cachedMsvc;
}

/**
 * Resolve the host build toolchain.
 *
 * Resolution order per tool: environment override -> PATH -> VS-bundled CMake
 * -> CLion-bundled copies. Missing entries are collected in `missing` so
 * `env.mjs --check` can report all of them at once.
 */
export function detectToolchain({ required = false } = {}) {
  loadEnvLocal();
  const clion = clionInstallations();
  const missing = [];

  const cmake = firstFile([
    process.env.CMAKE,
    which("cmake"),
    ...visualStudioCmakeCandidates(),
    ...clion.map((dir) => path.join(dir, "bin", "cmake", "win", "x64", "bin", "cmake.exe")),
  ]);
  if (!cmake) missing.push("cmake >= 3.27 (set CMAKE in .env.local)");

  const ninja = firstFile([
    process.env.NINJA,
    which("ninja"),
    ...clion.map((dir) => path.join(dir, "bin", "ninja", "win", "x64", "ninja.exe")),
  ]);
  if (!ninja) missing.push("ninja (set NINJA in .env.local)");

  let mingwBin = null;
  const candidates = [
    process.env.PTPN_MINGW_BIN,
    ...clion.map((dir) => path.join(dir, "bin", "mingw", "bin")),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, bin("g++")))) {
      mingwBin = candidate;
      break;
    }
  }
  if (!mingwBin) {
    const gxx = which("g++");
    if (gxx) mingwBin = path.dirname(gxx);
  }

  // The release build prefers the MSVC toolchain: it matches the Rust/Tauri
  // toolchain and is the only one on this machine that can produce a fully
  // static C++ binary (the CLion-bundled MinGW fails even a hello-world
  // `-static` link). RT_PN_CXX=mingw opts into the MinGW fallback.
  const preferMsvc = process.env.RT_PN_CXX !== "mingw";
  const msvc = preferMsvc ? msvcEnvironment() : null;
  const cxxToolchain = msvc ? "msvc" : mingwBin ? "mingw" : null;
  if (!cxxToolchain) {
    missing.push("MSVC C++ build tools (Visual Studio) or MinGW-w64 g++ (set PTPN_MINGW_BIN)");
  }

  const vcpkgRoot = firstDir(
    [process.env.VCPKG_ROOT, "D:/vcpkg", path.join(os.homedir(), "vcpkg")],
    (dir) => fs.existsSync(path.join(dir, "scripts", "buildsystems", "vcpkg.cmake")),
  );
  if (!vcpkgRoot) missing.push("vcpkg checkout (set VCPKG_ROOT in .env.local)");

  const rustc = process.env.RUSTC ?? which("rustc") ?? "rustc";
  const cargo = process.env.CARGO ?? which("cargo") ?? "cargo";
  let triple = null;
  try {
    triple = detectTriple(rustc);
  } catch {
    missing.push("rustc >= 1.88 (install the Rust toolchain or set RUSTC)");
  }

  const objdump = mingwBin
    ? firstFile([path.join(mingwBin, bin("objdump")), which("objdump")])
    : which("objdump");

  const toolchain = {
    cmake,
    ninja,
    mingwBin,
    msvc,
    cxxToolchain,
    vcpkgRoot,
    objdump,
    rustc,
    cargo,
    triple,
    missing,
    clionInstalls: clion,
  };
  if (required && missing.length > 0) {
    die(`missing build tools:\n  - ${missing.join("\n  - ")}`);
  }
  return toolchain;
}
