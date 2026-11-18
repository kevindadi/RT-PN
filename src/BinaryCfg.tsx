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

import type {
  BinaryCfgBlock,
  BinaryCfgEdge,
  BinaryFunctionCfg,
} from "./types";

type CfgNodeData = {
  block: BinaryCfgBlock;
  entry: boolean;
  selected: boolean;
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
  return `${min ?? "?"}–${max ?? "?"} cy`;
}

function CfgBlockCard({ data }: NodeProps<CfgNode>) {
  const block = data.block;
  const instructions = block.instructions?.length ?? 0;
  return (
    <div
      className={`cfg-node ${data.entry ? "entry" : ""} ${data.selected ? "selected" : ""} term-${(block.terminator ?? "none").replace(/[^a-z]/g, "")}`}
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
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

const nodeTypes = { cfgBlock: CfgBlockCard };

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
      data: { block, entry: block.id === start, selected: false },
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
          {block.terminator ?? "fallthrough"} · {cyclesLabel(block) || "no cycle data"} ·{" "}
          {block.size ?? "?"} bytes
        </span>
      </div>
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
              <td className="mono">{instruction.address ?? "—"}</td>
              <td className="mono cfg-insn-text">
                {instruction.text ?? `${instruction.mnemonic ?? ""} ${instruction.operands ?? ""}`}
              </td>
              <td className="mono faint">
                {instruction.source?.file
                  ? `${instruction.source.file}:${instruction.source.line ?? "?"}`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  onReload,
}: {
  cfg: BinaryFunctionCfg | null;
  loading: boolean;
  error: string | null;
  selector: string;
  onReload: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(cfg?.entry ?? cfg?.blocks[0]?.id ?? null);
  }, [cfg]);

  const layout = useMemo(() => {
    if (!cfg) return { nodes: [], edges: [] };
    return layoutCfg(cfg.blocks, cfg.edges, cfg.entry);
  }, [cfg]);

  const nodes = useMemo(
    () =>
      layout.nodes.map((node) => ({
        ...node,
        data: { ...node.data, selected: node.id === selectedId },
      })),
    [layout.nodes, selectedId],
  );

  const selectedBlock = cfg?.blocks.find((block) => block.id === selectedId) ?? null;

  if (loading) {
    return (
      <div className="bin-cfg bin-cfg-empty">
        <div className="sem-eyebrow">CFG EXPLORER</div>
        <p>loading function CFG for {selector || "default root"}…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="bin-cfg bin-cfg-empty">
        <div className="sem-eyebrow">CFG EXPLORER</div>
        <p className="bin-cfg-error">{error}</p>
        <button className="btn small" onClick={onReload}>
          RETRY
        </button>
      </div>
    );
  }
  if (!cfg) {
    return (
      <div className="bin-cfg bin-cfg-empty">
        <div className="sem-eyebrow">CFG EXPLORER</div>
        <p>Select a function in FUNCTIONS or a root in the sidebar to load its CFG.</p>
      </div>
    );
  }

  return (
    <div className="bin-cfg">
      <div className="cfg-toolbar">
        <div className="cfg-toolbar-title">
          <div className="sem-eyebrow">
            {cfg.kind || "function"} · {cfg.language || "—"} · SCHEMA {cfg.source ? "" : ""}
          </div>
          <h3>{cfg.name || cfg.selector}</h3>
          <div className="mono faint">
            {cfg.address || "—"} · {cfg.blocks.length} blocks · {cfg.edges.length} edges ·{" "}
            {cfg.blocks.reduce((sum, block) => sum + (block.instructions?.length ?? 0), 0)}{" "}
            instructions
          </div>
        </div>
        <div className="cfg-toolbar-actions">
          <button className="btn small" onClick={onReload}>
            RELOAD SLICE
          </button>
          <span className="faint mono">
            {cfg.json_path.split(/[\\/]/).pop() ?? "cfg.json"}
          </span>
        </div>
      </div>

      <div className="cfg-graph">
        <ReactFlow
          nodes={nodes}
          edges={layout.edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          maxZoom={1.6}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={22} size={1} color="#14283f" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {selectedBlock && <BlockInstructions block={selectedBlock} />}

      {cfg.caveats.length > 0 && (
        <div className="bin-caveats cfg-caveats">
          <div className="sem-eyebrow">TIMING CAVEATS</div>
          <ul>
            {cfg.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
