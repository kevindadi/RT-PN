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

export interface StateNode {
  id: string;
  index: number;
  marking: string;
  active: string;
  suspended: string;
  elapsed: string;
}

export interface StateGraph {
  valid: boolean;
  nodes: StateNode[];
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

export interface BinaryFunctionRow {
  id: string | null;
  name: string | null;
  demangled_name: string | null;
  address: string | null;
  size: number | null;
  kind: string | null;
  language: string | null;
  blocks: number;
  calls: number;
  cycles_min: number | null;
  cycles_max: number | null;
  inline_frames: number;
}

export interface BinaryOptions {
  cpu?: string;
  board_profile?: string;
  freq?: string;
}

export interface BinaryCfgInstruction {
  address?: string;
  size?: number;
  bytes?: string;
  mnemonic?: string;
  operands?: string;
  text?: string;
  is_call?: boolean;
  is_jump?: boolean;
  is_return?: boolean;
  is_conditional?: boolean;
  direct_target?: string | null;
  source?: { file?: string; line?: number };
}

export interface BinaryCfgBlock {
  id: string;
  address?: string;
  size?: number;
  instructions?: BinaryCfgInstruction[];
  calls?: Array<Record<string, unknown>>;
  cycles?: { min?: number; max?: number };
  terminator?: string;
}

export interface BinaryCfgEdge {
  from: string;
  to: string;
  kind?: string;
  site?: string;
  conditional?: boolean;
}

export interface BinaryFunctionCfg {
  selector: string;
  name: string;
  demangled_name: string;
  address: string;
  size: number;
  kind: string;
  language: string;
  source: Record<string, unknown>;
  inline_frames: Array<Record<string, unknown>>;
  entry: string | null;
  blocks: BinaryCfgBlock[];
  edges: BinaryCfgEdge[];
  calls: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  caveats: string[];
  cfg_mermaid: string;
  json_path: string;
  warnings: string[];
}

export interface BinaryProfile {
  name: string;
  path: string;
}

export interface BinaryAnalysis {
  model: Record<string, unknown>;
  profile: Record<string, unknown>;
  wcet: Record<string, unknown> | null;
  cache: Record<string, unknown> | null;
  data_cache: Record<string, unknown> | null;
  data_memory: Record<string, unknown> | null;
  branch_prediction: Record<string, unknown> | null;
  caveats: string[];
}

export interface BinaryCoverage {
  total_instructions: number;
  classes: Array<{ class: string; count: number }>;
  unknown_mnemonics: number;
}

export interface ElfWorkflow {
  elf_path: string;
  file_size: number;
  artifacts_dir: string;
  elf_view: string;
  elf_mermaid: string;
  cfg_text: string;
  cfg_svg: string;
  cfg_graph: Graph | null;
  functions: number;
  blocks: number;
  calls: number;
  diagnostics: number;
  artifacts: string[];
  warnings: string[];
  schema: string;
  image: Record<string, unknown>;
  timing: Record<string, unknown>;
  roots: Array<Record<string, unknown>>;
  concurrency: Array<Record<string, unknown>>;
  function_rows: BinaryFunctionRow[];
  cfg_diagnostics: Array<Record<string, unknown>>;
  caveats: string[];
  analysis: BinaryAnalysis;
  coverage: BinaryCoverage;
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
  | "replay"
  | "timeline"
  | "report"
  | "overview"
  | "elf"
  | "functions"
  | "cfg"
  | "analysis";
