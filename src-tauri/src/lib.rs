mod binary;
mod cli;
mod dot;
mod engine;
mod graph;
mod model;
mod workbench;
mod workspace;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::binary::{BinaryFunctionCfg, ElfWorkflow};
use crate::graph::Graph;
use crate::model::AnalysisResult;
use crate::workbench::WorkbenchDocs;

#[derive(Clone, Debug, Default, Serialize)]
struct TraceStep {
    state: String,
    transition: String,
    marking: String,
    active: String,
    elapsed: String,
}

/// Shortest path from the initial state class to a reachable deadlock, plus a
/// graph payload that the UI can open as a counterexample preview.
fn deadlock_trace(result: &AnalysisResult) -> Option<(Vec<TraceStep>, Graph)> {
    let deadlocks: Vec<usize> = result
        .metrics
        .get("deadlock_states")?
        .as_array()?
        .iter()
        .filter_map(|value| value.as_u64().map(|number| number as usize))
        .collect();
    if deadlocks.is_empty() || result.scg.nodes.is_empty() {
        return None;
    }

    let mut position_by_index: HashMap<i64, usize> = HashMap::new();
    for (position, node) in result.scg.nodes.iter().enumerate() {
        position_by_index.insert(node.index, position);
    }
    let start = position_by_index.get(&0).copied().unwrap_or(0);
    let targets: HashSet<usize> = deadlocks
        .iter()
        .filter_map(|index| position_by_index.get(&(*index as i64)).copied())
        .collect();
    if targets.is_empty() {
        return None;
    }

    let mut adjacency: Vec<Vec<(usize, String)>> = vec![Vec::new(); result.scg.nodes.len()];
    for edge in &result.scg.edges {
        if edge.from < adjacency.len() && edge.to < adjacency.len() {
            adjacency[edge.from].push((edge.to, edge.label.clone()));
        }
    }

    let mut parent: Vec<Option<(usize, String)>> = vec![None; result.scg.nodes.len()];
    let mut visited = vec![false; result.scg.nodes.len()];
    let mut queue = VecDeque::new();
    visited[start] = true;
    queue.push_back(start);
    let mut goal = None;
    while let Some(position) = queue.pop_front() {
        if targets.contains(&position) {
            goal = Some(position);
            break;
        }
        for (next, label) in &adjacency[position] {
            if !visited[*next] {
                visited[*next] = true;
                parent[*next] = Some((position, label.clone()));
                queue.push_back(*next);
            }
        }
    }

    let mut path = Vec::new();
    let mut cursor = goal?;
    loop {
        path.push(cursor);
        match &parent[cursor] {
            Some((previous, _)) => cursor = *previous,
            None => break,
        }
    }
    path.reverse();

    let clamp = |value: &str| -> String {
        let single = value.replace('\n', " ");
        if single.chars().count() > 160 {
            single.chars().take(159).collect::<String>() + "…"
        } else {
            single
        }
    };
    let mut steps = Vec::new();
    for (offset, position) in path.iter().enumerate() {
        let node = &result.scg.nodes[*position];
        let transition = if offset == 0 {
            String::new()
        } else {
            parent[*position]
                .as_ref()
                .map(|(_, label)| clamp(label))
                .unwrap_or_default()
        };
        steps.push(TraceStep {
            state: if node.id.is_empty() {
                format!("s{}", node.index)
            } else {
                node.id.clone()
            },
            transition,
            marking: clamp(&node.marking),
            active: clamp(&node.active),
            elapsed: node.elapsed.clone(),
        });
    }
    let records: Vec<(String, String, String, String)> = steps
        .iter()
        .enumerate()
        .map(|(offset, step)| {
            (
                step.state.clone(),
                if offset + 1 == steps.len() {
                    "deadlock".to_string()
                } else {
                    "state class".to_string()
                },
                step.marking.clone(),
                format!("t={}", step.elapsed),
            )
        })
        .collect();
    let edges: Vec<(usize, usize, String)> = steps
        .windows(2)
        .enumerate()
        .map(|(offset, window)| (offset, offset + 1, window[1].transition.clone()))
        .collect();
    Some((
        steps,
        Graph::from_records("Deadlock counterexample", records, edges),
    ))
}

#[derive(Serialize)]
struct PendingMeasurement {
    task: String,
    runs: Option<u64>,
    timeout: Option<u64>,
    expected_segments: Option<u64>,
    line: Option<u64>,
    column: Option<u64>,
}

#[derive(Serialize)]
struct FilledSource {
    path: String,
    filled: usize,
    remaining_pending: usize,
}

fn run_tool_output(
    cli: &std::path::Path,
    args: &[&std::ffi::OsStr],
    working_directory: Option<&std::path::Path>,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(cli);
    command.args(args);
    if let Some(directory) = working_directory {
        command.current_dir(directory);
    }
    command.env("PATH", cli::augmented_path(cli));
    command
        .output()
        .map_err(|error| format!("failed to start ptpn: {error}"))
}

fn json_from_stdout(output: &std::process::Output) -> Option<serde_json::Value> {
    let text = String::from_utf8_lossy(&output.stdout);
    let start = text.find('{')?;
    serde_json::from_str(&text[start..]).ok()
}

#[tauri::command]
fn pending_timings(path: String) -> Result<Vec<PendingMeasurement>, String> {
    let cli = cli::resolve_cli()
        .ok_or_else(|| "ptpn CLI not found; build it with `just engines`.".to_string())?;
    let input = PathBuf::from(&path);
    let working_directory = input.parent().map(std::path::Path::to_path_buf);
    let output = run_tool_output(
        &cli,
        &[
            std::ffi::OsStr::new("check"),
            std::ffi::OsStr::new("-f"),
            input.as_os_str(),
            std::ffi::OsStr::new("--diagnostics"),
            std::ffi::OsStr::new("json"),
        ],
        working_directory.as_deref(),
    )?;
    let envelope = json_from_stdout(&output)
        .ok_or_else(|| "ptpn check did not produce a JSON envelope".to_string())?;
    let measurements = envelope
        .get("result")
        .and_then(|result| result.get("pending_measurements"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(measurements
        .iter()
        .map(|measurement| PendingMeasurement {
            task: measurement
                .get("task")
                .and_then(|value| value.as_str())
                .unwrap_or("?")
                .to_string(),
            runs: measurement.get("runs").and_then(|value| value.as_u64()),
            timeout: measurement.get("timeout").and_then(|value| value.as_u64()),
            expected_segments: measurement
                .get("expected_segments")
                .and_then(|value| value.as_u64()),
            line: measurement
                .get("inject")
                .and_then(|inject| inject.get("line"))
                .and_then(|value| value.as_u64()),
            column: measurement
                .get("inject")
                .and_then(|inject| inject.get("column"))
                .and_then(|value| value.as_u64()),
        })
        .collect())
}

#[tauri::command]
fn fill_timings(path: String, values: serde_json::Value) -> Result<FilledSource, String> {
    let cli = cli::resolve_cli()
        .ok_or_else(|| "ptpn CLI not found; build it with `just engines`.".to_string())?;
    let input = PathBuf::from(&path);
    let directory = cli::artifact_directory()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("model");
    let values_path = directory.join(format!("{stem}.values-{stamp}.json"));
    let filled_path = directory.join(format!("{stem}.filled-{stamp}.rtsl"));
    let values_source = serde_json::to_string_pretty(&values)
        .map_err(|error| format!("cannot encode timing values: {error}"))?;
    std::fs::write(&values_path, values_source)
        .map_err(|error| format!("cannot write {}: {error}", values_path.display()))?;

    let working_directory = input.parent().map(std::path::Path::to_path_buf);
    let output = run_tool_output(
        &cli,
        &[
            std::ffi::OsStr::new("fill"),
            std::ffi::OsStr::new("-f"),
            input.as_os_str(),
            std::ffi::OsStr::new("--values"),
            values_path.as_os_str(),
            std::ffi::OsStr::new("--diagnostics"),
            std::ffi::OsStr::new("json"),
        ],
        working_directory.as_deref(),
    )?;
    let envelope = json_from_stdout(&output)
        .ok_or_else(|| "ptpn fill did not produce a JSON envelope".to_string())?;
    if envelope.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        let diagnostics = envelope
            .get("diagnostics")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("message").and_then(|value| value.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        return Err(if diagnostics.is_empty() {
            "ptpn fill failed".to_string()
        } else {
            diagnostics
        });
    }
    let result = envelope.get("result").cloned().unwrap_or_default();
    let source = result
        .get("source")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "ptpn fill returned no patched source".to_string())?;
    std::fs::write(&filled_path, source)
        .map_err(|error| format!("cannot write {}: {error}", filled_path.display()))?;
    Ok(FilledSource {
        path: filled_path.display().to_string(),
        filled: result
            .get("filled")
            .and_then(|value| value.as_array())
            .map(|items| items.len())
            .or_else(|| result.get("filled").and_then(|value| value.as_u64()).map(|n| n as usize))
            .unwrap_or(0),
        remaining_pending: result
            .get("remaining_pending")
            .and_then(|value| value.as_array())
            .map(|items| items.len())
            .or_else(|| {
                result
                    .get("remaining_pending")
                    .and_then(|value| value.as_u64())
                    .map(|n| n as usize)
            })
            .unwrap_or(0),
    })
}

#[derive(Debug, Default, Deserialize)]
struct AnalysisOptions {
    max_states: Option<u64>,
    timeout_secs: Option<u64>,
    max_memory_mb: Option<u64>,
    policy: Option<String>,
    tie: Option<String>,
}

/// Values accepted by `ptpn --policy` (docs/ptpn/usage.md, "Scheduling policies").
const SCHEDULING_POLICIES: [&str; 11] = [
    "fixed",
    "fixed_prior_with_resume",
    "fixed_prior_with_restart",
    "rm",
    "dm",
    "pip",
    "pcp",
    "srp",
    "edf",
    "fifo",
    "llf",
];

impl AnalysisOptions {
    /// Clamp the UI values into the range the analyzer accepts. The defaults keep
    /// state-class exploration bounded: Petri-net reachability graphs can grow
    /// exponentially, so a run must never be unbounded by accident.
    fn resolved(self) -> Result<cli::RunOptions, String> {
        let max_states = self.max_states.unwrap_or(20_000).clamp(100, 1_000_000);
        let timeout_secs = match self.timeout_secs.unwrap_or(120) {
            0 => 0,
            value => value.clamp(5, 3_600),
        };
        let max_memory_mb = match self.max_memory_mb.unwrap_or(2_048) {
            0 => 0,
            value => value.clamp(64, 65_536),
        };
        let policy = self.policy.unwrap_or_default();
        if !policy.is_empty() && !SCHEDULING_POLICIES.contains(&policy.as_str()) {
            return Err(format!("unknown scheduling policy `{policy}`"));
        }
        let tie = self.tie.unwrap_or_default();
        if !tie.is_empty() && tie != "fifo" && tie != "arbitrary" {
            return Err(format!("unknown tie mode `{tie}` (expected fifo or arbitrary)"));
        }
        Ok(cli::RunOptions {
            max_states,
            timeout_secs,
            max_memory_mb,
            policy,
            tie,
        })
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

#[derive(Debug, Default, Deserialize)]
struct AllocateOptions {
    max_candidates: Option<u64>,
    candidate_max_states: Option<u64>,
    objective: Option<String>,
    require_certified_wcet: Option<bool>,
}

#[derive(Serialize)]
struct AllocationReport {
    report: serde_json::Value,
    path: String,
}

#[tauri::command]
fn allocate_cores(
    path: String,
    options: Option<AllocateOptions>,
) -> Result<AllocationReport, String> {
    let cli = cli::resolve_cli()
        .ok_or_else(|| "ptpn CLI not found; build it with `just engines`.".to_string())?;
    let input = PathBuf::from(&path);
    let options = options.unwrap_or_default();
    let directory = cli::artifact_directory()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("model");
    let report_path = directory.join(format!("{stem}.allocation-{stamp}.json"));

    let working_directory = input.parent().map(std::path::Path::to_path_buf);
    let mut arguments: Vec<std::ffi::OsString> = vec![
        "allocate".into(),
        "-f".into(),
        input.as_os_str().to_os_string(),
        "-o".into(),
        report_path.clone().into_os_string(),
        "--diagnostics".into(),
        "json".into(),
    ];
    if let Some(max_candidates) = options.max_candidates {
        arguments.push("--max-candidates".into());
        arguments.push(max_candidates.clamp(1, 4_096).to_string().into());
    }
    if let Some(max_states) = options.candidate_max_states {
        arguments.push("--candidate-max-states".into());
        arguments.push(max_states.clamp(100, 200_000).to_string().into());
    }
    if let Some(objective) = options.objective {
        arguments.push("--objective".into());
        arguments.push(objective.into());
    }
    if options.require_certified_wcet.unwrap_or(false) {
        arguments.push("--require-certified-wcet".into());
    }
    let borrowed: Vec<&std::ffi::OsStr> = arguments.iter().map(std::ffi::OsString::as_os_str).collect();
    let output = run_tool_output(&cli, &borrowed, working_directory.as_deref())?;
    let envelope = json_from_stdout(&output)
        .ok_or_else(|| "ptpn allocate did not produce a JSON envelope".to_string())?;
    if envelope.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        let diagnostics = envelope
            .get("diagnostics")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("message").and_then(|value| value.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        return Err(if diagnostics.is_empty() {
            "ptpn allocate failed".to_string()
        } else {
            diagnostics
        });
    }
    let text = std::fs::read_to_string(&report_path)
        .map_err(|error| format!("cannot read {}: {error}", report_path.display()))?;
    let report: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("invalid allocation report: {error}"))?;
    Ok(AllocationReport {
        report,
        path: report_path.display().to_string(),
    })
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|error| format!("cannot write {path}: {error}"))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|error| format!("cannot read {path}: {error}"))
}

fn is_examples_dir(path: &std::path::Path) -> bool {
    path.join("ptpn").is_dir() && path.join("elf2tdg").is_dir()
}

fn examples_directory() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("PTPN_EXAMPLES_DIR") {
        candidates.push(PathBuf::from(value));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("examples"),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(directory) = exe.parent() {
            candidates.push(directory.join("examples"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("examples"));
    }
    candidates.into_iter().find(|candidate| is_examples_dir(candidate))
}

/// Directory that holds the packaged examples (`examples/ptpn`, `examples/elf2tdg`).
///
/// Resolution order: `PTPN_EXAMPLES_DIR`, the repository checkout (debug builds
/// and installed dev builds), next to the executable (portable layout), then the
/// working directory. A candidate is only accepted when it actually contains the
/// `ptpn` and `elf2tdg` trees — Cargo itself creates `target/debug/examples`, so
/// an existence check on `examples/` alone is not enough.
#[tauri::command]
fn example_base() -> Result<String, String> {
    let candidate = examples_directory().ok_or_else(|| {
        "examples directory not found (expected examples/ptpn and examples/elf2tdg)".to_string()
    })?;
    let resolved = candidate.canonicalize().unwrap_or(candidate);
    let mut text = resolved.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        text = format!(r"\\{rest}");
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        text = rest.to_string();
    }
    Ok(text)
}

#[derive(Serialize)]
struct BinaryProfile {
    name: String,
    path: String,
    cpu: Option<String>,
    arch: Option<String>,
}

fn profile_field(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = rest.trim().trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Board timing profiles shipped with the binary workflow example tree.
#[tauri::command]
fn binary_profiles() -> Result<Vec<BinaryProfile>, String> {
    let base = examples_directory()
        .ok_or_else(|| "examples directory not found; cannot list board profiles".to_string())?;
    let directory = base.join("elf2tdg").join("profiles");
    let mut profiles = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("toml") {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("profile")
                .to_string();
            profiles.push(BinaryProfile {
                name,
                path: path.display().to_string(),
                cpu: std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| profile_field(&text, "cpu")),
                arch: std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| profile_field(&text, "arch")),
            });
        }
    }
    profiles.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(profiles)
}

/// `ptpn describe`: the analyzer's own restatement of the effective scheduling
/// semantics (computed priorities, cores, lock nesting, release bindings).
#[tauri::command]
fn describe_model(path: String, policy: Option<String>, tie: Option<String>) -> Result<String, String> {
    let cli = cli::resolve_cli()
        .ok_or_else(|| "ptpn CLI not found; build it with `just engines`.".to_string())?;
    let input = PathBuf::from(&path);
    let mut arguments: Vec<std::ffi::OsString> = vec![
        "describe".into(),
        "-f".into(),
        input.as_os_str().to_os_string(),
        "--diagnostics".into(),
        "json".into(),
    ];
    if let Some(policy) = policy.filter(|value| !value.is_empty()) {
        arguments.push("--policy".into());
        arguments.push(policy.into());
    }
    if let Some(tie) = tie.filter(|value| !value.is_empty()) {
        arguments.push("--tie".into());
        arguments.push(tie.into());
    }
    let borrowed: Vec<&std::ffi::OsStr> = arguments.iter().map(std::ffi::OsString::as_os_str).collect();
    let working_directory = input.parent().map(std::path::Path::to_path_buf);
    let output = run_tool_output(&cli, &borrowed, working_directory.as_deref())?;
    let envelope = json_from_stdout(&output)
        .ok_or_else(|| "ptpn describe did not produce a JSON envelope".to_string())?;
    if envelope.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        let diagnostics = envelope
            .get("diagnostics")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("message").and_then(|value| value.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        return Err(if diagnostics.is_empty() {
            "ptpn describe failed".to_string()
        } else {
            diagnostics
        });
    }
    Ok(envelope
        .pointer("/result/description")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string())
}

#[derive(Serialize)]
struct AnalysisPayload {
    result: AnalysisResult,
    docs: WorkbenchDocs,
    ptpn_graph: Option<Graph>,
    state_graph: Option<Graph>,
    deadlock_trace: Option<Vec<TraceStep>>,
    deadlock_graph: Option<Graph>,
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
    let budgets = match options.unwrap_or_default().resolved() {
        Ok(budgets) => budgets,
        Err(error) => return Err(error),
    };
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
        let (deadlock_trace, deadlock_graph) = match deadlock_trace(&result) {
            Some((steps, graph)) => (Some(steps), Some(graph)),
            None => (None, None),
        };
        Ok(AnalysisPayload {
            result,
            docs,
            ptpn_graph,
            state_graph,
            deadlock_trace,
            deadlock_graph,
        })
    })
    .await
    .map_err(|error| format!("analysis worker failed: {error}"))?
}

#[tauri::command]
async fn analyze_elf(
    path: String,
    options: Option<binary::BinaryOptions>,
) -> Result<ElfWorkflow, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let elf = PathBuf::from(&path);
        if !elf.is_file() {
            return Err(format!("ELF not found: {}", elf.display()));
        }
        binary::analyze(&elf, &options.unwrap_or_default())
    })
    .await
    .map_err(|error| format!("ELF worker failed: {error}"))?
}

#[tauri::command]
async fn workspace_save_project(
    name: String,
    elf_path: String,
    options: serde_json::Value,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace::save_project(&name, &elf_path, &options, &payload)
    })
    .await
    .map_err(|error| format!("workspace worker failed: {error}"))?
}

#[tauri::command]
async fn workspace_recent(limit: Option<u32>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::recent(limit))
        .await
        .map_err(|error| format!("workspace worker failed: {error}"))?
}

#[tauri::command]
async fn workspace_open_project(id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::open_project(&id))
        .await
        .map_err(|error| format!("workspace worker failed: {error}"))?
}

#[tauri::command]
async fn workspace_open_run(id: String, run_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::open_run(&id, &run_id))
        .await
        .map_err(|error| format!("workspace worker failed: {error}"))?
}

#[tauri::command]
async fn workspace_delete_project(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::delete_project(&id))
        .await
        .map_err(|error| format!("workspace worker failed: {error}"))?
}

#[tauri::command]
async fn binary_function(
    path: String,
    selector: String,
    options: Option<binary::BinaryOptions>,
    run_artifact: Option<String>,
) -> Result<BinaryFunctionCfg, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(artifact) = run_artifact {
            return binary::function_cfg_from_run(Path::new(&artifact), &selector);
        }
        let elf = PathBuf::from(&path);
        if !elf.is_file() {
            return Err(format!("ELF not found: {}", elf.display()));
        }
        binary::function_cfg(&elf, &selector, &options.unwrap_or_default())
    })
    .await
    .map_err(|error| format!("ELF function worker failed: {error}"))?
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{StateEdge, StateGraph, StateNode};

    fn state_node(index: i64, marking: &str) -> StateNode {
        StateNode {
            id: format!("s{index}"),
            index,
            marking: marking.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn deadlock_trace_follows_the_shortest_path() {
        let mut scg = StateGraph {
            valid: true,
            ..Default::default()
        };
        scg.nodes = vec![
            state_node(0, "init"),
            state_node(1, "mid"),
            state_node(2, "dead"),
            state_node(3, "unrelated"),
        ];
        scg.edges = vec![
            StateEdge {
                from: 0,
                to: 1,
                label: "T1 @[0, 0]".to_string(),
            },
            StateEdge {
                from: 1,
                to: 2,
                label: "T2 @[1, 1]".to_string(),
            },
            StateEdge {
                from: 0,
                to: 3,
                label: "T0 @[0, 0]".to_string(),
            },
        ];
        let result = AnalysisResult {
            scg,
            metrics: serde_json::json!({ "deadlock_states": [2] }),
            ..Default::default()
        };
        let (steps, graph) = deadlock_trace(&result).expect("deadlock trace");
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].state, "s0");
        assert_eq!(steps[1].state, "s1");
        assert_eq!(steps[2].state, "s2");
        assert_eq!(steps[1].transition, "T1 @[0, 0]");
        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.nodes[2].kind, "deadlock");
    }

    #[test]
    fn deadlock_trace_is_absent_without_deadlocks() {
        let result = AnalysisResult {
            metrics: serde_json::json!({ "deadlock_states": [] }),
            ..Default::default()
        };
        assert!(deadlock_trace(&result).is_none());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RunState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_directory = webview_data_directory(app.handle());
            let _ = std::fs::create_dir_all(&data_directory);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("RT-PN | Real-Time Systems Workbench")
                .inner_size(1540.0, 960.0)
                .min_inner_size(1120.0, 720.0)
                .resizable(true)
                .theme(Some(tauri::Theme::Dark))
                .data_directory(data_directory)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            allocate_cores,
            analyze_model,
            analyze_elf,
            binary_function,
            binary_profiles,
            cancel_analysis,
            describe_model,
            engine_health,
            example_base,
            fill_timings,
            pending_timings,
            read_text_file,
            resolve_cli_path,
            resolve_elf2tdg_path,
            startup_paths,
            workspace_delete_project,
            workspace_open_project,
            workspace_open_run,
            workspace_recent,
            workspace_save_project,
            write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running RT-PN");
}
