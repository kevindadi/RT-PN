import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleHelp,
  Copy,
  Eye,
  FileCode2,
  FolderOpen,
  Network,
  Play,
  RefreshCw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { join } from "@tauri-apps/api/path";
import { invoke, isTauri } from "@tauri-apps/api/core";
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
import { BinaryConfiguration } from "./BinaryConfiguration";
import { BinaryCfg } from "./BinaryCfg";
import { BinaryCompare } from "./BinaryCompare";
import { BinaryFunctions, BinaryOverview } from "./BinaryStages";
import { SchedulingResults, schedulingMetrics, schedulingOutcome } from "./SchedulingResults";
import { WorkbenchBrand, WorkbenchHome, WorkbenchNavigation, workspaceSections } from "./Workbench";
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

const STAGES: Record<Stage, { label: string; title: string; subtitle: string; previewable?: boolean }> = {
  source: { label: "Source", title: "Model source", subtitle: "Review the input to scheduling verification." },
  dag: { label: "Task graph", title: "Task model", subtitle: "Review dependencies, priorities, core assignments, and timing." },
  configuration: { label: "Configuration", title: "Run configuration", subtitle: "Settings for the next analysis." },
  results: { label: "Summary", title: "Verification results", subtitle: "Review deadlocks, deadlines, and worst-case response times." },
  ptpn: { label: "Petri net", title: "Priority timed Petri net", subtitle: "Inspect places, transitions, and arcs.", previewable: true },
  semantics: { label: "Semantics", title: "Scheduling semantics", subtitle: "Inspect the policy rules and compare scheduling policies." },
  state: { label: "State space", title: "State-class graph", subtitle: "Inspect the explored states and transitions.", previewable: true },
  replay: { label: "Replay", title: "State-class replay", subtitle: "Step through the recorded transition path." },
  timeline: { label: "Timing windows", title: "Response-time envelopes", subtitle: "Review the range of completion times by task." },
  report: { label: "Report", title: "Analysis report", subtitle: "Read the analyzer output and assumptions." },
  elf: { label: "Sections", title: "ELF layout", subtitle: "Inspect ELF segments, sections, and the loader view.", previewable: true },
  overview: { label: "Overview", title: "Firmware overview", subtitle: "Inspect the image and the recovered program structure." },
  functions: { label: "Functions", title: "Function index", subtitle: "Find a function by name or address and open its control flow." },
  cfg: { label: "Control flow", title: "Control-flow evidence", subtitle: "Inspect basic blocks and their instructions.", previewable: true },
  analysis: { label: "Timing", title: "Firmware timing results", subtitle: "Review static timing estimates and their hardware assumptions." },
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

interface Budget {
  maxStates: number;
  timeoutSecs: number;
  maxMemoryMb: number;
}

interface SchedulingConfiguration {
  budget: Budget;
  policy: string;
  tie: string;
}

interface RunSnapshot {
  id: number;
  time: string;
  file: string;
  ok: boolean;
  partial: boolean;
  canceled: boolean;
  schedulable?: boolean | null;
  exact?: boolean;
  truncated?: boolean;
  states: number;
  budgets: Budget;
  elapsedMs: number;
  wcrt: Record<string, number>;
}

function snapshotFrom(payload: AnalysisPayload, budgets: Budget, id: number): RunSnapshot {
  const metrics = schedulingMetrics(payload);
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
  return value === undefined ? "-" : String(value);
}

function deadlockTraceText(trace: TraceStep[]): string {
  const lines = ["DEADLOCK COUNTEREXAMPLE", ""];
  trace.forEach((step, index) => {
    if (index > 0) {
      lines.push(`   -- ${step.transition || "(transition)"} -->`);
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
    `- Exit code: ${result.exit_code ?? "-"}`,
    `- Elapsed: ${result.elapsed_ms} ms`,
    `- Budget: max-states ${budgets.maxStates}, timeout ${budgets.timeoutSecs || "off"} s, max-memory ${budgets.maxMemoryMb || "off"} MB`,
    `- Scheduling policy: ${policy} | tie ${tie}`,
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
          `| ${entry.label} | ${entry.status} | ${entry.maxWcrt ?? "-"} | ${entry.states} | ${entry.deadlocks} | ${entry.elapsedMs} ms |`,
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
      before: String(a.exact ?? "-"),
      after: String(b.exact ?? "-"),
      regressed: a.exact === true && b.exact === false,
    },
    {
      label: "truncated",
      before: String(a.truncated ?? "-"),
      after: String(b.truncated ?? "-"),
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
              {a.file} | #{a.id} to #{b.id}
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
                    {row.regressed ? "  ^" : ""}
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
                    <td style={{ padding: 6, color: "#8ca9c8" }}>wcrt | {task}</td>
                    <td style={{ padding: 6 }}>{reportNumber(before)}</td>
                    <td style={{ padding: 6, color: regressed ? "#ff8a8a" : "#e6f1ff" }}>
                      {reportNumber(after)}
                      {regressed ? "  ^" : ""}
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

function fileName(path: string | null | undefined): string {
  if (!path) return "No file selected";
  return path.split(/[\\/]/).pop() ?? path;
}

function engineTag(engine: { source: string; external_override: boolean }): string {
  return engine.external_override ? `${engine.source.toUpperCase()}|EXTERNAL` : engine.source.toUpperCase();
}

function isBinaryPath(path: string): boolean {
  return /\.(elf|out|axf)$/i.test(path);
}

function sameBinaryOptions(left: BinaryOptions, right: BinaryOptions): boolean {
  return (left.cpu ?? "") === (right.cpu ?? "") &&
    (left.freq ?? "") === (right.freq ?? "") &&
    (left.board_profile ?? "") === (right.board_profile ?? "");
}

/** Guard rails so a huge Mermaid/text layout never blocks the workbench. */
const ELF_PREVIEW_CHAR_LIMIT = 400_000;
const ELF_TEXT_CHAR_LIMIT = 1_500_000;

function timestamp(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function App() {
  const [workflow, setWorkflow] = useState<Workflow>("none");
  const [hub, setHub] = useState(true);
  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(null);
  const [binary, setBinary] = useState<ElfWorkflow | null>(null);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<Stage>("source");
  const [source, setSource] = useState<{ path: string; text: string; error?: string } | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [homeComparison, setHomeComparison] = useState<Detail | null>(null);
  const [specRunConfig, setSpecRunConfig] = useState<SchedulingConfiguration | null>(null);
  const [binaryRunOptions, setBinaryRunOptions] = useState<BinaryOptions | null>(null);
  const [binaryUsesStoredRun, setBinaryUsesStoredRun] = useState(false);
  const runningRef = useRef(false);
  const cfgRequest = useRef(0);
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
  const [pendingMessage, setPendingMessage] = useState("");
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
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>([]);

  useEffect(() => {
    void workspaceRecent(12)
      .then(setWorkspaceProjects)
      .catch(() => undefined);
  }, [hub, workflow]);

  const [compareMode, setCompareMode] = useState(false);
  const [compareSelected, setCompareSelected] = useState<string[]>([]);
  const [compareLanes, setCompareLanes] = useState<CompareLane[]>([]);
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareProgress, setCompareProgress] = useState({ done: 0, total: 0 });
  const runStartedRef = useRef(0);
  const snapshotIdRef = useRef(1);
  const [error, setError] = useState<string | null>(null);
  const openPathRef = useRef<(path: string) => void>(() => undefined);

  const isBinary = workflow === "binary";
  const section = workspaceSections(isBinary).find(({ stages }) =>
    (stages as readonly Stage[]).includes(activeStage),
  );
  const relatedStages = section?.stages ?? [];
  const activeSource = source?.path === currentPath ? source : null;
  const doc = isBinary
    ? binaryDoc(activeStage, binary)
    : activeStage === "source"
      ? activeSource?.text ?? ""
      : stageDoc(activeStage, analysis?.docs);
  const taskMetrics = schedulingMetrics(analysis).tasks ?? [];
  const resultPolicy = policyById(specRunConfig?.policy ?? policy);
  const optionsDirty = isBinary
    ? binaryRunOptions !== null && !sameBinaryOptions(binaryRunOptions, binaryOptions)
    : specRunConfig !== null && (
      specRunConfig.budget.maxStates !== budget.maxStates ||
      specRunConfig.budget.timeoutSecs !== budget.timeoutSecs ||
      specRunConfig.budget.maxMemoryMb !== budget.maxMemoryMb ||
      specRunConfig.policy !== policy || specRunConfig.tie !== tie
    );
  const operationBusy = busy || sweepBusy || compareBusy || allocateBusy || fillBusy;

  useEffect(() => {
    if (isBinary || !currentPath || activeStage !== "source") return;
    let active = true;
    void readTextFile(currentPath)
      .then((text) => { if (active) setSource({ path: currentPath, text }); })
      .catch((error) => { if (active) setSource({ path: currentPath, text: "", error: String(error) }); });
    return () => { active = false; };
  }, [isBinary, currentPath, activeStage]);

  useEffect(() => {
    if (workflow !== "binary") return;
    void binaryProfiles()
      .then((items) => setProfiles(items))
      .catch(() => setProfiles([]));
  }, [workflow]);

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
    }).catch(() => () => undefined);
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => undefined);
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
        setMermaidPreview(null);
        setShowOutput(false);
        setGuideOpen(false);
        setHomeComparison(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
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
    getCurrentWindow().setTitle(`RT-PN  |  ${name}`).catch(() => undefined);
  };

  const appendHistory = useCallback((verdict: string, detailText: string) => {
    setHistory((previous) =>
      [{ time: timestamp(), verdict, detail: detailText }, ...previous].slice(0, 5),
    );
  }, []);

  const runSpec = useCallback(
    async (path: string, newProject: boolean, override?: SchedulingConfiguration) => {
      if (runningRef.current) return;
      runningRef.current = true;
      const config = override ?? { budget, policy, tie };
      cfgRequest.current += 1;
      setPreview(null);
      setImagePreview(null);
      setMermaidPreview(null);
      setHub(false);
      setWorkflow("spec");
      setBinary(null);
      setBinaryRunOptions(null);
      if (newProject) {
        setAnalysis(null);
        setSpecRunConfig(null);
        setHistory([]);
        setSnapshots([]);
        setShowOutput(false);
      }
      setCurrentPath(path);
      setActiveStage("results");
      setBusy(true);
      setError(null);
      setStatus({ text: "Verifying model", tone: "warn" });
      setDetail({ title: "Verification in progress", body: path });
      setWindowTitle(fileName(path));
      setLiveLog([]);
      setLiveElapsed(0);
      setPending([]);
      setPendingMessage("");
      setPendingInputs({});
      setAllocation(null);
      setDescribeText("");
      setSweep([]);
      setCompareMode(false);
      setCompareLanes([]);
      runStartedRef.current = Date.now();
      try {
        const payload = await analyzeModel(path, {
          max_states: config.budget.maxStates,
          timeout_secs: config.budget.timeoutSecs,
          max_memory_mb: config.budget.maxMemoryMb,
          policy: config.policy,
          tie: config.tie,
        });
        setAnalysis(payload);
        setSpecRunConfig(config);
        setSnapshots((previous) =>
          [...previous, snapshotFrom(payload, config.budget, snapshotIdRef.current++)].slice(-10),
        );
        const { result } = payload;
        const { partial, deadlocks, certified } = schedulingOutcome(payload);
        let verdict: Status;
        if (result.canceled) verdict = { text: "Canceled", tone: "warn" };
        else if (!result.ok) verdict = { text: "Verification failed", tone: "bad" };
        else if (payload.deadlock_trace?.length || (certified && deadlocks > 0)) {
          verdict = { text: "Deadlock found", tone: "bad" };
        } else if (partial) verdict = { text: "Exploration incomplete", tone: "warn" };
        else verdict = { text: "Verification complete", tone: "good" };
        setStatus(verdict);
        setDetail({
          title: verdict.text,
          body: result.ok
            ? `${result.scg.nodes.length} state classes, ${result.scg.edges.length} transitions`
            : result.error,
        });
        appendHistory(verdict.text, `${payload.docs.task_count} tasks, ${result.scg.nodes.length} state classes`);
      } catch (reason) {
        setStatus({ text: "Verification failed", tone: "bad" });
        setError(String(reason));
        setDetail({ title: "Verification failed", body: String(reason) });
      } finally {
        runningRef.current = false;
        runStartedRef.current = 0;
        setBusy(false);
      }
    },
    [appendHistory, budget, policy, tie],
  );

  const exportReport = useCallback(
    async (format: "md" | "json") => {
      if (!analysis || !specRunConfig) return;
      const { budget, policy, tie } = specRunConfig;
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
    [analysis, specRunConfig, sweep],
  );

  const refreshDescription = useCallback(async () => {
    if (!currentPath) return;
    setDescribeBusy(true);
    try {
      setDescribeText(await describeModel(currentPath, specRunConfig?.policy ?? policy, specRunConfig?.tie ?? tie));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setDescribeBusy(false);
    }
  }, [currentPath, policy, specRunConfig, tie]);

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
        const metrics = schedulingMetrics(payload);
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
    async (path: string, newProject: boolean, overrideOptions?: BinaryOptions, reviewResults = !newProject) => {
      if (runningRef.current) return;
      runningRef.current = true;
      const activeOptions = overrideOptions ?? binaryOptions;
      cfgRequest.current += 1;
      setCfgLoading(false);
      setPreview(null);
      setImagePreview(null);
      setMermaidPreview(null);
      setHub(false);
      setWorkflow("binary");
      setAnalysis(null);
      setSpecRunConfig(null);
      setCurrentPath(path);
      setActiveStage(reviewResults ? "analysis" : "overview");
      setBusy(true);
      setError(null);
      setLiveLog([]);
      setLiveElapsed(0);
      runStartedRef.current = Date.now();
      setStatus({ text: newProject ? "Inspecting firmware" : "Analyzing timing", tone: "accent" });
      setDetail({ title: "Firmware analysis in progress", body: path });
      setWindowTitle(fileName(path));
      if (newProject) {
        setBinary(null);
        setBinaryRunOptions(null);
        setBinaryOptions(activeOptions);
        setHistory([]);
        setShowOutput(false);
      }
      try {
        const payload = await analyzeElf(path, activeOptions);
        cfgRequest.current += 1;
        setFunctionCfg(null);
        setCfgSelector(null);
        setCfgLoading(false);
        setCfgError(null);
        setWcetPath(null);
        setBinary(payload);
        setBinaryRunOptions(activeOptions);
        setBinaryUsesStoredRun(false);
        setStatus({ text: "Firmware ready", tone: "good" });
        setDetail({
          title: "Firmware ready",
          body: `${payload.functions} functions, ${payload.blocks} basic blocks
${payload.artifacts_dir}`,
        });
        appendHistory("Firmware ready", `${payload.functions} functions, ${payload.calls} calls`);
        void workspaceSaveProject(fileName(path), path, activeOptions, payload)
          .then(() => workspaceRecent(12))
          .then(setWorkspaceProjects)
          .catch((error) => setError(`Could not save run history: ${String(error)}`));
      } catch (reason) {
        setStatus({ text: "Firmware analysis failed", tone: "bad" });
        setError(String(reason));
        setDetail({ title: "Firmware analysis failed", body: String(reason) });
      } finally {
        runningRef.current = false;
        runStartedRef.current = 0;
        setBusy(false);
      }
    },
    [appendHistory, binaryOptions],
  );

  const loadFunctionCfg = useCallback(
    async (selector: string, highlight: string[] | null = null) => {
      if (!currentPath || !selector || !binaryRunOptions) return;
      const request = ++cfgRequest.current;
      setWcetPath(highlight);
      setFunctionCfg(null);
      setCfgSelector(selector);
      setCfgLoading(true);
      setCfgError(null);
      try {
        const useArtifact = binaryUsesStoredRun || highlight !== null;
        const artifact = useArtifact
          ? binary?.artifacts.find((path) => path.endsWith(".cfg.json"))
          : undefined;
        if (useArtifact && !artifact) {
          throw new Error("This run has no saved CFG artifact. Run timing analysis to rebuild the evidence.");
        }
        const cfg = await binaryFunction(currentPath, selector, binaryRunOptions, artifact);
        if (cfgRequest.current !== request) return;
        setFunctionCfg(cfg);
        setDetail({
          title: "Function control flow",
          body: `${cfg.name || selector}
${cfg.address || "-"} | ${cfg.blocks.length} blocks
${cfg.source?.file ?? "Source location unavailable"}`,
        });
      } catch (reason) {
        if (cfgRequest.current === request) setCfgError(String(reason));
      } finally {
        if (cfgRequest.current === request) setCfgLoading(false);
      }
    },
    [binary, binaryRunOptions, binaryUsesStoredRun, currentPath],
  );

  const functionSelector = (row: BinaryFunctionRow): string =>
    row.address || row.name || row.demangled_name || row.id || "";

  useEffect(() => {
    if (!isBinary || activeStage !== "cfg" || !binary || busy || cfgSelector || cfgLoading) return;
    const rootName = binary.roots
      .map((root) => typeof root.name === "string" ? root.name : "")
      .find(Boolean);
    const row = binary.function_rows[0];
    const selector = rootName || (row ? functionSelector(row) : "");
    if (selector) void loadFunctionCfg(selector);
  }, [activeStage, binary, busy, cfgLoading, cfgSelector, isBinary, loadFunctionCfg]);

  const cancelRun = useCallback(async () => {
    setStatus({ text: "CANCELING", tone: "warn" });
    try {
      await cancelAnalysis();
    } catch (error) {
      setError(String(error));
    }
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
        body: `filled ${filled.filled} task(s) | ${filled.remaining_pending} pending remaining\n\n${filled.path}\n\nRe-analysing the patched source.`,
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
      setPendingMessage(list.length === 0 ? "No pending timing intervals found." : "");
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
      policy,
      tie,
      binaryOptions: isBinary ? binaryOptions : undefined,
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
  }, [currentPath, workflow, activeStage, budget, policy, tie, isBinary, binaryOptions]);

  const openProject = useCallback(async () => {
    try {
      const path = await pickProject();
      if (!path) return;
      const project = JSON.parse(await readTextFile(path)) as ProjectFile;
      if (!project.modelPath) throw new Error("Project file has no model path.");
      const config = {
        budget: project.budgets ?? budget,
        policy: project.policy ?? policy,
        tie: project.tie ?? tie,
      };
      setBudget(config.budget);
      setPolicy(config.policy);
      setTie(config.tie);
      const binary = project.workflow === "binary";
      if (binary) await runBinary(project.modelPath, true, project.binaryOptions ?? {});
      else await runSpec(project.modelPath, true, config);
      if (workspaceSections(binary).some(({ stages }) => (stages as readonly Stage[]).includes(project.stage))) {
        setActiveStage(project.stage);
      }
    } catch (reason) {
      setError(String(reason));
    }
  }, [budget, policy, tie, runBinary, runSpec]);

  const openSpecDialog = useCallback(async () => {
    try {
      const path = await pickSpecification();
      if (!path || runningRef.current) return;
      cfgRequest.current += 1;
      setWorkflow("spec");
      setHub(false);
      setAnalysis(null);
      setBinary(null);
      setSpecRunConfig(null);
      setBinaryRunOptions(null);
      setCurrentPath(path);
      setActiveStage("source");
      setSource(null);
      setHistory([]);
      setSnapshots([]);
      setPending([]);
      setPendingMessage("");
      setPendingInputs({});
      setAllocation(null);
      setDescribeText("");
      setSweep([]);
      setCompareMode(false);
      setCompareLanes([]);
      setLiveLog([]);
      setShowOutput(false);
      setError(null);
      setStatus({ text: "Model loaded", tone: "accent" });
      setDetail({ title: "Model loaded", body: path });
      setWindowTitle(fileName(path));
    } catch (error) {
      setError(String(error));
    }
  }, []);

  const openBinaryDialog = useCallback(async () => {
    try {
      const path = await pickElf();
      if (path) await runBinary(path, true, {});
    } catch (error) {
      setError(String(error));
    }
  }, [runBinary]);

  const openWorkspaceRun = useCallback(async (id: string, runId: string) => {
    try {
      const restored = await workspaceOpenRun(id, runId);
      setWorkflow("binary");
      setHub(false);
      setAnalysis(null);
      setBinary(restored.payload);
      setCurrentPath(restored.project.elf_path ?? null);
      const options = restored.project.options ?? {};
      setBinaryOptions(options);
      setBinaryRunOptions(options);
      setBinaryUsesStoredRun(true);
      setSpecRunConfig(null);
      setHistory([]);
      setShowOutput(false);
      cfgRequest.current += 1;
      setCfgLoading(false);
      setActiveStage("analysis");
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
          "A stored run payload was loaded from the workspace - no re-analysis was run.",
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
        `A  ${new Date(runs[0].at * 1000).toLocaleString()} | ${runs[0].profile || "no profile"}`,
        `B  ${new Date(runs[1].at * 1000).toLocaleString()} | ${runs[1].profile || "no profile"}`,
        "",
        `functions  ${a.payload.functions} -> ${b.payload.functions}`,
        `instructions  ${a.payload.coverage?.total_instructions ?? "?"} -> ${b.payload.coverage?.total_instructions ?? "?"}`,
        "",
        "WCET roots (A -> B, Delta B-A):",
      ];
      for (const name of names) {
        const cyclesA = rootA.get(name) ?? null;
        const cyclesB = rootB.get(name) ?? null;
        const delta =
          cyclesA !== null && cyclesB !== null ? cyclesB - cyclesA : null;
        lines.push(
          `  ${name}: ${cyclesA ?? "-"} -> ${cyclesB ?? "-"}` +
            (delta === null ? "" : ` (${delta > 0 ? "+" : ""}${delta.toFixed(1)} cy)`),
        );
      }
      setHomeComparison({ title: "Stored run comparison", body: lines.join("\n") });
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
      const options = restored.project.options ?? {};
      setBinaryOptions(options);
      setBinaryRunOptions(options);
      setBinaryUsesStoredRun(true);
      setSpecRunConfig(null);
      setHistory([]);
      setShowOutput(false);
      cfgRequest.current += 1;
      setCfgLoading(false);
      setActiveStage("analysis");
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
          "Cached text results loaded from the SQLite workspace - no re-analysis was run.",
      });
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const openPath = useCallback(
    (path: string) => {
      if (operationBusy) return;
      if (isBinaryPath(path)) {
        const newProject = path !== binary?.elf_path;
        void runBinary(path, newProject, newProject ? {} : undefined);
      } else {
        void runSpec(path, workflow !== "spec" || path !== currentPath);
      }
    },
    [binary?.elf_path, currentPath, operationBusy, runBinary, runSpec, workflow],
  );
  openPathRef.current = openPath;

  const openModelExample = useCallback(async () => {
    try {
      const base = await exampleBase();
      await runSpec(await join(base, "ptpn", "introduction", "locked.rtsl"), true, {
        budget: { maxStates: 20_000, timeoutSecs: 120, maxMemoryMb: 2048 },
        policy: "fixed_prior_with_resume",
        tie: "fifo",
      });
    } catch (reason) {
      setError(String(reason));
    }
  }, [runSpec]);

  const openElfExample = useCallback(async () => {
    try {
      const base = await exampleBase();
      const profile = await join(base, "elf2tdg", "profiles", "cortex-m7-wcet.toml");
      const options: BinaryOptions = {
        cpu: "cortex-m7",
        board_profile: profile,
      };
      await runBinary(
        await join(base, "elf2tdg", "rust-concurrency", "artifacts", "rust-concurrency-analysis.elf"),
        true,
        options,
        true,
      );
    } catch (reason) {
      setError(String(reason));
    }
  }, [runBinary]);

  const copyStage = async () => {
    try {
      const text = activeStage === "semantics" ? describeText || doc : doc;
      await navigator.clipboard.writeText(text);
      setStatus({ text: "Copied to clipboard", tone: "accent" });
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
          setShowOutput(true);
          setStatus({ text: "Preview too large", tone: "warn" });
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
          title: `${fileName(binary.elf_path)} | ELF LAYOUT`,
          footer:
            `Mermaid source ${(layout.length / 1024).toFixed(1)} KB ` +
            `(limit ${(ELF_PREVIEW_CHAR_LIMIT / 1024).toFixed(0)} KB) | rendered locally`,
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

  const displayPath = binary?.elf_path ?? currentPath;
  const displayName = fileName(displayPath);
  const stage = STAGES[activeStage];
  const lastRun = isBinary
    ? binaryRunOptions === null ? "" : [
        binaryRunOptions.cpu || "Auto-detected CPU",
        binaryRunOptions.freq,
        binaryRunOptions.board_profile ? fileName(binaryRunOptions.board_profile) : "",
      ].filter(Boolean).join(" / ")
    : specRunConfig === null ? "" : [
        resultPolicy.label,
        `${specRunConfig.tie} tie rule`,
        `${specRunConfig.budget.maxStates.toLocaleString("en-US")} state limit`,
      ].join(" / ");
  const selectedProfile = profiles.find((profile) => profile.path === binaryOptions.board_profile);
  const profileConflict = isBinary && Boolean(
    selectedProfile?.cpu && binaryOptions.cpu && selectedProfile.cpu !== binaryOptions.cpu,
  );
  const canRun = Boolean(currentPath) && !operationBusy && !profileConflict;
  const openInput = isBinary ? openBinaryDialog : openSpecDialog;
  const openSample = isBinary ? openElfExample : openModelExample;
  const onSelectFunction = (row: BinaryFunctionRow) => {
    setActiveStage("cfg");
    void loadFunctionCfg(functionSelector(row));
  };

  if (workflow === "none" || hub) {
    return (
      <div className="workbench-home">
        <header className="home-bar">
          <WorkbenchBrand />
          <div className="wb-actions">
            {workflow !== "none" && (
              <button className="wb-button wb-quiet" onClick={() => setHub(false)}>
                Resume workspace <ArrowRight size={15} />
              </button>
            )}
            <button className="wb-button wb-quiet" onClick={() => void openProject()}><FolderOpen size={15} /> Open project</button>
            <button className="wb-button wb-icon" onClick={() => setGuideOpen(true)} aria-label="Open workflow guide" title="Workflow guide"><CircleHelp size={19} /></button>
          </div>
        </header>
        <WorkbenchHome
          onOpenModel={() => void openSpecDialog()}
          onOpenFirmware={() => void openBinaryDialog()}
          onModelExample={() => void openModelExample()}
          onFirmwareExample={() => void openElfExample()}
        >
          {workspaceProjects.length > 0 && (
            <section className="wb-recents">
              <h2>Recent firmware</h2>
              <div className="wb-recent-list">
                {workspaceProjects.map((project) => (
                  <div className="wb-recent" key={project.id}>
                    <button
                      className="wb-recent-open"
                      onClick={() => void openWorkspaceProject(project.id)}
                      title={project.elf_path}
                    >
                      <FileCode2 size={17} />
                      <span><strong>{project.name}</strong><small>{project.arch || "ELF"} / {project.run_count ?? 0} runs</small></span>
                    </button>
                    <details className="wb-menu">
                      <summary className="wb-button wb-quiet" aria-label={`History for ${project.name}`}>History <ChevronDown size={14} /></summary>
                      <div className="wb-menu-content">
                        {project.last_runs?.map((run, index) => run.run_id && (
                          <button key={run.run_id} onClick={() => void openWorkspaceRun(project.id, run.run_id!)}>
                            {index === 0 ? "Latest" : "Run"} / {new Date(run.at * 1000).toLocaleString("en-US")}
                          </button>
                        ))}
                        <button disabled={(project.last_runs?.length ?? 0) < 2} onClick={() => void compareProjectRuns(project)}>Compare last two runs</button>
                        <button onClick={async () => {
                          if (!window.confirm(`Remove cached analyses for "${project.name}"?`)) return;
                          try {
                            await workspaceDeleteProject(project.id);
                            setWorkspaceProjects((previous) => previous.filter((item) => item.id !== project.id));
                          } catch (reason) {
                            setError(String(reason));
                          }
                        }}>Remove from history</button>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            </section>
          )}
          <footer className="home-footer">
            <span title={cli?.path}><i className={cli ? "wb-engine-ready" : ""} /> PTPN {cli ? engineTag(cli) : "unavailable"}</span>
            <span title={elf2tdg?.path}><i className={elf2tdg ? "wb-engine-ready" : ""} /> elf2tdg {elf2tdg ? engineTag(elf2tdg) : "unavailable"}</span>
          </footer>
        </WorkbenchHome>
        {homeComparison && (
          <div className="guide-overlay" onClick={() => setHomeComparison(null)}>
            <section className="guide-dialog wb-comparison" role="dialog" aria-modal="true" aria-label={homeComparison.title} onClick={(event) => event.stopPropagation()}>
              <div className="wb-panel-heading"><h2>{homeComparison.title}</h2><button className="wb-button wb-icon" aria-label="Close comparison" onClick={() => setHomeComparison(null)}><X size={18} /></button></div>
              <pre>{homeComparison.body}</pre>
            </section>
          </div>
        )}
        {guideOpen && <WorkflowGuide onClose={() => setGuideOpen(false)} />}
        {error && <button className="toast" role="alert" onClick={() => setError(null)}>{error}</button>}
      </div>
    );
  }

  return (
    <div className={`workbench-shell ${isBinary ? "workbench-firmware" : "workbench-model"}`}>
      <header className="workbench-bar">
        <button
          className="wb-button wb-quiet wb-home-button"
          onClick={() => setHub(true)}
          disabled={operationBusy}
          title="Back to workflows"
          aria-label="Back to workflows"
        >
          <ArrowLeft size={15} /> <WorkbenchBrand />
        </button>
        <div className="wb-current-file" title={displayPath ?? undefined}>
          <FileCode2 size={15} /> <span>{displayName}</span>
        </div>
        <div className="wb-actions wb-toolbar">
          <details className="wb-menu">
            <summary className="wb-button wb-quiet">File <ChevronDown size={13} /></summary>
            <div className="wb-menu-content" onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("button")) {
                event.currentTarget.closest("details")?.removeAttribute("open");
              }
            }}>
              <button disabled={operationBusy} onClick={() => void openInput()}>{isBinary ? "Open ELF" : "Open model"}</button>
              <button disabled={operationBusy} onClick={() => void openSample()}>Open example</button>
              <button disabled={operationBusy} onClick={() => void openProject()}>Open project</button>
              <button disabled={!currentPath || operationBusy} onClick={() => void saveProject()}>Save project</button>
            </div>
          </details>
          <button className="wb-button wb-icon" aria-label="Open workflow guide" title="Workflow guide" onClick={() => setGuideOpen(true)}><CircleHelp size={18} /></button>
          {busy && !isBinary ? (
            <button className="wb-button" disabled={status.text === "CANCELING"} onClick={() => void cancelRun()}><Square size={14} /> Cancel run</button>
          ) : (
            <button className="wb-button wb-primary" disabled={!canRun} title={profileConflict ? "Select the CPU required by the board profile" : undefined} onClick={() => {
              if (!currentPath) return;
              if (isBinary) void runBinary(currentPath, false);
              else void runSpec(currentPath, false);
            }}>
              {busy ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}
              {busy ? "Analyzing..." : isBinary ? "Run timing analysis" : "Run verification"}
            </button>
          )}
        </div>
      </header>

      <WorkbenchNavigation binary={isBinary} activeStage={activeStage} onStageChange={setActiveStage} />

      <main className="workbench-main">
        <div className="workbench-document">
          <header className="wb-document-header">
            <div>
              <h1>{stage.title}</h1>
              <p>{stage.subtitle}</p>
            </div>
            <div className="wb-actions">
              {activeStage === "cfg" && (
                <button className="wb-button" disabled={!binary} onClick={() => setActiveStage("functions")}>Find function</button>
              )}
              {doc && activeStage !== "cfg" && (
                <button className="wb-button wb-quiet" onClick={() => void copyStage()}><Copy size={14} /> Copy</button>
              )}
              {stage.previewable && (isBinary ? binary : analysis) && (
                <button className="wb-button" onClick={openPreview}><Eye size={15} /> {activeStage === "cfg" ? "Program graph" : "Preview graph"}</button>
              )}
              {!isBinary && section?.label === "Results" && analysis && (
                <details className="wb-menu">
                  <summary className="wb-button">Export <ChevronDown size={13} /></summary>
                  <div className="wb-menu-content">
                    <button onClick={() => void exportReport("md")}>Markdown report</button>
                    <button onClick={() => void exportReport("json")}>JSON report</button>
                  </div>
                </details>
              )}
            </div>
          </header>
          {relatedStages.length > 1 && (
            <nav className="wb-subnav" aria-label={`${section?.label} views`}>
              {relatedStages.map((item) => (
                <button key={item} onClick={() => setActiveStage(item)} aria-current={item === activeStage ? "page" : undefined}>
                  {STAGES[item].label}
                </button>
              ))}
            </nav>
          )}
          {(optionsDirty || (lastRun && (section?.label === "Results" || section?.label === "Evidence"))) && (
            <p className="wb-run-context">
              {lastRun && <>Displayed run: <strong>{lastRun}</strong></>}
              {optionsDirty && <span>Configuration changes apply to the next run.</span>}
            </p>
          )}
          {busy && (analysis || binary) && <p className="wb-run-context">A new run is in progress. The previous results remain visible below.</p>}
          <div className="wb-stage-content">
            {activeStage === "configuration" ? (
              isBinary ? (
                <BinaryConfiguration
                  binary={binary}
                  options={binaryOptions}
                  profiles={profiles}
                  busy={operationBusy}
                  onOptionsChange={setBinaryOptions}
                  onReloadProfiles={() => {
                    void binaryProfiles().then(setProfiles).catch((reason) => setError(String(reason)));
                  }}
                />
              ) : (
                <div className="wb-document">
                  <section className="wb-panel">
                    <h2>Scheduling policy</h2>
                    <p className="wb-muted">Choose the scheduling and equal-priority rules used during exploration.</p>
                    <fieldset className="wb-fields wb-fields-two" disabled={operationBusy}>
                      <label>
                        <span>Policy override</span>
                        <select value={policy} onChange={(event) => setPolicy(event.target.value)}>
                          {SCHEDULING_POLICIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>Equal-priority tie rule</span>
                        <select value={tie} onChange={(event) => setTie(event.target.value)}>
                          <option value="fifo">First in, first out</option>
                          <option value="arbitrary">Explore arbitrary order</option>
                        </select>
                      </label>
                    </fieldset>
                    <button className="wb-button wb-quiet" onClick={() => setActiveStage("semantics")}>View scheduling semantics <ArrowRight size={14} /></button>
                  </section>
                  <section className="wb-panel">
                    <h2>Search limits</h2>
                    <p className="wb-muted">Set a budget for state-space exploration. Enter zero to disable the time or memory limit.</p>
                    <fieldset className="wb-fields" disabled={operationBusy}>
                      {([
                        ["State limit", "maxStates", 100, 1_000_000],
                        ["Time limit (s)", "timeoutSecs", 0, 3_600],
                        ["Memory limit (MB)", "maxMemoryMb", 0, 65_536],
                      ] as const).map(([label, key, min, max]) => (
                        <label key={key}>
                          <span>{label}</span>
                          <input type="number" min={min} max={max} value={budget[key]} onChange={(event) => {
                            const value = Number(event.target.value);
                            setBudget((previous) => ({ ...previous, [key]: value }));
                          }} onBlur={() => {
                            setBudget((previous) => {
                              const value = previous[key];
                              const nonzeroMinimum = key === "timeoutSecs" ? 5 : key === "maxMemoryMb" ? 64 : min;
                              const next = min === 0 && value === 0 ? 0 : Math.max(nonzeroMinimum, Math.min(max, Math.round(value)));
                              return next === value ? previous : { ...previous, [key]: next };
                            });
                          }} />
                        </label>
                      ))}
                    </fieldset>
                  </section>
                  <details className="wb-panel wb-disclosure">
                    <summary>Resolve pending timing</summary>
                    <p className="wb-muted">Find RTSL tasks with pending timing intervals and fill them in a new source file.</p>
                    <button className="wb-button" disabled={!currentPath || operationBusy} onClick={() => void checkPending()}>Check intervals</button>
                    {pending.length === 0 && pendingMessage && <p className="wb-muted" role="status">{pendingMessage}</p>}
                    {pending.length > 0 && (
                      <>
                        <fieldset className="wb-fields wb-fields-two" disabled={operationBusy}>
                          {pending.map((entry) => (
                            <label key={entry.task}>
                              <span>{entry.task} / line {entry.line ?? "?"} / {entry.expected_segments ?? "?"} intervals</span>
                              <input
                                placeholder="min,max, min,max"
                                value={pendingInputs[entry.task] ?? ""}
                                onChange={(event) => setPendingInputs((previous) => ({ ...previous, [entry.task]: event.target.value }))}
                              />
                            </label>
                          ))}
                        </fieldset>
                        <button className="wb-button" disabled={operationBusy} onClick={() => void fillPending()}>Fill and verify</button>
                      </>
                    )}
                  </details>
                  <details className="wb-panel wb-disclosure">
                    <summary>Explore core allocations</summary>
                    <p className="wb-muted">Search the allowed core assignments declared by the task model.</p>
                    <button className="wb-button" disabled={!currentPath || operationBusy} onClick={() => void runAllocation()}>{allocateBusy ? "Searching..." : "Search allocations"}</button>
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
                    return assignment.map((item) => `${item.task}->c${item.core}`).join(" ");
                  };
                  return (
                    <div style={{ fontSize: 10, display: "grid", gap: 4 }}>
                      <div className="faint">
                        {String(search.strategy ?? "?")} | domain{" "}
                        {String(search.domain_size ?? "?")} | evaluated{" "}
                        {String(search.evaluated ?? "?")} | feasible{" "}
                        {String(search.feasible_count ?? "?")}
                      </div>
                      {best && (
                        <div className="mono">
                          best {assignmentText(best)} | wcrt {String(best.max_wcrt ?? "?")} |
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
                </div>
              )
            ) : activeStage === "results" && analysis ? (
              <div className="wb-document">
                <SchedulingResults payload={analysis} onReplay={() => setActiveStage("replay")} onStateSpace={() => setActiveStage("state")} onConfigure={() => setActiveStage("configuration")} />
                {history.length > 0 && (
                  <details className="wb-panel wb-disclosure">
                    <summary>Run history</summary>
                    <ul className="wb-history">
                      {history.map((entry, index) => (
                        <li key={`${entry.time}-${index}`}><time>{entry.time}</time><strong>{entry.verdict}</strong><span>{entry.detail}</span></li>
                      ))}
                    </ul>
                    <button className="wb-button" disabled={snapshots.length < 2} onClick={() => setCompareOpen(true)}>Compare last two runs</button>
                  </details>
                )}
              </div>
            ) : activeStage === "overview" && binary ? (
              <BinaryOverview
                binary={binary}
                onApplyPreset={(cpu, freq) => {
                  setBinaryOptions((previous) => ({ ...previous, cpu, freq }));
                  setActiveStage("configuration");
                }}
                onSelectFunction={onSelectFunction}
              />
            ) : activeStage === "functions" && binary ? (
              <BinaryFunctions binary={binary} onSelect={onSelectFunction} />
            ) : activeStage === "elf" && binary ? (
              <CodeStage
                doc={binary.elf_view.length > ELF_TEXT_CHAR_LIMIT
                  ? `${binary.elf_view.slice(0, ELF_TEXT_CHAR_LIMIT)}\n\nFull layout: ${binary.artifacts_dir}`
                  : binary.elf_view}
                stageKey="binary-elf"
              />
            ) : activeStage === "cfg" && binary ? (
              <BinaryCfg
                cfg={functionCfg}
                loading={cfgLoading}
                error={cfgError}
                selector={cfgSelector ?? ""}
                highlightPath={wcetPath}
                onReload={() => { if (cfgSelector) void loadFunctionCfg(cfgSelector, wcetPath); }}
              />
            ) : activeStage === "analysis" && binary ? (
              <div className="wb-document">
                <BinaryAnalysisView
                  binary={binary}
                  options={binaryRunOptions ?? {}}
                  onOpenConfig={() => setActiveStage("configuration")}
                  onOpenCfg={() => setActiveStage("cfg")}
                  onOpenPath={(selector, path) => {
                    setActiveStage("cfg");
                    void loadFunctionCfg(selector, path);
                  }}
                />
                <details className="wb-panel wb-disclosure">
                  <summary>Compare board profiles</summary>
                  <BinaryCompare
                    elfPath={binary.elf_path}
                    profiles={profiles}
                    cpu={binaryRunOptions?.cpu ?? ""}
                    freq={binaryRunOptions?.freq ?? ""}
                    defaultProfile={binaryRunOptions?.board_profile ?? ""}
                  />
                </details>
              </div>
            ) : activeStage === "semantics" && !isBinary ? (
              <SemanticsStage
                policy={resultPolicy}
                tie={specRunConfig?.tie ?? tie}
                describeText={describeText}
                describeBusy={describeBusy}
                onRefreshDescription={() => void refreshDescription()}
                sweep={sweep}
                sweepBusy={sweepBusy}
                sweepProgress={sweepProgress}
                sweepBudget={{ maxStates: sweepMaxStates, timeoutSecs: sweepTimeoutSecs }}
                canSweep={Boolean(currentPath) && (!operationBusy || sweepBusy)}
                onRunSweep={() => void runSweep()}
              />
            ) : activeStage === "replay" && analysis?.result.scg.valid ? (
              compareMode ? (
                <ReplayCompare
                  lanes={compareLanes}
                  busy={compareBusy}
                  progress={compareProgress}
                  selected={compareSelected}
                  onToggle={toggleComparePolicy}
                  onRun={() => { if (!operationBusy) void runPolicyComparison(); }}
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
                  modelLabel={fileName(analysis.result.path)}
                  policy={resultPolicy.label}
                  tie={specRunConfig?.tie ?? tie}
                  tasks={taskMetrics}
                  onCompare={openPolicyCompare}
                />
              )
            ) : doc ? (
              <CodeStage doc={doc} stageKey={`${workflow}-${activeStage}`} />
            ) : (
              <div className="wb-empty" role="status">
                {busy ? <RefreshCw size={24} className="spin" /> : <Network size={24} />}
                <h2>{busy
                  ? isBinary ? "Inspecting firmware" : "Verifying model"
                    : activeStage === "source" ? activeSource?.error ? "Could not read the model" : activeSource ? "The source file is empty" : "Loading model source"
                    : isBinary ? "Firmware data unavailable" : "Ready to verify"}</h2>
                <p>{busy
                  ? isBinary ? "Recovering the ELF layout and program control flow." : "Exploring the model's reachable states."
                  : activeStage === "source" ? activeSource?.error ?? ""
                    : isBinary ? "Run the analysis again or open an ELF file from the File menu."
                      : "Run verification to see the calculated results and evidence."}</p>
                {!busy && !isBinary && activeStage !== "source" && (
                  <button className="wb-button" onClick={() => setActiveStage("configuration")}>Review configuration <ArrowRight size={15} /></button>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {showOutput && (
        <section className="wb-output" aria-label="Run output">
          <div className="wb-panel-heading">
            <h2>Run output</h2>
            <button className="wb-button wb-icon" onClick={() => setShowOutput(false)} aria-label="Close output"><X size={17} /></button>
          </div>
          <div className="wb-output-content">
            <div><strong>{detail.title}</strong><pre>{detail.body}</pre></div>
            <pre>{busy
              ? liveLog.slice(-80).join("\n") || "Waiting for output..."
              : analysis?.result.logs.join("\n") || binary?.warnings.join("\n") || "No log output."}</pre>
            {!isBinary && analysis?.docs.assumptions && (
              <details><summary>Analysis assumptions</summary><pre>{analysis.docs.assumptions}</pre></details>
            )}
          </div>
        </section>
      )}
      <footer className="workbench-footer">
        <span className={`wb-status wb-status-${status.tone}`} role="status"><i />{status.text}</span>
        {busy && <span className="wb-muted">{(liveElapsed / 1000).toFixed(1)} s</span>}
        <button className="wb-button wb-quiet" onClick={() => setShowOutput((previous) => !previous)} aria-expanded={showOutput}>
          <Terminal size={15} /> Run output
        </button>
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
                <div className="sem-eyebrow">PREVIEW | MERMAID</div>
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
        <button className="toast" role="alert" onClick={() => setError(null)}>{error}</button>
      )}
    </div>
  );
}
