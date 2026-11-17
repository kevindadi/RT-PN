use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use crate::dot;
use crate::model::AnalysisResult;

fn subcommand_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "rtsl" => "rtsl",
        "ptpn" => "ptpn",
        _ => "tdg",
    }
}

fn writable_directory(path: PathBuf) -> Option<PathBuf> {
    std::fs::create_dir_all(&path).ok()?;
    let probe = path.join(format!(
        ".write-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    if std::fs::write(&probe, b"ok").is_err() {
        return None;
    }
    let _ = std::fs::remove_file(&probe);
    Some(path)
}

pub(crate) fn artifact_directory() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PTPN_ARTIFACT_DIR") {
        candidates.push(PathBuf::from(path));
    }
    let cwd = std::env::current_dir().ok();
    if cfg!(debug_assertions) {
        if let Some(cwd) = &cwd {
            candidates.push(cwd.join(".rt-pn-artifacts"));
        }
    }
    #[cfg(windows)]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(base).join("RT-PN").join("artifacts"));
    }
    #[cfg(not(windows))]
    if let Some(base) = std::env::var_os("XDG_CACHE_HOME") {
        candidates.push(PathBuf::from(base).join("rt-pn").join("artifacts"));
    }
    // A restricted development/runner environment may not have write access
    // to the user profile. The current directory is usually the workspace.
    if let Some(cwd) = &cwd {
        candidates.push(cwd.join(".rt-pn-artifacts"));
    }
    candidates.push(std::env::temp_dir().join("rt-pn-artifacts"));

    let mut tried = Vec::new();
    for candidate in candidates {
        if tried.iter().any(|item: &PathBuf| item == &candidate) {
            continue;
        }
        if let Some(directory) = writable_directory(candidate.clone()) {
            return Ok(directory);
        }
        tried.push(candidate);
    }
    Err(format!(
        "no writable artifact directory (tried {}). Set PTPN_ARTIFACT_DIR to a writable directory.",
        tried
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

pub fn run_analysis(cli: &Path, path: &Path) -> AnalysisResult {
    let started = Instant::now();
    let mut result = AnalysisResult {
        path: path.display().to_string(),
        ..Default::default()
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let artifact_dir = match artifact_directory() {
        Ok(directory) => directory,
        Err(error) => {
            result.error = error;
            return result;
        }
    };
    let run_dir = artifact_dir.join(format!("run-{}-{stamp}", std::process::id()));
    if let Err(error) = std::fs::create_dir_all(&run_dir) {
        result.error = format!(
            "cannot create artifact directory {}: {error}",
            run_dir.display()
        );
        return result;
    }
    let base = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .replace(
            |c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-',
            "_",
        );
    let ptpn_path = run_dir.join(format!("{base}.ptpn.dot"));
    let scg_path = run_dir.join(format!("{base}.scg.dot"));
    let metrics_path = run_dir.join(format!("{base}.metrics.json"));
    let wcet_path = run_dir.join(format!("{base}.wcet.json"));
    let tdg_path = run_dir.join(format!("{base}.tdg.json"));

    let subcommand = subcommand_for(path);
    let mut command = Command::new(cli);
    command
        .arg(subcommand)
        .arg("-f")
        .arg(path)
        .arg("--export-ptpn")
        .arg(&ptpn_path)
        .arg("--export-scg")
        .arg(&scg_path)
        .arg("--export-metrics")
        .arg(&metrics_path)
        .arg("--export-wcet")
        .arg(&wcet_path)
        .arg("--max-states")
        .arg("20000");
    if subcommand == "rtsl" {
        command.arg("--export-tdg").arg(&tdg_path);
    }
    if let Some(parent) = path.parent() {
        command.current_dir(parent);
    }
    command.env("PATH", augmented_path(cli));

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            result.error = format!("failed to start ptpn: {error}");
            return result;
        }
    };
    result.elapsed_ms = started.elapsed().as_millis();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    result.logs = stdout
        .lines()
        .chain(stderr.lines())
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect();

    let ptpn_text = std::fs::read_to_string(&ptpn_path).unwrap_or_default();
    let scg_text = std::fs::read_to_string(&scg_path).unwrap_or_default();
    result.net = dot::parse_petri(&ptpn_text);
    result.scg = dot::parse_state_graph(&scg_text);
    if let Ok(text) = std::fs::read_to_string(&metrics_path) {
        if let Ok(value) = serde_json::from_str(&text) {
            result.metrics = value;
        }
    }

    let tdg_text = if subcommand == "rtsl" {
        std::fs::read_to_string(&tdg_path).unwrap_or_default()
    } else if subcommand == "tdg" {
        std::fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };
    if !tdg_text.is_empty() {
        if let Ok(value) = serde_json::from_str(&tdg_text) {
            result.tdg = value;
        }
    }

    result.workflow_label = match subcommand {
        "rtsl" => "SPEC-FIRST · RTSL".to_string(),
        "ptpn" => "MANUAL NET · PTPN".to_string(),
        _ => "SPEC-FIRST · TDG".to_string(),
    };

    if !output.status.success() {
        result.ok = false;
        let interesting: Vec<&String> = result
            .logs
            .iter()
            .filter(|line| {
                let lower = line.to_ascii_lowercase();
                lower.contains("error") || lower.contains("failed") || lower.contains("unsupported")
            })
            .collect();
        let tail: Vec<String> = if interesting.is_empty() {
            result
                .logs
                .iter()
                .rev()
                .take(5)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        } else {
            interesting
                .into_iter()
                .rev()
                .take(5)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        };
        result.error = if tail.is_empty() {
            format!("ptpn exited with code {:?}", output.status.code())
        } else {
            tail.join("\n")
        };
        return result;
    }

    if !result.net.valid {
        result.error = "the analyzer produced no PTPN structure".to_string();
        result.ok = false;
        return result;
    }

    result.ok = true;
    result
}

fn augmented_path(cli: &Path) -> std::ffi::OsString {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(parent) = cli.parent() {
        entries.push(parent.to_path_buf());
    }
    if let Ok(path) = std::env::var("PTPN_MINGW_BIN") {
        entries.push(PathBuf::from(path));
    }
    for candidate in [
        r"D:\mingw64\bin",
        r"C:\msys64\mingw64\bin",
        r"C:\mingw64\bin",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_dir() {
            entries.push(path);
        }
    }
    if let Some(existing) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(entries).unwrap_or_default()
}

pub fn resolve_cli() -> Option<PathBuf> {
    crate::engine::locate("ptpn", crate::engine::current_mode()).map(|binary| binary.path)
}
