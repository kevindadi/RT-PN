import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  AllocationReport,
  AnalysisOptions,
  AnalysisPayload,
  BinaryFunctionCfg,
  BinaryOptions,
  BinaryProfile,
  ElfWorkflow,
  EngineHealth,
  EngineInfo,
  FilledSource,
  PendingMeasurement,
  WorkspaceProject,
} from "./types";

export async function pickSpecification(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Open a PTPN model",
    filters: [
      { name: "PTPN models", extensions: ["rtsl", "json", "ptpn"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickElf(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Import an ELF artifact",
    filters: [
      { name: "ELF binaries", extensions: ["elf", "out", "axf"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

export function analyzeModel(
  path: string,
  options?: AnalysisOptions,
): Promise<AnalysisPayload> {
  return invoke<AnalysisPayload>("analyze_model", { path, options: options ?? null });
}

/** Terminates the running analyzer process (state-space budget escape hatch). */
export function cancelAnalysis(): Promise<void> {
  return invoke<void>("cancel_analysis");
}

export function engineHealth(): Promise<EngineHealth[]> {
  return invoke<EngineHealth[]>("engine_health");
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

/** Pending `measured by llm` tasks reported by `ptpn check`. */
export function pendingTimings(path: string): Promise<PendingMeasurement[]> {
  return invoke<PendingMeasurement[]>("pending_timings", { path });
}

/** Runs `ptpn fill` and returns the patched source written next to the artifacts. */
export function fillTimings(
  path: string,
  values: Record<string, Array<[number, number]>>,
): Promise<FilledSource> {
  return invoke<FilledSource>("fill_timings", { path, values });
}

/** Searches core allocations and returns the exported allocation report. */
export function allocateCores(
  path: string,
  options?: {
    max_candidates?: number;
    candidate_max_states?: number;
    objective?: string;
    require_certified_wcet?: boolean;
  },
): Promise<AllocationReport> {
  return invoke<AllocationReport>("allocate_cores", { path, options: options ?? null });
}

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** `ptpn describe`: the analyzer's restatement of the effective semantics. */
export function describeModel(
  path: string,
  policy?: string,
  tie?: string,
): Promise<string> {
  return invoke<string>("describe_model", { path, policy: policy ?? null, tie: tie ?? null });
}

/** Base directory holding the packaged examples (`examples/ptpn`, `examples/elf2tdg`). */
export function exampleBase(): Promise<string> {
  return invoke<string>("example_base");
}

export async function pickProject(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Open an RT-PN project",
    filters: [
      { name: "RT-PN project", extensions: ["rtpn"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

/** Runs the ELF -> readable ELF -> CFG (+ preview image) workflow. */
export function analyzeElf(path: string, options?: BinaryOptions): Promise<ElfWorkflow> {
  return invoke<ElfWorkflow>("analyze_elf", { path, options: options ?? null });
}

/** Board timing profiles shipped with the binary example tree. */
export function binaryProfiles(): Promise<BinaryProfile[]> {
  return invoke<BinaryProfile[]>("binary_profiles");
}

/** Save/refresh the persistent workspace project for an analyzed ELF. */
export function workspaceSaveProject(
  name: string,
  elfPath: string,
  options: BinaryOptions,
  payload: ElfWorkflow,
): Promise<WorkspaceProject> {
  return invoke<WorkspaceProject>("workspace_save_project", {
    name,
    elfPath,
    options,
    payload,
  });
}

/** Recent projects, indexed in SQLite for instant startup previews. */
export function workspaceRecent(limit = 12): Promise<WorkspaceProject[]> {
  return invoke<WorkspaceProject[]>("workspace_recent", { limit });
}

/** Restore an analyzed project from its cached text results (no re-analysis). */
export function workspaceOpenProject(id: string): Promise<{
  project: { id: string; elf_path?: string; options?: BinaryOptions };
  payload: ElfWorkflow;
}> {
  return invoke("workspace_open_project", { id });
}

export function workspaceDeleteProject(id: string): Promise<void> {
  return invoke("workspace_delete_project", { id });
}

/** One function's CFG slice for the interactive CFG explorer. */
export function binaryFunction(
  path: string,
  selector: string,
  options?: BinaryOptions,
): Promise<BinaryFunctionCfg> {
  return invoke<BinaryFunctionCfg>("binary_function", {
    path,
    selector,
    options: options ?? null,
  });
}

export function resolveCliPath(): Promise<EngineInfo | null> {
  return invoke<EngineInfo | null>("resolve_cli_path");
}

export function resolveElf2tdgPath(): Promise<EngineInfo | null> {
  return invoke<EngineInfo | null>("resolve_elf2tdg_path");
}
