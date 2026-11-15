use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::model::{bool_text, number, AnalysisResult, ParsedModel, TaskInfo};

const RULE_WIDTH: usize = 96;

#[derive(Clone, Debug, Default, Serialize)]
pub struct WorkbenchDocs {
    pub workflow: String,
    pub dag: String,
    pub ptpn: String,
    pub state: String,
    pub timeline: String,
    pub report: String,
    pub assumptions: String,
    pub dag_summary: String,
    pub ptpn_summary: String,
    pub state_summary: String,
    pub timeline_summary: String,
    pub report_summary: String,
    pub task_count: usize,
    pub dag_edge_count: usize,
    pub known_core: usize,
    pub known_priority: usize,
}

impl WorkbenchDocs {
    pub fn incomplete(&self) -> bool {
        self.task_count > 0
            && (self.known_core < self.task_count || self.known_priority < self.task_count)
    }
}

fn rule() -> String {
    "─".repeat(RULE_WIDTH)
}

fn fit(value: &str, width: usize) -> String {
    let clean = value.replace('\n', " ");
    let chars: Vec<char> = clean.chars().collect();
    if chars.len() <= width {
        let mut result = clean;
        result.push_str(&" ".repeat(width - chars.len()));
        result
    } else if width <= 1 {
        chars.into_iter().take(width).collect()
    } else {
        let mut result: String = chars.into_iter().take(width - 1).collect();
        result.push('…');
        result
    }
}

fn tag(value: &str) -> String {
    format!("[{value}]")
}

fn workflow_for(result: &AnalysisResult) -> String {
    if !result.workflow_label.is_empty() {
        return result.workflow_label.clone();
    }
    match Path::new(&result.path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "rtsl" => "SPEC-FIRST · RTSL".to_string(),
        "json" => "SPEC-FIRST · TDG".to_string(),
        "ptpn" => "MANUAL NET · PTPN".to_string(),
        _ => "SPEC-FIRST".to_string(),
    }
}

fn input_kind(result: &AnalysisResult) -> &'static str {
    if !result.binary_artifact.is_empty() {
        return "ELF / STATIC DAG";
    }
    match Path::new(&result.path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "rtsl" => "RTSL",
        "json" => "TDG JSON",
        "ptpn" => "PTPN",
        _ => "MODEL",
    }
}

fn task_lane(id: &str) -> String {
    let lane: String = id
        .chars()
        .take_while(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
        .collect();
    if lane.is_empty() {
        "ctl".to_string()
    } else {
        lane
    }
}

fn core_text(task: &TaskInfo) -> String {
    if !task.has_core || task.core < 0 {
        tag("unknown")
    } else {
        task.core.to_string()
    }
}

fn source_text(task: &TaskInfo) -> String {
    tag(if task.wcet_kind.is_empty() {
        "model"
    } else {
        &task.wcet_kind
    })
}

fn task_table(parsed: &ParsedModel) -> Vec<String> {
    let mut lines = Vec::new();
    let mut id_width = 10;
    for task in &parsed.tasks {
        id_width = id_width.max((task.id.chars().count() + 2).min(22));
    }
    lines.push(format!("TASKS  {}", parsed.tasks.len()));
    lines.push(format!(
        "  {}{}{}{}{}{}{}SOURCE",
        fit("ID", id_width),
        fit("TYPE", 8),
        fit("CORE", 10),
        fit("PRIO", 7),
        fit("WCET", 13),
        fit("DEADLINE", 10),
        fit("PERIOD", 9)
    ));
    for task in &parsed.tasks {
        let deadline = if task.deadline > 0.0 {
            number(task.deadline)
        } else {
            "—".to_string()
        };
        let period = if task.period > 0.0 {
            number(task.period)
        } else {
            "—".to_string()
        };
        lines.push(format!(
            "  {}{}{}{}{}{}{}{}",
            fit(&task.id, id_width),
            fit(&task.kind, 8),
            fit(&core_text(task), 10),
            fit(
                &task
                    .has_priority
                    .then(|| task.priority.to_string())
                    .unwrap_or_else(|| "—".to_string()),
                7
            ),
            fit(&task.wcet_text(), 13),
            fit(&deadline, 10),
            fit(&period, 9),
            source_text(task)
        ));
        if task.allowed_cores.len() > 1 {
            lines.push(format!(
                "    allowed cores    {}",
                task.allowed_cores
                    .iter()
                    .map(|c| c.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if task.missed {
            lines.push(format!(
                "    {}  wcrt {}",
                tag("deadline miss"),
                number(task.wcrt)
            ));
        } else if task.capped {
            lines.push(format!("    {}  wcrt {}", tag("capped"), number(task.wcrt)));
        }
    }
    lines
}

fn build_dag(result: &AnalysisResult, parsed: &ParsedModel) -> String {
    let mut lines = Vec::new();
    lines.push(format!("TASK GRAPH  ·  {}", workflow_for(result)));
    lines.push(format!(
        "INPUT  {}  ·  {}",
        Path::new(&result.path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("—"),
        input_kind(result)
    ));
    if !result.binary_artifact.is_empty() {
        lines.push(format!(
            "ELF    {}",
            Path::new(&result.binary_artifact)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("—")
        ));
    }
    lines.push(rule());
    lines.push("CONFIGURATION".to_string());
    lines.push(format!("  policy              {}", parsed.config.policy));
    lines.push(format!("  cores               {}", parsed.config.num_cpus));
    lines.push(format!(
        "  cores / cpu         {}",
        parsed.config.cores_per_cpu
    ));
    lines.push(format!("  task capacity       {}", parsed.config.capacity));
    lines.push(String::new());
    lines.extend(task_table(parsed));

    if !parsed.config.starts.is_empty()
        || !parsed.config.periodic.is_empty()
        || !parsed.config.ends.is_empty()
    {
        lines.push(String::new());
        lines.push("RELEASE / COMPLETION".to_string());
        for task in &parsed.config.starts {
            lines.push(format!("  {}start", fit(task, 18)));
        }
        for (task, period) in &parsed.config.periodic {
            lines.push(format!("  {}periodic  {}", fit(task, 18), number(*period)));
        }
        for task in &parsed.config.ends {
            lines.push(format!("  {}end", fit(task, 18)));
        }
    }

    lines.push(String::new());
    lines.push(format!("EDGES  {}", parsed.edges.len()));
    if parsed.edges.is_empty() {
        lines.push("  (no TDG edges exported for this input)".to_string());
        if !parsed.has_tdg {
            lines.push("  NOTE  Full dependency edges need a TDG JSON or RTSL input.".to_string());
        }
    } else {
        let mut edge_width = 6;
        for edge in &parsed.edges {
            edge_width = edge_width
                .max((edge.source.chars().count().max(edge.target.chars().count()) + 2).min(22));
        }
        for edge in &parsed.edges {
            let label = if edge.label.is_empty() {
                String::new()
            } else {
                format!("  label {}", edge.label)
            };
            lines.push(format!(
                "  {}  →  {}{}",
                fit(&edge.source, edge_width),
                fit(&edge.target, edge_width),
                label
            ));
        }
    }

    if !parsed.has_tdg {
        lines.push(String::new());
        lines.push("  NOTE  No TDG export was available; task rows are reconstructed from metrics and PTPN structure.".to_string());
    }
    lines.join("\n")
}

fn build_ptpn(result: &AnalysisResult) -> String {
    let mut lines = Vec::new();
    let net = &result.net;
    lines.push("PTPN STRUCTURE".to_string());
    lines.push(format!(
        "{} places  ·  {} transitions  ·  {} arcs",
        net.places.len(),
        net.transitions.len(),
        net.arcs.len()
    ));
    lines.push(rule());
    if !net.valid {
        lines.push("  No PTPN structure was exported.".to_string());
        return lines.join("\n");
    }

    let mut id_width = 12;
    for place in &net.places {
        id_width = id_width.max((place.id.chars().count() + 2).min(26));
    }
    for transition in &net.transitions {
        id_width = id_width.max((transition.id.chars().count() + 2).min(26));
    }
    let arc_width = id_width.min(24);

    lines.push(format!("PLACES  {}", net.places.len()));
    lines.push(format!(
        "  {}{}{}TASK",
        fit("ID", id_width),
        fit("MARK", 7),
        fit("CAP", 7)
    ));
    for (index, place) in net.places.iter().enumerate() {
        let marking = net
            .initial_marking
            .get(index)
            .copied()
            .unwrap_or(place.tokens);
        let capacity = if place.capacity > 0 {
            place.capacity.to_string()
        } else {
            "∞".to_string()
        };
        lines.push(format!(
            "  {}{}{}{}",
            fit(&place.id, id_width),
            fit(&marking.to_string(), 7),
            fit(&capacity, 7),
            task_lane(&place.id)
        ));
    }

    lines.push(String::new());
    lines.push(format!("TRANSITIONS  {}", net.transitions.len()));
    lines.push(format!(
        "  {}{}{}{}FLAGS",
        fit("ID", id_width),
        fit("WINDOW", 14),
        fit("PRIO", 6),
        fit("CORE", 6)
    ));
    for transition in &net.transitions {
        let window = if transition.has_interval {
            format!(
                "[{}, {}]",
                number(transition.interval_min),
                number(transition.interval_max)
            )
        } else {
            "—".to_string()
        };
        let mut flags = Vec::new();
        if transition.suspendable {
            flags.push("suspend");
        }
        if transition.has_interval {
            flags.push("timed");
        }
        let core = if transition.core < 0 {
            "ctl".to_string()
        } else {
            transition.core.to_string()
        };
        lines.push(format!(
            "  {}{}{}{}{}",
            fit(&transition.id, id_width),
            fit(&window, 14),
            fit(&transition.priority.to_string(), 6),
            fit(&core, 6),
            if flags.is_empty() {
                "—".to_string()
            } else {
                flags.join(", ")
            }
        ));
    }

    lines.push(String::new());
    lines.push(format!("ARCS  {}", net.arcs.len()));
    for arc in &net.arcs {
        let (from, to) = if arc.from_place {
            (
                net.places
                    .get(arc.from)
                    .map(|p| p.id.as_str())
                    .unwrap_or("?"),
                net.transitions
                    .get(arc.to)
                    .map(|t| t.id.as_str())
                    .unwrap_or("?"),
            )
        } else {
            (
                net.transitions
                    .get(arc.from)
                    .map(|t| t.id.as_str())
                    .unwrap_or("?"),
                net.places.get(arc.to).map(|p| p.id.as_str()).unwrap_or("?"),
            )
        };
        lines.push(format!("  {}  →  {}", fit(from, arc_width), to));
    }

    let mut lanes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for place in &net.places {
        lanes
            .entry(task_lane(&place.id))
            .or_default()
            .push(place.id.clone());
    }
    for transition in &net.transitions {
        lanes
            .entry(task_lane(&transition.id))
            .or_default()
            .push(transition.id.clone());
    }
    if !lanes.is_empty() {
        lines.push(String::new());
        lines.push("TASK LANES".to_string());
        for (lane, ids) in lanes {
            lines.push(format!("  {}{}", fit(&lane, 8), ids.join("  ")));
        }
    }

    let marking: Vec<String> = net
        .places
        .iter()
        .enumerate()
        .filter_map(|(index, place)| {
            let tokens = net.initial_marking.get(index).copied().unwrap_or(0);
            (tokens > 0).then(|| format!("{}={}", place.id, tokens))
        })
        .collect();
    if !marking.is_empty() {
        lines.push(String::new());
        lines.push(format!("INITIAL MARKING  {}", marking.join("  ·  ")));
    }
    lines.join("\n")
}

fn wrap_value(prefix: &str, value: &str, width: usize) -> Vec<String> {
    if value.is_empty() {
        return vec![format!("    {prefix}—")];
    }
    let first_prefix = format!("    {prefix}");
    let continuation = " ".repeat(first_prefix.chars().count());
    let mut lines = Vec::new();
    let mut current = first_prefix.clone();
    let mut depth = 0i32;
    let mut start = 0usize;
    let chars: Vec<char> = value.chars().collect();
    let mut tokens = Vec::new();
    for (index, ch) in chars.iter().enumerate() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                tokens.push(
                    chars[start..index]
                        .iter()
                        .collect::<String>()
                        .trim()
                        .to_string(),
                );
                start = index + 1;
            }
            _ => {}
        }
    }
    tokens.push(chars[start..].iter().collect::<String>().trim().to_string());
    for token in tokens.into_iter().filter(|t| !t.is_empty()) {
        let piece = if current == first_prefix {
            token.clone()
        } else {
            format!(", {token}")
        };
        if current.chars().count() > first_prefix.chars().count()
            && current.chars().count() + piece.chars().count() > width
        {
            lines.push(current);
            current = format!("{continuation}{token}");
        } else {
            current.push_str(&piece);
        }
    }
    lines.push(current);
    lines
}

fn build_state(result: &AnalysisResult) -> String {
    let mut lines = Vec::new();
    let graph = &result.scg;
    let exact = bool_text(&result.metrics, "exact", true);
    lines.push("STATE-CLASS SPACE".to_string());
    lines.push(format!(
        "{} states  ·  {} edges  ·  {}",
        graph.nodes.len(),
        graph.edges.len(),
        if exact {
            tag("exact")
        } else {
            tag("approximate")
        }
    ));
    lines.push(rule());
    if !graph.valid {
        lines.push("  No state-class graph was exported.".to_string());
        return lines.join("\n");
    }

    let limit = graph.nodes.len().min(1400);
    lines.push(format!("STATES  {}", graph.nodes.len()));
    for node in graph.nodes.iter().take(limit) {
        lines.push(format!(
            "{}  ·  elapsed {}",
            fit(&node.id, 8),
            if node.elapsed.is_empty() {
                "—"
            } else {
                &node.elapsed
            }
        ));
        lines.extend(wrap_value("marking    ", &node.marking, 92));
        lines.extend(wrap_value("active     ", &node.active, 92));
        lines.extend(wrap_value("suspended  ", &node.suspended, 92));
    }
    if graph.nodes.len() > limit {
        lines.push(format!(
            "  NOTE  Showing first {} of {} states; use PREVIEW for the full graph.",
            limit,
            graph.nodes.len()
        ));
    }

    lines.push(String::new());
    lines.push(format!("EDGES  {}", graph.edges.len()));
    let edge_limit = graph.edges.len().min(2200);
    for edge in graph.edges.iter().take(edge_limit) {
        let from = graph
            .nodes
            .get(edge.from)
            .map(|n| n.id.as_str())
            .unwrap_or("S?");
        let to = graph
            .nodes
            .get(edge.to)
            .map(|n| n.id.as_str())
            .unwrap_or("S?");
        lines.push(format!(
            "  {}  ──{}──▶  {}",
            fit(from, 9),
            fit(&edge.label, 18),
            to
        ));
    }
    lines.join("\n")
}

fn build_timeline(result: &AnalysisResult, parsed: &ParsedModel) -> String {
    let mut lines = Vec::new();
    lines.push("RESPONSE ENVELOPES  ·  TEXT TIMELINE".to_string());
    lines.push("derived from WCRT / WCET metrics  ·  not a concrete schedule".to_string());
    lines.push(rule());
    if parsed.tasks.is_empty() {
        lines.push("  No task metrics available.".to_string());
        return lines.join("\n");
    }

    let mut domain: f64 = 1.0;
    for task in &parsed.tasks {
        domain = domain.max(task.wcrt).max(task.wcet).max(task.deadline);
    }
    domain *= 1.04;
    let bar_width = 34;

    let mut cores: BTreeMap<i64, Vec<&TaskInfo>> = BTreeMap::new();
    for task in &parsed.tasks {
        cores
            .entry(if task.has_core { task.core } else { -1 })
            .or_default()
            .push(task);
    }

    let mut core_metrics: HashMap<i64, Value> = HashMap::new();
    if let Some(cores_value) = result.metrics.get("cores").and_then(Value::as_array) {
        for core in cores_value {
            if let Some(index) = core.get("core").and_then(Value::as_i64) {
                core_metrics.insert(index, core.clone());
            }
        }
    }

    for (core, tasks) in cores {
        let util = core_metrics.get(&core).map(|value| {
            let low = value.get("util_min").and_then(Value::as_f64).unwrap_or(0.0);
            let high = value.get("util_max").and_then(Value::as_f64).unwrap_or(0.0);
            let busy = value
                .get("graph_busy_fraction")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            format!(
                "  ·  util [{}, {}]  ·  busy {}",
                number(low),
                number(high),
                number(busy)
            )
        });
        lines.push(format!(
            "{}{}",
            if core < 0 {
                "UNASSIGNED".to_string()
            } else {
                format!("CORE {core}")
            },
            util.unwrap_or_default()
        ));
        lines.push(format!(
            "  {}{}{}{}{}{}{}BLOCK",
            fit("TASK", 10),
            fit("WCET", 12),
            fit("WCRT", 8),
            fit("DEADLINE", 10),
            fit("SLACK", 8),
            fit("PREEMPT", 9),
            fit("INTERF", 8)
        ));
        for task in tasks {
            let slack = if task.has_slack {
                number(task.slack)
            } else {
                "—".to_string()
            };
            let deadline = if task.deadline > 0.0 {
                number(task.deadline)
            } else {
                "—".to_string()
            };
            lines.push(format!(
                "  {}{}{}{}{}{}{}{}",
                fit(&task.id, 10),
                fit(&task.wcet_text(), 12),
                fit(&number(task.wcrt), 8),
                fit(&deadline, 10),
                fit(&slack, 8),
                fit(&task.preemptions.to_string(), 9),
                fit(&number(task.interference), 8),
                number(task.blocking)
            ));
            let mut filled = ((bar_width as f64) * task.wcrt / domain).round() as i64;
            filled = filled.clamp(1, bar_width as i64);
            let mut bar: Vec<char> = "·".repeat(bar_width).chars().collect();
            for cell in bar.iter_mut().take(filled as usize) {
                *cell = '█';
            }
            if task.deadline > 0.0 {
                let marker = (((bar_width as f64) * task.deadline / domain).round() as i64)
                    .clamp(0, bar_width as i64 - 1) as usize;
                bar[marker] = '│';
            }
            lines.push(format!(
                "      |{}|  wcrt {} {}",
                bar.into_iter().collect::<String>(),
                number(task.wcrt),
                if task.wcrt_exact {
                    tag("exact")
                } else {
                    tag("approximate")
                }
            ));
        }
        lines.push(String::new());
    }
    lines.push(
        "  NOTE  The bars are response envelopes, not an execution trace. Use PREVIEW / STATE SPACE for witness structure."
            .to_string(),
    );
    lines.join("\n")
}

fn build_assumptions(result: &AnalysisResult, parsed: &ParsedModel) -> String {
    let mut lines = Vec::new();
    lines.push(format!("WORKFLOW      {}", workflow_for(result)));
    lines.push(format!(
        "INPUT         {}",
        Path::new(&result.path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("—")
    ));
    if !result.binary_artifact.is_empty() {
        lines.push(format!(
            "ELF           {}",
            Path::new(&result.binary_artifact)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("—")
        ));
    }
    lines.push(format!("POLICY        {}", parsed.config.policy));
    lines.push(format!(
        "CORES         {} real  ·  {} per cpu",
        parsed.config.num_cpus, parsed.config.cores_per_cpu
    ));
    lines.push(format!("CAPACITY      {}", parsed.config.capacity));

    let mut known_core = 0;
    let mut known_priority = 0;
    let mut sources: BTreeMap<String, usize> = BTreeMap::new();
    for task in &parsed.tasks {
        if task.kind != "task" {
            continue;
        }
        if task.has_core && task.core >= 0 {
            known_core += 1;
        }
        if task.has_priority {
            known_priority += 1;
        }
        *sources
            .entry(if task.wcet_kind.is_empty() {
                "model".to_string()
            } else {
                task.wcet_kind.clone()
            })
            .or_default() += 1;
    }
    let timing = sources
        .iter()
        .map(|(kind, count)| format!("{kind} {count}"))
        .collect::<Vec<_>>()
        .join("  ·  ");
    lines.push(format!(
        "TIMING        {}",
        if timing.is_empty() {
            "—".to_string()
        } else {
            timing
        }
    ));
    let task_count = parsed.tasks.iter().filter(|t| t.kind == "task").count();
    if task_count == 0 {
        lines.push(format!("CORE BINDING  {}", tag("unknown")));
        lines.push(format!("PRIORITY      {}", tag("unknown")));
    } else {
        lines.push(format!(
            "CORE BINDING  {known_core}/{task_count}{}",
            if known_core == task_count {
                String::new()
            } else {
                format!(" {}", tag("unknown"))
            }
        ));
        lines.push(format!(
            "PRIORITY      {known_priority}/{task_count}{}",
            if known_priority == task_count {
                String::new()
            } else {
                format!(" {}", tag("unknown"))
            }
        ));
    }

    lines.push(format!(
        "EXACT         {}",
        if result.ok {
            bool_text(&result.metrics, "exact", true).to_string()
        } else {
            tag("unknown")
        }
    ));
    lines.push(format!(
        "TRUNCATED     {}",
        if result.ok {
            bool_text(&result.metrics, "truncated", false).to_string()
        } else {
            tag("unknown")
        }
    ));
    lines.push(format!(
        "BOUNDED       {}",
        bool_text(&result.metrics, "bounded", true)
    ));
    let exact_wcrt = parsed.tasks.iter().filter(|t| t.wcrt_exact).count();
    if !parsed.tasks.is_empty() {
        lines.push(format!("WCRT EXACT    {exact_wcrt}/{}", parsed.tasks.len()));
    }
    lines.push(format!(
        "EVIDENCE      {} states  ·  {} edges",
        result.scg.nodes.len(),
        result.scg.edges.len()
    ));
    lines.push(format!(
        "VERDICT       {}",
        if !result.ok {
            tag("unknown")
        } else if bool_text(&result.metrics, "schedulable", false) {
            "schedulable".to_string()
        } else {
            "unschedulable".to_string()
        }
    ));
    lines.join("\n")
}

fn build_report(result: &AnalysisResult, parsed: &ParsedModel, assumptions: &str) -> String {
    let mut lines = Vec::new();
    lines.push("PTPN ANALYSIS REPORT".to_string());
    lines.push(format!("input      {}", result.path));
    if !result.binary_artifact.is_empty() {
        lines.push(format!("elf        {}", result.binary_artifact));
    }
    lines.push(format!("workflow   {}", workflow_for(result)));
    lines.push(rule());
    lines.push("VERDICT".to_string());
    lines.push(format!(
        "  {}",
        if !result.ok {
            "NO RESULT"
        } else if bool_text(&result.metrics, "schedulable", false) {
            "SCHEDULABLE"
        } else {
            "UNSCHEDULABLE"
        }
    ));
    lines.push(format!(
        "  exact {}  ·  truncated {}",
        bool_text(&result.metrics, "exact", true),
        bool_text(&result.metrics, "truncated", false)
    ));
    lines.push(format!(
        "  states {}  ·  hyperperiod {}",
        result.scg.nodes.len(),
        if result
            .metrics
            .get("hyperperiod")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            > 0.0
        {
            number(
                result
                    .metrics
                    .get("hyperperiod")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
            )
        } else {
            "—".to_string()
        }
    ));
    lines.push(String::new());
    lines.push("TASK OUTCOMES".to_string());
    let mut id_width = 14;
    for task in &parsed.tasks {
        id_width = id_width.max((task.id.chars().count() + 2).min(22));
    }
    lines.push(format!(
        "  {}{}{}{}{}RESULT",
        fit("TASK", id_width),
        fit("WCET", 13),
        fit("WCRT", 8),
        fit("DEADLINE", 10),
        fit("SLACK", 8)
    ));
    for task in &parsed.tasks {
        let deadline = if task.deadline > 0.0 {
            number(task.deadline)
        } else {
            "—".to_string()
        };
        let slack = if task.has_slack {
            number(task.slack)
        } else {
            "—".to_string()
        };
        lines.push(format!(
            "  {}{}{}{}{}{}",
            fit(&task.id, id_width),
            fit(&task.wcet_text(), 13),
            fit(&number(task.wcrt), 8),
            fit(&deadline, 10),
            fit(&slack, 8),
            if task.missed {
                tag("deadline miss")
            } else if task.wcrt_exact {
                tag("exact")
            } else {
                tag("approximate")
            }
        ));
    }
    lines.push(String::new());
    lines.push("ASSUMPTIONS / EVIDENCE".to_string());
    for line in assumptions.lines() {
        lines.push(format!("  {line}"));
    }
    lines.push(String::new());
    lines.push(
        "  NOTE  Text is the primary representation; use PREVIEW for graph inspection.".to_string(),
    );
    lines.join("\n")
}

fn failure_doc(result: &AnalysisResult) -> String {
    let mut lines = Vec::new();
    lines.push("ANALYSIS FAILED".to_string());
    lines.push(rule());
    lines.push(format!("input   {}", result.path));
    lines.push("error".to_string());
    for line in result.error.lines() {
        let mut current = "  ".to_string();
        for word in line.split_whitespace() {
            if current.chars().count() > 2
                && current.chars().count() + word.chars().count() + 1 > 94
            {
                lines.push(current);
                current = "    ".to_string();
            }
            if current.chars().count() > 2 {
                current.push(' ');
            }
            current.push_str(word);
        }
        lines.push(current);
    }
    lines.push(String::new());
    lines.push("  NOTE  The run log in the right panel has the full analyzer output.".to_string());
    lines.join("\n")
}

pub fn render(result: &AnalysisResult) -> WorkbenchDocs {
    let parsed = ParsedModel::from_result(result);
    let mut docs = WorkbenchDocs {
        workflow: workflow_for(result),
        dag_summary: format!(
            "{} TASKS  ·  {} {}",
            parsed.tasks.len(),
            parsed.edges.len(),
            if parsed.edges.len() == 1 {
                "EDGE"
            } else {
                "EDGES"
            }
        ),
        ptpn_summary: format!(
            "{} PLACES  ·  {} TRANSITIONS  ·  {} ARCS",
            result.net.places.len(),
            result.net.transitions.len(),
            result.net.arcs.len()
        ),
        state_summary: format!(
            "{} STATES  ·  {} EDGES  ·  {}",
            result.scg.nodes.len(),
            result.scg.edges.len(),
            if bool_text(&result.metrics, "exact", true) {
                tag("exact")
            } else {
                tag("approximate")
            }
        ),
        timeline_summary: format!(
            "{} TASKS  ·  {} {}",
            parsed.tasks.len(),
            parsed.config.num_cpus,
            if parsed.config.num_cpus == 1 {
                "CORE"
            } else {
                "CORES"
            }
        ),
        report_summary: if result.ok {
            if bool_text(&result.metrics, "schedulable", false) {
                "SCHEDULABLE".to_string()
            } else {
                "UNSCHEDULABLE".to_string()
            }
        } else {
            "NO RESULT".to_string()
        },
        task_count: parsed.tasks.iter().filter(|t| t.kind == "task").count(),
        dag_edge_count: parsed.edges.len(),
        ..Default::default()
    };
    for task in &parsed.tasks {
        if task.kind != "task" {
            continue;
        }
        if task.has_core && task.core >= 0 {
            docs.known_core += 1;
        }
        if task.has_priority {
            docs.known_priority += 1;
        }
    }

    if !result.ok {
        let failed = failure_doc(result);
        docs.dag = format!("{}\n\n{}", failed, build_dag(result, &parsed));
        docs.ptpn = failed.clone();
        docs.state = failed.clone();
        docs.timeline = failed.clone();
        docs.report = failed;
        docs.assumptions = build_assumptions(result, &parsed);
        if !result.error.is_empty() {
            docs.assumptions.push_str("\nERROR         ");
            docs.assumptions
                .push_str(&result.error.chars().take(300).collect::<String>());
        }
        return docs;
    }

    docs.assumptions = build_assumptions(result, &parsed);
    docs.dag = build_dag(result, &parsed);
    docs.ptpn = build_ptpn(result);
    docs.state = build_state(result);
    docs.timeline = build_timeline(result, &parsed);
    docs.report = build_report(result, &parsed, &docs.assumptions);
    if docs.incomplete() {
        let warning = format!(
            "ASSUMPTIONS INCOMPLETE\nCore {}/{} known  ·  priority {}/{} known\nThe analyzer used parser defaults for missing fields. This is not a certified binary-first verdict.\n\n",
            docs.known_core, docs.task_count, docs.known_priority, docs.task_count
        );
        docs.report = format!("{warning}{}", docs.report);
    }
    docs
}
