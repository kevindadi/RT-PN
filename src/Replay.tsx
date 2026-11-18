import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import { writeTextFile } from "./api";
import { buildReplayHtml, type ReplayExport } from "./replayExport";
import type { StateGraph, TraceStep } from "./types";

interface ReplayStep {
  state: string;
  transition: string;
  marking: string;
  active: string;
  suspended: string;
  elapsed: string;
}

function parseMarking(text: string): Array<{ name: string; tokens: number }> {
  const inner = text.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner || inner === "empty") return [];
  const counts = new Map<string, number>();
  for (const entry of inner.split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = entry.match(/^(.*?)(?:\((\d+)\))?$/);
    const name = (match?.[1] ?? entry).trim();
    const tokens = match?.[2] ? Number(match[2]) : 1;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + tokens);
  }
  return [...counts.entries()].map(([name, tokens]) => ({ name, tokens }));
}

function parseEntries(text: string): string[] {
  if (!text || text.trim() === "(none)") return [];
  const entries: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      if (current.trim()) entries.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function traceToSteps(trace: TraceStep[]): ReplayStep[] {
  return trace.map((step) => ({
    state: step.state,
    transition: step.transition,
    marking: step.marking,
    active: step.active,
    suspended: "",
    elapsed: step.elapsed,
  }));
}

function shortestPath(scg: StateGraph, targetPosition: number): ReplayStep[] | null {
  const count = scg.nodes.length;
  if (count === 0) return null;
  const startPosition = Math.max(
    scg.nodes.findIndex((node) => node.index === 0),
    0,
  );
  const target = Math.min(Math.max(targetPosition, 0), count - 1);
  const adjacency: Array<Array<{ to: number; label: string }>> = Array.from(
    { length: count },
    () => [],
  );
  for (const edge of scg.edges) {
    if (edge.from < count && edge.to < count) {
      adjacency[edge.from].push({ to: edge.to, label: edge.label });
    }
  }
  const parent: Array<{ from: number; label: string } | null> = Array(count).fill(null);
  const visited = Array(count).fill(false);
  const queue: number[] = [startPosition];
  visited[startPosition] = true;
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (current === target) break;
    for (const edge of adjacency[current]) {
      if (!visited[edge.to]) {
        visited[edge.to] = true;
        parent[edge.to] = { from: current, label: edge.label };
        queue.push(edge.to);
      }
    }
  }
  if (!visited[target]) return null;
  const path: number[] = [];
  let cursor = target;
  while (true) {
    path.push(cursor);
    if (cursor === startPosition) break;
    const previous = parent[cursor];
    if (!previous) return null;
    cursor = previous.from;
  }
  path.reverse();
  return path.map((position, offset) => {
    const node = scg.nodes[position];
    return {
      state: node.id,
      transition: offset === 0 ? "" : (parent[position]?.label ?? ""),
      marking: node.marking,
      active: node.active,
      suspended: node.suspended,
      elapsed: node.elapsed,
    };
  });
}

export function ScgReplay({
  scg,
  trace,
  modelLabel,
  policy,
  tie,
}: {
  scg: StateGraph;
  trace: TraceStep[] | null;
  modelLabel?: string;
  policy?: string;
  tie?: string;
}) {
  const hasTrace = Boolean(trace && trace.length > 0);
  const [target, setTarget] = useState(Math.max(scg.nodes.length - 1, 0));
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState("");

  useEffect(() => {
    setTarget(Math.max(scg.nodes.length - 1, 0));
  }, [scg]);

  const steps = useMemo<ReplayStep[]>(() => {
    if (hasTrace && trace) return traceToSteps(trace);
    return shortestPath(scg, target) ?? [];
  }, [hasTrace, scg, target, trace]);

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [steps]);

  useEffect(() => {
    if (!playing || steps.length === 0) return;
    if (index >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => setIndex((current) => Math.min(current + 1, steps.length - 1)),
      900 / speed,
    );
    return () => window.clearTimeout(timer);
  }, [playing, index, steps.length, speed]);

  if (steps.length === 0) {
    return (
      <div className="replay-empty">
        <div className="sem-eyebrow">SCG REPLAY</div>
        <p>No transition path is available for this state-class graph.</p>
      </div>
    );
  }

  const current = steps[index];
  const notches = parseMarking(current.marking);
  const previous = index > 0 ? parseMarking(steps[index - 1].marking) : [];
  const previousCounts = new Map(previous.map((place) => [place.name, place.tokens]));
  const active = parseEntries(current.active);
  const suspended = parseEntries(current.suspended);
  const last = steps.length - 1;

  const replayPayload = (): ReplayExport => ({
    version: 1,
    model: modelLabel || "model",
    policy: policy || "unknown",
    tie: tie || "fifo",
    mode: hasTrace ? "deadlock counterexample" : "shortest path",
    generatedAt: new Date().toISOString(),
    stepCount: steps.length,
    steps: steps.map((step) => ({
      state: step.state,
      transition: step.transition,
      marking: step.marking,
      active: step.active,
      suspended: step.suspended,
      elapsed: step.elapsed,
    })),
  });

  const exportReplay = async (format: "html" | "json") => {
    setExporting(true);
    setExportNote("");
    try {
      const payload = replayPayload();
      const base =
        (modelLabel || "replay")
          .replace(/[^A-Za-z0-9._-]+/g, "_")
          .replace(/^_+|_+$/g, "") || "replay";
      const target = await save({
        defaultPath: `${base}.replay.${format}`,
        filters: [
          {
            name: format === "html" ? "Self-contained replay" : "Replay JSON",
            extensions: [format],
          },
        ],
      });
      if (!target) return;
      await writeTextFile(
        target,
        format === "html" ? buildReplayHtml(payload) : JSON.stringify(payload, null, 2),
      );
      setExportNote(`saved · ${target}`);
    } catch (reason) {
      setExportNote(String(reason));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="replay">
      <header className="replay-hero">
        <div className="sem-eyebrow">SCG REPLAY</div>
        <h2 className="semantics-title">State-class evolution</h2>
        <div className="semantics-badges">
          <span className="sem-badge">
            {hasTrace ? "deadlock counterexample" : "shortest path"}
          </span>
          <span className="sem-badge">{steps.length} transitions</span>
          <span className="sem-badge math">start {steps[0].state}</span>
          <span className="sem-badge math">target {steps[last].state}</span>
        </div>
        <div className="replay-export-row">
          <button
            className="btn small"
            disabled={exporting}
            onClick={() => void exportReplay("html")}
          >
            EXPORT HTML
          </button>
          <button
            className="btn small"
            disabled={exporting}
            onClick={() => void exportReplay("json")}
          >
            EXPORT JSON
          </button>
          {exportNote && <span className="replay-note">{exportNote}</span>}
        </div>
      </header>

      <div className="replay-controls">
        <button className="btn small" onClick={() => { setIndex(0); setPlaying(false); }} title="reset">
          ⏮
        </button>
        <button
          className="btn small"
          disabled={index === 0}
          onClick={() => { setPlaying(false); setIndex((current) => Math.max(0, current - 1)); }}
        >
          ◀
        </button>
        <button
          className="btn small accent"
          onClick={() => setPlaying((current) => !current)}
        >
          {playing ? "PAUSE" : "PLAY"}
        </button>
        <button
          className="btn small"
          disabled={index === last}
          onClick={() => { setPlaying(false); setIndex((current) => Math.min(last, current + 1)); }}
        >
          ▶
        </button>
        <button
          className="btn small"
          disabled={index === last}
          onClick={() => { setPlaying(false); setIndex(last); }}
        >
          ⏭
        </button>
        <input
          className="replay-range"
          type="range"
          min={0}
          max={last}
          value={index}
          onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }}
        />
        <span className="mono replay-counter">
          {index + 1} / {steps.length}
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
        {!hasTrace && (
          <select
            className="replay-select"
            value={target}
            title="target state class"
            onChange={(event) => setTarget(Number(event.target.value))}
          >
            {scg.nodes.map((node, position) => (
              <option key={node.id} value={position}>
                {node.id} · {node.marking}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="replay-stage">
        <section className="replay-panel">
          <h3>MARKING · M</h3>
          <div className="replay-marking">
            {notches.length === 0 && <div className="faint">[empty]</div>}
            {notches.map((place) => {
              const wasMarked = (previousCounts.get(place.name) ?? 0) > 0;
              return (
                <div className={`replay-place ${wasMarked ? "" : "added"}`} key={place.name}>
                  <span className="replay-place-name">{place.name}</span>
                  <span className="replay-tokens">
                    {Array.from({ length: Math.min(place.tokens, 6) }, (_, slot) => (
                      <i className="replay-token" key={slot} />
                    ))}
                    {place.tokens > 6 && <em>+{place.tokens - 6}</em>}
                  </span>
                  <span className="replay-count">×{place.tokens}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="replay-panel">
          <h3>SELECTED ACTIVE SET · E_pri</h3>
          <div className="replay-chips">
            {active.length === 0 && <div className="faint">(none)</div>}
            {active.map((entry) => (
              <span className="replay-chip" key={entry}>
                {entry}
              </span>
            ))}
          </div>
          {suspended.length > 0 && (
            <>
              <h3 className="replay-subhead">SUSPENDED</h3>
              <div className="replay-chips">
                {suspended.map((entry) => (
                  <span className="replay-chip suspended" key={entry}>
                    {entry}
                  </span>
                ))}
              </div>
            </>
          )}
          <div className="replay-meta">
            <div>
              <span className="sem-eyebrow">fired</span>
              <span className="math">{current.transition || "(initial state)"}</span>
            </div>
            <div>
              <span className="sem-eyebrow">elapsed</span>
              <span className="math">t = {current.elapsed || "0"}</span>
            </div>
            <div>
              <span className="sem-eyebrow">state class</span>
              <span className="math">{current.state}</span>
            </div>
          </div>
        </section>
      </div>

      <div className="replay-timeline">
        {steps.map((step, position) => (
          <button
            key={`${step.state}-${position}`}
            className={`replay-step ${position === index ? "active" : ""} ${position < index ? "past" : ""}`}
            onClick={() => { setPlaying(false); setIndex(position); }}
            title={step.transition || "initial state"}
          >
            <span>{step.state}</span>
            <small>{step.transition || "init"}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
