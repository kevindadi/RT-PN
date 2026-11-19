import { X } from "lucide-react";

export function WorkflowGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="guide-overlay" onClick={onClose}>
      <div className="guide-dialog wb-guide" role="dialog" aria-modal="true" aria-labelledby="workflow-guide-title" onClick={(event) => event.stopPropagation()}>
        <div className="wb-panel-heading">
          <h2 id="workflow-guide-title">Workflow guide</h2>
          <button className="wb-button wb-icon" onClick={onClose} aria-label="Close guide"><X size={18} /></button>
        </div>
        <div className="guide-grid">
          <section className="wb-panel">
            <h2>Scheduling verification</h2>
            <ol className="guide-steps">
              <li><strong>Open model.</strong> Load an RTSL specification, a TDG JSON model, or a native Petri net.</li>
              <li><strong>Configuration.</strong> Review the scheduler, equal-priority rule, and search limits.</li>
              <li><strong>Run verification.</strong> Read deadlock and deadline outcomes and worst-case response times in Results.</li>
              <li><strong>Evidence.</strong> Replay a counterexample or inspect the Petri net and state space.</li>
            </ol>
          </section>
          <section className="wb-panel">
            <h2>Firmware timing</h2>
            <ol className="guide-steps">
              <li><strong>Open ELF.</strong> Browse the image, sections, and recovered function index.</li>
              <li><strong>Configuration.</strong> Choose a CPU and an optional board profile and frequency.</li>
              <li><strong>Run timing analysis.</strong> Review static timing estimates and available model results.</li>
              <li><strong>Evidence.</strong> Open a function or estimated longest path to inspect its basic blocks and instructions.</li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
