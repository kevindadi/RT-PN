import type { StateGraph, TraceStep } from "./types";

export interface ReplayStep {
  state: string;
  transition: string;
  marking: string;
  active: string;
  suspended: string;
  elapsed: string;
}

export function parseMarking(text: string): Array<{ name: string; tokens: number }> {
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

export function parseEntries(text: string): string[] {
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

export function traceToSteps(trace: TraceStep[]): ReplayStep[] {
  return trace.map((step) => ({
    state: step.state,
    transition: step.transition,
    marking: step.marking,
    active: step.active,
    suspended: "",
    elapsed: step.elapsed,
  }));
}

export function shortestPath(scg: StateGraph, targetPosition: number): ReplayStep[] | null {
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

/** Replay path for an analysis result: deadlock trace when present, otherwise
 * the shortest path to the last explored state class. */
export function stepsFor(
  scg: StateGraph,
  trace: TraceStep[] | null,
  target?: number,
): ReplayStep[] {
  if (trace && trace.length > 0) return traceToSteps(trace);
  return shortestPath(scg, target ?? Math.max(scg.nodes.length - 1, 0)) ?? [];
}
