import type { ReactNode } from "react";
import {
  ArrowRight,
  Binary,
  CircuitBoard,
  ClipboardCheck,
  Cpu,
  FileCode2,
  FolderOpen,
  GitBranch,
  Network,
  Route,
  SlidersHorizontal,
  Workflow as WorkflowIcon,
} from "lucide-react";

import type { Stage } from "./types";

export function WorkbenchBrand() {
  return (
    <span className="workbench-brand">
      <span className="workbench-brand-mark"><WorkflowIcon size={18} aria-hidden="true" /></span>
      <span>RT-PN</span>
    </span>
  );
}

export function WorkbenchHome({
  onOpenModel,
  onOpenFirmware,
  onModelExample,
  onFirmwareExample,
  children,
}: {
  onOpenModel: () => void;
  onOpenFirmware: () => void;
  onModelExample: () => void;
  onFirmwareExample: () => void;
  children?: ReactNode;
}) {
  return (
    <main className="workbench-home-content">
      <div className="workbench-home-intro">
        <h1>Real-time systems<br />workbench</h1>
        <p>Verify a scheduling design or investigate the timing of compiled firmware.</p>
      </div>
      <div className="workflow-options">
        <section className="workflow-option workflow-option-model">
          <ol className="workflow-diagram" aria-label="Model, Petri net, then verification">
            <li><span><FileCode2 size={21} /></span><b>Task model</b></li>
            <li><span><Network size={21} /></span><b>Petri net</b></li>
            <li><span><ClipboardCheck size={21} /></span><b>Verification</b></li>
          </ol>
          <div className="workflow-option-content">
            <div>
              <h2>Scheduling verification</h2>
              <p>Check task deadlines and find deadlocks in a model of cores, priorities, dependencies, and locks.</p>
            </div>
            <div className="workflow-option-actions">
              <button className="wb-button wb-primary" onClick={onOpenModel}><FolderOpen size={16} /> Open model</button>
              <button className="wb-button wb-quiet" onClick={onModelExample}>Try model example <ArrowRight size={15} /></button>
            </div>
          </div>
        </section>
        <section className="workflow-option workflow-option-firmware">
          <ol className="workflow-diagram" aria-label="ELF image, control flow, then timing">
            <li><span><Binary size={21} /></span><b>ELF image</b></li>
            <li><span><GitBranch size={21} /></span><b>Control flow</b></li>
            <li><span><Cpu size={21} /></span><b>Static timing</b></li>
          </ol>
          <div className="workflow-option-content">
            <div>
              <h2>Firmware timing</h2>
              <p>Explore control flow from an ELF image and estimate execution costs with a CPU and board model.</p>
            </div>
            <div className="workflow-option-actions">
              <button className="wb-button wb-primary" onClick={onOpenFirmware}><FolderOpen size={16} /> Open ELF</button>
              <button className="wb-button wb-quiet" onClick={onFirmwareExample}>Try firmware example <ArrowRight size={15} /></button>
            </div>
          </div>
        </section>
      </div>
      {children}
    </main>
  );
}

const MODEL_SECTIONS = [
  { label: "Model", icon: FileCode2, stages: ["source", "dag"] },
  { label: "Configuration", icon: SlidersHorizontal, stages: ["configuration"] },
  { label: "Results", icon: ClipboardCheck, stages: ["results", "timeline", "report"] },
  { label: "Evidence", icon: Route, stages: ["replay", "ptpn", "state", "semantics"] },
] as const satisfies ReadonlyArray<{ label: string; icon: typeof FileCode2; stages: readonly Stage[] }>;

const FIRMWARE_SECTIONS = [
  { label: "Firmware", icon: CircuitBoard, stages: ["overview", "elf", "functions"] },
  { label: "Configuration", icon: SlidersHorizontal, stages: ["configuration"] },
  { label: "Results", icon: ClipboardCheck, stages: ["analysis"] },
  { label: "Evidence", icon: Route, stages: ["cfg"] },
] as const satisfies ReadonlyArray<{ label: string; icon: typeof FileCode2; stages: readonly Stage[] }>;

export function workspaceSections(binary: boolean) {
  return binary ? FIRMWARE_SECTIONS : MODEL_SECTIONS;
}

export function WorkbenchNavigation({
  binary,
  activeStage,
  onStageChange,
}: {
  binary: boolean;
  activeStage: Stage;
  onStageChange: (stage: Stage) => void;
}) {
  const sections = workspaceSections(binary);
  return (
    <nav aria-label="Analysis workspace" className="workbench-navigation">
      <div className="workbench-nav-title">{binary ? "Firmware timing" : "Scheduling verification"}</div>
      {sections.map(({ label, icon: Icon, stages }) => {
        const active = (stages as readonly Stage[]).includes(activeStage);
        return (
          <button
            key={label}
            aria-current={active ? "page" : undefined}
            onClick={() => { if (!active) onStageChange(stages[0]); }}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
