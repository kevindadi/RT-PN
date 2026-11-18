import { useEffect, useState } from "react";

import type { SweepEntry } from "./types";

export interface SchedulingPolicy {
  id: string;
  label: string;
  family: string;
  orderRule: string;
  clocks: string;
  extraState: string[];
  firing: string[];
  locks: string;
  restrictions: string;
  tieSensitive: boolean;
}

export const SCHEDULING_POLICIES: SchedulingPolicy[] = [
  {
    id: "fixed",
    label: "Fixed priority",
    family: "static priority",
    orderRule: "E_pri = { t ∈ E_struct | priority(t) is maximal }",
    clocks: "x0, h_t (execution), w_t (suspension; projected out by default)",
    extraState: [],
    firing: [
      "Native fixed-priority analysis with resume-style preemption.",
      "Equal priorities are resolved by the tie mode (fifo or arbitrary).",
    ],
    locks:
      "mutex critical sections may suspend: h_t is frozen, w_t runs; spin critical sections are non-suspendable.",
    restrictions: "one in-flight job per task.",
    tieSensitive: true,
  },
  {
    id: "fixed_prior_with_resume",
    label: "Fixed priority · resume preemption",
    family: "static priority",
    orderRule: "E_pri = { t ∈ E_struct | priority(t) is maximal }",
    clocks: "x0, h_t, w_t (suspension projected out by default)",
    extraState: [],
    firing: [
      "Engine-native preemption: a higher-priority enabled transition preempts the running one.",
      "The preempted execution clock h_t is frozen and resumed without losing work.",
    ],
    locks: "mutex owners may suspend; PIP/PCP/SRP-style inheritance applies only when the lock protocol is selected.",
    restrictions: "one in-flight job per task; recommended for native analysis.",
    tieSensitive: true,
  },
  {
    id: "fixed_prior_with_restart",
    label: "Fixed priority · restart preemption",
    family: "static priority",
    orderRule: "E_pri = { t ∈ E_struct | priority(t) is maximal }",
    clocks: "x0, h_t (reset on preemption)",
    extraState: [],
    firing: [
      "Structural restart preemption: the preempted segment is discarded and re-executed from its start.",
      "The lowering emits an explicit restart structure, so no frozen clock is kept.",
    ],
    locks: "restart applies to the preempted execution segment, not across a held mutex.",
    restrictions: "one in-flight job per task.",
    tieSensitive: true,
  },
  {
    id: "rm",
    label: "Rate monotonic",
    family: "static priority (derived)",
    orderRule: "priority(t) = ordered by period p_t (shorter p_t → higher priority)",
    clocks: "x0, h_t, w_t",
    extraState: [],
    firing: [
      "Priorities are recomputed at lowering; the firing rule is the resume-style fixed-priority rule.",
      "The model's declared priority field is ignored.",
    ],
    locks: "fixed-priority suspension semantics.",
    restrictions: "periodic or start-bound tasks carry the period used by the assignment.",
    tieSensitive: true,
  },
  {
    id: "dm",
    label: "Deadline monotonic",
    family: "static priority (derived)",
    orderRule: "priority(t) = ordered by relative deadline D_t (shorter D_t → higher priority)",
    clocks: "x0, h_t, w_t",
    extraState: [],
    firing: [
      "Priorities are recomputed at lowering; resume-style fixed-priority firing.",
      "The model's declared priority field is ignored.",
    ],
    locks: "fixed-priority suspension semantics.",
    restrictions: "every task needs a deadline for the assignment.",
    tieSensitive: true,
  },
  {
    id: "pip",
    label: "Priority inheritance (PIP)",
    family: "static priority + lock protocol",
    orderRule: "effective priority(t) = max(own priority, max priority of tasks blocked by t)",
    clocks: "x0, h_t, w_t",
    extraState: ["lock ownership L(m) ⊆ T derived from the marking"],
    firing: [
      "Lock owners inherit the priority of the blocked tasks; E_pri is computed from effective priorities.",
      "Firing re-derives ownership and the effective priorities of the new state class.",
    ],
    locks: "mutex only; spin sections stay non-suspendable. Requires task_place_capacity = 1.",
    restrictions: "one in-flight job per task; protocol is defined on the uniprocessor case.",
    tieSensitive: true,
  },
  {
    id: "pcp",
    label: "Priority ceiling (PCP)",
    family: "static priority + lock protocol",
    orderRule: "admission: priority(t) > system ceiling Γ; effective priority = max(own, inherited)",
    clocks: "x0, h_t, w_t",
    extraState: ["static lock ceilings", "system ceiling Γ = max ceiling of locked resources"],
    firing: [
      "Ceiling-based admission gates which structurally enabled transitions may run.",
      "Transitive inheritance raises the owner priority; canonicalization keeps the zone exact.",
    ],
    locks: "mutex only, task_place_capacity = 1, one in-flight job per task.",
    restrictions: "classical protocol is uniprocessor; multi-core support is guarded.",
    tieSensitive: true,
  },
  {
    id: "srp",
    label: "Stack resource policy (SRP)",
    family: "static priority + lock protocol",
    orderRule: "start gate: fire only if priority(t) > Γ; no priority inheritance",
    clocks: "x0, h_t, w_t",
    extraState: ["static lock ceilings", "global system ceiling Γ"],
    firing: [
      "No owner priority inflation: admission is controlled solely by the system-ceiling gate.",
      "Scheduling decisions branch on the admissible selected active set.",
    ],
    locks: "mutex only, task_place_capacity = 1, one in-flight job per task.",
    restrictions: "classical protocol is uniprocessor; multi-core support is guarded.",
    tieSensitive: true,
  },
  {
    id: "edf",
    label: "Earliest deadline first (job-clock EDF)",
    family: "dynamic priority (job-clock)",
    orderRule: "E_pri = { t ∈ E_struct | absolute deadline d_t is minimal among released jobs }",
    clocks: "x0, r_i (per-job release), h_t, w_t; clock layout includes release clocks",
    extraState: ["one in-flight job per task", "per-job release clock r_i"],
    firing: [
      "Time elapse observes r_i; firing selects the branch with the earliest absolute deadline.",
      "Tied deadlines are enumerated as separate scheduling branches.",
    ],
    locks: "unsupported: EDF models must not use locks.",
    restrictions:
      "statically partitioned multi-core: cores_per_cpu = 1, one in-flight job/task, no locks, no dependency-driven releases; positive explicit/implicit deadline required.",
    tieSensitive: true,
  },
  {
    id: "fifo",
    label: "FIFO (arrival order)",
    family: "dynamic priority (job-clock)",
    orderRule: "E_pri = { t ∈ E_struct | r_t is minimal (earliest release) }",
    clocks: "x0, r_i (per-job release), h_t, w_t",
    extraState: ["per-job release clock r_i"],
    firing: [
      "Non-preemptive FIFO: arrival-order branches per core; the running job keeps the core.",
      "Time elapse and firing are ordered by the release clocks.",
    ],
    locks: "unsupported: FIFO models must not use locks.",
    restrictions:
      "statically partitioned multi-core: cores_per_cpu = 1, one in-flight job/task, no locks or dependency-driven releases.",
    tieSensitive: true,
  },
  {
    id: "llf",
    label: "Least laxity first (event-driven)",
    family: "dynamic priority (laxity clock)",
    orderRule: "E_pri = { t ∈ E_struct | laxity χ_t = D_t − now − remaining_work_t is minimal }",
    clocks: "x0, χ_i (laxity), h_t; deterministic segments only",
    extraState: ["laxity clocks χ_i", "deterministic (zero-width) execution segments"],
    firing: [
      "Event-driven LLF: priority is recomputed from the laxity clock at each event.",
      "This is not classical continuous-time LLF; segments must be deterministic.",
    ],
    locks: "unsupported: LLF models must not use locks.",
    restrictions:
      "statically partitioned multi-core: cores_per_core = 1, one in-flight job/task, no locks or dependency-driven releases; deterministic segments required.",
    tieSensitive: true,
  },
];

export function policyById(id: string): SchedulingPolicy {
  return SCHEDULING_POLICIES.find((policy) => policy.id === id) ?? SCHEDULING_POLICIES[1];
}

const PHASES = [
  "time elapse",
  "structural enabling (E_struct)",
  "priority filter (E_pri)",
  "fire transition",
  "canonicalize zone",
];

function SemanticsAnimation({ policy }: { policy: SchedulingPolicy }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setPhase((current) => (current + 1) % PHASES.length);
    }, 1800);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setPhase(0), [policy.id]);

  const enabled = phase >= 1;
  const filtered = phase >= 2;
  const fired = phase >= 3;
  const canonical = phase >= 4;

  return (
    <section className="sem-anim">
      <div className="sem-anim-head">
        <span className="sem-eyebrow">LIVE FIRING RULE</span>
        <span className="sem-phase">
          <i className={`sem-dot ${enabled ? "on" : ""}`} />
          {PHASES[phase]}
        </span>
      </div>
      <div className="sem-net">
        <div className={`sem-place ${enabled ? "lit" : ""}`}>
          <span className="sem-place-name">p_ready</span>
          {!fired && <span className="sem-token" />}
        </div>
        <div className="sem-arrow" />
        <div className={`sem-transition ${enabled ? "E_struct" : ""} ${filtered ? "E_pri" : ""}`}>
          <span>t_exec</span>
          <small>{policy.family.includes("dynamic") ? "clock key" : "priority"}</small>
        </div>
        <div className="sem-arrow" />
        <div className={`sem-place ${fired ? "lit" : ""}`}>
          <span className="sem-place-name">p_run</span>
          {fired && <span className="sem-token running" />}
        </div>
        <div className="sem-arrow" />
        <div className={`sem-transition ${canonical ? "canon" : ""}`}>
          <span>t_done</span>
          <small>fire</small>
        </div>
        <div className="sem-arrow" />
        <div className={`sem-place ${canonical ? "lit" : ""}`}>
          <span className="sem-place-name">p_done</span>
          {canonical && <span className="sem-token done" />}
        </div>
      </div>
      <div className="sem-anim-meta">
        <div>
          <span className="sem-eyebrow">E_pri rule</span>
          <span className="math sem-rule-inline">{policy.orderRule}</span>
        </div>
        <div>
          <span className="sem-eyebrow">clocks</span>
          <span className="math sem-rule-inline">{policy.clocks}</span>
        </div>
      </div>
      <div className="sem-zone" data-canonical={canonical || undefined}>
        <span>Z</span>
        <span className="math">x0 − x0 ≤ 0 · h_t ∈ [l, u] · r_i ≤ D_i</span>
      </div>
    </section>
  );
}

export function SemanticsStage({
  policy,
  tie,
  describeText,
  describeBusy,
  onRefreshDescription,
  sweep,
  sweepBusy,
  sweepProgress,
  sweepBudget,
  canSweep,
  onRunSweep,
}: {
  policy: SchedulingPolicy;
  tie: string;
  describeText: string;
  describeBusy: boolean;
  onRefreshDescription: () => void;
  sweep: SweepEntry[];
  sweepBusy: boolean;
  sweepProgress: { done: number; total: number };
  sweepBudget: { maxStates: number; timeoutSecs: number };
  canSweep: boolean;
  onRunSweep: () => void;
}) {
  return (
    <div className="semantics">
      <header className="semantics-hero">
        <div className="sem-eyebrow">FORMAL SCHEDULING SEMANTICS</div>
        <h2 className="semantics-title">{policy.label}</h2>
        <div className="semantics-badges">
          <span className="sem-badge">{policy.family}</span>
          <span className="sem-badge math">{policy.id}</span>
          {policy.tieSensitive && <span className="sem-badge">tie-sensitive</span>}
        </div>
        <p className="semantics-lede">
          The analyzer explores the state-class reachability graph of the lowered PTPN and
          branches on every admissible scheduling decision of the selected policy.
        </p>
      </header>

      <div className="semantics-grid">
        <article className="sem-card">
          <h3>STATE</h3>
          <div className="sem-formula math">S = (M, Z, E_struct, E_pri, Susp)</div>
          <p>
            <span className="math">M</span> is the marking, <span className="math">Z</span> the
            canonical DBM clock zone; <span className="math">E_pri ⊆ E_struct</span> is the
            selected active set and <span className="math">Susp</span> the suspended
            transitions.
          </p>
          <ul>
            {policy.extraState.map((item) => (
              <li key={item}>{item}</li>
            ))}
            <li>branching on each admissible selected active set (and tie ordering)</li>
          </ul>
        </article>

        <article className="sem-card">
          <h3>TIME ELAPSE</h3>
          <div className="sem-formula math">delay δ ≥ 0; Z′ = Z ↑ δ; M unchanged</div>
          <p>
            Time may advance while no enabled transition becomes disabled. Frozen execution
            clocks of suspended transitions do not advance; their suspension clocks do.
          </p>
        </article>

        <article className="sem-card">
          <h3>PRIORITY FILTER</h3>
          <div className="sem-formula math">
            E_pri = filter_{policy.id}(E_struct, M, Z)
          </div>
          <p>{policy.orderRule}</p>
        </article>

        <article className="sem-card">
          <h3>FIRE</h3>
          <div className="sem-formula math">
            t ∈ E_pri; M′ = M − •t + t•; clocks of t reset
          </div>
          <ul>
            {policy.firing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <article className="sem-card wide">
          <h3>PREEMPTION, LOCKS AND CLOCKS</h3>
          <p>{policy.locks}</p>
          <p className="sem-mono">{policy.clocks}</p>
        </article>

        <article className="sem-card wide">
          <h3>RESTRICTIONS</h3>
          <p>{policy.restrictions}</p>
        </article>
      </div>

      <SemanticsAnimation policy={policy} />

      <section className="sem-sweep">
        <div className="sem-sweep-head">
          <div>
            <div className="sem-eyebrow">POLICY SWEEP</div>
            <h3>Cross-policy comparison</h3>
          </div>
          <button
            className="btn small accent"
            disabled={!canSweep || sweepBusy}
            onClick={onRunSweep}
          >
            {sweepBusy
              ? `RUNNING ${sweepProgress.done}/${sweepProgress.total}`
              : "RUN SWEEP"}
          </button>
        </div>
        <p className="sem-sweep-note">
          Runs the loaded model once per policy with the current tie mode
          <span className="math"> {tie}</span>, bounded to{" "}
          <span className="math">{sweepBudget.maxStates.toLocaleString()}</span> states and{" "}
          <span className="math">{sweepBudget.timeoutSecs || "∞"} s</span> per policy. The
          selected policy above is not changed.
        </p>
        {sweep.length === 0 ? (
          <div className="faint">
            {sweepBusy ? "sweeping policies…" : "run a sweep to compare verdicts, WCRT and state counts"}
          </div>
        ) : (
          <table className="sem-sweep-table">
            <thead>
              <tr>
                <th align="left">policy</th>
                <th align="left">verdict</th>
                <th align="right">max wcrt</th>
                <th align="right">states</th>
                <th align="right">deadlocks</th>
                <th align="right">elapsed</th>
              </tr>
            </thead>
            <tbody>
              {sweep.map((entry) => (
                <tr
                  key={entry.policy}
                  className={
                    entry.status === "OK"
                      ? "sweep-ok"
                      : entry.status === "PARTIAL"
                        ? "sweep-warn"
                        : "sweep-bad"
                  }
                  title={entry.error || undefined}
                >
                  <td>{entry.label}</td>
                  <td>{entry.status}</td>
                  <td align="right">{entry.maxWcrt ?? "—"}</td>
                  <td align="right">{entry.states}</td>
                  <td align="right">{entry.deadlocks}</td>
                  <td align="right">{entry.elapsedMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="sem-describe">
        <div className="sem-describe-head">
          <div>
            <div className="sem-eyebrow">MODEL RESTATEMENT</div>
            <h3>ptpn describe</h3>
          </div>
          <button className="btn small" disabled={describeBusy} onClick={onRefreshDescription}>
            {describeBusy ? "RUNNING…" : "REFRESH"}
          </button>
        </div>
        <pre>{describeBusy ? "running ptpn describe…" : describeText || "Analyze an RTSL model to get the model-specific restatement of the effective semantics."}</pre>
      </section>
    </div>
  );
}
