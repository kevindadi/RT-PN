use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, Serialize)]
pub struct Place {
    pub id: String,
    pub label: String,
    pub tokens: i64,
    pub capacity: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Transition {
    pub id: String,
    pub label: String,
    pub core: i64,
    pub priority: i64,
    pub suspendable: bool,
    pub has_interval: bool,
    pub interval_min: f64,
    pub interval_max: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Arc {
    pub from: usize,
    pub to: usize,
    pub from_place: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct PetriNet {
    pub valid: bool,
    pub places: Vec<Place>,
    pub transitions: Vec<Transition>,
    pub arcs: Vec<Arc>,
    pub initial_marking: Vec<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct StateNode {
    pub id: String,
    pub index: i64,
    pub marking: String,
    pub active: String,
    pub suspended: String,
    pub elapsed: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct StateEdge {
    pub from: usize,
    pub to: usize,
    pub label: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct StateGraph {
    pub valid: bool,
    pub nodes: Vec<StateNode>,
    pub edges: Vec<StateEdge>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct AnalysisResult {
    pub ok: bool,
    pub error: String,
    pub path: String,
    pub logs: Vec<String>,
    pub elapsed_ms: u128,
    pub net: PetriNet,
    pub scg: StateGraph,
    pub metrics: Value,
    pub tdg: Value,
    pub workflow_label: String,
    pub binary_artifact: String,
    pub exit_code: Option<i32>,
    /// Exit code 5: the resource budget stopped the exploration; results are a
    /// certified upper-bound prefix, not a complete state space.
    pub partial: bool,
    pub canceled: bool,
    pub timed_out: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct TaskInfo {
    pub id: String,
    pub kind: String,
    pub wcet_kind: String,
    pub core: i64,
    pub has_core: bool,
    pub priority: i64,
    pub has_priority: bool,
    pub allowed_cores: Vec<i64>,
    pub times: Vec<(f64, f64)>,
    pub bcet: f64,
    pub wcet: f64,
    pub wcrt: f64,
    pub deadline: f64,
    pub period: f64,
    pub slack: f64,
    pub has_slack: bool,
    pub preemptions: i64,
    pub interference: f64,
    pub blocking: f64,
    pub observed: bool,
    pub missed: bool,
    pub capped: bool,
    pub wcrt_exact: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct TdgEdge {
    pub source: String,
    pub target: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ModelConfig {
    pub name: String,
    pub policy: String,
    pub num_cpus: i64,
    pub cores_per_cpu: i64,
    pub capacity: i64,
    pub starts: Vec<String>,
    pub ends: Vec<String>,
    pub periodic: Vec<(String, f64)>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ParsedModel {
    pub config: ModelConfig,
    pub tasks: Vec<TaskInfo>,
    pub edges: Vec<TdgEdge>,
    pub has_tdg: bool,
}

fn value_str(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(v) = value.get(*key) {
            if let Some(s) = v.as_str() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn value_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = value.get(*key).and_then(Value::as_f64) {
            return Some(v);
        }
    }
    None
}

fn value_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(v) = value.get(*key).and_then(Value::as_i64) {
            return Some(v);
        }
    }
    None
}

fn value_bool(value: &Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(v) = value.get(*key).and_then(Value::as_bool) {
            return Some(v);
        }
    }
    None
}

impl TaskInfo {
    fn from_tdg(node: &Value) -> Self {
        let mut task = Self::default();
        task.id = value_str(node, &["id", "name"]).unwrap_or_default();
        task.kind = value_str(node, &["type"]).unwrap_or_else(|| "task".to_string());
        task.wcet_kind = value_str(node, &["wcet_kind"]).unwrap_or_else(|| "model".to_string());
        if let Some(core) = value_i64(node, &["core"]) {
            task.core = core;
            task.has_core = core >= 0;
        }
        if let Some(priority) = value_i64(node, &["priority"]) {
            task.priority = priority;
            task.has_priority = true;
        }
        if let Some(allowed) = node.get("allowed_cores").and_then(Value::as_array) {
            for core in allowed.iter().filter_map(Value::as_i64) {
                task.allowed_cores.push(core);
            }
        }
        if let Some(times) = node.get("time").and_then(Value::as_array) {
            for pair in times {
                if let Some(pair) = pair.as_array() {
                    if pair.len() >= 2 {
                        if let (Some(a), Some(b)) = (pair[0].as_f64(), pair[1].as_f64()) {
                            task.times.push((a, b));
                        }
                    }
                }
            }
        }
        task.deadline = value_f64(node, &["deadline"]).unwrap_or(0.0);
        task
    }

    pub fn merge_metrics(&mut self, metrics: &Value) {
        if metrics.is_null() {
            return;
        }
        if let Some(v) = value_f64(metrics, &["bcet"]) {
            self.bcet = v;
        }
        if let Some(v) = value_f64(metrics, &["wcet"]) {
            self.wcet = v;
        }
        if let Some(v) = value_f64(metrics, &["wcrt"]) {
            self.wcrt = v;
        }
        if let Some(v) = value_f64(metrics, &["deadline"]) {
            if v > 0.0 {
                self.deadline = v;
            }
        }
        if let Some(v) = value_f64(metrics, &["period"]) {
            self.period = v;
        }
        if let Some(v) = value_f64(metrics, &["slack"]) {
            self.slack = v;
            self.has_slack = true;
        }
        self.preemptions = value_i64(metrics, &["max_preemptions"]).unwrap_or(0);
        self.interference = value_f64(metrics, &["worst_interference"]).unwrap_or(0.0);
        self.blocking = value_f64(metrics, &["worst_blocking"]).unwrap_or(0.0);
        self.observed = value_bool(metrics, &["observed"]).unwrap_or(false);
        self.missed = value_bool(metrics, &["deadline_missed"]).unwrap_or(false);
        self.capped = value_bool(metrics, &["wcrt_capped"]).unwrap_or(false);
        self.wcrt_exact = value_bool(metrics, &["wcrt_exact"]).unwrap_or(false);
        if self.times.is_empty() && self.wcet > 0.0 {
            self.times.push((self.bcet, self.wcet));
        }
        if !self.times.is_empty() {
            self.bcet = self.times.iter().map(|x| x.0).fold(f64::INFINITY, f64::min);
            self.wcet = self.times.iter().map(|x| x.1).fold(0.0, f64::max);
        }
    }

    pub fn wcet_text(&self) -> String {
        self.times
            .first()
            .map(|(a, b)| format!("[{}, {}]", number(*a), number(*b)))
            .unwrap_or_else(|| {
                if self.wcet > 0.0 {
                    number(self.wcet)
                } else {
                    "—".to_string()
                }
            })
    }
}

impl ParsedModel {
    pub fn from_result(result: &AnalysisResult) -> Self {
        let mut parsed = Self::default();
        parsed.has_tdg = result.tdg.is_object();
        let config = result
            .tdg
            .get("configuration")
            .cloned()
            .unwrap_or(Value::Null);
        if config.is_object() {
            parsed.config.name = result
                .tdg
                .get("graph")
                .and_then(|g| g.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            parsed.config.policy =
                value_str(&config, &["policy"]).unwrap_or_else(|| "fixed".to_string());
            parsed.config.num_cpus = value_i64(&config, &["num_cpus"]).unwrap_or(1).max(1);
            parsed.config.cores_per_cpu =
                value_i64(&config, &["cores_per_cpu"]).unwrap_or(1).max(1);
            parsed.config.capacity = value_i64(&config, &["task_place_capacity"])
                .unwrap_or(1)
                .max(1);
            if let Some(start) = config.get("start").and_then(Value::as_array) {
                for item in start {
                    if let Some(name) = item.as_str() {
                        parsed.config.starts.push(name.to_string());
                    } else if let Some(name) = item.get("task").and_then(Value::as_str) {
                        parsed.config.starts.push(name.to_string());
                    }
                }
            }
            if let Some(end) = config.get("end").and_then(Value::as_array) {
                for item in end {
                    if let Some(name) = item.as_str() {
                        parsed.config.ends.push(name.to_string());
                    }
                }
            }
            if let Some(periodic) = config.get("periodic").and_then(Value::as_array) {
                for item in periodic {
                    if let Some(name) = item.get("task").and_then(Value::as_str) {
                        parsed.config.periodic.push((
                            name.to_string(),
                            item.get("period").and_then(Value::as_f64).unwrap_or(0.0),
                        ));
                    }
                }
            }
        }

        let mut metrics_by_name = std::collections::HashMap::new();
        if let Some(tasks) = result.metrics.get("tasks").and_then(Value::as_array) {
            for task in tasks {
                if let Some(name) = task.get("name").and_then(Value::as_str) {
                    metrics_by_name.insert(name.to_string(), task.clone());
                }
            }
        }

        if let Some(nodes) = result.tdg.get("nodes").and_then(Value::as_array) {
            for node in nodes {
                let mut task = TaskInfo::from_tdg(node);
                if task.id.is_empty() {
                    continue;
                }
                if let Some(metrics) = metrics_by_name.get(&task.id) {
                    task.merge_metrics(metrics);
                }
                parsed.tasks.push(task);
            }
        }

        for (name, metrics) in &metrics_by_name {
            if parsed.tasks.iter().any(|task| &task.id == name) {
                continue;
            }
            let mut task = TaskInfo {
                id: name.clone(),
                kind: "task".to_string(),
                wcet_kind: "model".to_string(),
                ..Default::default()
            };
            task.merge_metrics(metrics);
            if let Some(core) = value_i64(metrics, &["core"]) {
                task.core = core;
                task.has_core = core >= 0;
            }
            if let Some(priority) = value_i64(metrics, &["priority"]) {
                task.priority = priority;
                task.has_priority = true;
            }
            parsed.tasks.push(task);
        }

        if let Some(edges) = result.tdg.get("edges").and_then(Value::as_array) {
            for edge in edges {
                let source = value_str(edge, &["source"]).unwrap_or_default();
                let target = value_str(edge, &["target"]).unwrap_or_default();
                if source.is_empty() || target.is_empty() {
                    continue;
                }
                parsed.edges.push(TdgEdge {
                    source,
                    target,
                    label: value_str(edge, &["label"]).unwrap_or_default(),
                });
            }
        }

        if parsed.config.num_cpus <= 1 {
            if let Some(cores) = result.metrics.get("cores").and_then(Value::as_array) {
                parsed.config.num_cpus = cores.len().max(1) as i64;
            }
            for task in &parsed.tasks {
                if task.has_core {
                    parsed.config.num_cpus = parsed.config.num_cpus.max(task.core + 1);
                }
            }
        }

        for task in &mut parsed.tasks {
            if task.wcet <= 0.0 {
                for (_, high) in &task.times {
                    task.wcet = task.wcet.max(*high);
                }
            }
        }

        parsed.tasks.sort_by(|a, b| a.id.cmp(&b.id));
        parsed
    }
}

pub fn number(value: f64) -> String {
    if !value.is_finite() {
        return "—".to_string();
    }
    if (value - value.round()).abs() < 0.0001 {
        format!("{}", value.round() as i64)
    } else {
        format!("{value:.2}")
    }
}

pub fn bool_text(value: &Value, key: &str, fallback: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}
