mod binary;
mod cli;
mod dot;
mod graph;
mod model;
mod workbench;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::binary::ElfWorkflow;
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

#[tauri::command]
fn resolve_elf2tdg_path() -> Option<String> {
    binary::resolve_elf2tdg().map(|path| path.display().to_string())
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
async fn analyze_elf(path: String) -> Result<ElfWorkflow, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let elf = PathBuf::from(&path);
        if !elf.is_file() {
            return Err(format!("ELF not found: {}", elf.display()));
        }
        binary::analyze(&elf)
    })
    .await
    .map_err(|error| format!("ELF worker failed: {error}"))?
}

fn webview_data_directory(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(directory) = std::env::var("RT_PN_WEBVIEW_DATA_DIR") {
        return PathBuf::from(directory);
    }
    if cfg!(debug_assertions) {
        // Development runs from the repository. Keeping WebView2 state inside
        // the workspace avoids user-profile ACL/locking problems (and leaves the
        // installed app's data untouched).
        if let Ok(cwd) = std::env::current_dir() {
            return cwd.join(".webview2");
        }
    }
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join("webview"))
        .unwrap_or_else(|_| std::env::temp_dir().join("rt-pn-webview"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_directory = webview_data_directory(app.handle());
            let _ = std::fs::create_dir_all(&data_directory);
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("RT-PN  ·  Real-Time Petri Workbench")
                    .inner_size(1540.0, 960.0)
                    .min_inner_size(1120.0, 720.0)
                    .resizable(true)
                    .theme(Some(tauri::Theme::Dark))
                    .data_directory(data_directory)
                    .build()?;
            let _ = window.set_title("RT-PN  ·  Real-Time Petri Workbench");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            analyze_model,
            analyze_elf,
            resolve_cli_path,
            resolve_elf2tdg_path,
            startup_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running RT-PN");
}
