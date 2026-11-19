import { ArrowRight, CircleAlert, CircleCheck, Clock3 } from "lucide-react";

import type { AnalysisPayload } from "./types";

export interface SchedulingMetrics {
  schedulable?: boolean | null;
  exact?: boolean;
  truncated?: boolean;
  horizon?: { truncated?: boolean; deadlock_analysis_certified?: boolean };
  deadlock_states?: number[];
  tasks?: Array<{
    name?: string;
    core?: number;
    deadline?: number;
    wcrt?: number | null;
    wcrt_lb?: number | null;
    wcrt_exact?: boolean;
    wcrt_capped?: boolean;
    slack?: number | null;
    observed?: boolean;
    verdict?: string;
    deadline_missed?: boolean;
  }>;
}

export function schedulingMetrics(payload: AnalysisPayload | null): SchedulingMetrics {
  return (payload?.result.metrics ?? {}) as SchedulingMetrics;
}

export function schedulingOutcome(payload: AnalysisPayload) {
  const { result } = payload;
  const metrics = schedulingMetrics(payload);
  const partial = Boolean(result.partial || metrics.truncated || metrics.horizon?.truncated);
  const deadlocks = Array.isArray(metrics.deadlock_states) ? metrics.deadlock_states.length : 0;
  const certified =
    result.ok && result.scg.valid && !partial && metrics.exact === true &&
    metrics.horizon?.deadlock_analysis_certified !== false && Array.isArray(metrics.deadlock_states);
  return { metrics, partial, deadlocks, certified };
}

const number = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 3 })
    : "-";

export function SchedulingResults({
  payload,
  onReplay,
  onStateSpace,
  onConfigure,
}: {
  payload: AnalysisPayload;
  onReplay: () => void;
  onStateSpace: () => void;
  onConfigure: () => void;
}) {
  const { result } = payload;
  const { metrics, partial, deadlocks, certified } = schedulingOutcome(payload);

  if (!result.ok) {
    return (
      <div className="wb-document">
        <section className="wb-notice wb-notice-warning">
          <CircleAlert aria-hidden="true" size={21} />
          <div>
            <h2>{result.canceled ? "Verification canceled" : "Verification could not finish"}</h2>
            <pre>{result.error}</pre>
          </div>
        </section>
      </div>
    );
  }

  const hasTrace = Boolean(payload.deadlock_trace?.length);
  const headline = hasTrace || (certified && deadlocks > 0)
    ? "Reachable deadlock found"
    : certified ? "No reachable deadlock found" : "Deadlock status inconclusive";
  const description = hasTrace
    ? "Follow the transition sequence from the initial state to a deadlock."
    : certified
      ? `Exploration completed with ${number(result.scg.nodes.length)} state classes.`
      : deadlocks > 0
        ? "The explored graph contains candidate deadlock states. No counterexample could be reconstructed."
        : "No deadlock was found in the explored state space. The available result leaves the overall status open.";
  const Icon = hasTrace || !certified || deadlocks > 0 ? CircleAlert : CircleCheck;
  const noticeTone = hasTrace || (certified && deadlocks > 0) ? "danger" : certified ? "success" : "warning";
  const deadlineMisses = metrics.tasks?.filter((task) => task.deadline_missed).length;
  const { task_count: taskCount, known_core: knownCore, known_priority: knownPriority } = payload.docs;
  const incompleteInputs = taskCount > 0 && (knownCore < taskCount || knownPriority < taskCount);

  return (
    <div className="wb-document">
      <section className={`wb-notice wb-notice-${noticeTone}`}>
        <Icon size={22} aria-hidden="true" />
        <div><h2>{headline}</h2><p>{description}</p></div>
        {hasTrace
          ? <button className="wb-button" onClick={onReplay}>Replay counterexample <ArrowRight size={15} /></button>
          : result.scg.nodes.length > 0 && <button className="wb-button" onClick={onStateSpace}>View state space <ArrowRight size={15} /></button>}
      </section>
      {partial && (
        <section className="wb-notice wb-notice-warning">
          <Clock3 size={20} aria-hidden="true" />
          <div><h2>Exploration incomplete</h2><p>Search limits stopped this run. Review the scope and timing bounds before drawing conclusions.</p></div>
          <button className="wb-button" onClick={onConfigure}>Review configuration</button>
        </section>
      )}
      {incompleteInputs && (
        <details className="wb-panel wb-disclosure">
          <summary>Review task assignment assumptions</summary>
          <p className="wb-muted">The input specifies a core for {knownCore} of {taskCount} tasks and a priority for {knownPriority} of {taskCount} tasks.</p>
          <pre className="wb-assumptions">{payload.docs.assumptions}</pre>
        </details>
      )}
      <dl className="wb-facts">
        <div><dt>State classes</dt><dd>{number(result.scg.nodes.length)}</dd></div>
        <div><dt>Proven deadline misses</dt><dd>{number(deadlineMisses)}</dd></div>
        <div><dt>Analysis duration</dt><dd>{number(result.elapsed_ms)} <small>ms</small></dd></div>
      </dl>
      <section className="wb-panel">
        <h2>Task timing</h2>
        <p className="wb-muted">Worst-case response time (WCRT) and deadline slack in model time units.</p>
        {metrics.tasks?.length ? (
          <div className="wb-table-scroll">
            <table className="wb-table">
              <thead><tr><th>Task</th><th>Core</th><th>WCRT</th><th>Deadline</th><th>Slack</th><th>Deadline status</th></tr></thead>
              <tbody>
                {metrics.tasks.map((task, index) => (
                  <tr key={`${task.name}-${index}`}>
                    <th scope="row">{task.name ?? "Unnamed task"}</th>
                    <td>{number(task.core)}</td>
                    <td>
                      {task.observed === false
                        ? "Unobserved"
                        : typeof task.wcrt === "number"
                          ? <>{number(task.wcrt)} <small>{task.wcrt_capped ? "Capped" : task.wcrt_exact ? "Exact" : "Bound"}</small></>
                          : task.wcrt_lb != null ? `At least ${number(task.wcrt_lb)}` : "-"}
                    </td>
                    <td>{task.deadline && task.deadline > 0 ? number(task.deadline) : "-"}</td>
                    <td>{task.observed === false ? "-" : number(task.slack)}</td>
                    <td className={task.deadline_missed ? "wb-error-text" : undefined}>
                      {task.deadline_missed ? "Missed" : task.verdict?.replace(/_/g, " ") || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="wb-muted">This run returned no per-task timing results.</p>}
      </section>
    </div>
  );
}
