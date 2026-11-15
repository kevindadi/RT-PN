use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::graph::Graph;

#[derive(Clone, Debug, Default, Serialize)]
pub struct BinaryArtifacts {
    pub elf_path: PathBuf,
    pub bundle_path: Option<PathBuf>,
    pub elf: Value,
    pub cfg: Value,
    pub threads: Value,
    pub net: Value,
    pub has_bundle: bool,
    pub file_size: u64,
    pub error: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct BinaryDocs {
    pub elf_text: String,
    pub cfg_text: String,
    pub threads_text: String,
    pub net_text: String,
    pub elf_summary: String,
    pub cfg_summary: String,
    pub threads_summary: String,
    pub net_summary: String,
    pub assumptions: String,
    pub cfg_graph: Option<Graph>,
    pub threads_graph: Option<Graph>,
    pub net_graph: Option<Graph>,
}

fn scalar(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items.iter().map(scalar).collect::<Vec<_>>().join(", "),
        Value::Object(_) => value.to_string(),
        Value::Null => "—".to_string(),
    }
}

fn field(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(found) = value.get(*key) {
            if !found.is_null() {
                return scalar(found);
            }
        }
    }
    "—".to_string()
}

fn fit(value: &str, width: usize) -> String {
    let chars: Vec<char> = value.replace('\n', " ").chars().collect();
    if chars.len() <= width {
        let mut result: String = chars.into_iter().collect();
        result.push_str(&" ".repeat(width - result.chars().count()));
        result
    } else if width <= 1 {
        chars.into_iter().take(width).collect()
    } else {
        let mut result: String = chars.into_iter().take(width - 1).collect();
        result.push('…');
        result
    }
}

fn rule() -> String {
    "─".repeat(96)
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn array(value: &Value, keys: &[&str]) -> Vec<Value> {
    for key in keys {
        if let Some(items) = value.get(*key).and_then(Value::as_array) {
            return items.clone();
        }
    }
    Vec::new()
}

fn object(value: &Value, keys: &[&str]) -> Value {
    for key in keys {
        if let Some(found) = value.get(*key) {
            if found.is_object() {
                return found.clone();
            }
        }
    }
    Value::Null
}

fn records_from(items: Vec<Value>, offset: usize) -> Vec<(String, String, String, String)> {
    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let id = field(&item, &["id", "name", "label", "block"]);
            let id = if id == "—" {
                format!("N{}", offset + index)
            } else {
                id
            };
            (
                id,
                field(&item, &["kind", "type"]),
                field(&item, &["address", "addr", "entry", "entry_point"]),
                field(&item, &["text", "function", "instructions", "detail"]),
            )
        })
        .collect()
}

fn node_records(value: &Value, keys: &[&str]) -> Vec<(String, String, String, String)> {
    let items = array(value, keys);
    if !items.is_empty() {
        return records_from(items, 0);
    }
    // Some parser bundles group blocks under cfg.functions[] rather than a
    // flat cfg.nodes[] list.
    let mut records = Vec::new();
    for function in array(value, &["functions"]) {
        let blocks = array(&function, &["nodes", "blocks"]);
        let offset = records.len();
        records.extend(records_from(blocks, offset));
    }
    records
}

fn edge_records(value: &Value, ids: &HashMap<String, usize>) -> Vec<(usize, usize, String)> {
    let mut items = array(value, &["edges", "arcs"]);
    for function in array(value, &["functions"]) {
        items.extend(array(&function, &["edges"]));
    }
    let mut records = Vec::new();
    for item in items {
        let source = field(&item, &["source", "from", "src"]);
        let target = field(&item, &["target", "to", "dst"]);
        if let (Some(from), Some(to)) = (ids.get(&source), ids.get(&target)) {
            records.push((*from, *to, field(&item, &["kind", "label"])));
        }
    }
    records
}

fn graph_from(value: &Value, node_keys: &[&str], title: &str) -> Option<Graph> {
    let records = node_records(value, node_keys);
    if records.is_empty() {
        return None;
    }
    let ids: HashMap<String, usize> = records
        .iter()
        .enumerate()
        .map(|(index, (id, _, _, _))| (id.clone(), index))
        .collect();
    let edges = edge_records(value, &ids);
    Some(Graph::from_records(title, records, edges))
}

fn pretty(value: &Value, limit: usize) -> String {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let mut output = lines
        .iter()
        .take(limit)
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>();
    if lines.len() > limit {
        output.push(format!(
            "  NOTE  JSON preview truncated at {limit} of {} lines.",
            lines.len()
        ));
    }
    output.join("\n")
}

impl BinaryArtifacts {
    pub fn load(elf_path: &Path) -> Self {
        let mut artifacts = Self {
            elf_path: elf_path.to_path_buf(),
            file_size: std::fs::metadata(elf_path).map(|m| m.len()).unwrap_or(0),
            ..Default::default()
        };
        let elf_string = elf_path.to_string_lossy().to_string();
        let stem_string = elf_path.with_extension("").to_string_lossy().to_string();
        let candidates = [
            format!("{elf_string}.bundle.json"),
            format!("{stem_string}.bundle.json"),
            format!("{elf_string}.ptpn-bundle.json"),
            format!("{stem_string}.ptpn-bundle.json"),
            format!("{elf_string}.ptpn.json"),
            format!("{stem_string}.ptpn.json"),
            format!("{elf_string}.dag.json"),
            format!("{stem_string}.dag.json"),
            format!("{elf_string}.tdg.json"),
            format!("{stem_string}.tdg.json"),
        ];
        for candidate in candidates {
            if let Some(root) = read_json(Path::new(&candidate)) {
                artifacts.bundle_path = Some(PathBuf::from(candidate));
                artifacts.has_bundle = root.get("elf").is_some()
                    || root.get("cfg").is_some()
                    || root.get("threads").is_some()
                    || root.get("net").is_some();
                artifacts.elf = object(&root, &["elf"]);
                artifacts.cfg = object(&root, &["cfg", "control_flow", "controlFlow"]);
                artifacts.threads = object(&root, &["threads", "thread_control", "threadControl"]);
                artifacts.net = object(&root, &["net", "unified_net", "unifiedNet", "tdg", "dag"]);
                if artifacts.net.is_null()
                    && (root.get("nodes").is_some() || root.get("configuration").is_some())
                {
                    artifacts.net = root;
                }
                break;
            }
        }
        if artifacts.elf.is_null() {
            artifacts.elf = json!({
                "file": elf_path.file_name().and_then(|s| s.to_str()).unwrap_or("firmware.elf"),
                "path": elf_path.display().to_string(),
                "size": artifacts.file_size,
            });
        }
        artifacts
    }
}

pub fn render(artifacts: &BinaryArtifacts) -> BinaryDocs {
    let mut docs = BinaryDocs::default();
    let file_name = artifacts
        .elf_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("firmware.elf");

    let mut elf_lines = Vec::new();
    elf_lines.push("ELF ARTIFACT".to_string());
    elf_lines.push(format!("file        {file_name}"));
    elf_lines.push(format!("path        {}", artifacts.elf_path.display()));
    elf_lines.push(format!("size        {} bytes", artifacts.file_size));
    elf_lines.push(rule());
    elf_lines.push("METADATA".to_string());
    for key in [
        "format",
        "class",
        "endian",
        "machine",
        "architecture",
        "arch",
        "language",
        "frontend",
        "runtime",
        "entry",
        "entry_point",
        "compiler",
        "target",
    ] {
        if artifacts.elf.get(key).is_some() {
            elf_lines.push(format!(
                "  {}{}",
                fit(key, 16),
                field(&artifacts.elf, &[key])
            ));
        }
    }
    let sections = array(&artifacts.elf, &["sections"]);
    if !sections.is_empty() {
        elf_lines.push(String::new());
        elf_lines.push(format!("SECTIONS  {}", sections.len()));
        elf_lines.push(format!(
            "  {}{}{}FLAGS",
            fit("NAME", 22),
            fit("ADDRESS", 14),
            fit("SIZE", 10)
        ));
        for section in sections.iter().take(120) {
            elf_lines.push(format!(
                "  {}{}{}{}",
                fit(&field(section, &["name", "id"]), 22),
                fit(&field(section, &["address", "addr"]), 14),
                fit(&field(section, &["size"]), 10),
                field(section, &["flags", "type"])
            ));
        }
    }
    let symbols = array(&artifacts.elf, &["symbols", "functions"]);
    if !symbols.is_empty() {
        elf_lines.push(String::new());
        elf_lines.push(format!("SYMBOLS  {}", symbols.len()));
        elf_lines.push(format!("  {}{}KIND", fit("NAME", 30), fit("ADDRESS", 14)));
        for symbol in symbols.iter().take(160) {
            elf_lines.push(format!(
                "  {}{}{}",
                fit(&field(symbol, &["name", "id"]), 30),
                fit(&field(symbol, &["address", "addr"]), 14),
                field(symbol, &["kind", "type"])
            ));
        }
    }
    if artifacts.bundle_path.is_none() {
        elf_lines.push(String::new());
        elf_lines.push("  NOTE  No parser bundle was found next to this ELF.".to_string());
        elf_lines.push(
            "        Expected <elf>.bundle.json with elf/cfg/threads/net sections.".to_string(),
        );
    }
    docs.elf_text = elf_lines.join("\n");

    let cfg = graph_from(&artifacts.cfg, &["nodes", "blocks"], "CFG");
    let cfg_records = node_records(&artifacts.cfg, &["nodes", "blocks"]);
    let cfg_edges = cfg.as_ref().map(|g| g.edges.len()).unwrap_or(0);
    let mut cfg_lines = Vec::new();
    cfg_lines.push("CONTROL-FLOW GRAPH".to_string());
    cfg_lines.push(format!("source  {file_name}"));
    cfg_lines.push(rule());
    if cfg_records.is_empty() {
        cfg_lines.push("  No CFG artifacts in the parser bundle.".to_string());
        cfg_lines.push(
            "  Expected: cfg.nodes[] / cfg.edges[] (or cfg.functions[] with blocks).".to_string(),
        );
    } else {
        cfg_lines.push(format!(
            "{} basic blocks  ·  {} edges",
            cfg_records.len(),
            cfg_edges
        ));
        cfg_lines.push(String::new());
        cfg_lines.push("BLOCKS".to_string());
        cfg_lines.push(format!(
            "  {}{}{}DETAIL",
            fit("ID", 22),
            fit("KIND", 12),
            fit("ADDRESS", 14)
        ));
        for (id, kind, address, detail) in cfg_records.iter().take(260) {
            cfg_lines.push(format!(
                "  {}{}{}{}",
                fit(id, 22),
                fit(kind, 12),
                fit(address, 14),
                detail
            ));
        }
        if let Some(graph) = &cfg {
            if !graph.edges.is_empty() {
                cfg_lines.push(String::new());
                cfg_lines.push(format!("EDGES  {}", graph.edges.len()));
                for edge in graph.edges.iter().take(400) {
                    cfg_lines.push(format!(
                        "  {}  →  {}{}",
                        fit(&graph.nodes[edge.from].id, 22),
                        fit(&graph.nodes[edge.to].id, 22),
                        if edge.label == "—" {
                            String::new()
                        } else {
                            format!("  {}", edge.label)
                        }
                    ));
                }
            }
        }
    }
    docs.cfg_text = cfg_lines.join("\n");
    docs.cfg_graph = cfg;

    let thread_records = node_records(&artifacts.threads, &["threads", "nodes", "tasks"]);
    let threads = graph_from(
        &artifacts.threads,
        &["threads", "nodes", "tasks"],
        "THREADS",
    );
    let mut thread_lines = Vec::new();
    thread_lines.push("THREAD CONTROL".to_string());
    thread_lines.push(format!("source  {file_name}"));
    thread_lines.push(rule());
    if thread_records.is_empty() {
        thread_lines.push("  No thread-control artifacts in the parser bundle.".to_string());
        thread_lines.push(
            "  Expected: threads.runtime / frontend, threads[] or nodes[], edges[].".to_string(),
        );
    } else {
        thread_lines.push(format!(
            "runtime   {}",
            field(&artifacts.threads, &["runtime", "thread_runtime"])
        ));
        thread_lines.push(format!(
            "frontend  {}",
            field(&artifacts.threads, &["frontend", "language_frontend"])
        ));
        thread_lines.push(format!(
            "{} thread/task entries  ·  {} edges",
            thread_records.len(),
            threads.as_ref().map(|g| g.edges.len()).unwrap_or(0)
        ));
        thread_lines.push(String::new());
        thread_lines.push("ENTRIES".to_string());
        thread_lines.push(format!(
            "  {}{}{}DETAIL",
            fit("ID", 22),
            fit("KIND", 14),
            fit("ENTRY", 18)
        ));
        for (id, kind, entry, detail) in thread_records.iter().take(160) {
            thread_lines.push(format!(
                "  {}{}{}{}",
                fit(id, 22),
                fit(kind, 14),
                fit(entry, 18),
                detail
            ));
        }
        if let Some(graph) = &threads {
            if !graph.edges.is_empty() {
                thread_lines.push(String::new());
                thread_lines.push(format!("EDGES  {}", graph.edges.len()));
                for edge in graph.edges.iter().take(300) {
                    thread_lines.push(format!(
                        "  {}  →  {}{}",
                        fit(&graph.nodes[edge.from].id, 22),
                        fit(&graph.nodes[edge.to].id, 22),
                        if edge.label == "—" {
                            String::new()
                        } else {
                            format!("  {}", edge.label)
                        }
                    ));
                }
            }
        }
    }
    docs.threads_text = thread_lines.join("\n");
    docs.threads_graph = threads;

    let net_records = node_records(&artifacts.net, &["tasks", "nodes", "places"]);
    let net_graph = graph_from(&artifacts.net, &["tasks", "nodes", "places"], "NET");
    let mut net_lines = Vec::new();
    net_lines.push("GENERATED UNIFIED NET".to_string());
    net_lines.push(format!("source  {file_name}"));
    if let Some(path) = &artifacts.bundle_path {
        net_lines.push(format!(
            "bundle  {}",
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("bundle")
        ));
    }
    net_lines.push(rule());
    if artifacts.net.is_null() || net_records.is_empty() {
        net_lines.push("  No generated net in the parser bundle.".to_string());
        net_lines.push("  Expected: net (or tdg/dag) in the unified format.".to_string());
        net_lines
            .push("  The analysis backend is intentionally pending in this workflow.".to_string());
    } else {
        net_lines.push(format!(
            "format    {}",
            field(&artifacts.net, &["format", "schema", "kind"])
        ));
        let configuration = artifacts
            .net
            .get("configuration")
            .cloned()
            .unwrap_or(Value::Null);
        if configuration.is_object() {
            net_lines.push(format!("policy    {}", field(&configuration, &["policy"])));
            net_lines.push(format!(
                "cores     {}",
                field(&configuration, &["num_cpus"])
            ));
        }
        net_lines.push(format!(
            "{} nodes  ·  {} edges",
            net_records.len(),
            net_graph.as_ref().map(|g| g.edges.len()).unwrap_or(0)
        ));
        net_lines.push(String::new());
        net_lines.push("NODES".to_string());
        net_lines.push(format!(
            "  {}{}{}EXTRA",
            fit("ID", 24),
            fit("KIND", 12),
            fit("DETAIL", 18)
        ));
        for (id, kind, detail, extra) in net_records.iter().take(300) {
            net_lines.push(format!(
                "  {}{}{}{}",
                fit(id, 24),
                fit(kind, 12),
                fit(detail, 18),
                extra
            ));
        }
        if let Some(graph) = &net_graph {
            if !graph.edges.is_empty() {
                net_lines.push(String::new());
                net_lines.push(format!("EDGES  {}", graph.edges.len()));
                for edge in graph.edges.iter().take(400) {
                    net_lines.push(format!(
                        "  {}  →  {}{}",
                        fit(&graph.nodes[edge.from].id, 24),
                        fit(&graph.nodes[edge.to].id, 24),
                        if edge.label == "—" {
                            String::new()
                        } else {
                            format!("  {}", edge.label)
                        }
                    ));
                }
            }
        }
        net_lines.push(String::new());
        net_lines.push(
            "  NOTE  This is the generated-net preview. The binary analysis backend is pending."
                .to_string(),
        );
    }
    docs.net_text = net_lines.join("\n");
    docs.net_graph = net_graph;

    docs.elf_summary = format!("{file_name}  ·  {} bytes", artifacts.file_size);
    docs.cfg_summary = format!(
        "{} BLOCKS  ·  {} EDGES",
        cfg_records.len(),
        docs.cfg_graph.as_ref().map(|g| g.edges.len()).unwrap_or(0)
    );
    docs.threads_summary = format!(
        "{} ENTRIES  ·  {} EDGES",
        thread_records.len(),
        docs.threads_graph
            .as_ref()
            .map(|g| g.edges.len())
            .unwrap_or(0)
    );
    docs.net_summary = format!(
        "{} NODES  ·  {} EDGES",
        net_records.len(),
        docs.net_graph.as_ref().map(|g| g.edges.len()).unwrap_or(0)
    );

    let mut assumptions = Vec::new();
    assumptions.push("WORKFLOW      BINARY · ELF".to_string());
    assumptions.push(format!("ELF           {file_name}"));
    assumptions.push(format!(
        "BUNDLE        {}",
        artifacts
            .bundle_path
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("[missing]")
    ));
    assumptions.push(format!(
        "ARCH          {}",
        field(&artifacts.elf, &["architecture", "arch", "machine"])
    ));
    assumptions.push(format!(
        "LANGUAGE      {}",
        field(&artifacts.elf, &["language", "source_language"])
    ));
    assumptions.push(format!(
        "FRONTEND      {}",
        field(&artifacts.elf, &["frontend", "runtime"])
    ));
    assumptions.push(format!("CFG           {}", docs.cfg_summary));
    assumptions.push(format!("THREADS       {}", docs.threads_summary));
    assumptions.push(format!("NET           {}", docs.net_summary));
    assumptions.push("ANALYSIS      backend pending".to_string());
    if !artifacts.error.is_empty() {
        assumptions.push(format!("ERROR         {}", artifacts.error));
    }
    docs.assumptions = assumptions.join("\n");

    if let Some(bundle) = &artifacts.bundle_path {
        if bundle
            .file_name()
            .and_then(|s| s.to_str())
            .map(|name| name.ends_with(".dag.json"))
            .unwrap_or(false)
        {
            docs.elf_text
                .push_str("\n  NOTE  Legacy net-only sidecar; CFG/THREADS need the parser bundle.");
        }
    }

    if artifacts.cfg.is_null() {
        docs.cfg_text = format!("{}\n\n{}", docs.cfg_text, pretty(&artifacts.cfg, 40));
    }
    docs
}
