export function WorkflowGuide({
  onClose,
  initial = "binary",
}: {
  onClose: () => void;
  initial?: "spec" | "binary";
}) {
  return (
    <div className="guide-overlay" onClick={onClose}>
      <div className="guide-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="guide-head">
          <div>
            <div className="sem-eyebrow">WORKBENCH GUIDE</div>
            <h2>How to use RT-PN</h2>
            <div className="faint">
              Two independent workflows: scheduling analysis (RTSL/TDG → PTPN) and
              binary analysis (ELF → CFG → static timing). Pick one on the start
              screen; switch any time from NEW WORKSPACE.
            </div>
          </div>
          <button className="btn small" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div className="guide-grid">
          <section className="guide-section binary">
            <h3>Binary analysis (ELF → CFG → timing)</h3>
            <ol className="guide-steps">
              <li>
                <b>Import an ELF</b> with IMPORT ELF, or load the bundled sample
                with SAMPLE / ELF EXAMPLE.
              </li>
              <li>
                Open <b>ANALYSIS PROFILE</b> in the sidebar and confirm the detected
                architecture preset (CPU model + frequency); add a board profile
                for caches/branch/WCET, then RUN WITH PROFILE.
              </li>
              <li>
                Read <b>OVERVIEW</b> (image, timing model, hot functions) and{" "}
                <b>ELF LAYOUT</b> (text; PREVIEW opens the rendered layout image).
              </li>
              <li>
                Use <b>FUNCTIONS</b> or the sidebar ROOTS &amp; CONCURRENCY list to
                pick a function; <b>CFG</b> shows GRAPH / TEXT / MMD views and an
                instruction inspector.
              </li>
              <li>
                <b>ANALYSIS</b> shows WCET roots, caches, branch prediction and
                data-memory results; open a WCET root's CFG to highlight its
                longest path, edit the board profile TOML, compare two profiles
                A/B and export MD/JSON reports.
              </li>
            </ol>
          </section>
          <section className="guide-section">
            <h3>Scheduling analysis (RTSL / TDG → PTPN → SCG)</h3>
            <ol className="guide-steps">
              <li>
                <b>Open a model</b> (RTSL/TDG) or load the sample from the start
                screen; the analysis runs automatically.
              </li>
              <li>
                Pick a <b>scheduling policy</b> and tie mode in RUN CONTROL, adjust
                the state/time/memory budget, and RE-RUN.
              </li>
              <li>
                Inspect <b>DAG / PTPN / STATE SPACE</b> stages and the SEMANTICS page
                for the formal state and firing rules.
              </li>
              <li>
                Use <b>REPLAY</b> to walk a real state-class path, COMPARE POLICIES
                for a cross-policy sweep, and check WCRT/SLACK, deadlock
                counterexamples, core allocation and pending timing tools.
              </li>
              <li>
                Export the run (MD/JSON), save a <b>.rtpn project</b>, or open RUN
                HISTORY to compare runs.
              </li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
