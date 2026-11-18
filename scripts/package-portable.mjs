// Assemble the portable package:
//
//   dist/rt-pn-portable/
//     rt-pn.exe                      Tauri desktop app
//     bin/ptpn.exe, bin/elf2tdg.exe  engine CLIs (staged sidecars)
//     example/                       TDG / RTSL samples and an ELF fixture
//     run-rt-pn.cmd                  launcher that wires the env vars
//     README.txt
//     versions.json                  written by scripts/versions.mjs
//
// Then zip the folder to dist/RT-PN-<version>-portable-<arch>.zip.

import fs from "node:fs";
import path from "node:path";

import { bin, detectToolchain, ensureDir, exists, log, paths, readJson, run, which } from "./lib.mjs";
import { collectManifest, writeManifest } from "./manifest.mjs";

const toolchain = detectToolchain({ required: true });
const packageJson = readJson(path.join(paths.root, "package.json"));
const tauriConf = readJson(path.join(paths.root, "src-tauri", "tauri.conf.json"));
const version = tauriConf.version ?? packageJson.version;

const appBinary = path.join(paths.tauriTarget, "release", bin("rt-pn"));
if (!exists(appBinary)) {
  console.error(`error: missing ${appBinary}\n  run \`just build\` first`);
  process.exit(1);
}

function copyInto(source, relativeTarget) {
  if (!exists(source)) {
    console.warn(`warning: sample not found, skipping: ${source}`);
    return;
  }
  const target = path.join(paths.portable, relativeTarget);
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

fs.rmSync(paths.portable, { recursive: true, force: true });
ensureDir(path.join(paths.portable, "bin"));
ensureDir(path.join(paths.portable, "example"));

copyInto(appBinary, bin("rt-pn"));
copyInto(
  path.join(paths.sidecars, `ptpn-${toolchain.triple}${bin("")}`),
  path.join("bin", bin("ptpn")),
);
copyInto(
  path.join(paths.sidecars, `elf2tdg-${toolchain.triple}${bin("")}`),
  path.join("bin", bin("elf2tdg")),
);

function copyTree(source, relativeTarget) {
  if (!exists(source)) {
    console.warn(`warning: example tree not found, skipping: ${source}`);
    return;
  }
  const target = path.join(paths.portable, relativeTarget);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

copyTree(paths.ptpnExamples, path.join("examples", "ptpn"));
copyTree(paths.elf2tdgExamples, path.join("examples", "elf2tdg"));

const launcher = [
  "@echo off",
  "setlocal",
  'cd /d "%~dp0"',
  'set "PTPN_BIN=%~dp0bin\\ptpn.exe"',
  'set "ELF2TDG_BIN=%~dp0bin\\elf2tdg.exe"',
  'if not defined PTPN_ARTIFACT_DIR set "PTPN_ARTIFACT_DIR=%~dp0artifacts"',
  'if not exist "%~dp0artifacts" mkdir "%~dp0artifacts"',
  'if not defined RT_PN_WEBVIEW_DATA_DIR set "RT_PN_WEBVIEW_DATA_DIR=%~dp0webview2"',
  'start "" "%~dp0rt-pn.exe" %*',
  "",
].join("\r\n");
fs.writeFileSync(path.join(paths.portable, "run-rt-pn.cmd"), launcher, "utf8");

const readme = [
  "RT-PN portable workbench",
  "=======================",
  "",
  `Version: ${version}   (${toolchain.triple})`,
  "",
  "Run:  run-rt-pn.cmd  [optional-model-path]",
  "",
  "Contents:",
  "  rt-pn.exe          Tauri/React desktop workbench",
  "  bin\\ptpn.exe       real-time scheduling analyzer (PTPN / WCRT / deadlock)",
  "  bin\\elf2tdg.exe    ELF -> Task Dependency Graph extractor",
  "  examples\\ptpn      RTSL/TDG samples (diagnostics, benchmarks, introduction)",
  "  examples\\elf2tdg   ELF fixtures and elf2tdg sample artifacts",
  "  versions.json      exact engine commits and tool versions used for this build",
  "",
  "The launcher points PTPN_BIN/ELF2TDG_BIN at the bundled CLIs and keeps the",
  "WebView2 profile and analysis artifacts inside this folder.",
  "",
  "Requirements:",
  "  - Microsoft Edge WebView2 (included with Windows 11; install the Evergreen",
  "    Runtime on older Windows).",
  "  - Windows x64.",
  "",
  "Source and documentation: https://github.com/kevindadi/RT-PN",
  "",
].join("\r\n");
fs.writeFileSync(path.join(paths.portable, "README.txt"), readme, "utf8");

// The manifest must exist before zipping so the archive is self-describing.
const manifest = collectManifest(toolchain);
writeManifest(paths.versions, manifest);
writeManifest(path.join(paths.portable, "versions.json"), manifest);
log(`wrote ${paths.versions} and ${path.join(paths.portable, "versions.json")}`);

// Zip the folder so the release artifact is a single file.
const zipName = `RT-PN-${version}-portable-${process.arch}.zip`;
const zipPath = path.join(paths.dist, zipName);
fs.rmSync(zipPath, { force: true });
const tar = which("tar");
if (tar) {
  run(tar, ["-a", "-c", "-f", zipPath, "-C", paths.dist, path.basename(paths.portable)]);
} else {
  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${paths.portable}' -DestinationPath '${zipPath}' -Force`,
  ]);
}
const megabytes = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
log(`portable package: ${zipPath} (${megabytes} MB)`);
