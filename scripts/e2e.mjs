// End-to-end smoke test through the *staged* sidecars, so it verifies exactly
// what ships inside the Tauri bundle.
//
//   1. elf2tdg  parses the checked-in Cortex-M ELF fixture -> TDG JSON
//   2. ptpn     analyzes its own TDG example -> PTPN DOT, state graph, metrics
//
// The two engines speak different TDG dialects today (elf2tdg emits a CFG/TDG
// system graph, ptpn consumes its own task/lock TDG), so the bridge between
// them is intentionally out of scope here; this test guards the CLI contract
// and the packaging path.

import fs from "node:fs";
import path from "node:path";

import { bin, detectToolchain, ensureDir, exists, log, paths, run } from "./lib.mjs";

const toolchain = detectToolchain({ required: true });
const suffix = bin("");
const sidecar = (name) => path.join(paths.sidecars, `${name}-${toolchain.triple}${suffix}`);

const elf2tdg = sidecar("elf2tdg");
const ptpn = sidecar("ptpn");

ensureDir(paths.e2e);

const elfFixture = path.join(
  paths.elf2tdgEngine,
  "examples",
  "rust-concurrency",
  "artifacts",
  "rust-concurrency-analysis.elf",
);
const ptpnExample = path.join(paths.ptpnEngine, "example", "motivating-examples", "hw.json");

function requireFile(file) {
  if (!exists(file)) throw new Error(`expected output was not produced: ${file}`);
}

try {
  for (const [name, file] of [
    ["elf2tdg", elf2tdg],
    ["ptpn", ptpn],
  ]) {
    if (!exists(file)) throw new Error(`missing staged ${name} sidecar at ${file}\n  run \`just stage\` first`);
  }
  if (!exists(elfFixture)) throw new Error(`missing ELF fixture: ${elfFixture}`);

  // ---- 1. ELF -> TDG JSON -------------------------------------------------
  const tdgJson = path.join(paths.e2e, "rust-concurrency.tdg.json");
  run(elf2tdg, [elfFixture, "--format", "json", "--output", tdgJson]);
  requireFile(tdgJson);
  const tdg = JSON.parse(fs.readFileSync(tdgJson, "utf8"));
  if (typeof tdg !== "object" || tdg === null) throw new Error("elf2tdg did not emit a JSON object");
  log(`elf2tdg TDG JSON fields: ${Object.keys(tdg).slice(0, 8).join(", ")}`);

  // ---- 2. TDG -> PTPN + state-space analysis ------------------------------
  const ptpnDot = path.join(paths.e2e, "hw.ptpn.dot");
  const scgDot = path.join(paths.e2e, "hw.scg.dot");
  const metricsJson = path.join(paths.e2e, "hw.metrics.json");
  const wcetJson = path.join(paths.e2e, "hw.wcet.json");
  run(
    ptpn,
    [
      "tdg",
      "-f", ptpnExample,
      "--max-states", "20000",
      "--export-ptpn", ptpnDot,
      "--export-scg", scgDot,
      "--export-metrics", metricsJson,
      "--export-wcet", wcetJson,
    ],
    { cwd: paths.ptpnEngine },
  );
  for (const file of [ptpnDot, metricsJson, wcetJson]) requireFile(file);
  const metrics = JSON.parse(fs.readFileSync(metricsJson, "utf8"));
  if (typeof metrics !== "object" || metrics === null) throw new Error("ptpn did not emit metrics JSON");
  log(`ptpn metrics fields: ${Object.keys(metrics).slice(0, 8).join(", ")}`);

  console.log("\nE2E smoke test passed: elf2tdg + ptpn sidecars are runnable.");
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  process.exit(1);
}
