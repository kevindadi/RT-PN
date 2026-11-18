import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Binary,
  Boxes,
  Braces,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Cpu,
  Eye,
  FileCode2,
  FolderOpen,
  GitBranch,
  Layers3,
  Network,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  Upload,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

import {
  allocateCores,
  analyzeElf,
  analyzeModel,
  binaryFunction,
  binaryProfiles,
  cancelAnalysis,
  describeModel,
  engineHealth,
  exampleBase,
  fillTimings,
  pendingTimings,
  pickElf,
  pickProject,
  pickSpecification,
  readTextFile,
  workspaceDeleteProject,
  workspaceOpenProject,
  workspaceOpenRun,
  workspaceRecent,
  workspaceSaveProject,
  writeTextFile,
} from "./api";
import { BinaryAnalysisView } from "./BinaryAnalysis";
import { BinaryCfg } from "./BinaryCfg";
import { BinaryCompare } from "./BinaryCompare";
import { BinaryOverview } from "./BinaryStages";
import { WorkflowGuide } from "./Guide";
import { CodeStage } from "./CodeStage";
import { GraphPreview, SvgPreview } from "./GraphPreview";
import { Mermaid } from "./Mermaid";
import { ScgReplay } from "./Replay";
import { ReplayCompare, type CompareLane } from "./ReplayCompare";
import { stepsFor } from "./replayModel";
import { SCHEDULING_POLICIES, SemanticsStage, policyById } from "./Semantics";
import type {
  AllocationReport,
  AnalysisPayload,
  ElfWorkflow,
  EngineHealth,
  Graph,
  PendingMeasurement,
  ProjectFile,
  RunRecord,
  Stage,
  SweepEntry,
  TraceStep,
  Workflow,
  WorkbenchDocs,
  BinaryFunctionRow,
  BinaryFunctionCfg,
  BinaryOptions,
  BinaryProfile,
  WorkspaceProject,
} from "./types";

const STAGES: Record<
  Stage,
  { label: string; title: string; subtitle: string; previewable: boolean }
> = {
  dag: {
    label: "DAG",
    title: "TASK GRAPH",
    subtitle: "Text-first DAG / task view · explicit timing provenance",
    previewable: false,
  },
  ptpn: {
    label: "PTPN",
    title: "PTPN STRUCTURE",
    subtitle: "Places, transitions and arcs as dense text",
    previewable: true,
  },
  semantics: {
    label: "SEMANTICS",
    title: "SCHEDULING SEMANTICS",
    subtitle: "Formal state, firing rule and animation for the selected policy",
    previewable: false,
  },
  state: {
    label: "STATE SPACE",
    title: "STATE-CLASS SPACE",
    subtitle: "Reachability classes and transitions as text",
    previewable: true,
  },
  replay: {
    label: "REPLAY",
    title: "STATE-CLASS REPLAY",
    subtitle: "Step through a real transition path: marking, E_pri and clocks",
    previewable: false,
  },
  timeline: {
    label: "TIMELINE",
    title: "TIMELINE / ENVELOPES",
    subtitle: "Response envelopes · not a concrete schedule",
    previewable: false,
  },
  report: {
    label: "REPORT",
    title: "REPORT",
    subtitle: "Copyable analysis report with assumptions",
    previewable: false,
  },
  elf: {
    label: "ELF",
    title: "ELF LAYOUT",
    subtitle: "Readable ELF layout as text · PREVIEW renders the Mermaid image",
    previewable: true,
  },
  overview: {
    label: "OVERVIEW",
    title: "BINARY OVERVIEW",
    subtitle: "Image, timing model, roots and hot functions of the CFG",
    previewable: false,
  },
  functions: {
    label: "FUNCTIONS",
    title: "FUNCTION INDEX",
    subtitle: "Searchable functions with block/call/cycle metadata",
    previewable: false,
  },
  cfg: {
    label: "CFG",
    title: "CONTROL-FLOW GRAPH",
    subtitle: "Interactive function CFG with instruction inspector",
    previewable: true,
  },
  analysis: {
    label: "ANALYSIS",
    title: "STATIC ANALYSIS",
    subtitle: "Board-profile cache, branch, memory and WCET results",
    previewable: false,
  },
};

type Tone = "muted" | "accent" | "good" | "warn" | "bad" | "violet";

interface Status {
  text: string;
  tone: Tone;
}

interface Detail {
  title: string;
  body: string;
}

interface PreviewState {
  graph: Graph;
  title: string;
  footer: string;
}

interface ImagePreviewState {
  svg: string;
  title: string;
  footer: string;
}

interface Metrics {
  schedulable?: boolean;
  exact?: boolean;
  truncated?: boolean;
  hyperperiod?: number;
  states?: number;
  deadlocks?: number;
  tasks?: Array<{
    name?: string;
    core?: number;
    deadline?: number;
    wcrt?: number;
    slack?: number | null;
    deadline_missed?: boolean;
  }>;
  cores?: unknown[];
  deadlock_states?: number[];
}

interface Budget {
  maxStates: number;
  timeoutSecs: number;
  maxMemoryMb: number;
}

interface RunSnapshot {
  id: number;
  time: string;
  file: string;
  ok: boolean;
  partial: boolean;
  canceled: boolean;
  schedulable?: boolean;
  exact?: boolean;
  truncated?: boolean;
  states: number;
  budgets: Budget;
  elapsedMs: number;
  wcrt: Record<string, number>;
}

function snapshotFrom(payload: AnalysisPayload, budgets: Budget, id: number): RunSnapshot {
  const metrics = (payload.result.metrics ?? {}) as Metrics;
  const wcrt: Record<string, number> = {};
  for (const task of metrics.tasks ?? []) {
    if (task?.name && typeof task.wcrt === "number") {
      wcrt[task.name] = task.wcrt;
    }
  }
  return {
    id,
    time: timestamp(),
    file: fileName(payload.result.path),
    ok: payload.result.ok,
    partial: payload.result.partial,
    canceled: payload.result.canceled,
    schedulable: metrics.schedulable,
    exact: metrics.exact,
    truncated: metrics.truncated,
    states: payload.result.scg.nodes.length,
    budgets,
    elapsedMs: payload.result.elapsed_ms,
    wcrt,
  };
}

function reportNumber(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}

function deadlockTraceText(trace: TraceStep[]): string {
  const lines = ["DEADLOCK COUNTEREXAMPLE", ""];
  trace.forEach((step, index) => {
    if (index > 0) {
      lines.push(`   ── ${step.transition || "(transition)"} ──▶`);
    }
    lines.push(` ${step.state}  t=${step.elapsed || "?"}  M=${step.marking}`);
  });
  return lines.join("\n");
}

function buildMarkdownReport(
  payload: AnalysisPayload,
  budgets: Budget,
  policy: string,
  tie: string,
  sweep: SweepEntry[] = [],
): string {
  const result = payload.result;
  const metrics = result.metrics ?? {};
  const lines = [
    `# RT-PN analysis report`,
    "",
    `- Model: \`${result.path}\``,
    `- Workflow: ${result.workflow_label || "SPEC-FIRST"}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Status: ${result.ok ? (result.partial ? "PARTIAL (resource budget reached)" : "OK") : "FAILED"}`,
    `- Exit code: ${result.exit_code ?? "—"}`,
    `- Elapsed: ${result.elapsed_ms} ms`,
    `- Budget: max-states ${budgets.maxStates}, timeout ${budgets.timeoutSecs || "off"} s, max-memory ${budgets.maxMemoryMb || "off"} MB`,
    `- Scheduling policy: ${policy} · tie ${tie}`,
    "",
    "## Assumptions",
    "",
    payload.docs.assumptions || "(none)",
    "",
    "## State space",
    "",
    `- state classes: ${result.scg.nodes.length}`,
    `- transitions: ${result.scg.edges.length}`,
    `- places/transitions/arcs: ${result.net.places.length}/${result.net.transitions.length}/${result.net.arcs.length}`,
    "",
    "## Metrics JSON",
    "",
    "```json",
    JSON.stringify(metrics, null, 2),
    "```",
    "",
  ];
  if (sweep.length > 0) {
    lines.push(
      "## Policy sweep",
      "",
      "| policy | verdict | max WCRT | states | deadlocks | elapsed |",
      "| --- | --- | ---: | ---: | ---: | ---: |",
      ...sweep.map(
        (entry) =>
          `| ${entry.label} | ${entry.status} | ${entry.maxWcrt ?? "—"} | ${entry.states} | ${entry.deadlocks} | ${entry.elapsedMs} ms |`,
      ),
      "",
    );
  }
  if (payload.deadlock_trace && payload.deadlock_trace.length > 0) {
    lines.push("## Deadlock counterexample", "", "```text", deadlockTraceText(payload.deadlock_trace), "```", "");
  }
  lines.push(
    "## DAG",
    "",
    "```text",
    payload.docs.dag,
    "```",
    "",
    "## Report",
    "",
    "```text",
    payload.docs.report,
    "```",
    "",
  );
  if (result.error) {
    lines.push("## Error", "", "```text", result.error, "```", "");
  }
  const logTail = result.logs.slice(-80);
  if (logTail.length > 0) {
    lines.push("## Analyzer log tail", "", "```text", logTail.join("\n"), "```", "");
  }
  return lines.join("\n");
}

function WcrtChart({ tasks }: { tasks: NonNullable<Metrics["tasks"]> }) {
  const scale = Math.max(
    1,
    ...tasks.map((task) => Math.max(task.wcrt ?? 0, task.deadline ?? 0)),
  );
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {tasks.map((task) => {
        const wcrt = task.wcrt ?? 0;
        const deadline = task.deadline ?? 0;
        const missed = task.deadline_missed ?? (deadline > 0 && wcrt > deadline);
        const slack = deadline > 0 ? deadline - wcrt : task.slack;
        return (
          <div key={task.name ?? "task"} style={{ fontSize: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="mono">{task.name ?? "task"}</span>
              <span className="faint">
                wcrt {wcrt}
                {deadline > 0 ? ` / d ${deadline}` : ""}
                {typeof slack === "number" ? ` · slack ${slack}` : ""}
              </span>
            </div>
            <div
              style={{
                position: "relative",
                height: 8,
                background: "#0b1422",
                border: "1px solid #1d3350",
                borderRadius: 2,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${Math.min(100, (wcrt / scale) * 100)}%`,
                  background: missed ? "#ff6b6b" : "#4fa3ff",
                }}
              />
              {deadline > 0 && (
                <div
                  title="deadline"
                  style={{
                    position: "absolute",
                    top: -3,
                    bottom: -3,
                    left: `${Math.min(100, (deadline / scale) * 100)}%`,
                    width: 1,
                    background: "#f2c14e",
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RunCompare({ a, b, onClose }: { a: RunSnapshot; b: RunSnapshot; onClose: () => void }) {
  const rows: Array<{ label: string; before: string; after: string; regressed: boolean }> = [
    {
      label: "status",
      before: a.ok ? (a.partial ? "PARTIAL" : "OK") : "FAILED",
      after: b.ok ? (b.partial ? "PARTIAL" : "OK") : "FAILED",
      regressed: a.ok && !b.ok,
    },
    {
      label: "schedulable",
      before: reportNumber(a.schedulable === undefined ? undefined : Number(a.schedulable)),
      after: reportNumber(b.schedulable === undefined ? undefined : Number(b.schedulable)),
      regressed: a.schedulable === true && b.schedulable === false,
    },
    {
      label: "state classes",
      before: String(a.states),
      after: String(b.states),
      regressed: b.states > a.states,
    },
    {
      label: "exact",
      before: String(a.exact ?? "—"),
      after: String(b.exact ?? "—"),
      regressed: a.exact === true && b.exact === false,
    },
    {
      label: "truncated",
      before: String(a.truncated ?? "—"),
      after: String(b.truncated ?? "—"),
      regressed: a.truncated === false && b.truncated === true,
    },
    {
      label: "elapsed ms",
      before: String(a.elapsedMs),
      after: String(b.elapsedMs),
      regressed: false,
    },
    {
      label: "budget",
      before: `${a.budgets.maxStates}/${a.budgets.timeoutSecs}s`,
      after: `${b.budgets.maxStates}/${b.budgets.timeoutSecs}s`,
      regressed: false,
    },
  ];
  const tasks = [...new Set([...Object.keys(a.wcrt), ...Object.keys(b.wcrt)])].sort();
  return (
    <div className="preview-backdrop" onMouseDown={onClose}>
      <div className="preview-window" onMouseDown={(event) => event.stopPropagation()}>
        <div className="preview-header">
          <div>
            <div className="preview-eyebrow">RUN COMPARISON</div>
            <div className="preview-title">
              {a.file} · #{a.id} → #{b.id}
            </div>
          </div>
          <div className="preview-footer-label">red = regression</div>
          <button className="btn ghost" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div className="preview-canvas" style={{ display: "block", overflow: "auto", padding: 18 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "#7c8ca8", textAlign: "left" }}>
                <th style={{ padding: 6 }}>metric</th>
                <th style={{ padding: 6 }}>run #{a.id}</th>
                <th style={{ padding: 6 }}>run #{b.id}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} style={{ borderTop: "1px solid #1d3350" }}>
                  <td style={{ padding: 6, color: "#b9d3ec" }}>{row.label}</td>
                  <td style={{ padding: 6 }}>{row.before}</td>
                  <td style={{ padding: 6, color: row.regressed ? "#ff8a8a" : "#e6f1ff" }}>
                    {row.after}
                    {row.regressed ? "  ▲" : ""}
                  </td>
                </tr>
              ))}
              {tasks.map((task) => {
                const before = a.wcrt[task];
                const after = b.wcrt[task];
                const regressed =
                  before !== undefined && after !== undefined && after > before;
                return (
                  <tr key={`task-${task}`} style={{ borderTop: "1px solid #11243b" }}>
                    <td style={{ padding: 6, color: "#8ca9c8" }}>wcrt · {task}</td>
                    <td style={{ padding: 6 }}>{reportNumber(before)}</td>
                    <td style={{ padding: 6, color: regressed ? "#ff8a8a" : "#e6f1ff" }}>
                      {reportNumber(after)}
                      {regressed ? "  ▲" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function stagesFor(workflow: Workflow): Stage[] {
  return workflow === "binary"
    ? ["overview", "elf", "cfg", "analysis"]
    : ["dag", "ptpn", "semantics", "state", "replay", "timeline", "report"];
}

function stageDoc(stage: Stage, docs: WorkbenchDocs | undefined): string {
  if (!docs) return "";
  switch (stage) {
    case "dag":
      return docs.dag;
    case "ptpn":
      return docs.ptpn;
    case "state":
      return docs.state;
    case "timeline":
      return docs.timeline;
    case "report":
      return docs.report;
    default:
      return "";
  }
}

function binaryDoc(stage: Stage, elf: ElfWorkflow | null | undefined): string {
  if (!elf) return "";
  switch (stage) {
    case "elf":
      return elf.elf_view;
    case "cfg":
      return elf.cfg_text;
    default:
      return "";
  }
}

function stageSummary(stage: Stage, docs: WorkbenchDocs | undefined): string {
  if (!docs) return "";
  switch (stage) {
    case "dag":
      return docs.dag_summary;
    case "ptpn":
      return docs.ptpn_summary;
    case "state":
      return docs.state_summary;
    case "timeline":
      return docs.timeline_summary;
    case "report":
      return docs.report_summary;
    default:
      return "";
  }
}

function fileName(path: string | null | undefined): string {
  if (!path) return "NO MODEL";
  return path.split(/[\\/]/).pop() ?? path;
}

function engineTag(engine: { source: string; external_override: boolean }): string {
  return engine.external_override ? `${engine.source.toUpperCase()}·EXTERNAL` : engine.source.toUpperCase();
}

function isBinaryPath(path: string): boolean {
  return /\.(elf|out|axf)$/i.test(path);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function valueString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function analysisModelId(binary: ElfWorkflow): string {
  const model = binary.analysis?.model;
  if (model === null || typeof model !== "object") return "no timing model";
  return valueString((model as Record<string, unknown>).id) || "no timing model";
}

/** Guard rails so a huge Mermaid/text layout never blocks the workbench. */
const ELF_PREVIEW_CHAR_LIMIT = 400_000;
const ELF_TEXT_CHAR_LIMIT = 1_500_000;

function timestamp(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface BinaryRunConfig {
  id: string;
  name: string;
  cpu?: string;
  freq?: string;
  board_profile?: string;
}

const BINARY_CONFIGS_KEY = "rtpn.binary.configs.v1";

export default function App() {
  const [workflow, setWorkflow] = useState<Workflow>("none");
  const [hub, setHub] = useState(true);
  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(null);
  const [binary, setBinary] = useState<ElfWorkflow | null>(null);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<Stage>("dag");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ text: "NO PROJECT", tone: "muted" });
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [detail, setDetail] = useState<Detail>({
    title: "NO MODEL",
    body: "Choose a workflow to begin. Text is the primary surface; graphs open only from PREVIEW.",
  });
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const [mermaidPreview, setMermaidPreview] = useState<{
    chart: string;
    title: string;
    footer: string;
  } | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [cli, setCli] = useState<EngineHealth | null>(null);
  const [elf2tdg, setElf2tdg] = useState<EngineHealth | null>(null);
  const [budget, setBudget] = useState<Budget>({
    maxStates: 20000,
    timeoutSecs: 120,
    maxMemoryMb: 2048,
  });
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [liveElapsed, setLiveElapsed] = useState(0);
  const [snapshots, setSnapshots] = useState<RunSnapshot[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [pending, setPending] = useState<PendingMeasurement[]>([]);
  const [pendingInputs, setPendingInputs] = useState<Record<string, string>>({});
  const [fillBusy, setFillBusy] = useState(false);
  const [allocation, setAllocation] = useState<AllocationReport | null>(null);
  const [allocateBusy, setAllocateBusy] = useState(false);
  const [policy, setPolicy] = useState("fixed_prior_with_resume");
  const [tie, setTie] = useState("fifo");
  const [describeText, setDescribeText] = useState("");
  const [describeBusy, setDescribeBusy] = useState(false);
  const [sweep, setSweep] = useState<SweepEntry[]>([]);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepProgress, setSweepProgress] = useState({ done: 0, total: 0 });
  const [binaryOptions, setBinaryOptions] = useState<BinaryOptions>({});
  const [profiles, setProfiles] = useState<BinaryProfile[]>([]);
  const [cfgSelector, setCfgSelector] = useState<string | null>(null);
  const [functionCfg, setFunctionCfg] = useState<BinaryFunctionCfg | null>(null);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [wcetPath, setWcetPath] = useState<string[] | null>(null);
  const [binaryFunctionQuery, setBinaryFunctionQuery] = useState("");
  const [configName, setConfigName] = useState("");
  const [binaryConfigs, setBinaryConfigs] = useState<BinaryRunConfig[]>(() => {
    try {
      const stored = localStorage.getItem(BINARY_CONFIGS_KEY);
      return stored ? (JSON.parse(stored) as BinaryRunConfig[]) : [];
    } catch {
      return [];
    }
  });
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>([]);

  useEffect(() => {
    void workspaceRecent(12)
      .then(setWorkspaceProjects)
      .catch(() => undefined);
  }, [hub, workflow]);

  useEffect(() => {
    try {
      localStorage.setItem(BINARY_CONFIGS_KEY, JSON.stringify(binaryConfigs));
    } catch {
      // storage can be unavailable in restricted webviews; configurations are optional
    }
  }, [binaryConfigs]);
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelected, setCompareSelected] = useState<string[]>([]);
  const [compareLanes, setCompareLanes] = useState<CompareLane[]>([]);
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareProgress, setCompareProgress] = useState({ done: 0, total: 0 });
  const runStartedRef = useRef(0);
  const snapshotIdRef = useRef(1);
  const [error, setError] = useState<string | null>(null);
  const openPathRef = useRef<(path: string) => void>(() => undefined);

  const metrics = (analysis?.result.metrics ?? {}) as Metrics;
  const stages = stagesFor(workflow);
  const isBinary = workflow === "binary";
  const doc = isBinary
    ? binaryDoc(activeStage, binary)
    : stageDoc(activeStage, analysis?.docs);
  const binarySummary = binary
    ? activeStage === "overview"
      ? `${binary.schema || "cfg"} · ${binary.functions} fns · ${binary.roots.length} roots`
      : activeStage === "functions"
        ? `${binary.function_rows.length} functions · click a row to open the CFG`
        : activeStage === "analysis"
          ? `${analysisModelId(binary)} · ${binary.analysis?.caveats?.length ?? 0} caveats`
          : activeStage === "elf"
          ? `${(binary.file_size / 1024).toFixed(1)} KB · ${binary.artifacts_dir}`
          : `${binary.functions} fns · ${binary.blocks} blocks · ${binary.calls} calls · ${binary.diagnostics} diagnostics`
    : "";
  const summary = isBinary ? binarySummary : stageSummary(activeStage, analysis?.docs);
  const assumptions = isBinary
    ? binary?.warnings.join("\n") ||
      "elf2tdg loader view → readable CFG → Graphviz preview. Threads/net analysis is pending."
    : analysis?.docs?.assumptions ?? "";

  const deadlockSteps = analysis?.deadlock_trace ?? null;
  const deadlockCount = metrics.deadlock_states?.length ?? 0;
  const taskMetrics = metrics.tasks ?? [];
  const policyInfo = policyById(policy);

  useEffect(() => {
    if (workflow !== "binary") return;
    void binaryProfiles()
      .then((items) => setProfiles(items))
      .catch(() => setProfiles([]));
  }, [workflow]);

  const openDeadlockPreview = () => {
    if (!analysis?.deadlock_graph) return;
    setPreview({
      graph: analysis.deadlock_graph,
      title: "DEADLOCK COUNTEREXAMPLE",
      footer: "Shortest path from the initial state class to a reachable deadlock",
    });
  };

  useEffect(() => {
    engineHealth()
      .then((list) => {
        setCli(list.find((engine) => engine.name === "ptpn") ?? null);
        setElf2tdg(list.find((engine) => engine.name === "elf2tdg") ?? null);
      })
      .catch(() => {
        setCli(null);
        setElf2tdg(null);
      });
  }, []);

  useEffect(() => {
    const pending = listen<{ line: string; elapsed_ms: number }>("analysis-log", (event) => {
      setLiveLog((previous) => [...previous.slice(-199), event.payload.line]);
      setLiveElapsed(event.payload.elapsed_ms);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      if (runStartedRef.current > 0) {
        setLiveElapsed(Date.now() - runStartedRef.current);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    invoke<string[]>("startup_paths")
      .then((paths) => {
        const path = paths[0];
        if (path) {
          window.setTimeout(() => openPathRef.current(path), 250);
        }
      })
      .catch(() => undefined);  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreview(null);
        setImagePreview(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const path = event.payload.paths?.[0];
          if (path) openPathRef.current(path);
        }
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const setWindowTitle = (name: string) => {
    getCurrentWindow().setTitle(`RT-PN  ·  ${name}`).catch(() => undefined);
  };

  const appendHistory = useCallback((verdict: string, detailText: string) => {
    setHistory((previous) =>
      [{ time: timestamp(), verdict, detail: detailText }, ...previous].slice(0, 5),
    );
  }, []);

  const runSpec = useCallback(
    async (path: string, newProject: boolean) => {
      setPreview(null);
      setImagePreview(null);
      setMermaidPreview(null);
      setHub(false);
      setWorkflow("spec");
      setBinary(null);
      setAnalysis(null);
      setCurrentPath(path);
      setActiveStage("dag");
      setBusy(true);
      setError(null);
      setStatus({ text: "ANALYZING", tone: "warn" });
      setDetail({
        title: "ANALYZING",
        body: `${path}\n\nRunning the C++ ptpn analyzer and materializing text artifacts.`,
      });
      setWindowTitle(fileName(path));
      if (newProject) setHistory([]);
      setLiveLog([]);
      setLiveElapsed(0);
      setPending([]);
      setPendingInputs({});
      setAllocation(null);
      setDescribeText("");
      setSweep([]);
      setCompareMode(false);
      setCompareLanes([]);
      runStartedRef.current = Date.now();
      try {
        const payload = await analyzeModel(path, {
          max_states: budget.maxStates,
          timeout_secs: budget.timeoutSecs,
          max_memory_mb: budget.maxMemoryMb,
          policy,
          tie,
        });
        setAnalysis(payload);
        setBusy(false);
        runStartedRef.current = 0;
        const result = payload.result;
        setSnapshots((previous) =>
          [...previous, snapshotFrom(payload, budget, snapshotIdRef.current++)].slice(-10),
        );
        if (result.canceled) {
          setStatus({ text: "CANCELED", tone: "warn" });
          setDetail({
            title: "RUN CANCELED",
            body: `canceled after ${result.elapsed_ms} ms`,
          });
          appendHistory("CANCELED", `${payload.docs.task_count}T · canceled`);
          return;
        }
        const verdict = !result.ok
          ? "ERROR"
          : result.partial
            ? "PARTIAL"
            : metricsSchedulable(payload)
              ? "SCHEDULABLE"
              : "UNSCHEDULABLE";
        setStatus({
          text: verdict,
          tone: !result.ok
            ? "bad"
            : result.partial
              ? "warn"
              : metricsSchedulable(payload)
                ? "good"
                : "bad",
        });
        const budgetLine = `budget   max-states ${budget.maxStates} · timeout ${budget.timeoutSecs || "off"} s · max-memory ${budget.maxMemoryMb || "off"} MB\npolicy   ${policyInfo.label} (${policy}) · tie ${tie}`;
        const partialLine = result.partial
          ? `\npartial  resource budget reached (exit 5): the state-class graph is an incomplete prefix and metrics stay bounds`
          : "";
        setDetail({
          title: result.ok ? "MODEL READY" : "ANALYSIS FAILED",
          body: result.ok
            ? `${result.net.places.length} places · ${result.net.transitions.length} transitions\n${result.scg.nodes.length} state classes · ${result.scg.edges.length} edges\n${budgetLine}${partialLine}\n\nText is the primary workbench; PREVIEW opens a graph.`
            : `${result.error}\n\n${budgetLine}`,
        });
        appendHistory(
          verdict,
          `${payload.docs.task_count}T · ${result.scg.nodes.length}S${result.partial ? " · partial" : ""}`,
        );
        void describeModel(path, policy, tie)
          .then((description) => setDescribeText(description))
          .catch(() => setDescribeText(""));
      } catch (reason) {
        setBusy(false);
        setStatus({ text: "ANALYSIS FAILED", tone: "bad" });
        setError(String(reason));
        setDetail({ title: "ANALYSIS FAILED", body: String(reason) });
      }
    },
    [appendHistory, budget, policyInfo, policy, tie],
  );

  const exportReport = useCallback(
    async (format: "md" | "json") => {
      if (!analysis) return;
      const contents =
        format === "md"
          ? buildMarkdownReport(analysis, budget, policy, tie, sweep)
          : JSON.stringify(
              { budgets: budget, policy, tie, sweep, result: analysis.result, docs: analysis.docs },
              null,
              2,
            );
      const stem = fileName(analysis.result.path).replace(/\.[^.]+$/, "");
      try {
        const target = await save({
          defaultPath: `${stem}-report.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (!target) return;
        await writeTextFile(target, contents);
        setDetail({ title: "REPORT EXPORTED", body: target });
      } catch (reason) {
        setError(String(reason));
      }
    },
    [analysis, budget, policy, tie, sweep],
  );

  const refreshDescription = useCallback(async () => {
    if (!currentPath) return;
    setDescribeBusy(true);
    try {
      setDescribeText(await describeModel(currentPath, policy, tie));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setDescribeBusy(false);
    }
  }, [currentPath, policy, tie]);

  const toggleComparePolicy = (id: string) => {
    setCompareSelected((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id],
    );
  };

  const openPolicyCompare = () => {
    setCompareSelected(
      Array.from(new Set([policy, "fixed_prior_with_resume", "pcp", "pip"])),
    );
    setCompareMode(true);
  };

  const runPolicyComparison = useCallback(async () => {
    if (!currentPath || isBinary || compareBusy) return;
    const policies = compareSelected.length > 0 ? compareSelected : [policy];
    const maxStates = Math.min(budget.maxStates, 5_000);
    const timeoutSecs = Math.min(budget.timeoutSecs || 20, 20);
    setCompareBusy(true);
    setCompareLanes([]);
    setError(null);
    const lanes: CompareLane[] = [];
    for (const [position, id] of policies.entries()) {
      setCompareProgress({ done: position, total: policies.length });
      const info = policyById(id);
      let lane: CompareLane = {
        policy: id,
        label: info.label,
        status: "ERROR",
        mode: "",
        error: "",
        steps: [],
      };
      try {
        const payload = await analyzeModel(currentPath, {
          max_states: maxStates,
          timeout_secs: timeoutSecs,
          max_memory_mb: budget.maxMemoryMb,
          policy: id,
          tie,
        });
        const steps = stepsFor(payload.result.scg, payload.deadlock_trace);
        const deadlock = Boolean(payload.deadlock_trace?.length);
        const status = !payload.result.ok
          ? "ERROR"
          : deadlock
            ? "DEADLOCK"
            : payload.result.partial || payload.result.timed_out
              ? "PARTIAL"
              : "PATH";
        lane = {
          ...lane,
          status,
          mode: deadlock ? "deadlock counterexample" : "shortest path",
          steps,
          error: payload.result.ok ? "" : payload.result.error,
        };
      } catch (reason) {
        lane = { ...lane, error: String(reason) };
      }
      lanes.push(lane);
      setCompareLanes([...lanes]);
    }
    setCompareProgress({ done: policies.length, total: policies.length });
    setCompareBusy(false);
  }, [
    compareBusy,
    compareSelected,
    currentPath,
    isBinary,
    budget.maxMemoryMb,
    budget.maxStates,
    budget.timeoutSecs,
    tie,
    policy,
  ]);

  const sweepMaxStates = Math.min(budget.maxStates, 8_000);
  const sweepTimeoutSecs = Math.min(budget.timeoutSecs || 30, 30);

  const runSweep = useCallback(async () => {
    if (!currentPath || isBinary || sweepBusy) return;
    setSweepBusy(true);
    setSweep([]);
    setError(null);
    const entries: SweepEntry[] = [];
    for (const [index, candidate] of SCHEDULING_POLICIES.entries()) {
      setSweepProgress({ done: index, total: SCHEDULING_POLICIES.length });
      let entry: SweepEntry = {
        policy: candidate.id,
        label: candidate.label,
        status: "ERROR",
        ok: false,
        schedulable: null,
        states: 0,
        maxWcrt: null,
        deadlocks: 0,
        elapsedMs: 0,
        partial: false,
        error: "",
      };
      try {
        const payload = await analyzeModel(currentPath, {
          max_states: sweepMaxStates,
          timeout_secs: sweepTimeoutSecs,
          max_memory_mb: budget.maxMemoryMb,
          policy: candidate.id,
          tie,
        });
        const result = payload.result;
        const metrics = (result.metrics ?? {}) as Metrics;
        const deadlocks = metrics.deadlock_states?.length ?? 0;
        const wcrts = (metrics.tasks ?? [])
          .map((task) => task.wcrt)
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        const status = !result.ok
          ? "ERROR"
          : result.partial || result.timed_out
            ? "PARTIAL"
            : deadlocks > 0
              ? "DEADLOCK"
              : metrics.schedulable === false
                ? "UNSCHEDULABLE"
                : "OK";
        entry = {
          ...entry,
          status,
          ok: result.ok,
          schedulable: metrics.schedulable ?? null,
          states: result.scg?.nodes?.length ?? 0,
          maxWcrt: wcrts.length > 0 ? Math.max(...wcrts) : null,
          deadlocks,
          elapsedMs: result.elapsed_ms,
          partial: result.partial,
          error: result.ok ? "" : result.error,
        };
      } catch (reason) {
        entry = { ...entry, status: "ERROR", error: String(reason) };
      }
      entries.push(entry);
      setSweep([...entries]);
    }
    setSweepProgress({ done: SCHEDULING_POLICIES.length, total: SCHEDULING_POLICIES.length });
    setSweepBusy(false);
  }, [currentPath, isBinary, budget.maxMemoryMb, tie, sweepBusy, sweepMaxStates, sweepTimeoutSecs]);

  const runBinary = useCallback(
    async (path: string, newProject: boolean, overrideOptions?: BinaryOptions) => {
      setPreview(null);
      setImagePreview(null);
      setMermaidPreview(null);
      setHub(false);
      setWorkflow("binary");
      setAnalysis(null);
      setCurrentPath(null);
      setBusy(true);
      setError(null);
      setStatus({ text: "PARSING ELF", tone: "violet" });
      setDetail({
        title: "ELF WORKFLOW",
        body: `${path}\n\nRunning the elf2tdg loader view and CFG extraction.`,
      });
      setWindowTitle(fileName(path));
      if (newProject) setHistory([]);
      setFunctionCfg(null);
      setCfgSelector(null);
      setCfgError(null);
      setWcetPath(null);
      setBinary(null);
      const activeOptions = overrideOptions ?? binaryOptions;
      try {
        const payload = await analyzeElf(path, activeOptions);
        setBinary(payload);
        setCurrentPath(path);
        void workspaceSaveProject(fileName(path), path, activeOptions, payload)
          .then(() => workspaceRecent(12))
          .then(setWorkspaceProjects)
          .catch(() => undefined);
        setCurrentPath(path);
        setBusy(false);
        setActiveStage("overview");
        setStatus({ text: "ELF READY", tone: "violet" });
        const warningBlock =
          payload.warnings.length > 0
            ? `\n\nwarnings\n${payload.warnings.map((warning) => `  · ${warning}`).join("\n")}`
            : "";
        setDetail({
          title: "ELF WORKFLOW",
          body:
            `ELF      ${fileName(payload.elf_path)} (${Math.round(payload.file_size / 1024)} KB)\n` +
            `CFG      ${payload.functions} functions · ${payload.blocks} blocks · ${payload.calls} calls\n` +
            `PREVIEW  ${payload.cfg_svg ? "Graphviz SVG" : "interactive graph fallback"}\n` +
            `ARTIFACTS ${payload.artifacts_dir}${warningBlock}`,
        });
        appendHistory(
          "ELF",
          `CFG ${payload.functions} fn · ${payload.calls} calls`,
        );
      } catch (reason) {
        setBusy(false);
        setStatus({ text: "IMPORT FAILED", tone: "bad" });
        setError(String(reason));
        setDetail({ title: "IMPORT FAILED", body: String(reason) });
      }
    },
    [appendHistory, binaryOptions],
  );

  const loadFunctionCfg = useCallback(
    async (selector: string) => {
      if (!currentPath || !selector) return;
      setWcetPath(null);
      setCfgSelector(selector);
      setCfgLoading(true);
      setCfgError(null);
      try {
        const cfg = await binaryFunction(currentPath, selector, binaryOptions);
        setFunctionCfg(cfg);
        setDetail({
          title: "FUNCTION CFG",
          body:
            `${cfg.name || selector}\n` +
            `${cfg.address || "—"} · ${cfg.blocks.length} blocks · ${cfg.edges.length} edges\n` +
            `${cfg.source?.file ? `${cfg.source.file}:${cfg.source.line ?? "?"}` : "no source mapping"}`,
        });
      } catch (reason) {
        setFunctionCfg(null);
        setCfgError(String(reason));
        setDetail({ title: "CFG EXPLORER", body: String(reason) });
      } finally {
        setCfgLoading(false);
      }
    },
    [binaryOptions, currentPath],
  );

  const functionSelector = (row: BinaryFunctionRow): string =>
    row.name || row.demangled_name || row.address || row.id || "";

  useEffect(() => {
    if (!isBinary || activeStage !== "cfg" || !currentPath) return;
    if (functionCfg && cfgSelector) return;
    if (cfgLoading) return;
    const rootName = binary?.roots
      .map((root) => (typeof root.name === "string" ? root.name : ""))
      .find((name) => name.length > 0);
    const fallback = binary?.function_rows.find((row) => (row.name ?? "").length > 0);
    const selector = rootName || (fallback ? functionSelector(fallback) : "");
    if (selector) void loadFunctionCfg(selector);
  }, [
    activeStage,
    binary,
    cfgLoading,
    cfgSelector,
    functionCfg,
    isBinary,
    currentPath,
    loadFunctionCfg,
  ]);

  const cancelRun = useCallback(async () => {
    setStatus({ text: "CANCELING", tone: "warn" });
    await cancelAnalysis();
  }, []);

  const fillPending = useCallback(async () => {
    if (!currentPath || pending.length === 0) return;
    const values: Record<string, Array<[number, number]>> = {};
    for (const measurement of pending) {
      const numbers = (pendingInputs[measurement.task] ?? "")
        .split(/[\s,;]+/)
        .map((token) => Number(token))
        .filter((value) => Number.isFinite(value));
      if (numbers.length === 0 || numbers.length % 2 !== 0) {
        setError(`Task ${measurement.task}: enter interval pairs, e.g. "1,2, 2,3, 1,2".`);
        return;
      }
      const intervals: Array<[number, number]> = [];
      for (let index = 0; index < numbers.length; index += 2) {
        intervals.push([numbers[index], numbers[index + 1]]);
      }
      if (
        measurement.expected_segments !== null &&
        intervals.length !== measurement.expected_segments
      ) {
        setError(
          `Task ${measurement.task}: expected ${measurement.expected_segments} intervals, got ${intervals.length}.`,
        );
        return;
      }
      values[measurement.task] = intervals;
    }
    try {
      setFillBusy(true);
      const filled = await fillTimings(currentPath, values);
      setPending([]);
      setFillBusy(false);
      setDetail({
        title: "TIMING FILLED",
        body: `filled ${filled.filled} task(s) · ${filled.remaining_pending} pending remaining\n\n${filled.path}\n\nRe-analysing the patched source.`,
      });
      await runSpec(filled.path, false);
    } catch (reason) {
      setFillBusy(false);
      setError(String(reason));
    }
  }, [currentPath, pending, pendingInputs, runSpec]);

  const checkPending = useCallback(async () => {
    if (!currentPath) return;
    try {
      const list = await pendingTimings(currentPath);
      setPending(list);
      setPendingInputs(
        Object.fromEntries(list.map((measurement) => [measurement.task, ""])),
      );
      setDetail({
        title: "PENDING TIMING",
        body:
          list.length === 0
            ? "No pending `measured by llm` intervals in this model."
            : list
                .map(
                  (measurement) =>
                    `${measurement.task}  line ${measurement.line ?? "?"}  runs ${measurement.runs ?? "?"}  expected ${measurement.expected_segments ?? "?"} intervals`,
                )
                .join("\n"),
      });
    } catch (reason) {
      setError(String(reason));
    }
  }, [currentPath]);

  const runAllocation = useCallback(async () => {
    if (!currentPath || isBinary) return;
    setAllocateBusy(true);
    setError(null);
    try {
      const report = await allocateCores(currentPath, {
        max_candidates: 32,
        candidate_max_states: Math.min(budget.maxStates, 20000),
      });
      setAllocation(report);
      setDetail({ title: "CORE ALLOCATION", body: `report\n${report.path}` });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setAllocateBusy(false);
    }
  }, [currentPath, isBinary, budget.maxStates]);

  const saveProject = useCallback(async () => {
    if (!currentPath) return;
    const project: ProjectFile = {
      version: 1,
      workflow: workflow === "binary" ? "binary" : "spec",
      modelPath: currentPath,
      stage: activeStage,
      budgets: budget,
      savedAt: new Date().toISOString(),
    };
    try {
      const target = await save({
        defaultPath: "rt-pn-project.rtpn",
        filters: [{ name: "RT-PN project", extensions: ["rtpn"] }],
      });
      if (!target) return;
      await writeTextFile(target, JSON.stringify(project, null, 2));
      setDetail({ title: "PROJECT SAVED", body: target });
    } catch (reason) {
      setError(String(reason));
    }
  }, [currentPath, workflow, activeStage, budget]);

  const openProject = useCallback(async () => {
    const path = await pickProject();
    if (!path) return;
    try {
      const project = JSON.parse(await readTextFile(path)) as ProjectFile;
      if (!project.modelPath) throw new Error("project file has no modelPath");
      setBudget(project.budgets ?? budget);
      if (project.workflow === "binary") {
        await runBinary(project.modelPath, true);
      } else {
        await runSpec(project.modelPath, true);
      }
      if (project.stage) setActiveStage(project.stage);
      setDetail({
        title: "PROJECT LOADED",
        body: `${project.modelPath}\nstage ${project.stage}`,
      });
    } catch (reason) {
      setError(String(reason));
    }
  }, [budget, runBinary, runSpec]);

  const openSpecDialog = useCallback(async () => {
    const path = await pickSpecification();
    if (path) await runSpec(path, true);
  }, [runSpec]);

  const openBinaryDialog = useCallback(async () => {
    const path = await pickElf();
    if (path) await runBinary(path, true);
  }, [runBinary]);

  const openWorkspaceRun = useCallback(async (id: string, runId: string) => {
    try {
      const restored = await workspaceOpenRun(id, runId);
      setWorkflow("binary");
      setHub(false);
      setAnalysis(null);
      setBinary(restored.payload);
      setCurrentPath(restored.project.elf_path ?? null);
      setBinaryOptions((restored.project.options ?? {}) as BinaryOptions);
      setActiveStage("overview");
      setFunctionCfg(null);
      setCfgSelector(null);
      setCfgError(null);
      setWcetPath(null);
      setStatus({ text: "HISTORICAL RUN RESTORED", tone: "violet" });
      setWindowTitle(fileName(restored.project.elf_path ?? "project"));
      setDetail({
        title: "HISTORICAL RUN",
        body:
          `run ${runId}\n${restored.project.elf_path ?? ""}\n\n` +
          "A stored run payload was loaded from the workspace — no re-analysis was run.",
      });
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const compareProjectRuns = useCallback(async (project: WorkspaceProject) => {
    const runs = project.last_runs ?? [];
    if (runs.length < 2 || !runs[0].run_id || !runs[1].run_id) return;
    try {
      const [a, b] = await Promise.all([
        workspaceOpenRun(project.id, runs[0].run_id),
        workspaceOpenRun(project.id, runs[1].run_id),
      ]);
      const roots = (payload: ElfWorkflow) =>
        new Map(
          (Array.isArray(payload.analysis?.wcet?.roots)
            ? (payload.analysis.wcet!.roots as Array<Record<string, unknown>>)
            : []
          ).map((root) => [
            String(root.name ?? root.function ?? "root"),
            typeof root.cycles === "number" ? root.cycles : null,
          ]),
        );
      const rootA = roots(a.payload);
      const rootB = roots(b.payload);
      const names = Array.from(new Set([...rootA.keys(), ...rootB.keys()])).sort();
      const lines = [
        `A  ${new Date(runs[0].at * 1000).toLocaleString()} · ${runs[0].profile || "no profile"}`,
        `B  ${new Date(runs[1].at * 1000).toLocaleString()} · ${runs[1].profile || "no profile"}`,
        "",
        `functions  ${a.payload.functions} → ${b.payload.functions}`,
        `instructions  ${a.payload.coverage?.total_instructions ?? "?"} → ${b.payload.coverage?.total_instructions ?? "?"}`,
        "",
        "WCET roots (A → B, Δ B−A):",
      ];
      for (const name of names) {
        const cyclesA = rootA.get(name) ?? null;
        const cyclesB = rootB.get(name) ?? null;
        const delta =
          cyclesA !== null && cyclesB !== null ? cyclesB - cyclesA : null;
        lines.push(
          `  ${name}: ${cyclesA ?? "—"} → ${cyclesB ?? "—"}` +
            (delta === null ? "" : ` (${delta > 0 ? "+" : ""}${delta.toFixed(1)} cy)`),
        );
      }
      setDetail({ title: "STORED RUN COMPARISON", body: lines.join("\n") });
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const openWorkspaceProject = useCallback(async (id: string) => {
    try {
      const restored = await workspaceOpenProject(id);
      setWorkflow("binary");
      setHub(false);
      setAnalysis(null);
      setBinary(restored.payload);
      setCurrentPath(restored.project.elf_path ?? null);
      setBinaryOptions((restored.project.options ?? {}) as BinaryOptions);
      setActiveStage("overview");
      setFunctionCfg(null);
      setCfgSelector(null);
      setCfgError(null);
      setWcetPath(null);
      setStatus({ text: "PROJECT RESTORED", tone: "violet" });
      setWindowTitle(fileName(restored.project.elf_path ?? "project"));
      setDetail({
        title: "PROJECT RESTORED",
        body:
          `${restored.project.elf_path ?? ""}\n\n` +
          "Cached text results loaded from the SQLite workspace — no re-analysis was run.",
      });
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const openPath = useCallback(
    (path: string) => {
      if (isBinaryPath(path)) {
        void runBinary(path, path !== binary?.elf_path);
      } else {
        void runSpec(path, path !== currentPath);
      }
    },
    [binary?.elf_path, currentPath, runBinary, runSpec],
  );
  openPathRef.current = openPath;

  const openExample = useCallback(async () => {
    try {
      const base = await exampleBase();
      if (isBinary) {
        await runBinary(
          `${base}/elf2tdg/rust-concurrency/artifacts/rust-concurrency-analysis.elf`,
          true,
        );
      } else {
        await runSpec(`${base}/ptpn/motivating-examples/hw.json`, true);
      }
    } catch (reason) {
      setError(String(reason));
    }
  }, [isBinary, runBinary, runSpec]);

  const openElfExample = useCallback(async () => {
    try {
      const base = await exampleBase();
      const profile = `${base}/elf2tdg/profiles/cortex-m4-pipeline.toml`;
      const options: BinaryOptions = {
        cpu: "cortex-m4",
        freq: "168MHz",
        board_profile: profile,
      };
      setBinaryOptions(options);
      await runBinary(
        `${base}/elf2tdg/rust-concurrency/artifacts/rust-concurrency-analysis.elf`,
        true,
        options,
      );
    } catch (reason) {
      setError(String(reason));
    }
  }, [runBinary]);

  const copyStage = async () => {
    try {
      const text = activeStage === "semantics" ? describeText || doc : doc;
      await navigator.clipboard.writeText(text);
      setStatus({ text: "COPIED", tone: "accent" });
    } catch {
      setError("Clipboard unavailable");
    }
  };

  const openPreview = () => {
    if (isBinary) {
      if (!binary) return;
      if (activeStage === "elf") {
        const layout = binary.elf_mermaid ?? "";
        const artifact = `${binary.artifacts_dir}\\${fileName(binary.elf_path).replace(/\.[^.]+$/, "")}.elf.mmd`;
        if (!layout) {
          setDetail({
            title: "ELF PREVIEW",
            body: "No Mermaid layout was produced for this image.",
          });
          return;
        }
        if (layout.length > ELF_PREVIEW_CHAR_LIMIT) {
          setStatus({ text: "PREVIEW SKIPPED", tone: "warn" });
          setDetail({
            title: "ELF PREVIEW TOO LARGE",
            body:
              `The Mermaid layout is ${(layout.length / 1024).toFixed(0)} KB, over the ` +
              `${(ELF_PREVIEW_CHAR_LIMIT / 1024).toFixed(0)} KB preview limit.\n\n` +
              `Open the artifact directly instead:\n${artifact}`,
          });
          return;
        }
        setMermaidPreview({
          chart: layout,
          title: `${fileName(binary.elf_path)} · ELF LAYOUT`,
          footer:
            `Mermaid source ${(layout.length / 1024).toFixed(1)} KB ` +
            `(limit ${(ELF_PREVIEW_CHAR_LIMIT / 1024).toFixed(0)} KB) · rendered locally`,
        });
        return;
      }
      if (activeStage !== "cfg") return;
      if (binary.cfg_svg) {
        setImagePreview({
          svg: binary.cfg_svg,
          title: "CFG PREVIEW",
          footer: "Graphviz rendering from the elf2tdg DOT export",
        });
        return;
      }
      if (binary.cfg_graph) {
        setPreview({
          graph: binary.cfg_graph,
          title: "CFG PREVIEW",
          footer: "Interactive function-level graph (Graphviz was not found)",
        });
      }
      return;
    }
    const graph =
      activeStage === "ptpn" ? analysis?.ptpn_graph : activeStage === "state" ? analysis?.state_graph : null;
    if (!graph) return;
    setPreview({
      graph,
      title: `${STAGES[activeStage].title} PREVIEW`,
      footer:
        activeStage === "ptpn"
          ? "PTPN structure from the analyzer export"
          : "State-class graph from the analyzer export",
    });
  };

  const verdict = isBinary
    ? { text: "ELF PARSED", tone: "violet" as Tone }
    : analysis?.result.ok
      ? metricsSchedulable(analysis)
        ? { text: "SCHEDULABLE", tone: "good" as Tone }
        : { text: "UNSCHEDULABLE", tone: "bad" as Tone }
      : { text: "NO RESULT", tone: "muted" as Tone };

  const maxWcrt = Math.max(0, ...(metrics.tasks ?? []).map((task) => task.wcrt ?? 0));
  const displayPath = binary?.elf_path ?? currentPath;
  const displayName = fileName(displayPath);
  const workflowLabel =
    workflow === "binary"
      ? "BINARY · ELF"
      : workflow === "spec"
        ? analysis?.docs?.workflow ?? "SPEC-FIRST"
        : "NO WORKFLOW";

  if (workflow === "none" || hub) {
    return (
      <div className="chooser">
        <header className="chooser-header">
          <div className="brand">
            <div className="brand-mark">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M16 2 28 9v14l-12 7L4 23V9z" />
                <circle cx="16" cy="9" r="2.3" />
                <circle cx="10" cy="21" r="2.3" />
                <circle cx="22" cy="21" r="2.3" />
                <path d="M16 11.3 11 19M16 11.3 21 19M11.8 21h8.4" />
              </svg>
            </div>
            <div>
              <div className="brand-name">RT-PN</div>
              <div className="brand-sub">REAL-TIME PETRI WORKBENCH</div>
            </div>
          </div>
          <div className="chooser-engines">
            <button className="btn small" onClick={() => setGuideOpen(true)}>
              ? GUIDE
            </button>
            <span className="engine-label" title={cli?.path ?? undefined}>
              <Cpu size={11} />
              <span>
                {cli
                  ? `PTPN [${engineTag(cli)}] ${cli.version ?? ""}`
                  : "PTPN NOT FOUND · just engines"}
              </span>
            </span>
            <span className="engine-label" title={elf2tdg?.path ?? undefined}>
              <Binary size={11} />
              <span>
                {elf2tdg
                  ? `ELF2TDG [${engineTag(elf2tdg)}] ${elf2tdg.version ?? ""}`
                  : "ELF2TDG NOT FOUND · just engines"}
              </span>
            </span>
          </div>
        </header>
        <Hub
          onSpec={() => void openSpecDialog()}
          onBinary={() => void openBinaryDialog()}
          onSpecExample={() => void openExample()}
          onBinaryExample={() => void openElfExample()}
        />
        {workspaceProjects.length > 0 && (
          <section className="chooser-recent">
            <div className="chooser-section-head">
              <div>
                <div className="sem-eyebrow">RECENT PROJECTS · SQLITE WORKSPACE</div>
                <h2>Open a cached analysis</h2>
              </div>
              <span className="faint">{workspaceProjects.length} indexed</span>
            </div>
            <div className="chooser-recent-list">
              {workspaceProjects.map((project) => (
                <div className="project-card-wrap" key={project.id}>
                  <button
                    className="project-card"
                    onClick={() => void openWorkspaceProject(project.id)}
                    title={project.elf_path ?? ""}
                  >
                    <b>{project.name}</b>
                    <small>
                      {project.arch || "—"} · {project.functions ?? "?"} functions ·{" "}
                      {project.run_count ?? 0} runs · {project.profile || "no board profile"}
                    </small>
                    <span className="mono faint">
                      {project.latest_wcet_root
                        ? `WCET ${project.latest_wcet_root} · ${project.latest_wcet_cycles?.toFixed(0) ?? "?"} cy`
                        : "no WCET result in the last run"}
                      {project.last_opened
                        ? ` · opened ${new Date(project.last_opened * 1000).toLocaleDateString()}`
                        : ""}
                    </span>
                  </button>
                  <button
                    className="project-compare"
                    title="compare the latest two stored runs"
                    disabled={(project.last_runs?.length ?? 0) < 2}
                    onClick={(event) => {
                      event.stopPropagation();
                      void compareProjectRuns(project);
                    }}
                  >
                    Δ
                  </button>
                  <button
                    className="project-delete"
                    title="remove this cached project (your ELF is kept)"
                    onClick={async (event) => {
                      event.stopPropagation();
                      if (
                        !window.confirm(
                          `Remove "${project.name}" from the workspace?\n\nThe cached text results are deleted; your ELF file stays untouched.`,
                        )
                      ) {
                        return;
                      }
                      try {
                        await workspaceDeleteProject(project.id);
                        setWorkspaceProjects((previous) =>
                          previous.filter((item) => item.id !== project.id),
                        );
                      } catch (reason) {
                        setError(String(reason));
                      }
                    }}
                  >
                    ×
                  </button>
                  {project.last_runs && project.last_runs.length > 0 && (
                    <div className="project-runs mono faint">
                      {project.last_runs.slice(0, 3).map((run, index) => (
                        <button
                          key={`${run.at}-${index}`}
                          className="project-run"
                          title="open this stored run"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (run.run_id) void openWorkspaceRun(project.id, run.run_id);
                          }}
                        >
                          {new Date(run.at * 1000).toLocaleTimeString()} ·{" "}
                          {run.wcet_root
                            ? `${run.wcet_root} ${run.wcet_cycles?.toFixed(0) ?? "?"} cy`
                            : "no WCET"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="chooser-foot">
          RT-PN 0.4.2 · analysis setup fixed · Two independent workspaces.
        </footer>
        {guideOpen && <WorkflowGuide onClose={() => setGuideOpen(false)} />}
      </div>
    );
  }

  return (
    <div className={`app ${isBinary ? "mode-binary" : "mode-spec"}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M16 2 28 9v14l-12 7L4 23V9z" />
              <circle cx="16" cy="9" r="2.3" />
              <circle cx="10" cy="21" r="2.3" />
              <circle cx="22" cy="21" r="2.3" />
              <path d="M16 11.3 11 19M16 11.3 21 19M11.8 21h8.4" />
            </svg>
          </div>
          <div>
            <div className="brand-name">RT-PN</div>
            <div className="brand-sub">REAL-TIME PETRI WORKBENCH</div>
          </div>
        </div>
        <div className={`workflow-pill ${workflow}`}>{workflowLabel}</div>
        <div className="path-chip" title={displayPath ?? undefined}>
          <FileCode2 size={13} />
          <span>{displayName}</span>
        </div>
          <div className="topbar-actions">
          <StatusPill status={status} />
          <button
            className="btn primary"
            disabled={!currentPath || busy}
            onClick={() => {
              if (!currentPath) return;
              if (isBinary) void runBinary(currentPath, false);
              else void runSpec(currentPath, false);
            }}
          >
            {busy ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
            {busy ? "ANALYZING" : "RUN ANALYSIS"}
          </button>
          <button
            className="btn"
            onClick={() => (isBinary ? void openBinaryDialog() : void openSpecDialog())}
          >
            <FolderOpen size={13} /> {isBinary ? "IMPORT" : "OPEN"}
          </button>
          <button className="btn" onClick={() => setGuideOpen(true)}>
            ? GUIDE
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-scroll">
          <Section title="WORKFLOW" />
          <div className="workflow-name">{workflowLabel}</div>
          <div className="workflow-hint">
            {workflow === "binary"
              ? "ELF → READABLE LAYOUT → CFG + PREVIEW"
              : workflow === "spec"
                ? "RTSL / TDG → PTPN → SCG"
                : "Choose a workflow to begin"}
          </div>
          <div className="stack">
            <button
              className="btn wide"
              onClick={() => {
                setHub(true);
                setPreview(null);
                setImagePreview(null);
                setWorkflow("none");
                setAnalysis(null);
                setBinary(null);
                setCurrentPath(null);
                setHistory([]);
                setActiveStage("dag");
                setBusy(false);
                setError(null);
                setStatus({ text: "NO PROJECT", tone: "muted" });
                setDetail({
                  title: "NO MODEL",
                  body: "Choose a workflow to begin.",
                });
                getCurrentWindow()
                  .setTitle("RT-PN  ·  Real-Time Petri Workbench")
                  .catch(() => undefined);
              }}
            >
              <Plus size={13} /> NEW WORKSPACE
            </button>
          </div>

          <div className="divider" />
          <Section title="MODEL" />
          <div className="source-name">{displayName}</div>
          <div className="source-path" title={displayPath ?? undefined}>
            {displayPath ?? "No model loaded"}
          </div>
          <div className="stack">
            {!isBinary ? (
              <>
                <button className="btn wide primary" onClick={() => void openSpecDialog()}>
                  <FolderOpen size={13} /> OPEN MODEL
                </button>
                <div className="action-row">
                  <button className="btn small" onClick={() => void openExample()}>
                    <Braces size={13} /> EXAMPLES
                  </button>
                  <button
                    className="btn small"
                    disabled={!currentPath}
                    onClick={() => void saveProject()}
                  >
                    <Copy size={12} /> SAVE
                  </button>
                  <button className="btn small" onClick={() => void openProject()}>
                    <FolderOpen size={12} /> OPEN
                  </button>
                </div>
              </>
            ) : (
              <>
                <button className="btn wide violet" onClick={() => void openBinaryDialog()}>
                  <Upload size={13} /> IMPORT ELF
                </button>
                <button className="btn wide" onClick={() => void openElfExample()}>
                  <Braces size={13} /> ELF EXAMPLE
                </button>
              </>
            )}
          </div>

          {isBinary && (
            <>
              <div className="divider" />
              <Section title="FUNCTION INDEX" />
              <input
                className="profile-input"
                type="text"
                placeholder="filter functions…"
                value={binaryFunctionQuery}
                onChange={(event) => setBinaryFunctionQuery(event.target.value)}
              />
              <div className="bin-nav bin-function-list">
                {(binary?.function_rows ?? [])
                  .filter((row) => {
                    const query = binaryFunctionQuery.trim().toLowerCase();
                    if (!query) return true;
                    return [row.name, row.demangled_name, row.address]
                      .some((value) => (value ?? "").toLowerCase().includes(query));
                  })
                  .slice(0, 80)
                  .map((row, index) => {
                    const selector = functionSelector(row);
                    if (!selector) return null;
                    return (
                      <button
                        key={`fn-${row.id ?? index}-${selector}`}
                        className="bin-nav-row"
                        title={row.address ?? ""}
                        onClick={() => {
                          setActiveStage("cfg");
                          setFunctionCfg(null);
                          setCfgSelector(null);
                          void loadFunctionCfg(selector);
                        }}
                      >
                        <span>{row.name || row.address || selector}</span>
                        <small>{row.kind ?? "fn"} · {row.blocks}b</small>
                      </button>
                    );
                  })}
                {!binary && (
                  <div className="faint">
                    import an ELF to browse functions; the function index opens CFG documents.
                  </div>
                )}
              </div>
            </>
          )}

          {isBinary && (
            <>
              <div className="divider" />
              <Section title="RUN CONFIGURATION" />
              <select
                className="policy-select"
                value={binaryOptions.cpu ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setBinaryOptions((previous) => ({
                    ...previous,
                    cpu: event.target.value || undefined,
                  }))
                }
              >
                <option value="">cpu · auto-detect</option>
                {["cortex-m4", "cortex-m7", "cortex-m33", "riscv32", "aarch64", "x86-64"].map(
                  (cpu) => (
                    <option key={cpu} value={cpu}>
                      {cpu}
                    </option>
                  ),
                )}
              </select>
              <select
                className="policy-select"
                value={binaryOptions.board_profile ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setBinaryOptions((previous) => ({
                    ...previous,
                    board_profile: event.target.value || undefined,
                  }))
                }
              >
                <option value="">board profile · none</option>
                {profiles.map((profile) => (
                  <option key={profile.path} value={profile.path}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <input
                className="profile-input"
                type="text"
                placeholder="frequency · e.g. 168MHz"
                value={binaryOptions.freq ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setBinaryOptions((previous) => ({
                    ...previous,
                    freq: event.target.value || undefined,
                  }))
                }
              />
              <div className="config-save">
                <input
                  className="profile-input"
                  type="text"
                  placeholder="named run configuration"
                  value={configName}
                  disabled={busy}
                  onChange={(event) => setConfigName(event.target.value)}
                />
                <button
                  className="btn small accent"
                  disabled={busy}
                  onClick={() => {
                    const name =
                      configName.trim() ||
                      [binaryOptions.cpu, binaryOptions.freq]
                        .filter(Boolean)
                        .join(" · ") ||
                      "default";
                    setBinaryConfigs((previous) => [
                      ...previous.filter((configuration) => configuration.name !== name),
                      {
                        id: `${Date.now()}-${name}`,
                        name,
                        cpu: binaryOptions.cpu,
                        freq: binaryOptions.freq,
                        board_profile: binaryOptions.board_profile,
                      },
                    ]);
                    setConfigName("");
                  }}
                >
                  SAVE CONFIG
                </button>
              </div>
              {binaryConfigs.length > 0 && (
                <div className="config-list">
                  {binaryConfigs.map((configuration) => (
                    <div key={configuration.id} className="config-row">
                      <button
                        className="config-apply"
                        onClick={() => {
                          setBinaryOptions({
                            cpu: configuration.cpu,
                            freq: configuration.freq,
                            board_profile: configuration.board_profile,
                          });
                          setDetail({
                            title: "RUN CONFIGURATION",
                            body:
                              `${configuration.name}\n` +
                              `cpu ${configuration.cpu ?? "auto"} · freq ${configuration.freq ?? "default"} · ` +
                              `profile ${configuration.board_profile ?? "none"}\n\n` +
                              "Press RUN ANALYSIS in the toolbar to apply it.",
                          });
                        }}
                      >
                        <b>{configuration.name}</b>
                        <small>
                          {[
                            configuration.cpu,
                            configuration.freq,
                            (configuration.board_profile ?? "").split(/[\\/]/).pop(),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </button>
                      <button
                        className="config-del"
                        title="delete configuration"
                        onClick={() =>
                          setBinaryConfigs((previous) =>
                            previous.filter((item) => item.id !== configuration.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="faint">
                This configuration applies to the next run. Use <b>RUN ANALYSIS</b> in the
                toolbar to execute; the function index on the left opens CFG documents.
                CPU/board profile select the timing model (caches, branch predictor,
                memory wait states, WCET).
              </div>
            </>
          )}

          {isBinary && (
            <>
              <div className="divider" />
              <Section title="ROOTS & CONCURRENCY" />
              <div className="bin-nav">
                {(binary?.roots ?? []).slice(0, 12).map((root, index) => {
                  const name = typeof root.name === "string" ? root.name : "";
                  if (!name) return null;
                  return (
                    <button
                      key={`root-${index}`}
                      className="bin-nav-row"
                      onClick={() => {
                        setActiveStage("cfg");
                        setFunctionCfg(null);
                        void loadFunctionCfg(name);
                      }}
                      title={String(root.confidence ?? "")}
                    >
                      <span>{name}</span>
                      <small>{String(root.kind ?? "root")}</small>
                    </button>
                  );
                })}
                {(binary?.concurrency ?? []).slice(0, 8).map((site, index) => {
                  const operation = (site.operation ?? {}) as Record<string, unknown>;
                  const name = String(operation.name ?? operation.api ?? "");
                  if (!name) return null;
                  return (
                    <button
                      key={`site-${index}`}
                      className="bin-nav-row spawn"
                      onClick={() => {
                        setActiveStage("cfg");
                        setFunctionCfg(null);
                        void loadFunctionCfg(name);
                      }}
                      title={String(operation.api ?? "")}
                    >
                      <span>{name}</span>
                      <small>{String(operation.kind ?? "spawn")}</small>
                    </button>
                  );
                })}
                {(binary?.roots.length ?? 0) === 0 && (
                  <div className="faint">
                    run the ELF analysis to list execution roots and concurrency sites
                  </div>
                )}
              </div>
            </>
          )}

          {!isBinary && (
            <>
              <div className="side-summary">
                <div className={`side-verdict ${verdict.tone}`}>{verdict.text}</div>
                <div className="side-stats">
                  <span>
                    <b>{analysis?.result.ok ? analysis.result.scg.nodes.length : "—"}</b>
                    <small>states</small>
                  </span>
                  <span>
                    <b>{analysis?.result.ok ? formatNumber(maxWcrt) : "—"}</b>
                    <small>wcrt</small>
                  </span>
                  <span>
                    <b>{analysis?.result.ok ? deadlockCount : "—"}</b>
                    <small>deadlocks</small>
                  </span>
                  <span>
                    <b>{policyInfo.id}</b>
                    <small>policy</small>
                  </span>
                </div>
              </div>
            </>
          )}

          {!isBinary && (
            <>
              <div className="divider" />
              <Section title="RUN CONTROL" />
              <select
                className="policy-select"
                value={policy}
                disabled={busy}
                onChange={(event) => {
                  setPolicy(event.target.value);
                  setDescribeText("");
                }}
              >
                {SCHEDULING_POLICIES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <select
                className="policy-select"
                value={tie}
                disabled={busy}
                onChange={(event) => {
                  setTie(event.target.value);
                  setDescribeText("");
                }}
              >
                <option value="fifo">tie · fifo</option>
                <option value="arbitrary">tie · arbitrary</option>
              </select>
              <div className="faint">
                {policyInfo.family} · {policyInfo.tieSensitive ? "tie-sensitive" : "tie-free"}
              </div>
              <div className="budget-row">
                {(
                  [
                    ["STATES", "maxStates", 100, 1_000_000, 1_000],
                    ["TIMEOUT S", "timeoutSecs", 0, 3_600, 30],
                    ["MEM MB", "maxMemoryMb", 0, 65_536, 256],
                  ] as const
                ).map(([label, key, min, max, step]) => (
                  <label key={key} className="budget-field">
                    <span>{label}</span>
                    <input
                      type="number"
                      min={min}
                      max={max}
                      step={step}
                      value={budget[key]}
                      disabled={busy}
                      onChange={(event) =>
                        setBudget((previous) => ({
                          ...previous,
                          [key]: Number(event.target.value) || 0,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="action-row">
                <button
                  className="btn small accent"
                  disabled={!currentPath || busy}
                  onClick={() => currentPath && void runSpec(currentPath, false)}
                >
                  <Play size={12} /> {busy ? "RUNNING" : "RE-RUN"}
                </button>
                <button
                  className="btn small"
                  disabled={!currentPath || describeBusy}
                  onClick={() => void refreshDescription()}
                >
                  <Terminal size={12} /> DESCRIBE
                </button>
                {busy && workflow === "spec" && (
                  <button className="btn small bad" onClick={() => void cancelRun()}>
                    CANCEL {Math.round(liveElapsed / 1000)}s
                  </button>
                )}
              </div>
            </>
          )}

          <div className="divider" />
          <Section title="ARTIFACTS" />
          {isBinary ? (
            <div className="artifact-list">
              <Artifact label="SCHEMA" value={binary?.schema || "—"} />
              <Artifact
                label="FN"
                value={
                  binary
                    ? `${binary.functions} · ${binary.blocks} BB · ${binary.calls} calls`
                    : "—"
                }
              />
              <Artifact
                label="ROOTS"
                value={binary ? `${binary.roots.length} · ${binary.concurrency.length} spawns` : "—"}
              />
              <Artifact
                label="DIAG"
                value={binary ? String(binary.diagnostics) : "—"}
              />
              <Artifact
                label="IMG"
                value={binary ? (binary.cfg_svg ? "Graphviz SVG" : "graph fallback") : "—"}
              />
              <Artifact label="ART" value={binary ? binary.artifacts_dir : "—"} />
            </div>
          ) : analysis?.result.ok ? (
            <div className="artifact-list">
              <Artifact
                label="DAG"
                value={`${analysis.docs.task_count}T · ${analysis.docs.dag_edge_count}E`}
              />
              <Artifact
                label="PTPN"
                value={`${analysis.result.net.places.length}P · ${analysis.result.net.transitions.length}T · ${analysis.result.net.arcs.length}A`}
              />
              <Artifact
                label="SCG"
                value={`${analysis.result.scg.nodes.length}S · ${analysis.result.scg.edges.length}E`}
              />
              <Artifact label="RUN" value={`${analysis.result.elapsed_ms} ms`} />
            </div>
          ) : (
            <div className="faint">no artifacts yet</div>
          )}

          {!isBinary && analysis?.result.ok && taskMetrics.length > 0 && (
            <details className="fold">
              <summary>WCRT / SLACK</summary>
              <WcrtChart tasks={taskMetrics} />
            </details>
          )}

          {!isBinary && (
            <details className="fold">
              <summary>CORE ALLOCATION</summary>
              <button
                className="btn wide"
                disabled={!currentPath || busy || allocateBusy}
                onClick={() => void runAllocation()}
              >
                <Cpu size={13} /> {allocateBusy ? "SEARCHING…" : "ALLOCATE CORES"}
              </button>
              {allocation ? (
                (() => {
                  const report = allocation.report as Record<string, unknown>;
                  const search = (report.search ?? {}) as Record<string, unknown>;
                  const pareto = (report.pareto ?? []) as Array<Record<string, unknown>>;
                  const best = report.best as Record<string, unknown> | null | undefined;
                  const assignmentText = (entry: Record<string, unknown> | null | undefined) => {
                    const assignment = (entry?.assignment ?? []) as Array<{
                      task?: string;
                      core?: number;
                    }>;
                    return assignment.map((item) => `${item.task}→c${item.core}`).join(" ");
                  };
                  return (
                    <div style={{ fontSize: 10, display: "grid", gap: 4 }}>
                      <div className="faint">
                        {String(search.strategy ?? "?")} · domain{" "}
                        {String(search.domain_size ?? "?")} · evaluated{" "}
                        {String(search.evaluated ?? "?")} · feasible{" "}
                        {String(search.feasible_count ?? "?")}
                      </div>
                      {best && (
                        <div className="mono">
                          best {assignmentText(best)} · wcrt {String(best.max_wcrt ?? "?")} ·
                          load {String(best.max_core_load ?? "?")}
                        </div>
                      )}
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ color: "#7c8ca8" }}>
                            <th align="left">pareto</th>
                            <th align="right">wcrt</th>
                            <th align="right">load</th>
                            <th align="right">dead</th>
                            <th align="right">states</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pareto.map((candidate, index) => (
                            <tr key={index} style={{ borderTop: "1px solid #11243b" }}>
                              <td style={{ padding: 2 }}>{assignmentText(candidate)}</td>
                              <td align="right">{String(candidate.max_wcrt ?? "?")}</td>
                              <td align="right">{String(candidate.max_core_load ?? "?")}</td>
                              <td align="right">{String(candidate.deadlock_states ?? "?")}</td>
                              <td align="right">{String(candidate.states ?? "?")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()
              ) : (
                <div className="faint">
                  searches allowed core assignments (RTSL `core any` or TDG `allowed_cores`)
                </div>
              )}
            </details>
          )}

          {!isBinary && (
            <details className="fold">
              <summary>COUNTEREXAMPLE</summary>
              {deadlockSteps && deadlockSteps.length > 0 ? (
                <>
                  <pre className="assumptions">{deadlockTraceText(deadlockSteps)}</pre>
                  <button className="btn wide bad" onClick={openDeadlockPreview}>
                    <Eye size={13} /> TRACE PREVIEW
                  </button>
                  <button className="btn wide" onClick={() => setActiveStage("replay")}>
                    <Play size={13} /> REPLAY TRACE
                  </button>
                </>
              ) : (
                <div className="faint">
                  {analysis?.result.ok
                    ? "no reachable deadlock in the explored state space"
                    : "run an analysis to search for deadlocks"}
                </div>
              )}
            </details>
          )}

          {!isBinary && (
            <details className="fold">
              <summary>PENDING TIMING</summary>
              <button
                className="btn wide"
                disabled={!currentPath || busy || fillBusy}
                onClick={() => void checkPending()}
              >
                <RefreshCw size={13} /> CHECK PENDING
              </button>
              {pending.length === 0 ? (
                <div className="faint">
                  lists `measured by llm` tasks and fills their intervals via `ptpn fill`
                </div>
              ) : (
                <div>
                  {pending.map((measurement) => (
                    <div key={measurement.task} style={{ marginTop: 8, fontSize: 11 }}>
                      <div className="mono faint">
                        {measurement.task} · line {measurement.line ?? "?"} · expected{" "}
                        {measurement.expected_segments ?? "?"} intervals
                      </div>
                      <input
                        type="text"
                        placeholder="min,max, min,max, ..."
                        value={pendingInputs[measurement.task] ?? ""}
                        onChange={(event) =>
                          setPendingInputs((previous) => ({
                            ...previous,
                            [measurement.task]: event.target.value,
                          }))
                        }
                        style={{
                          width: "100%",
                          background: "#0b1422",
                          color: "#dce8f5",
                          border: "1px solid #1d3350",
                          borderRadius: 3,
                          padding: "2px 6px",
                          fontFamily: "inherit",
                        }}
                      />
                    </div>
                  ))}
                  <button
                    className="btn wide accent"
                    disabled={fillBusy}
                    onClick={() => void fillPending()}
                  >
                    <Play size={13} /> FILL &amp; ANALYZE
                  </button>
                </div>
              )}
            </details>
          )}

          {!isBinary && (
            <details className="fold">
              <summary>RUN HISTORY</summary>
          {history.length === 0 ? (
            <div className="faint">no runs in this session</div>
          ) : (
            <div className="history-list">
              {history.map((record, index) => (
                <div className="history-row" key={`${record.time}-${index}`}>
                  <span className="mono faint">{record.time}</span>
                  <span className={`history-verdict ${record.verdict.toLowerCase()}`}>
                    {record.verdict}
                  </span>
                  <span className="mono faint">{record.detail}</span>
                </div>
              ))}
            </div>
          )}
          <button
            className="btn wide"
            disabled={snapshots.length < 2}
            onClick={() => setCompareOpen(true)}
          >
            <RefreshCw size={13} /> COMPARE RUNS
          </button>
            </details>
          )}

          <div className="sidebar-bottom">
            <div className="engine-label" title={cli?.path ?? undefined}>
              <Cpu size={11} />
              <span>
                {cli
                  ? `PTPN [${engineTag(cli)}] ${cli.version ?? ""} ${cli.path}`
                  : "PTPN NOT FOUND · just engines"}
              </span>
            </div>
            <div className="engine-label" title={elf2tdg?.path ?? undefined}>
              <Binary size={11} />
              <span>
                {elf2tdg
                  ? `ELF2TDG [${engineTag(elf2tdg)}] ${elf2tdg.version ?? ""} ${elf2tdg.path}`
                  : "ELF2TDG NOT FOUND · just engines"}
              </span>
            </div>
            <div className="brand-foot">RT-PN · NATIVE RUST WORKBENCH</div>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <>
            <div className="stage-tabs">
              {stages.map((stage) => (
                <button
                  key={stage}
                  className={`stage-tab ${activeStage === stage ? "active" : ""}`}
                  onClick={() => setActiveStage(stage)}
                >
                  {STAGES[stage].label}
                </button>
              ))}
            </div>
            <div className="stage-body">
              <div className="stage-header">
                <div>
                  <div className="stage-title-row">
                    <h1>{STAGES[activeStage].title}</h1>
                    <span className="stage-summary">{summary}</span>
                  </div>
                  <div className="stage-subtitle">{STAGES[activeStage].subtitle}</div>
                </div>
                <div className="stage-actions">
                  <span className="stage-search-hint">⌘/Ctrl+F search</span>
                  <button className="btn small" onClick={() => void copyStage()}>
                    <Copy size={12} /> COPY
                  </button>
                  {STAGES[activeStage].previewable && (
                    <button className="btn small accent" onClick={openPreview}>
                      <Eye size={12} /> PREVIEW
                    </button>
                  )}
                </div>
              </div>
              <div className="stage-rule" />
              {activeStage === "overview" && isBinary && binary ? (
                <BinaryOverview
                  binary={binary}
                  onApplyPreset={(cpu, freq) => {
                    setBinaryOptions((previous) => ({ ...previous, cpu, freq }));
                    setDetail({
                      title: "PRESET APPLIED",
                      body:
                        `CPU ${cpu} · ${freq}\n\n` +
                        "Press RUN ANALYSIS in the toolbar to rebuild the analysis with this configuration.",
                    });
                  }}
                />
              ) : activeStage === "elf" && isBinary && binary ? (
                <CodeStage
                  doc={
                    binary.elf_view.length > ELF_TEXT_CHAR_LIMIT
                      ? `${binary.elf_view.slice(0, ELF_TEXT_CHAR_LIMIT)}\n\n` +
                        `… layout truncated at ${(ELF_TEXT_CHAR_LIMIT / 1024).toFixed(0)} KB. ` +
                        `Full artifact: ${binary.artifacts_dir}\\${fileName(binary.elf_path).replace(/\.[^.]+$/, "")}.elf.mmd`
                      : binary.elf_view
                  }
                  stageKey="binary-elf"
                />
              ) : activeStage === "cfg" && isBinary && binary ? (
                <BinaryCfg
                  cfg={functionCfg}
                  loading={cfgLoading}
                  error={cfgError}
                  selector={cfgSelector ?? ""}
                  highlightPath={wcetPath}
                  onReload={() => {
                    if (cfgSelector) {
                      setFunctionCfg(null);
                      void loadFunctionCfg(cfgSelector);
                    }
                  }}
                />
              ) : activeStage === "analysis" && isBinary && binary ? (
                <div className="bin-analysis-stack">
                  <BinaryAnalysisView
                    binary={binary}
                    boardProfile={binaryOptions.board_profile ?? ""}
                    options={binaryOptions}
                    profiles={profiles}
                    busy={busy}
                    canRun={Boolean(currentPath)}
                    onOptionsChange={setBinaryOptions}
                    onReloadProfiles={() => {
                      void binaryProfiles()
                        .then(setProfiles)
                        .catch((reason) => setError(String(reason)));
                    }}
                    onRun={() => {
                      if (currentPath) void runBinary(currentPath, false);
                    }}
                    onProfileSaved={(path) =>
                      setBinaryOptions((previous) => ({ ...previous, board_profile: path }))
                    }
                    onOpenPath={(selector, path) => {
                      setWcetPath(path);
                      setFunctionCfg(null);
                      setCfgSelector(null);
                      setActiveStage("cfg");
                      void loadFunctionCfg(selector);
                      setDetail({
                        title: "WCET LONGEST PATH",
                        body:
                          `${selector}\n${path.length} blocks highlighted in the CFG\n` +
                          "Static CFG longest-path estimate — not a hardware proof.",
                      });
                    }}
                  />
                  <BinaryCompare
                    elfPath={binary.elf_path}
                    profiles={profiles}
                    cpu={binaryOptions.cpu ?? ""}
                    freq={binaryOptions.freq ?? ""}
                    defaultProfile={binaryOptions.board_profile ?? ""}
                  />
                </div>
              ) : activeStage === "semantics" && !isBinary ? (
                <SemanticsStage
                  policy={policyInfo}
                  tie={tie}
                  describeText={describeText}
                  describeBusy={describeBusy}
                  onRefreshDescription={() => void refreshDescription()}
                  sweep={sweep}
                  sweepBusy={sweepBusy}
                  sweepProgress={sweepProgress}
                  sweepBudget={{ maxStates: sweepMaxStates, timeoutSecs: sweepTimeoutSecs }}
                  canSweep={Boolean(currentPath) && !isBinary}
                  onRunSweep={() => void runSweep()}
                />
              ) : activeStage === "replay" && !isBinary && analysis ? (
                compareMode ? (
                  <ReplayCompare
                    lanes={compareLanes}
                    busy={compareBusy}
                    progress={compareProgress}
                    selected={compareSelected}
                    onToggle={toggleComparePolicy}
                    onRun={() => void runPolicyComparison()}
                    onClose={() => setCompareMode(false)}
                    maxStates={Math.min(budget.maxStates, 5_000)}
                    timeoutSecs={Math.min(budget.timeoutSecs || 20, 20)}
                    tie={tie}
                    modelLabel={displayName}
                  />
                ) : (
                  <ScgReplay
                    scg={analysis.result.scg}
                    trace={analysis.deadlock_trace}
                    modelLabel={displayName}
                    policy={policyInfo.label}
                    tie={tie}
                    tasks={taskMetrics}
                    onCompare={openPolicyCompare}
                  />
                )
              ) : doc ? (
                <CodeStage doc={doc} stageKey={`${workflow}-${activeStage}`} />
              ) : (
                <div className="empty-stage">
                  <Network size={24} />
                  <div>{busy ? "Analysis is running…" : "NO DATA IN THIS STAGE"}</div>
                  <span>
                    {busy
                      ? "The elf2tdg loader is extracting the ELF and CFG."
                      : "Open a model or import an ELF binary."}
                  </span>
                </div>
              )}
            </div>
        </>
      </main>

      <aside className="inspector">
        <div className="inspector-scroll">
          {!isBinary && (
            <>
              <Section title="ASSUMPTIONS &amp; EVIDENCE" />
              <pre className="assumptions">
                {assumptions || "Run an analysis to populate the assumptions."}
              </pre>
            </>
          )}
          <div className="divider" />
          <Section title="DETAILS" />
          <div className="detail-title">{detail.title}</div>
          <div className="detail-body">{detail.body}</div>
          <div className="divider" />
          <Section title="RUN LOG" />
          <pre className="run-log">
            {busy && liveLog.length > 0
              ? liveLog.slice(-80).join("\n")
              : analysis?.result.logs.join("\n") || binary?.warnings.join("\n") || "(no output)"}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn small"
              disabled={!analysis}
              onClick={() => void exportReport("md")}
            >
              EXPORT MD
            </button>
            <button
              className="btn small"
              disabled={!analysis}
              onClick={() => void exportReport("json")}
            >
              EXPORT JSON
            </button>
          </div>
        </div>
      </aside>

      <footer className="statusbar">
        <span>
          <Activity size={11} /> {status.text}
        </span>
        <span className="status-right">
          {analysis?.result.ok
            ? `${analysis.result.scg.nodes.length} state classes · ${analysis.result.elapsed_ms} ms · ${policyInfo.id} · budget ${budget.maxStates} states / ${budget.timeoutSecs || "∞"} s${deadlockCount > 0 ? ` · ${deadlockCount} deadlock${deadlockCount === 1 ? "" : "s"}` : ""}`
            : isBinary
              ? "elf2tdg artifacts · analysis backend pending"
              : "text-first workbench"}
        </span>
      </footer>

      {preview && (
        <GraphPreview
          graph={preview.graph}
          title={preview.title}
          footer={preview.footer}
          onClose={() => setPreview(null)}
        />
      )}

      {imagePreview && (
        <SvgPreview
          svg={imagePreview.svg}
          title={imagePreview.title}
          footer={imagePreview.footer}
          onClose={() => setImagePreview(null)}
        />
      )}

      {mermaidPreview && (
        <div className="mermaid-overlay" onClick={() => setMermaidPreview(null)}>
          <div className="mermaid-dialog" onClick={(event) => event.stopPropagation()}>
            <header className="mermaid-head">
              <div>
                <div className="sem-eyebrow">PREVIEW · MERMAID</div>
                <h3>{mermaidPreview.title}</h3>
              </div>
              <button className="btn small" onClick={() => setMermaidPreview(null)}>
                CLOSE
              </button>
            </header>
            <div className="mermaid-body">
              <Mermaid chart={mermaidPreview.chart} />
            </div>
            <footer className="mermaid-foot">{mermaidPreview.footer}</footer>
          </div>
        </div>
      )}

      {compareOpen && snapshots.length >= 2 && (
        <RunCompare
          a={snapshots[snapshots.length - 2]}
          b={snapshots[snapshots.length - 1]}
          onClose={() => setCompareOpen(false)}
        />
      )}

      {guideOpen && <WorkflowGuide onClose={() => setGuideOpen(false)} />}

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
}

function metricsSchedulable(payload: AnalysisPayload): boolean {
  return Boolean(payload.result.metrics?.schedulable);
}

function StatusPill({ status }: { status: Status }) {
  return <div className={`status-pill ${status.tone}`}>{status.text}</div>;
}

function Section({ title }: { title: string }) {
  return <div className="section-title">{title}</div>;
}

function Artifact({ label, value }: { label: string; value: string }) {
  return (
    <div className="artifact-row">
      <span className="artifact-label">{label}</span>
      <span className="artifact-value">{value}</span>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function Hub({
  onSpec,
  onBinary,
  onSpecExample,
  onBinaryExample,
}: {
  onSpec: () => void;
  onBinary: () => void;
  onSpecExample: () => void;
  onBinaryExample: () => void;
}) {
  return (
    <div className="hub">
      <div className="hub-head">
        <div className="hub-eyebrow">RT-PN WORKBENCH</div>
        <h1>Choose an analysis mode</h1>
        <p>
          The two modes share one workbench but never mix their stages. Pick a
          mode to enter its dedicated workspace; switch at any time from the
          sidebar.
        </p>
      </div>
      <div className="hub-cards">
        <section className="hub-card spec">
          <div className="hub-kicker">01 · RTSL / TDG → PTPN → SCG</div>
          <h2 className="accent">Scheduling analysis</h2>
          <p>
            Model-first, timed and prioritized. Lower a specification to a
            priority timed Petri net and explore its state-class graph.
          </p>
          <ul className="hub-list">
            <li>11 scheduling policies with formal Mermaid semantics</li>
            <li>WCRT, deadline slack, deadlock counterexamples, core allocation</li>
            <li>Cross-policy sweep, state-class replay and report export</li>
          </ul>
          <div className="hub-spacer" />
          <div className="hub-actions">
            <button className="btn primary wide" onClick={onSpec}>
              <FolderOpen size={13} /> OPEN MODEL
            </button>
            <button className="btn small" onClick={onSpecExample}>
              <Braces size={13} /> SAMPLE
            </button>
          </div>
        </section>
        <section className="hub-card binary">
          <div className="hub-kicker">02 · ELF → CFG</div>
          <h2 className="violet">Binary analysis</h2>
          <p>
            Code-first static inspection: load an ELF and read its layout and
            control-flow graph. Scheduling analysis is intentionally separate.
          </p>
          <ul className="hub-list">
            <li>Readable ELF layout extracted by elf2tdg</li>
            <li>Readable CFG plus optional Graphviz preview image</li>
            <li>elf2tdg is still evolving; TDG output is being replaced by CFG-first views</li>
          </ul>
          <div className="hub-spacer" />
          <div className="hub-actions">
            <button className="btn violet wide" onClick={onBinary}>
              <Binary size={13} /> IMPORT ELF
            </button>
            <button className="btn small" onClick={onBinaryExample}>
              <Braces size={13} /> SAMPLE
            </button>
          </div>
        </section>
      </div>
      <div className="hub-foot">
        <span>
          Both engines are bundled locally; examples live under{" "}
          <span className="mono">examples/</span> in the repository and portable package.
        </span>
      </div>
    </div>
  );
}












