import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { AnalysisPayload, BinaryPayload } from "./types";

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

export function analyzeModel(path: string): Promise<AnalysisPayload> {
  return invoke<AnalysisPayload>("analyze_model", { path });
}

export function loadBinary(path: string): Promise<BinaryPayload> {
  return invoke<BinaryPayload>("load_binary", { path });
}

export function resolveCliPath(): Promise<string | null> {
  return invoke<string | null>("resolve_cli_path");
}
