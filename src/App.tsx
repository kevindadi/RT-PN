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

import {
  analyzeElf,
  analyzeModel,
  pickElf,
  pickSpecification,
  resolveCliPath,
  resolveElf2tdgPath,
} from "./api";
import { CodeStage } from "./CodeStage";
import { GraphPreview, SvgPreview } from "./GraphPreview";
import type {
  AnalysisPayload,
  ElfWorkflow,
  EngineInfo,
  Graph,
  RunRecord,
  Stage,
  Workflow,
  WorkbenchDocs,
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
  state: {
    label: "STATE SPACE",
    title: "STATE-CLASS SPACE",
    subtitle: "Reachability classes and transitions as text",
    previewable: true,
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
    subtitle: "Readable ELF loader view produced by elf2tdg",
    previewable: false,
  },
  cfg: {
    label: "CFG",
    title: "CONTROL-FLOW GRAPH",
    subtitle: "Readable CFG from elf2tdg · preview image via Graphviz",
    previewable: true,
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
  tasks?: Array<{ wcrt?: number; name?: string }>;
  cores?: unknown[];
}

function stagesFor(workflow: Workflow): Stage[] {
  return workflow === "binary"
    ? ["elf", "cfg"]
    : ["dag", "ptpn", "state", "timeline", "report"];
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

function engineTag(engine: EngineInfo): string {
  return engine.external_override ? `${engine.source.toUpperCase()}·EXTERNAL` : engine.source.toUpperCase();
}

function engineDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}

function isBinaryPath(path: string): boolean {
  return /\.(elf|out|axf)$/i.test(path);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function timestamp(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
  const [cli, setCli] = useState<EngineInfo | null>(null);
  const [elf2tdg, setElf2tdg] = useState<EngineInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openPathRef = useRef<(path: string) => void>(() => undefined);

  const metrics = (analysis?.result.metrics ?? {}) as Metrics;
  const stages = stagesFor(workflow);
  const isBinary = workflow === "binary";
  const doc = isBinary
    ? binaryDoc(activeStage, binary)
    : stageDoc(activeStage, analysis?.docs);
  const binarySummary = binary
    ? activeStage === "elf"
      ? `${(binary.file_size / 1024).toFixed(1)} KB · ${binary.artifacts_dir}`
      : `${binary.functions} fns · ${binary.blocks} blocks · ${binary.calls} calls · ${binary.diagnostics} diagnostics`
    : "";
  const summary = isBinary ? binarySummary : stageSummary(activeStage, analysis?.docs);
  const assumptions = isBinary
    ? binary?.warnings.join("\n") ||
      "elf2tdg loader view → readable CFG → Graphviz preview. Threads/net analysis is pending."
    : analysis?.docs?.assumptions ?? "";

  useEffect(() => {
    resolveCliPath()
      .then((path) => setCli(path))
      .catch(() => setCli(null));
    resolveElf2tdgPath()
      .then((path) => setElf2tdg(path))
      .catch(() => setElf2tdg(null));
  }, []);

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
      try {
        const payload = await analyzeModel(path);
        setAnalysis(payload);
        setBusy(false);
        const verdict = !payload.result.ok
          ? "ERROR"
          : metricsSchedulable(payload)
            ? "SCHEDULABLE"
            : "UNSCHEDULABLE";
        setStatus({
          text: verdict,
          tone: !payload.result.ok ? "bad" : metricsSchedulable(payload) ? "good" : "bad",
        });
        setDetail({
          title: payload.result.ok ? "MODEL READY" : "ANALYSIS FAILED",
          body: payload.result.ok
            ? `${payload.result.net.places.length} places · ${payload.result.net.transitions.length} transitions\n${payload.result.scg.nodes.length} state classes · ${payload.result.scg.edges.length} edges\n\nText is the primary workbench; PREVIEW opens a graph.`
            : payload.result.error,
        });
        appendHistory(
          verdict,
          `${payload.docs.task_count}T · ${payload.result.scg.nodes.length}S`,
        );
      } catch (reason) {
        setBusy(false);
        setStatus({ text: "ANALYSIS FAILED", tone: "bad" });
        setError(String(reason));
        setDetail({ title: "ANALYSIS FAILED", body: String(reason) });
      }
    },
    [appendHistory],
  );

  const runBinary = useCallback(
    async (path: string, newProject: boolean) => {
      setPreview(null);
      setImagePreview(null);
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
      try {
        const payload = await analyzeElf(path);
        setBinary(payload);
        setBusy(false);
        setActiveStage("elf");
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
    [appendHistory],
  );

  const openSpecDialog = useCallback(async () => {
    const path = await pickSpecification();
    if (path) await runSpec(path, true);
  }, [runSpec]);

  const openBinaryDialog = useCallback(async () => {
    const path = await pickElf();
    if (path) await runBinary(path, true);
  }, [runBinary]);

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
    if (!cli) {
      setError("ptpn CLI not found; build it with `just engines` or set PTPN_BIN.");
      return;
    }
    const cliDirectory = engineDirectory(cli.path);
    const candidate = `${cliDirectory}/../example/motivating-examples/hw.json`;
    await runSpec(candidate, true);
  }, [cli, runSpec]);

  const copyStage = async () => {
    try {
      await navigator.clipboard.writeText(doc);
      setStatus({ text: "COPIED", tone: "accent" });
    } catch {
      setError("Clipboard unavailable");
    }
  };

  const openPreview = () => {
    if (isBinary) {
      if (activeStage !== "cfg" || !binary) return;
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

  return (
    <div className="app">
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
            disabled={workflow !== "spec" || !currentPath || busy}
            onClick={() => currentPath && void runSpec(currentPath, false)}
          >
            {busy ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
            {isBinary ? "PENDING" : busy ? "ANALYZING" : "RUN ANALYSIS"}
          </button>
          <button className="btn" onClick={() => void openSpecDialog()}>
            <FolderOpen size={13} /> OPEN
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
            <button className="btn wide" onClick={() => void openBinaryDialog()}>
              <Upload size={13} /> IMPORT ELF
            </button>
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
          <Section title="MODEL SOURCE" />
          <div className="source-name">{displayName}</div>
          <div className="source-path" title={displayPath ?? undefined}>
            {displayPath ?? "No model loaded"}
          </div>
          <div className="stack">
            <button className="btn wide" onClick={() => void openSpecDialog()}>
              <FolderOpen size={13} /> OPEN MODEL
            </button>
            <button className="btn wide" onClick={() => void openExample()}>
              <Braces size={13} /> EXAMPLES
            </button>
          </div>

          <div className="divider" />
          <Section title="ARTIFACTS" />
          {isBinary ? (
            <div className="artifact-list">
              <Artifact
                label="ELF"
                value={binary ? `${Math.round(binary.file_size / 1024)} KB` : "—"}
              />
              <Artifact
                label="CFG"
                value={
                  binary
                    ? `${binary.functions} FN · ${binary.blocks} BB · ${binary.calls} CALLS`
                    : "—"
                }
              />
              <Artifact
                label="IMG"
                value={binary ? (binary.cfg_svg ? "Graphviz SVG" : "graph fallback") : "—"}
              />
              <Artifact
                label="ART"
                value={binary ? binary.artifacts_dir : "—"}
              />
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

          <div className="divider" />
          <Section title="RUN HISTORY" />
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

          <div className="divider" />
          <Section title="VERDICT" />
          <div className={`verdict ${verdict.tone}`}>{verdict.text}</div>
          <div className="verdict-sub">
            {isBinary
              ? "elf2tdg artifacts loaded"
              : analysis?.result.ok
                ? "text-first analysis"
                : "waiting for a model"}
          </div>
          <div className="stat-grid">
            <Stat
              label="STATES"
              value={analysis?.result.ok ? String(analysis.result.scg.nodes.length) : "—"}
              tone="accent"
            />
            <Stat
              label="HYPERPERIOD"
              value={
                analysis?.result.ok && (metrics.hyperperiod ?? 0) > 0
                  ? formatNumber(metrics.hyperperiod ?? 0)
                  : "—"
              }
              tone="violet"
            />
            <Stat
              label="MAX WCRT"
              value={analysis?.result.ok ? formatNumber(maxWcrt) : "—"}
              tone="bad"
            />
            <Stat
              label="CORES"
              value={analysis?.result.ok ? String(metrics.cores?.length ?? 0) : "—"}
              tone="warn"
            />
          </div>

          <div className="sidebar-bottom">
            <div className="engine-label" title={cli?.path ?? undefined}>
              <Cpu size={11} />
              <span>{cli ? `PTPN [${engineTag(cli)}] ${cli.path}` : "PTPN NOT FOUND · just engines"}</span>
            </div>
            <div className="engine-label" title={elf2tdg?.path ?? undefined}>
              <Binary size={11} />
              <span>
                {elf2tdg
                  ? `ELF2TDG [${engineTag(elf2tdg)}] ${elf2tdg.path}`
                  : "ELF2TDG NOT FOUND · just engines"}
              </span>
            </div>
            <div className="brand-foot">RT-PN · NATIVE RUST WORKBENCH</div>
          </div>
        </div>
      </aside>

      <main className="workspace">
        {hub || workflow === "none" ? (
          <Hub
            onSpec={() => void openSpecDialog()}
            onBinary={() => void openBinaryDialog()}
            onExample={() => void openExample()}
          />
        ) : (
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
              {doc ? (
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
        )}
      </main>

      <aside className="inspector">
        <div className="inspector-scroll">
          <Section title="ASSUMPTIONS & EVIDENCE" />
          <pre className="assumptions">
            {assumptions || "Run an analysis to populate the assumptions."}
          </pre>
          <div className="divider" />
          <Section title="DETAILS" />
          <div className="detail-title">{detail.title}</div>
          <div className="detail-body">{detail.body}</div>
          <div className="divider" />
          <Section title="RUN LOG" />
          <pre className="run-log">{analysis?.result.logs.join("\n") || binary?.warnings.join("\n") || "(no output)"}</pre>
        </div>
      </aside>

      <footer className="statusbar">
        <span>
          <Activity size={11} /> {status.text}
        </span>
        <span className="status-right">
          {analysis?.result.ok
            ? `${analysis.result.scg.nodes.length} state classes · ${analysis.result.elapsed_ms} ms`
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
  onExample,
}: {
  onSpec: () => void;
  onBinary: () => void;
  onExample: () => void;
}) {
  return (
    <div className="hub">
      <div className="hub-head">
        <div className="hub-eyebrow">NEW WORKSPACE</div>
        <h1>Choose a workflow</h1>
        <p>
          Text is the primary surface. The analysis pipeline is shared; only the
          intake contract differs.
        </p>
      </div>
      <div className="hub-cards">
        <div className="hub-card">
          <div className="hub-kicker">01 / MODEL FIRST</div>
          <h2 className="accent">SPECIFICATION-FIRST</h2>
          <p>
            Author or open RTSL, TDG JSON or PTPN. Priorities, cores and timing
            intervals are explicit.
          </p>
          <div className="hub-spacer" />
          <button className="btn primary wide" onClick={onSpec}>
            <FolderOpen size={13} /> OPEN SPECIFICATION
          </button>
        </div>
        <div className="hub-card">
          <div className="hub-kicker">02 / CODE FIRST</div>
          <h2 className="violet">BINARY-FIRST</h2>
          <p>
            Import an ELF: elf2tdg renders a readable ELF layout, then a readable
            CFG and a Graphviz preview image. Threads/net analysis is pending.
          </p>
          <div className="hub-spacer" />
          <button className="btn violet wide" onClick={onBinary}>
            <Binary size={13} /> IMPORT ELF
          </button>
        </div>
      </div>
      <div className="hub-foot">
        <button className="btn" onClick={onExample}>
          <Braces size={13} /> LOAD HW EXAMPLE
        </button>
        <span>Threads/net analysis is pending; ELF and CFG views come from elf2tdg.</span>
      </div>
    </div>
  );
}


