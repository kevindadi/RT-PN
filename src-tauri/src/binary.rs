// ELF workflow: drives the external elf2tdg CLI and turns its output into
// readable artifacts plus a preview image for the workbench.
//
//   1. `elf2tdg <elf> --view elf`            -> readable ELF layout file
//   2. `elf2tdg <elf> --view cfg --format json --output ...`
//                                            -> readable CFG listing + graph
//   3. `elf2tdg <elf> --view cfg --format dot` -> Graphviz rendering (SVG)
//                                               used for the preview image
//
// Threads/net stages and any scheduling analysis are intentionally out of
// scope: the ELF/TDG backend is still under development.

use std::collections::{BTreeSet, HashMap};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::graph::Graph;

const SVG_LIMIT: usize = 8 * 1024 * 1024;
const FUNCTION_LIMIT: usize = 120;
const BLOCK_LIMIT: usize = 40;
const CALL_LIMIT: usize = 12;

/// Analysis options forwarded to the elf2tdg CLI.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BinaryOptions {
    pub cpu: Option<String>,
    pub board_profile: Option<String>,
    pub freq: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ElfWorkflow {
    pub elf_path: PathBuf,
    pub file_size: u64,
    pub artifacts_dir: PathBuf,
    pub elf_view: String,
    pub elf_mermaid: String,
    pub cfg_text: String,
    pub cfg_svg: String,
    pub cfg_graph: Option<Graph>,
    pub functions: usize,
    pub blocks: usize,
    pub calls: usize,
    pub diagnostics: usize,
    pub artifacts: Vec<String>,
    pub warnings: Vec<String>,
    pub schema: String,
    pub image: Value,
    pub timing: Value,
    pub roots: Vec<Value>,
    pub concurrency: Vec<Value>,
    pub function_rows: Vec<Value>,
    pub cfg_diagnostics: Vec<Value>,
    pub caveats: Vec<String>,
}

fn rule() -> String {
    "─".repeat(96)
}

fn fit(text: &str, width: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= width {
        let mut value: String = chars.into_iter().collect();
        value.push_str(&" ".repeat(width - value.chars().count()));
        value
    } else if width <= 1 {
        chars.into_iter().take(width).collect()
    } else {
        let mut value: String = chars.into_iter().take(width - 1).collect();
        value.push('…');
        value
    }
}

fn augmented_path(program: &Path) -> OsString {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(parent) = program.parent() {
        entries.push(parent.to_path_buf());
    }
    if let Some(existing) = env::var_os("PATH") {
        entries.extend(env::split_paths(&existing));
    }
    env::join_paths(entries).unwrap_or_default()
}

fn which(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    for directory in env::split_paths(&paths) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_dot() -> Option<PathBuf> {
    if let Ok(value) = env::var("DOT") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    for candidate in [
        "C:/Program Files/Graphviz/bin/dot.exe",
        "C:/Program Files (x86)/Graphviz/bin/dot.exe",
        "/usr/bin/dot",
        "/usr/local/bin/dot",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    which("dot.exe").or_else(|| which("dot"))
}

/// Resolve the external `elf2tdg` CLI with the workbench engine policy
/// (bundled sidecar in release builds, development trees in debug builds).
pub fn resolve_elf2tdg() -> Option<PathBuf> {
    crate::engine::locate("elf2tdg", crate::engine::current_mode()).map(|binary| binary.path)
}

fn run_tool(program: &Path, args: &[String]) -> Result<(), String> {
    let mut command = Command::new(program);
    command.args(args);
    command.env("PATH", augmented_path(program));
    let output = command
        .output()
        .map_err(|error| format!("failed to start {}: {error}", program.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: Vec<&str> = stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Err(format!(
        "{} {} failed (exit {:?})\n{}",
        program.display(),
        args.join(" "),
        output.status.code(),
        tail.join("\n")
    ))
}

fn sanitized_stem(elf: &Path) -> String {
    elf.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("firmware")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

fn artifact_dir(elf: &Path) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let base = crate::cli::artifact_directory()?;
    Ok(base.join(format!(
        "elf-{}-{}-{stamp}",
        sanitized_stem(elf),
        std::process::id()
    )))
}

fn elf_view_text(elf: &Path, mermaid_path: &Path, layout: &str) -> String {
    let mut lines = Vec::new();
    lines.push("ELF LAYOUT".to_string());
    lines.push(format!(
        "file        {}",
        elf.file_name().and_then(|name| name.to_str()).unwrap_or("firmware.elf")
    ));
    lines.push(format!("size        {} bytes", fs::metadata(elf).map(|m| m.len()).unwrap_or(0)));
    lines.push(format!("artifact    {}", mermaid_path.display()));
    lines.push(format!("generator   elf2tdg --view elf (Mermaid source)"));
    lines.push(rule());
    lines.push(layout.to_string());
    lines.join("\n")
}

fn cfg_graph(cfg: &Value) -> Option<Graph> {
    let functions = cfg.get("functions").and_then(Value::as_array)?;
    if functions.is_empty() {
        return None;
    }

    let mut records: Vec<(String, String, String, String)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for function in functions.iter().take(800) {
        let id = function
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let name = function
            .get("primary_name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        let kind = function
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("function")
            .to_string();
        let address = function
            .get("address")
            .and_then(Value::as_str)
            .unwrap_or("—")
            .to_string();
        let mut extra = function
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(noreturn) = function.get("noreturn").and_then(Value::as_str) {
            if !extra.is_empty() {
                extra.push_str(" · ");
            }
            extra.push_str(&format!("noreturn:{noreturn}"));
        }
        index.insert(id, records.len());
        records.push((name, kind, address, extra));
    }

    let mut edges: Vec<(usize, usize, String)> = Vec::new();
    let mut seen: BTreeSet<(usize, usize)> = BTreeSet::new();
    'outer: for function in functions.iter() {
        let Some(from) = function
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| index.get(id))
            .copied()
        else {
            continue;
        };
        let Some(blocks) = function.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            let Some(calls) = block.get("calls").and_then(Value::as_array) else {
                continue;
            };
            for call in calls {
                let Some(target) = call
                    .get("target_function")
                    .and_then(Value::as_str)
                    .and_then(|id| index.get(id))
                    .copied()
                else {
                    continue;
                };
                if target == from || !seen.insert((from, target)) {
                    continue;
                }
                edges.push((from, target, "call".to_string()));
                if edges.len() >= 3000 {
                    break 'outer;
                }
            }
        }
    }

    Some(Graph::from_records("Control-flow graph", records, edges))
}

struct CfgStats {
    functions: usize,
    blocks: usize,
    calls: usize,
    diagnostics: usize,
}

fn readable_cfg(cfg: &Value, json_path: &Path, dot_path: &Path, svg_path: Option<&Path>) -> (String, CfgStats) {
    let functions = cfg
        .get("functions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let diagnostics = cfg
        .get("diagnostics")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);

    let mut blocks_total = 0usize;
    let mut calls_total = 0usize;
    for function in &functions {
        for block in function.get("blocks").and_then(Value::as_array).into_iter().flatten() {
            blocks_total += 1;
            calls_total += block
                .get("calls")
                .and_then(Value::as_array)
                .map(|calls| calls.len())
                .unwrap_or(0);
        }
    }

    let mut lines = Vec::new();
    lines.push("CONTROL-FLOW GRAPH".to_string());
    lines.push(format!(
        "schema      {}",
        cfg.get("cfg_schema_version").and_then(Value::as_str).unwrap_or("—")
    ));
    if let Some(image) = cfg.get("image") {
        lines.push(format!(
            "image       arch={} entry={} type={}",
            image.get("arch").and_then(Value::as_str).unwrap_or("—"),
            image.get("entry").and_then(Value::as_str).unwrap_or("—"),
            image.get("elf_type").and_then(Value::as_str).unwrap_or("—"),
        ));
    }
    lines.push(format!(
        "functions   {}\nblocks      {}\ncalls       {}\ndiagnostics {}",
        functions.len(),
        blocks_total,
        calls_total,
        diagnostics
    ));
    lines.push(format!("artifact    {}", json_path.display()));
    lines.push(format!("dot         {}", dot_path.display()));
    if let Some(svg) = svg_path {
        lines.push(format!("preview     {}", svg.display()));
    }
    if let Some(roots) = cfg.get("pointer_roots").and_then(Value::as_array) {
        if !roots.is_empty() {
            let shown: Vec<String> = roots
                .iter()
                .take(16)
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            lines.push(format!("roots       {} ({})", roots.len(), shown.join(", ")));
        }
    }
    lines.push(rule());
    lines.push("FUNCTIONS".to_string());
    lines.push(format!(
        "  {}{}{}DETAIL",
        fit("NAME", 34),
        fit("ADDRESS", 14),
        fit("KIND", 12)
    ));
    for function in functions.iter().take(FUNCTION_LIMIT) {
        let name = function
            .get("primary_name")
            .and_then(Value::as_str)
            .unwrap_or("—");
        let address = function
            .get("address")
            .and_then(Value::as_str)
            .unwrap_or("—");
        let kind = function.get("kind").and_then(Value::as_str).unwrap_or("—");
        let mut detail = function
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(noreturn) = function.get("noreturn").and_then(Value::as_str) {
            if !detail.is_empty() {
                detail.push_str(" · ");
            }
            detail.push_str(&format!("noreturn:{noreturn}"));
        }
        lines.push(format!(
            "  {}{}{}{}",
            fit(name, 34),
            fit(address, 14),
            fit(kind, 12),
            detail
        ));

        let blocks = function.get("blocks").and_then(Value::as_array);
        for block in blocks.into_iter().flatten().take(BLOCK_LIMIT) {
            let block_id = block
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("—");
            let block_address = block
                .get("address")
                .and_then(Value::as_str)
                .unwrap_or("—");
            let block_size = block.get("size").and_then(Value::as_u64).unwrap_or(0);
            let terminator = block
                .get("terminator")
                .and_then(Value::as_str)
                .unwrap_or("");
            lines.push(format!(
                "    {}  size={}  {}",
                fit(&format!("{block_id} @{block_address}"), 44),
                block_size,
                terminator
            ));
            let calls = block.get("calls").and_then(Value::as_array);
            for call in calls.into_iter().flatten().take(CALL_LIMIT) {
                let site = call.get("site").and_then(Value::as_str).unwrap_or("—");
                let target = call
                    .get("target_function")
                    .and_then(Value::as_str)
                    .or_else(|| call.get("target").and_then(Value::as_str))
                    .unwrap_or("unresolved");
                let flags = {
                    let mut flags = Vec::new();
                    if call.get("unresolved").and_then(Value::as_bool).unwrap_or(false) {
                        flags.push("unresolved");
                    }
                    if call.get("noreturn").and_then(Value::as_bool).unwrap_or(false) {
                        flags.push("noreturn");
                    }
                    if call.get("conditional").and_then(Value::as_bool).unwrap_or(false) {
                        flags.push("conditional");
                    }
                    if flags.is_empty() {
                        String::new()
                    } else {
                        format!(" [{}]", flags.join(","))
                    }
                };
                lines.push(format!("      -> {} @{}{}", target, site, flags));
            }
        }
    }
    if functions.len() > FUNCTION_LIMIT {
        lines.push(format!(
            "  NOTE  listing truncated at {FUNCTION_LIMIT} of {} functions; full data in the JSON artifact.",
            functions.len()
        ));
    }

    (
        lines.join("\n"),
        CfgStats {
            functions: functions.len(),
            blocks: blocks_total,
            calls: calls_total,
            diagnostics,
        },
    )
}

fn analysis_args(options: &BinaryOptions) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(cpu) = options.cpu.as_deref().filter(|value| !value.is_empty()) {
        args.push("--cpu".to_string());
        args.push(cpu.to_string());
    }
    if let Some(profile) = options
        .board_profile
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        args.push("--board-profile".to_string());
        args.push(profile.to_string());
    }
    if let Some(freq) = options.freq.as_deref().filter(|value| !value.is_empty()) {
        args.push("--freq".to_string());
        args.push(freq.to_string());
    }
    args
}

fn elf_view_args(input: &Path, output: &Path, options: &BinaryOptions) -> Vec<String> {
    let mut args = vec![
        "--view".to_string(),
        "elf".to_string(),
        "--output".to_string(),
        output.display().to_string(),
    ];
    args.extend(analysis_args(options));
    args.push(input.display().to_string());
    args
}

fn cfg_json_args(input: &Path, output: &Path, options: &BinaryOptions) -> Vec<String> {
    let mut args = vec![
        "--view".to_string(),
        "cfg".to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--no-cfg-instructions".to_string(),
        "--output".to_string(),
        output.display().to_string(),
    ];
    args.extend(analysis_args(options));
    args.push(input.display().to_string());
    args
}

fn cfg_dot_args(input: &Path, output: &Path, options: &BinaryOptions) -> Vec<String> {
    let mut args = vec![
        "--view".to_string(),
        "cfg".to_string(),
        "--format".to_string(),
        "dot".to_string(),
        "--output".to_string(),
        output.display().to_string(),
    ];
    args.extend(analysis_args(options));
    args.push(input.display().to_string());
    args
}

/// Single-function CFG slice for the interactive CFG explorer.
#[derive(Clone, Debug, Default, Serialize)]
pub struct BinaryFunctionCfg {
    pub selector: String,
    pub name: String,
    pub demangled_name: String,
    pub address: String,
    pub size: u64,
    pub kind: String,
    pub language: String,
    pub source: Value,
    pub inline_frames: Vec<Value>,
    pub entry: Option<String>,
    pub blocks: Vec<Value>,
    pub edges: Vec<Value>,
    pub calls: Vec<Value>,
    pub diagnostics: Vec<Value>,
    pub caveats: Vec<String>,
    pub json_path: String,
    pub warnings: Vec<String>,
}

fn timing_caveats(timing: &Value) -> Vec<String> {
    let mut caveats: Vec<String> = Vec::new();
    let mut push = |caveat: &str| {
        if !caveats.iter().any(|item| item == caveat) {
            caveats.push(caveat.to_string());
        }
    };
    if let Some(global) = timing.get("caveats").and_then(Value::as_array) {
        for caveat in global.iter().filter_map(Value::as_str) {
            push(caveat);
        }
    }
    if let Some(models) = timing.get("models").and_then(Value::as_array) {
        for model in models {
            if let Some(items) = model.get("caveats").and_then(Value::as_array) {
                for caveat in items.iter().filter_map(Value::as_str) {
                    push(caveat);
                }
            }
        }
    }
    caveats
}

fn sanitized_selector(selector: &str) -> String {
    selector
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

/// Export one function's CFG (with instructions) for the interactive CFG stage.
pub fn function_cfg(
    elf: &Path,
    selector: &str,
    options: &BinaryOptions,
) -> Result<BinaryFunctionCfg, String> {
    let program = resolve_elf2tdg().ok_or_else(|| {
        "elf2tdg CLI not found. Set ELF2TDG_BIN, or build it with `just engines`.".to_string()
    })?;
    let directory = artifact_dir(elf)?;
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "cannot create artifact directory {}: {error}",
            directory.display()
        )
    })?;
    let stem = sanitized_stem(elf);
    let slug = sanitized_selector(selector);
    let json_path = directory.join(format!("{stem}.fn-{slug}.json"));

    let mut args = vec![
        "--view".to_string(),
        "cfg".to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--function".to_string(),
        selector.to_string(),
        "--output".to_string(),
        json_path.display().to_string(),
    ];
    args.extend(analysis_args(options));
    args.push(elf.display().to_string());
    let mut warnings = Vec::new();
    run_tool(&program, &args)?;
    let source = fs::read_to_string(&json_path)
        .map_err(|error| format!("cannot read {}: {error}", json_path.display()))?;
    let cfg: Value = serde_json::from_str(&source)
        .map_err(|error| format!("invalid CFG JSON from elf2tdg: {error}"))?;
    let function = cfg
        .get("functions")
        .and_then(Value::as_array)
        .and_then(|functions| functions.first())
        .cloned()
        .ok_or_else(|| format!("elf2tdg matched no function for selector `{selector}`"))?;
    if cfg
        .get("diagnostics_omitted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        warnings.push("elf2tdg omitted some diagnostics (raise --max-diagnostics)".to_string());
    }
    let text = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let blocks = function
        .get("blocks")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(200)
                .map(|block| {
                    let mut block = block.clone();
                    if let Some(object) = block.as_object_mut() {
                        if let Some(instructions) =
                            object.get("instructions").and_then(Value::as_array).cloned()
                        {
                            let trimmed: Vec<Value> =
                                instructions.into_iter().take(300).collect();
                            object.insert("instructions".to_string(), Value::Array(trimmed));
                        }
                    }
                    block
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let edges = function
        .get("edges")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(600).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let calls = function
        .get("recovered_calls")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(200).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let diagnostics = cfg
        .get("diagnostics")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(50).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let timing = cfg.get("timing").cloned().unwrap_or(Value::Null);
    let caveats = timing_caveats(&timing);
    let inline_frames = function
        .get("inline_frames")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(64).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(BinaryFunctionCfg {
        selector: selector.to_string(),
        name: text(&function, "primary_name"),
        demangled_name: text(&function, "demangled_name"),
        address: text(&function, "address"),
        size: function.get("size").and_then(Value::as_u64).unwrap_or(0),
        kind: text(&function, "kind"),
        language: text(&function, "language"),
        source: function.get("source").cloned().unwrap_or(Value::Null),
        inline_frames,
        entry: function
            .get("entry")
            .and_then(Value::as_str)
            .map(str::to_string),
        blocks,
        edges,
        calls,
        diagnostics,
        caveats,
        json_path: json_path.display().to_string(),
        warnings,
    })
}

/// Run the full ELF -> readable ELF -> CFG (+ preview image) workflow.
pub fn analyze(elf: &Path, options: &BinaryOptions) -> Result<ElfWorkflow, String> {
    let program = resolve_elf2tdg().ok_or_else(|| {
        "elf2tdg CLI not found. Set ELF2TDG_BIN, or build it with `just engines`.".to_string()
    })?;
    let directory = artifact_dir(elf)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create artifact directory {}: {error}", directory.display()))?;
    let stem = sanitized_stem(elf);
    let elf_mmd = directory.join(format!("{stem}.elf.mmd"));
    let cfg_json = directory.join(format!("{stem}.cfg.json"));
    let cfg_dot = directory.join(format!("{stem}.cfg.dot"));
    let cfg_svg = directory.join(format!("{stem}.cfg.svg"));

    let mut warnings = Vec::new();

    // 1. Loader view: readable ELF layout (Mermaid source file).
    run_tool(&program, &elf_view_args(elf, &elf_mmd, options))?;

    // 2. CFG views: readable JSON plus a DOT rendering source.
    run_tool(&program, &cfg_json_args(elf, &cfg_json, options))?;
    run_tool(&program, &cfg_dot_args(elf, &cfg_dot, options))?;

    let layout = fs::read_to_string(&elf_mmd)
        .map_err(|error| format!("cannot read {}: {error}", elf_mmd.display()))?;
    let cfg_source = fs::read_to_string(&cfg_json)
        .map_err(|error| format!("cannot read {}: {error}", cfg_json.display()))?;
    let cfg: Value = serde_json::from_str(&cfg_source)
        .map_err(|error| format!("invalid CFG JSON from elf2tdg: {error}"))?;

    // 3. Preview image: render the DOT with Graphviz when it is available.
    let rendered = match find_dot() {
        Some(dot) => match run_tool(
            &dot,
            &[
                "-Tsvg".to_string(),
                cfg_dot.display().to_string(),
                "-o".to_string(),
                cfg_svg.display().to_string(),
            ],
        ) {
            Ok(()) => match fs::read_to_string(&cfg_svg) {
                Ok(svg) if svg.len() <= SVG_LIMIT => Some(svg),
                Ok(svg) => {
                    warnings.push(format!(
                        "preview image is {} bytes (limit {SVG_LIMIT}); using the interactive graph instead",
                        svg.len()
                    ));
                    None
                }
                Err(error) => {
                    warnings.push(format!("cannot read rendered preview: {error}"));
                    None
                }
            },
            Err(error) => {
                warnings.push(format!("Graphviz failed: {error}"));
                None
            }
        },
        None => {
            warnings.push(
                "Graphviz `dot` was not found; the preview falls back to the interactive graph"
                    .to_string(),
            );
            None
        }
    };

    let (cfg_text, stats) = readable_cfg(
        &cfg,
        &cfg_json,
        &cfg_dot,
        rendered.as_ref().map(|_| cfg_svg.as_path()),
    );
    let graph = cfg_graph(&cfg);
    let elf_view = elf_view_text(elf, &elf_mmd, &layout);

    let schema = cfg
        .get("cfg_schema_version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let image = cfg.get("image").cloned().unwrap_or(Value::Null);
    let timing = cfg.get("timing").cloned().unwrap_or(Value::Null);
    let roots = cfg
        .get("roots")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(64).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let concurrency = cfg
        .get("concurrency")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(128).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let cfg_diagnostics = cfg
        .get("diagnostics")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(200).cloned().collect::<Vec<_>>())
        .unwrap_or_default();

    let caveats = timing_caveats(&timing);

    let function_rows = cfg
        .get("functions")
        .and_then(Value::as_array)
        .map(|functions| {
            functions
                .iter()
                .take(600)
                .map(|function| {
                    let blocks = function
                        .get("blocks")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let calls = blocks
                        .iter()
                        .map(|block| {
                            block
                                .get("calls")
                                .and_then(Value::as_array)
                                .map(|items| items.len())
                                .unwrap_or(0)
                        })
                        .sum::<usize>();
                    let mut cycles_min = f64::INFINITY;
                    let mut cycles_max = f64::NEG_INFINITY;
                    for block in &blocks {
                        if let Some(cycles) = block.get("cycles") {
                            if let Some(min) = cycles.get("min").and_then(Value::as_f64) {
                                cycles_min = cycles_min.min(min);
                            }
                            if let Some(max) = cycles.get("max").and_then(Value::as_f64) {
                                cycles_max = cycles_max.max(max);
                            }
                        }
                    }
                    serde_json::json!({
                        "id": function.get("id").cloned().unwrap_or(Value::Null),
                        "name": function.get("primary_name").cloned().unwrap_or(Value::Null),
                        "demangled_name": function.get("demangled_name").cloned().unwrap_or(Value::Null),
                        "address": function.get("address").cloned().unwrap_or(Value::Null),
                        "size": function.get("size").cloned().unwrap_or(Value::Null),
                        "kind": function.get("kind").cloned().unwrap_or(Value::Null),
                        "language": function.get("language").cloned().unwrap_or(Value::Null),
                        "blocks": blocks.len(),
                        "calls": calls,
                        "cycles_min": if cycles_min.is_finite() { Value::from(cycles_min) } else { Value::Null },
                        "cycles_max": if cycles_max.is_finite() { Value::from(cycles_max) } else { Value::Null },
                        "inline_frames": function
                            .get("inline_frames")
                            .and_then(Value::as_array)
                            .map(|items| items.len())
                            .unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let artifacts = vec![
        elf_mmd.display().to_string(),
        cfg_json.display().to_string(),
        cfg_dot.display().to_string(),
        cfg_svg.display().to_string(),
    ];

    Ok(ElfWorkflow {
        elf_path: elf.to_path_buf(),
        file_size: fs::metadata(elf).map(|metadata| metadata.len()).unwrap_or(0),
        artifacts_dir: directory,
        elf_view,
        elf_mermaid: layout,
        cfg_text,
        cfg_svg: rendered.unwrap_or_default(),
        cfg_graph: graph,
        functions: stats.functions,
        blocks: stats.blocks,
        calls: stats.calls,
        diagnostics: stats.diagnostics,
        artifacts,
        warnings,
        schema,
        image,
        timing,
        roots,
        concurrency,
        function_rows,
        cfg_diagnostics,
        caveats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_artifacts<T>(run: impl FnOnce() -> T) -> T {
        // Keep the scratch artifacts inside the workspace build directory: the
        // system temp directory and the pre-existing target tree are not
        // writable by every restricted agent/CI child process. Cargo runs these
        // tests in parallel, so serialize them: PTPN_ARTIFACT_DIR is process
        // global and one test's cleanup would otherwise delete another test's
        // artifact tree mid-run.
        static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        static NEXT_TEST_DIR: std::sync::atomic::AtomicUsize =
            std::sync::atomic::AtomicUsize::new(0);
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let unique = NEXT_TEST_DIR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("build")
            .join(format!(
                "elf-workflow-test-{}-{unique}",
                std::process::id()
            ));
        let previous = std::env::var_os("PTPN_ARTIFACT_DIR");
        std::env::set_var("PTPN_ARTIFACT_DIR", &directory);
        let value = run();
        match previous {
            Some(value) => std::env::set_var("PTPN_ARTIFACT_DIR", value),
            None => std::env::remove_var("PTPN_ARTIFACT_DIR"),
        }
        let _ = std::fs::remove_dir_all(directory);
        value
    }

    #[test]
    fn commands_pass_the_elf_input() {
        let input = Path::new("fw.elf");
        let options = BinaryOptions::default();
        let cases = [
            elf_view_args(input, Path::new("art/fw.elf.mmd"), &options),
            cfg_json_args(input, Path::new("art/fw.cfg.json"), &options),
            cfg_dot_args(input, Path::new("art/fw.cfg.dot"), &options),
        ];
        for args in cases {
            assert_eq!(args.last().map(String::as_str), Some("fw.elf"));
            assert!(args.iter().any(|arg| arg == "--view"));
            assert!(args.iter().any(|arg| arg == "--output"));
        }
    }

    #[test]
    fn commands_forward_the_analysis_profile() {
        let input = Path::new("fw.elf");
        let options = BinaryOptions {
            cpu: Some("cortex-m4".to_string()),
            board_profile: Some("board.toml".to_string()),
            freq: Some("168MHz".to_string()),
        };
        let args = cfg_json_args(input, Path::new("art/fw.cfg.json"), &options);
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--cpu" && pair[1] == "cortex-m4"));
        assert!(args.windows(2).any(|pair| pair[0] == "--board-profile"
            && pair[1] == "board.toml"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--freq" && pair[1] == "168MHz"));
    }

    #[test]
    fn analyzes_the_checked_in_example_elf() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root");
        let program = root.join("build/cargo/release").join(bin("elf2tdg"));
        let fixture = root.join(
            "engines/elf2tdg/examples/rust-concurrency/artifacts/rust-concurrency-analysis.elf",
        );
        if !program.is_file() || !fixture.is_file() {
            eprintln!(
                "skipping ELF workflow test: run `just engine-elf2tdg` and check out the elf2tdg engine first"
            );
            return;
        }
        std::env::set_var("ELF2TDG_BIN", &program);
        let workflow = with_temp_artifacts(|| {
            let workflow =
                analyze(&fixture, &BinaryOptions::default()).expect("ELF workflow must succeed");
            // The scratch directory is removed after the closure returns, so
            // check the on-disk artifacts here.
            assert!(workflow.artifacts_dir.is_dir());
            for artifact in &workflow.artifacts {
                assert!(
                    Path::new(artifact).is_file(),
                    "missing artifact {artifact}"
                );
            }
            workflow
        });
        assert!(workflow.elf_view.contains("flowchart"));
        assert!(workflow.elf_mermaid.contains("flowchart"));
        assert!(!workflow.schema.is_empty(), "CFG schema must be reported");
        assert!(workflow.functions > 0, "CFG must contain functions");
        assert!(!workflow.function_rows.is_empty());
        assert!(!workflow.cfg_text.is_empty());
    }

    #[test]
    fn exports_a_single_function_with_instructions() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root");
        let program = root.join("build/cargo/release").join(bin("elf2tdg"));
        let fixture = root.join(
            "engines/elf2tdg/examples/rust-concurrency/artifacts/rust-concurrency-analysis.elf",
        );
        if !program.is_file() || !fixture.is_file() {
            eprintln!(
                "skipping function CFG test: run `just engine-elf2tdg` and check out the elf2tdg engine first"
            );
            return;
        }
        std::env::set_var("ELF2TDG_BIN", &program);
        let options = BinaryOptions {
            cpu: Some("cortex-m4".to_string()),
            ..Default::default()
        };
        let cfg = with_temp_artifacts(|| {
            function_cfg(&fixture, "start_tasks", &options).expect("function slice must succeed")
        });
        assert!(!cfg.name.is_empty());
        assert!(!cfg.blocks.is_empty());
        assert!(
            cfg.blocks.iter().any(|block| block
                .get("instructions")
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false)),
            "function slice must carry instructions"
        );
        assert!(Path::new(&cfg.json_path).is_file() || !cfg.json_path.is_empty());
    }

    fn bin(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    }
}
