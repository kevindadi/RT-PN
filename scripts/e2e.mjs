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

import { bin, capture, detectToolchain, ensureDir, exists, log, paths, run, which } from "./lib.mjs";

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

  // ---- 2. ELF layout + CFG views (workbench ELF workflow) -----------------
  const elfView = path.join(paths.e2e, "rust.elf.mmd");
  run(elf2tdg, [elfFixture, "--view", "elf", "--output", elfView]);
  requireFile(elfView);
  if (!fs.readFileSync(elfView, "utf8").includes("flowchart")) {
    throw new Error("elf2tdg ELF view did not emit a Mermaid layout");
  }

  const cfgJson = path.join(paths.e2e, "rust.cfg.json");
  run(elf2tdg, [
    elfFixture,
    "--view", "cfg",
    "--format", "json",
    "--no-cfg-instructions",
    "--output", cfgJson,
  ]);
  const cfg = JSON.parse(fs.readFileSync(cfgJson, "utf8"));
  if (!Array.isArray(cfg.functions) || cfg.functions.length === 0) {
    throw new Error("elf2tdg CFG view did not emit functions");
  }

  const cfgDot = path.join(paths.e2e, "rust.cfg.dot");
  run(elf2tdg, [elfFixture, "--view", "cfg", "--format", "dot", "--output", cfgDot]);
  const dot = which("dot") ?? which("dot.exe");
  if (dot) {
    const cfgSvg = path.join(paths.e2e, "rust.cfg.svg");
    run(dot, ["-Tsvg", cfgDot, "-o", cfgSvg]);
    requireFile(cfgSvg);
    log(`CFG preview image: ${cfgSvg} (${fs.statSync(cfgSvg).size} bytes)`);
  } else {
    log("Graphviz not found; CFG preview image check skipped");
  }
  log(`elf2tdg CFG: schema ${cfg.cfg_schema_version}, ${cfg.functions.length} functions`);

  // ---- 3. TDG -> PTPN + state-space analysis ------------------------------
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

  // ---- 4. deadlock counterexample ----------------------------------------
  const deadlockModel = path.join(paths.root, "tests", "fixtures", "ptpn", "deadlock-locks.rtsl");
  const deadlockMetrics = path.join(paths.e2e, "deadlock.metrics.json");
  run(
    ptpn,
    [
      "rtsl",
      "-f", deadlockModel,
      "--max-states", "5000",
      "--timeout", "30",
      "--export-metrics", deadlockMetrics,
      "--export-scg", path.join(paths.e2e, "deadlock.scg.dot"),
    ],
    { cwd: paths.ptpnEngine },
  );
  const deadlockReport = JSON.parse(fs.readFileSync(deadlockMetrics, "utf8"));
  if (!Array.isArray(deadlockReport.deadlock_states) || deadlockReport.deadlock_states.length === 0) {
    throw new Error("deadlock fixture did not produce deadlock states");
  }
  log(`deadlock fixture: ${deadlockReport.deadlock_states.length} deadlock state(s)`);

  // ---- 5. pending `measured by llm` + ptpn fill --------------------------
  const pendingModel = path.join(
    paths.ptpnEngine,
    "example",
    "introduction",
    "demo.rtsl",
  );
  const checkEnvelope = JSON.parse(
    capture(ptpn, ["check", "-f", pendingModel, "--diagnostics", "json"], {
      cwd: paths.ptpnEngine,
    }),
  );
  const pending = checkEnvelope.result?.pending_measurements ?? [];
  if (pending.length === 0) {
    throw new Error("demo.rtsl should report one pending `measured by llm` task");
  }
  const valuesPath = path.join(paths.e2e, "pending.values.json");
  fs.writeFileSync(valuesPath, JSON.stringify({ fusion: [[1, 2], [3, 4], [1, 2]] }), "utf8");
  const fillEnvelope = JSON.parse(
    capture(
      ptpn,
      [
        "fill",
        "-f", pendingModel,
        "--values", valuesPath,
        "--diagnostics", "json",
      ],
      { cwd: paths.ptpnEngine },
    ),
  );
  const patched = fillEnvelope.result?.source ?? "";
  if (!patched.includes("time") || patched.length === 0) {
    throw new Error("ptpn fill did not return the patched source");
  }
  log(`pending timing fill: ${pending[0].task} -> ${patched.split("\n").length} patched lines`);

  // ---- 6. ptpn describe (scheduling policy semantics) ------------------
  const describeEnvelope = JSON.parse(
    capture(
      ptpn,
      [
        "describe",
        "-f", path.join(paths.ptpnEngine, "example", "introduction", "locked.rtsl"),
        "--policy", "fixed_prior_with_restart",
        "--tie", "arbitrary",
        "--diagnostics", "json",
      ],
      { cwd: paths.ptpnEngine },
    ),
  );
  const description = describeEnvelope.result?.description ?? "";
  if (describeEnvelope.ok !== true || description.length === 0) {
    throw new Error("ptpn describe returned no scheduling description");
  }
  log(`describe: ${description.split("\n").length} lines for fixed_prior_with_restart`);

  console.log("\nE2E smoke test passed: elf2tdg + ptpn sidecars are runnable.");
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  process.exit(1);
}
