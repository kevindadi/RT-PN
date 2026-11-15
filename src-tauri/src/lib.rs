mod binary;
mod cli;
mod dot;
mod graph;
mod model;
mod workbench;

use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

use crate::binary::BinaryArtifacts;
use crate::graph::Graph;
use crate::model::AnalysisResult;
use crate::workbench::WorkbenchDocs;

#[derive(Serialize)]
struct AnalysisPayload {
    result: AnalysisResult,
    docs: WorkbenchDocs,
    ptpn_graph: Option<Graph>,
    state_graph: Option<Graph>,
}

#[derive(Serialize)]
struct BinaryPayload {
    docs: binary::BinaryDocs,
    elf_path: String,
    bundle_path: Option<String>,
    file_size: u64,
}

#[tauri::command]
fn resolve_cli_path() -> Option<String> {
    cli::resolve_cli().map(|path| path.display().to_string())
}

#[tauri::command]
fn startup_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| {
            let lower = arg.to_ascii_lowercase();
            lower.ends_with(".rtsl")
                || lower.ends_with(".json")
                || lower.ends_with(".ptpn")
                || lower.ends_with(".elf")
                || lower.ends_with(".out")
                || lower.ends_with(".axf")
        })
        .collect()
}

#[tauri::command]
async fn analyze_model(path: String) -> Result<AnalysisPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cli_path = cli::resolve_cli().ok_or_else(|| {
            "ptpn CLI not found. Set PTPN_BIN or build the C++ analyzer.".to_string()
        })?;
        let input = PathBuf::from(&path);
        let mut result = cli::run_analysis(&cli_path, &input);
        if result.workflow_label.is_empty() {
            result.workflow_label = "SPEC-FIRST".to_string();
        }
        let docs = workbench::render(&result);
        let ptpn_graph = result.net.valid.then(|| Graph::from_petri(&result.net));
        let state_graph = result.scg.valid.then(|| Graph::from_state(&result.scg));
        Ok(AnalysisPayload {
            result,
            docs,
            ptpn_graph,
            state_graph,
        })
    })
    .await
    .map_err(|error| format!("analysis worker failed: {error}"))?
}

#[tauri::command]
fn load_binary(path: String) -> Result<BinaryPayload, String> {
    let elf = PathBuf::from(&path);
    if !elf.is_file() {
        return Err(format!("ELF not found: {}", elf.display()));
    }
    let artifacts = BinaryArtifacts::load(&elf);
    let docs = binary::render(&artifacts);
    Ok(BinaryPayload {
        docs,
        elf_path: artifacts.elf_path.display().to_string(),
        bundle_path: artifacts.bundle_path.map(|p| p.display().to_string()),
        file_size: artifacts.file_size,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("RT-PN  ·  Real-Time Petri Workbench");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            analyze_model,
            load_binary,
            resolve_cli_path,
            startup_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running RT-PN");
}
