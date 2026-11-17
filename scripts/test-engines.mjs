// Engine tests:
//   elf2tdg  cargo test --workspace
//   ptpn     CLI smoke tests against the release binary (the full gtest suite
//            lives in the engine repository and runs on its Linux CI)
//
// Fixtures that need cross toolchains (arm-none-eabi-gcc, g++) report skips in
// the upstream tests, so this stays runnable on a plain Windows host.

import fs from "node:fs";
import path from "node:path";

import { bin, detectToolchain, ensureDir, exists, paths, run, scratchEnv } from "./lib.mjs";

const toolchain = detectToolchain({ required: true });
ensureDir(paths.smoke);

const ptpn = path.join(paths.ptpnBuild, bin("ptpn"));
const out = (name) => path.join(paths.smoke, name);

function requireFile(file) {
  if (!exists(file)) throw new Error(`expected output was not produced: ${file}`);
}

try {
  // ---- ptpn: upstream CI smoke sequence -----------------------------------
  if (!exists(ptpn)) throw new Error(`missing ${ptpn}; run \`just engines\` first`);

  run(
    ptpn,
    [
      "tdg",
      "-f", "example/motivating-examples/hw.json",
      "--no-analysis",
      "--export-ptpn", out("hw.ptpn.dot"),
      "--export-wcet", out("hw.wcet.json"),
    ],
    { cwd: paths.ptpnEngine },
  );
  requireFile(out("hw.ptpn.dot"));
  requireFile(out("hw.wcet.json"));

  run(ptpn, ["check", "-f", "test/golden/rtsl/appendix.rtsl"], { cwd: paths.ptpnEngine });

  run(
    ptpn,
    [
      "rtsl",
      "-f", "test/golden/rtsl/appendix.rtsl",
      "--no-analysis",
      "--export-tdg", out("appendix.tdg.json"),
    ],
    { cwd: paths.ptpnEngine },
  );
  requireFile(out("appendix.tdg.json"));
  run(ptpn, ["tdg", "-f", out("appendix.tdg.json"), "--no-analysis"], { cwd: paths.ptpnEngine });

  console.log("\nptpn CLI smoke tests passed.");

  // ---- elf2tdg: workspace unit/integration tests --------------------------
  // `loads_current_test_executable` loads its own test binary and asserts a
  // non-empty COFF symbol table. MSVC-linked PE files carry their symbols in a
  // PDB instead, so the assertion only holds on the upstream Linux/ELF CI.
  run(
    toolchain.cargo,
    [
      "test",
      "--manifest-path", path.join(paths.elf2tdgEngine, "Cargo.toml"),
      "--workspace",
      "--locked",
      "--",
      "--skip", "loader::tests::loads_current_test_executable",
    ],
    { env: { CARGO_TARGET_DIR: paths.cargoTarget, ...scratchEnv() } },
  );
  console.log("\nelf2tdg cargo tests passed.");
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  process.exit(1);
}
