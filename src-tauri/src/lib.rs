mod binary;
mod cli;
mod dot;
mod engine;
mod graph;
mod model;
mod workbench;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::binary::ElfWorkflow;
use crate::graph::Graph;
use crate::model::AnalysisResult;
use crate::workbench::WorkbenchDocs;

#[derive(Debug, Default, Deserialize)]
struct AnalysisOptions {
    max_states: Option<u64>,
    timeout_secs: Option<u64>,
    max_memory_mb: Option<u64>,
}

impl AnalysisOptions {
    /// Clamp the UI values into the range the analyzer accepts. The defaults keep
    /// state-class exploration bounded: Petri-net reachability graphs can grow
    /// exponentially, so a run must never be unbounded by accident.
    fn budgets(self) -> cli::RunOptions {
        let max_states = self.max_states.unwrap_or(20_000).clamp(100, 1_000_000);
        let timeout_secs = match self.timeout_secs.unwrap_or(120) {
            0 => 0,
            value => value.clamp(5, 3_600),
        };
        let max_memory_mb = match self.max_memory_mb.unwrap_or(2_048) {
            0 => 0,
            value => value.clamp(64, 65_536),
        };
        cli::RunOptions {
            max_states,
            timeout_secs,
            max_memory_mb,
        }
    }
}

#[derive(Default)]
struct RunState {
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
struct EngineHealth {
    name: String,
    path: String,
    source: String,
    external_override: bool,
    version: Option<String>,
}

fn probe_version(path: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).to_string()
    } else {
        String::from_utf8_lossy(&output.stdout).to_string()
    };
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[tauri::command]
fn engine_health() -> Vec<EngineHealth> {
    let mut engines = Vec::new();
    for name in ["ptpn", "elf2tdg"] {
        match engine::locate(name, engine::current_mode()) {
            Some(found) => engines.push(EngineHealth {
                name: name.to_string(),
                path: found.path.display().to_string(),
                source: found.source.as_str().to_string(),
                external_override: found.external_override,
                version: probe_version(&found.path),
            }),
            None => engines.push(EngineHealth {
                name: name.to_string(),
                path: String::new(),
                source: "missing".to_string(),
                external_override: false,
                version: None,
            }),
        }
    }
    engines
}

#[tauri::command]
fn cancel_analysis(state: State<'_, RunState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|error| format!("cannot write {path}: {error}"))
}

#[derive(Serialize)]
struct AnalysisPayload {
    result: AnalysisResult,
    docs: WorkbenchDocs,
    ptpn_graph: Option<Graph>,
    state_graph: Option<Graph>,
}

#[tauri::command]
fn resolve_elf2tdg_path() -> Option<engine::EngineInfo> {
    engine::locate("elf2tdg", engine::current_mode()).map(|binary| binary.info())
}

#[tauri::command]
fn resolve_cli_path() -> Option<engine::EngineInfo> {
    engine::locate("ptpn", engine::current_mode()).map(|binary| binary.info())
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
async fn analyze_model(
    path: String,
    options: Option<AnalysisOptions>,
    app: tauri::AppHandle,
    state: State<'_, RunState>,
) -> Result<AnalysisPayload, String> {
    let budgets = options.unwrap_or_default().budgets();
    state.cancel.store(false, Ordering::Relaxed);
    let cancel = Arc::clone(&state.cancel);
    tauri::async_runtime::spawn_blocking(move || {
        let cli_path = cli::resolve_cli().ok_or_else(|| {
            "ptpn CLI not found. Set PTPN_BIN or build the C++ analyzer.".to_string()
        })?;
        let input = PathBuf::from(&path);
        let started = std::time::Instant::now();
        let mut result = cli::run_analysis(&cli_path, &input, &budgets, &cancel, |line| {
            let _ = app.emit(
                "analysis-log",
                serde_json::json!({
                    "line": line,
                    "elapsed_ms": started.elapsed().as_millis(),
                }),
            );
        });
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
        .manage(RunState::default())
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
            cancel_analysis,
            engine_health,
            resolve_cli_path,
            resolve_elf2tdg_path,
            startup_paths,
            write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running RT-PN");
}
