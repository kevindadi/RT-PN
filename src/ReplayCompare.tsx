import { useEffect, useState } from "react";

import { SCHEDULING_POLICIES } from "./Semantics";
import { parseEntries, parseMarking, type ReplayStep } from "./replayModel";

export interface CompareLane {
  policy: string;
  label: string;
  status: string;
  mode: string;
  error: string;
  steps: ReplayStep[];
}

const statusClass = (status: string): string =>
  status === "ERROR"
    ? "cmp-bad"
    : status === "PARTIAL"
      ? "cmp-warn"
      : status === "DEADLOCK"
        ? "cmp-bad"
        : "cmp-ok";

function LaneMarking({ step, previous }: { step: ReplayStep; previous?: ReplayStep }) {
  const places = parseMarking(step.marking);
  const previousCounts = new Map(
    (previous ? parseMarking(previous.marking) : []).map((place) => [place.name, place.tokens]),
  );
  if (places.length === 0) return <div className="faint">[empty]</div>;
  return (
    <div className="cmp-marking">
      {places.map((place) => (
        <span
          className={`cmp-place ${(previousCounts.get(place.name) ?? 0) > 0 ? "" : "added"}`}
          key={place.name}
        >
          <span className="cmp-place-name">{place.name}</span>
          <span className="cmp-tokens">
            {Array.from({ length: Math.min(place.tokens, 4) }, (_, slot) => (
              <i key={slot} />
            ))}
          </span>
          <span className="cmp-count">×{place.tokens}</span>
        </span>
      ))}
    </div>
  );
}

export function ReplayCompare({
  lanes,
  busy,
  progress,
  selected,
  onToggle,
  onRun,
  onClose,
  maxStates,
  timeoutSecs,
  tie,
}: {
  lanes: CompareLane[];
  busy: boolean;
  progress: { done: number; total: number };
  selected: string[];
  onToggle: (policy: string) => void;
  onRun: () => void;
  onClose: () => void;
  maxStates: number;
  timeoutSecs: number;
  tie: string;
}) {
  const maxSteps = Math.max(1, ...lanes.map((lane) => lane.steps.length));
  const last = maxSteps - 1;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [lanes.length]);

  useEffect(() => {
    if (!playing) return;
    if (index >= last) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex((current) => Math.min(current + 1, last)), 950 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, last, speed]);

  return (
    <div className="cmp">
      <header className="cmp-hero">
        <div className="sem-eyebrow">POLICY-AWARE REPLAY</div>
        <h2 className="semantics-title">Same model, different schedulers</h2>
        <div className="semantics-badges">
          <span className="sem-badge">{lanes.length} policies</span>
          <span className="sem-badge">tie {tie}</span>
          <span className="sem-badge">
            bounded {maxStates.toLocaleString()} states · {timeoutSecs || "∞"} s each
          </span>
        </div>
        <div className="replay-export-row">
          <button className="btn small" onClick={onClose}>
            CLOSE COMPARISON
          </button>
        </div>
      </header>

      <div className="cmp-setup">
        <div className="cmp-setup-head">
          <div>
            <div className="sem-eyebrow">POLICIES</div>
            <h3>Choose the schedulers to run side by side</h3>
          </div>
          <button className="btn small accent" disabled={busy || selected.length === 0} onClick={onRun}>
            {busy
              ? `RUNNING ${progress.done}/${progress.total}`
              : `RUN ${selected.length} POLIC${selected.length === 1 ? "Y" : "IES"}`}
          </button>
        </div>
        <div className="cmp-policies">
          {SCHEDULING_POLICIES.map((entry) => (
            <button
              key={entry.id}
              className={`cmp-chip ${selected.includes(entry.id) ? "on" : ""}`}
              disabled={busy}
              onClick={() => onToggle(entry.id)}
              title={entry.family}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="faint">
          Each policy is analyzed independently on the loaded model; a lane replays its deadlock
          counterexample when one exists, otherwise the shortest path to its last explored state
          class. Policies with no replay path (e.g. unsupported class) are reported as errors.
        </div>
      </div>

      {lanes.length === 0 ? (
        <div className="faint" style={{ padding: "18px 4px" }}>
          {busy ? "running the selected policies…" : "select policies and run the comparison"}
        </div>
      ) : (
        <>
          <div className="cmp-controls">
            <button
              className="btn small"
              onClick={() => {
                setPlaying(false);
                setIndex(0);
              }}
            >
              ⏮
            </button>
            <button
              className="btn small"
              disabled={index === 0}
              onClick={() => {
                setPlaying(false);
                setIndex((current) => Math.max(0, current - 1));
              }}
            >
              ◀
            </button>
            <button className="btn small accent" onClick={() => setPlaying((current) => !current)}>
              {playing ? "PAUSE" : "PLAY"}
            </button>
            <button
              className="btn small"
              disabled={index === last}
              onClick={() => {
                setPlaying(false);
                setIndex((current) => Math.min(last, current + 1));
              }}
            >
              ▶
            </button>
            <button
              className="btn small"
              disabled={index === last}
              onClick={() => {
                setPlaying(false);
                setIndex(last);
              }}
            >
              ⏭
            </button>
            <input
              className="replay-range"
              type="range"
              min={0}
              max={last}
              value={index}
              onChange={(event) => {
                setPlaying(false);
                setIndex(Number(event.target.value));
              }}
            />
            <span className="mono replay-counter">
              {index + 1} / {maxSteps}
            </span>
            <select
              className="replay-select"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
            </select>
          </div>

          <div className="cmp-lanes">
            {lanes.map((lane) => {
              const laneIndex = Math.min(index, Math.max(lane.steps.length - 1, 0));
              const step = lane.steps[laneIndex];
              const previous = laneIndex > 0 ? lane.steps[laneIndex - 1] : undefined;
              const active = step ? parseEntries(step.active) : [];
              return (
                <section className="cmp-lane" key={lane.policy}>
                  <div className="cmp-lane-head">
                    <span className="cmp-lane-title">{lane.label}</span>
                    <span className={`cmp-status ${statusClass(lane.status)}`}>{lane.status}</span>
                  </div>
                  <div className="cmp-lane-meta">
                    {lane.mode || (lane.error ? lane.error : "no replay path")}
                  </div>
                  {step ? (
                    <>
                      <div className="cmp-section">
                        <span className="sem-eyebrow">marking</span>
                        <LaneMarking step={step} previous={previous} />
                      </div>
                      <div className="cmp-section">
                        <span className="sem-eyebrow">fired</span>
                        <div className="math cmp-fired">{step.transition || "(initial state)"}</div>
                        <div className="mono cmp-step-meta">
                          {step.state} · t = {step.elapsed || "0"} · step {laneIndex + 1}/
                          {lane.steps.length}
                        </div>
                      </div>
                      <div className="cmp-section">
                        <span className="sem-eyebrow">E_pri</span>
                        <div className="cmp-e_pri">
                          {active.length === 0 && <span className="faint">(none)</span>}
                          {active.slice(0, 4).map((entry) => (
                            <span className="cmp-e_pri-chip" key={entry}>
                              {entry}
                            </span>
                          ))}
                          {active.length > 4 && (
                            <span className="cmp-e_pri-chip">+{active.length - 4}</span>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="faint">no replay path</div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
