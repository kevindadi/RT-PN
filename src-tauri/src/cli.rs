use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::dot;
use crate::model::AnalysisResult;

/// Resource budget for one analyzer run. State-class exploration can blow up
/// on adversarial models, so both limits are always passed to the engine.
#[derive(Clone, Debug)]
pub struct RunOptions {
    pub max_states: u64,
    pub timeout_secs: u64,
    pub max_memory_mb: u64,
    /// Empty means "keep the model's policy".
    pub policy: String,
    /// `fifo` or `arbitrary`; empty keeps the engine default.
    pub tie: String,
}

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

pub fn run_analysis(
    cli: &Path,
    path: &Path,
    options: &RunOptions,
    cancel: &AtomicBool,
    mut on_line: impl FnMut(&str),
) -> AnalysisResult {
    let started = Instant::now();
    // Windows verbatim paths (`\\?\C:\...`) reject forward slashes and confuse
    // the CLI's file loading; normalize them before invoking the analyzer.
    let path_text = path.display().to_string();
    let normalized = path_text.strip_prefix(r"\\?\").unwrap_or(&path_text).to_string();
    let path = Path::new(&normalized);
    let mut result = AnalysisResult {
        path: normalized.clone(),
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
        .arg(options.max_states.to_string());
    if options.timeout_secs > 0 {
        command.arg("--timeout").arg(options.timeout_secs.to_string());
    }
    if options.max_memory_mb > 0 {
        command.arg("--max-memory").arg(options.max_memory_mb.to_string());
    }
    if !options.policy.is_empty() {
        command.arg("--policy").arg(&options.policy);
    }
    if !options.tie.is_empty() {
        command.arg("--tie").arg(&options.tie);
    }
    if subcommand == "rtsl" {
        command.arg("--export-tdg").arg(&tdg_path);
    }
    if let Some(parent) = path.parent() {
        command.current_dir(parent);
    }
    command
        .env("PATH", augmented_path(cli))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            result.error = format!("failed to start ptpn: {error}");
            return result;
        }
    };

    // Stream stdout/stderr line by line so the UI can show progress and the
    // cancel command can interrupt long state-space explorations.
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let sender = sender.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(|line| line.ok()) {
                let _ = sender.send(line);
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let sender = sender.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(|line| line.ok()) {
                let _ = sender.send(line);
            }
        }));
    }
    drop(sender);

    // The engine enforces --timeout itself and then exits with partial results
    // (E-PERF-003, exit 5). This watchdog covers a wedged engine: after a grace
    // period the process is terminated and the run is reported as timed out.
    let watchdog = (options.timeout_secs > 0)
        .then(|| started + std::time::Duration::from_secs(options.timeout_secs + 20));
    let mut canceled = false;
    let mut watchdog_fired = false;
    let status = loop {
        while let Ok(line) = receiver.try_recv() {
            let line = line.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            on_line(&line);
            result.logs.push(line);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(error) => {
                result.error = format!("lost the ptpn process: {error}");
                break None;
            }
        }
        if cancel.load(Ordering::Relaxed) {
            canceled = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        if let Some(deadline) = watchdog {
            if Instant::now() >= deadline {
                watchdog_fired = true;
                let _ = child.kill();
                break child.wait().ok();
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };

    for reader in readers {
        let _ = reader.join();
    }
    while let Ok(line) = receiver.try_recv() {
        if !line.trim().is_empty() {
            result.logs.push(line);
        }
    }
    result.elapsed_ms = started.elapsed().as_millis();
    result.exit_code = status.and_then(|status| status.code());
    result.canceled = canceled;
    result.timed_out = watchdog_fired;
    result.partial = result.exit_code == Some(5);

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

    if canceled || watchdog_fired {
        result.ok = false;
        result.error = if canceled {
            format!("canceled after {} ms", result.elapsed_ms)
        } else {
            format!(
                "the analyzer exceeded the {} s watchdog and was terminated without partial results",
                options.timeout_secs
            )
        };
        return result;
    }

    if !result.net.valid {
        let tail = result
            .logs
            .iter()
            .rev()
            .take(3)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        result.error = if tail.is_empty() {
            "the analyzer produced no PTPN structure".to_string()
        } else {
            format!("the analyzer produced no PTPN structure\n\n{tail}")
        };
        result.ok = false;
        return result;
    }

    if result.exit_code != Some(0) && !result.partial {
        result.ok = false;
        let tail: Vec<String> = result
            .logs
            .iter()
            .rev()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        result.error = if tail.is_empty() {
            format!("ptpn exited with code {:?}", result.exit_code)
        } else {
            tail.join("\n")
        };
        return result;
    }

    if result.partial {
        result.error = format!(
            "resource budget reached (exit 5): the state-class graph is an incomplete prefix and metrics stay bounds. Budget: max-states {}, timeout {} s, max-memory {} MB",
            options.max_states, options.timeout_secs, options.max_memory_mb
        );
    }

    result.ok = true;
    result
}

pub(crate) fn augmented_path(cli: &Path) -> std::ffi::OsString {
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
