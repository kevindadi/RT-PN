export interface GraphNode {
  id: string;
  kind: string;
  detail: string;
  extra: string;
  shape: "circle" | "rect" | string;
}

export interface GraphEdge {
  from: number;
  to: number;
  label: string;
}

export interface Graph {
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface WorkbenchDocs {
  workflow: string;
  dag: string;
  ptpn: string;
  state: string;
  timeline: string;
  report: string;
  assumptions: string;
  dag_summary: string;
  ptpn_summary: string;
  state_summary: string;
  timeline_summary: string;
  report_summary: string;
  task_count: number;
  dag_edge_count: number;
  known_core: number;
  known_priority: number;
}

export interface PetriNet {
  valid: boolean;
  places: Array<{ id: string; tokens: number; capacity: number }>;
  transitions: Array<{ id: string; core: number; priority: number }>;
  arcs: Array<{ from: number; to: number; from_place: boolean }>;
  initial_marking: number[];
}

export interface StateGraph {
  valid: boolean;
  nodes: Array<{ id: string; index: number }>;
  edges: Array<{ from: number; to: number; label: string }>;
}

export interface AnalysisResult {
  ok: boolean;
  error: string;
  path: string;
  logs: string[];
  elapsed_ms: number;
  net: PetriNet;
  scg: StateGraph;
  metrics: Record<string, unknown>;
  tdg: Record<string, unknown>;
  workflow_label: string;
  binary_artifact: string;
  exit_code: number | null;
  partial: boolean;
  canceled: boolean;
  timed_out: boolean;
}

export interface TraceStep {
  state: string;
  transition: string;
  marking: string;
  active: string;
  elapsed: string;
}

export interface AnalysisPayload {
  result: AnalysisResult;
  docs: WorkbenchDocs;
  ptpn_graph: Graph | null;
  state_graph: Graph | null;
  deadlock_trace: TraceStep[] | null;
  deadlock_graph: Graph | null;
}

export interface PendingMeasurement {
  task: string;
  runs: number | null;
  timeout: number | null;
  expected_segments: number | null;
  line: number | null;
  column: number | null;
}

export interface FilledSource {
  path: string;
  filled: number;
  remaining_pending: number;
}

export interface AllocationReport {
  report: Record<string, unknown>;
  path: string;
}

export interface ProjectFile {
  version: number;
  workflow: "spec" | "binary";
  modelPath: string;
  stage: Stage;
  budgets: { maxStates: number; timeoutSecs: number; maxMemoryMb: number };
  savedAt: string;
}

export interface SweepEntry {
  policy: string;
  label: string;
  status: string;
  ok: boolean;
  schedulable: boolean | null;
  states: number;
  maxWcrt: number | null;
  deadlocks: number;
  elapsedMs: number;
  partial: boolean;
  error: string;
}

export interface ElfWorkflow {
  elf_path: string;
  file_size: number;
  artifacts_dir: string;
  elf_view: string;
  cfg_text: string;
  cfg_svg: string;
  cfg_graph: Graph | null;
  functions: number;
  blocks: number;
  calls: number;
  diagnostics: number;
  artifacts: string[];
  warnings: string[];
}

export interface EngineInfo {
  path: string;
  source: string;
  external_override: boolean;
}

export interface EngineHealth extends EngineInfo {
  name: string;
  version: string | null;
}

export interface AnalysisOptions {
  max_states?: number;
  timeout_secs?: number;
  max_memory_mb?: number;
  policy?: string;
  tie?: string;
}

export interface RunRecord {
  time: string;
  verdict: string;
  detail: string;
}

export type Workflow = "none" | "spec" | "binary";

export type Stage =
  | "dag"
  | "ptpn"
  | "semantics"
  | "state"
  | "timeline"
  | "report"
  | "elf"
  | "cfg";
