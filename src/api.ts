import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { AnalysisOptions, AnalysisPayload, ElfWorkflow, EngineHealth, EngineInfo } from "./types";

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

/** Runs the ELF -> readable ELF -> CFG (+ preview image) workflow. */
export function analyzeElf(path: string): Promise<ElfWorkflow> {
  return invoke<ElfWorkflow>("analyze_elf", { path });
}

export function resolveCliPath(): Promise<EngineInfo | null> {
  return invoke<EngineInfo | null>("resolve_cli_path");
}

export function resolveElf2tdgPath(): Promise<EngineInfo | null> {
  return invoke<EngineInfo | null>("resolve_elf2tdg_path");
}
