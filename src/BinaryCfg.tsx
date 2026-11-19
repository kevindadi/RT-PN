import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import { Mermaid } from "./Mermaid";
import type {
  BinaryCfgBlock,
  BinaryCfgEdge,
  BinaryFunctionCfg,
} from "./types";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function cfgText(cfg: BinaryFunctionCfg): string {
  const lines: string[] = [];
  const source = cfg.source ?? {};
  const instructionCount = cfg.blocks.reduce(
    (sum, block) => sum + (block.instructions?.length ?? 0),
    0,
  );
  lines.push(`${cfg.name || cfg.selector}  @ ${cfg.address || "-"}`);
  lines.push(
    `${cfg.kind || "function"} | ${cfg.language || "-"} | ` +
      `${cfg.blocks.length} blocks | ${cfg.edges.length} edges | ${instructionCount} instructions`,
  );
  const file = str(source.file);
  if (file) lines.push(`source: ${file}:${str(source.line)}`);
  lines.push("", "BLOCKS");
  for (const block of cfg.blocks) {
    const cyclesMin = block.cycles?.min;
    const cyclesMax = block.cycles?.max;
    const cycles =
      cyclesMin === undefined && cyclesMax === undefined
        ? ""
        : `  cycles ${cyclesMin ?? "?"}-${cyclesMax ?? "?"}`;
    lines.push(
      `  ${block.address ?? block.id}  size=${block.size ?? "?"}  ` +
        `${block.terminator ?? "fallthrough"}${cycles}`,
    );
    for (const instruction of block.instructions ?? []) {
      const sourceLocation = instruction.source?.file
        ? `   ; ${instruction.source.file}:${instruction.source.line ?? "?"}`
        : "";
      const text =
        instruction.text ??
        `${instruction.mnemonic ?? ""} ${instruction.operands ?? ""}`.trim();
      lines.push(`    ${instruction.address ?? "-"}  ${text}${sourceLocation}`);
    }
    if ((block.calls ?? []).length > 0) {
      const targets = (block.calls ?? [])
        .map((call) => {
          const target =
            (call.target_function as string | undefined) ??
            (call.target as string | undefined) ??
            (call.site as string | undefined);
          return target ?? "call";
        })
        .join(", ");
      lines.push(`    -> ${targets}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

type CfgNodeData = {
  block: BinaryCfgBlock;
  entry: boolean;
  selected: boolean;
  onPath: boolean;
  onSelect?: () => void;
};

type CfgNode = Node<CfgNodeData, "cfgBlock">;

const EDGE_COLORS: Record<string, string> = {
  fallthrough: "#4a6f96",
  branch: "#4fa3ff",
  call: "#b49bff",
  return: "#67e8a2",
};

function cyclesLabel(block: BinaryCfgBlock): string {
  const min = block.cycles?.min;
  const max = block.cycles?.max;
  if (min === undefined && max === undefined) return "";
  return `${min ?? "?"}-${max ?? "?"} cy`;
}

function CfgBlockCard({ data }: NodeProps<CfgNode>) {
  const block = data.block;
  const instructions = block.instructions?.length ?? 0;
  return (
    <div
      className={`cfg-node ${data.entry ? "entry" : ""} ${data.selected ? "selected" : ""} ${data.onPath ? "on-path" : ""} term-${(block.terminator ?? "none").replace(/[^a-z]/g, "")}`}
    >
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="cfg-node-head">
        <span className="cfg-node-address">{block.address ?? block.id}</span>
        {data.entry && <span className="cfg-node-entry">ENTRY</span>}
      </div>
      <div className="cfg-node-meta">
        <span>{block.terminator ?? "fallthrough"}</span>
        <span>{cyclesLabel(block)}</span>
      </div>
      <div className="cfg-node-foot">
        <span>{instructions} insn</span>
        {(block.calls?.length ?? 0) > 0 && <span>{block.calls!.length} call</span>}
      </div>
      <button
        type="button"
        className="cfg-node-pick nodrag nopan"
        aria-label={`Inspect block ${block.address ?? block.id}`}
        aria-pressed={data.selected}
        onClick={data.onSelect}
      />
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

const nodeTypes = { cfgBlock: CfgBlockCard };
const BLOCK_WIDTH = 196;
const BLOCK_HEIGHT = 88;
const HANDLE_SIZE = 6;

function layoutCfg(
  blocks: BinaryCfgBlock[],
  edges: BinaryCfgEdge[],
  entry: string | null,
): { nodes: CfgNode[]; edges: Edge[] } {
  const ids = new Set(blocks.map((block) => block.id));
  const validEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const block of blocks) {
    adjacency.set(block.id, []);
    indegree.set(block.id, 0);
  }
  for (const edge of validEdges) {
    adjacency.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const levels = new Map<string, number>();
  const start = entry && ids.has(entry) ? entry : blocks[0]?.id;
  const queue: string[] = [];
  if (start) {
    levels.set(start, 0);
    queue.push(start);
  } else {
    for (const block of blocks) {
      if ((indegree.get(block.id) ?? 0) === 0) {
        levels.set(block.id, 0);
        queue.push(block.id);
      }
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const level = levels.get(current) ?? 0;
    for (const next of adjacency.get(current) ?? []) {
      if (!levels.has(next)) {
        levels.set(next, level + 1);
        queue.push(next);
      }
    }
  }
  for (const block of blocks) {
    if (!levels.has(block.id)) levels.set(block.id, 0);
  }
  const rows = new Map<number, number>();
  const nodes: CfgNode[] = blocks.map((block) => {
    const level = levels.get(block.id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return {
      id: block.id,
      type: "cfgBlock",
      position: { x: level * 300, y: row * 128 },
      width: BLOCK_WIDTH,
      height: BLOCK_HEIGHT,
      ariaLabel: `Basic block ${block.address ?? block.id}`,
      handles: [
        { type: "target", position: Position.Left, x: 0, y: (BLOCK_HEIGHT - HANDLE_SIZE) / 2, width: HANDLE_SIZE, height: HANDLE_SIZE },
        { type: "source", position: Position.Right, x: BLOCK_WIDTH - HANDLE_SIZE, y: (BLOCK_HEIGHT - HANDLE_SIZE) / 2, width: HANDLE_SIZE, height: HANDLE_SIZE },
      ],
      data: { block, entry: block.id === start, selected: false, onPath: false },
    };
  });
  const flowEdges: Edge[] = validEdges.map((edge, index) => ({
    id: `edge-${index}`,
    source: edge.from,
    target: edge.to,
    label: edge.kind ?? "",
    type: "smoothstep",
    animated: Boolean(edge.conditional),
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { stroke: EDGE_COLORS[edge.kind ?? ""] ?? "#4a6f96" },
    labelStyle: {
      fill: "#9fc0de",
      fontSize: 9,
      fontFamily: "Cascadia Code, monospace",
    },
    labelBgStyle: { fill: "#0b1422", fillOpacity: 0.9 },
  }));
  return { nodes, edges: flowEdges };
}

function BlockInstructions({ block }: { block: BinaryCfgBlock }) {
  return (
    <div className="cfg-instructions">
      <div className="cfg-inst-head">
        <span className="sem-eyebrow">BLOCK {block.address ?? block.id}</span>
        <span className="mono faint">
          {block.terminator ?? "fallthrough"} | {cyclesLabel(block) || "no cycle data"} |{" "}
          {block.size ?? "?"} bytes
        </span>
      </div>
      {Boolean(block.instructions?.length) ? (
        <table className="bin-table cfg-inst-table">
          <thead>
            <tr>
              <th align="left">address</th>
              <th align="left">instruction</th>
              <th align="left">source</th>
            </tr>
          </thead>
          <tbody>
            {(block.instructions ?? []).map((instruction, index) => (
              <tr
                key={`${instruction.address}-${index}`}
                className={
                  instruction.is_call
                    ? "insn-call"
                    : instruction.is_conditional
                      ? "insn-branch"
                      : instruction.is_return
                        ? "insn-return"
                        : ""
                }
              >
                <td className="mono">{instruction.address ?? "-"}</td>
                <td className="mono cfg-insn-text">
                  {instruction.text ?? `${instruction.mnemonic ?? ""} ${instruction.operands ?? ""}`}
                </td>
                <td className="mono faint">
                  {instruction.source?.file
                    ? `${instruction.source.file}:${instruction.source.line ?? "?"}`
                    : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="wb-muted">No instruction details are available for this block in the saved CFG.</p>
      )}
      {(block.calls?.length ?? 0) > 0 && (
        <div className="cfg-block-calls">
          <span className="sem-eyebrow">CALLS</span>
          {(block.calls ?? []).map((call, index) => (
            <span key={index} className="cfg-call-chip">
              {String(
                (call.target_function as string | undefined) ??
                  (call.target as string | undefined) ??
                  (call.site as string | undefined) ??
                  "call",
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function BinaryCfg({
  cfg,
  loading,
  error,
  selector,
  highlightPath,
  onReload,
}: {
  cfg: BinaryFunctionCfg | null;
  loading: boolean;
  error: string | null;
  selector: string;
  highlightPath?: string[] | null;
  onReload: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"graph" | "text" | "mmd">("graph");

  useEffect(() => {
    setSelectedId(cfg?.entry ?? cfg?.blocks[0]?.id ?? null);
  }, [cfg]);

  const layout = useMemo(() => {
    if (!cfg) return { nodes: [], edges: [] };
    return layoutCfg(cfg.blocks, cfg.edges, cfg.entry);
  }, [cfg]);

  const pathSet = useMemo(() => new Set(highlightPath ?? []), [highlightPath]);
  const nodes = useMemo(
    () =>
      layout.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          selected: node.id === selectedId,
          onPath: pathSet.has(node.id),
          onSelect: () => setSelectedId(node.id),
        },
      })),
    [layout.nodes, pathSet, selectedId],
  );
  const edges = useMemo(() => {
    if (!highlightPath?.length) return layout.edges;
    const steps = new Map<string, Set<string>>();
    for (let index = 1; index < highlightPath.length; index += 1) {
      const source = highlightPath[index - 1];
      const targets = steps.get(source) ?? new Set<string>();
      targets.add(highlightPath[index]);
      steps.set(source, targets);
    }
    return layout.edges.map((edge) => steps.get(edge.source)?.has(edge.target)
      ? {
          ...edge,
          animated: false,
          style: { ...edge.style, stroke: "#f3ca85", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#f3ca85" },
        }
      : edge);
  }, [highlightPath, layout.edges]);

  const selectedBlock = cfg?.blocks.find((block) => block.id === selectedId) ?? null;
  const activeView = view === "mmd" && !cfg?.cfg_mermaid ? "graph" : view;
  const highlightedCount = nodes.filter((node) => node.data.onPath).length;
  const instructionCount = cfg?.blocks.reduce((sum, block) => sum + (block.instructions?.length ?? 0), 0) ?? 0;

  if (loading) {
    return (
      <div className="bin-cfg bin-cfg-empty">
        <p role="status">Loading control flow for {selector || "the entry point"}...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="bin-cfg bin-cfg-empty">
        <p className="bin-cfg-error" role="alert">{error}</p>
        <button className="wb-button" onClick={onReload}>
          Try again
        </button>
      </div>
    );
  }
  if (!cfg) {
    return (
      <div className="bin-cfg bin-cfg-empty">
        <p>Use Find function to select a function from the recovered index.</p>
      </div>
    );
  }

  return (
    <div className="bin-cfg">
      <div className="cfg-toolbar">
        <div className="cfg-toolbar-title">
          <h3>{cfg.name || cfg.selector}</h3>
          <div className="mono faint">
            {cfg.address || "-"} | {cfg.blocks.length} blocks | {cfg.edges.length} edges |{" "}
            {instructionCount > 0 ? `${instructionCount} instructions` : "Instruction details unavailable"}
          </div>
        </div>
        <div className="cfg-toolbar-actions">
          <div className="cfg-tabs">
            {(
              [
                ["graph", "Graph"],
                ["text", "Text"],
                ["mmd", "Mermaid"],
              ] as const
            ).filter(([value]) => value !== "mmd" || cfg.cfg_mermaid).map(([value, label]) => (
              <button
                key={value}
                className={`btn small ${activeView === value ? "accent" : ""}`}
                aria-pressed={activeView === value}
                onClick={() => setView(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="btn small" onClick={onReload}>
            Reload function
          </button>
          <span className="faint mono">
            {cfg.json_path.split(/[\\/]/).pop() ?? "cfg.json"}
          </span>
        </div>
      </div>

      {activeView === "graph" ? (
        <div className="cfg-evidence-grid">
          <div className="cfg-graph">
            {pathSet.size > 0 && (
              <div className="cfg-path-badge">
                Longest path / {highlightedCount} of {pathSet.size} blocks shown
              </div>
            )}
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.2}
              maxZoom={1.6}
              nodesDraggable={false}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={22} size={1} color="#14283f" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          {selectedBlock && <BlockInstructions block={selectedBlock} />}
        </div>
      ) : activeView === "text" ? (
        <pre className="cfg-text">{cfgText(cfg)}</pre>
      ) : (
        <div className="cfg-mermaid">
          <Mermaid chart={cfg.cfg_mermaid} />
        </div>
      )}

      {cfg.caveats.length > 0 && (
        <details className="wb-panel wb-disclosure cfg-caveats">
          <summary>Timing assumptions</summary>
          <ul>
            {cfg.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
