import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import type { Graph } from "./types";

type GraphNodeData = {
  label: string;
  kind: string;
  detail: string;
  extra: string;
  shape: string;
};

type FlowNode = Node<GraphNodeData, "graphNode">;

function GraphNodeCard({ data }: NodeProps<FlowNode>) {
  const circle = data.shape === "circle";
  return (
    <div
      className={`flow-node ${circle ? "flow-circle" : "flow-rect"} kind-${data.kind.replace(/ /g, "-")}`}
    >
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-node-id">{data.label}</div>
      {data.detail && data.detail !== "-" && (
        <div className="flow-node-detail">{data.detail}</div>
      )}
      {data.extra && <div className="flow-node-extra">{data.extra}</div>}
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

const nodeTypes = { graphNode: GraphNodeCard };

function layoutGraph(graph: Graph): Map<number, { x: number; y: number }> {
  const count = graph.nodes.length;
  const positions = new Map<number, { x: number; y: number }>();
  if (count === 0) return positions;

  // PTPNs are bipartite: places on the left, transitions on the right. A
  // layered BFS on a cyclic net produces a much noisier preview.
  if (graph.title.toLowerCase().includes("ptpn")) {
    const places = graph.nodes
      .map((node, index) => ({ node, index }))
      .filter((entry) => entry.node.kind === "place");
    const transitions = graph.nodes
      .map((node, index) => ({ node, index }))
      .filter((entry) => entry.node.kind !== "place");
    const rows = Math.max(places.length, transitions.length);
    places.forEach((entry, row) => {
      positions.set(entry.index, {
        x: 0,
        y: (row - (rows - 1) / 2) * 92,
      });
    });
    transitions.forEach((entry, row) => {
      positions.set(entry.index, {
        x: 360,
        y: (row - (rows - 1) / 2) * 92,
      });
    });
    return positions;
  }

  if (graph.title.toLowerCase().includes("state-class")) {
    const columns = 5;
    graph.nodes.forEach((_, index) => {
      positions.set(index, {
        x: (index % columns) * 286,
        y: Math.floor(index / columns) * 128,
      });
    });
    return positions;
  }

  const adjacency: number[][] = Array.from({ length: count }, () => []);
  const indegree = new Array<number>(count).fill(0);
  for (const edge of graph.edges) {
    if (edge.from < count && edge.to < count) {
      adjacency[edge.from].push(edge.to);
      indegree[edge.to] += 1;
    }
  }

  const levels = new Array<number>(count).fill(-1);
  const queue: number[] = [];
  indegree.forEach((degree, index) => {
    if (degree === 0) {
      levels[index] = 0;
      queue.push(index);
    }
  });
  if (queue.length === 0) {
    levels[0] = 0;
    queue.push(0);
  }
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of adjacency[node]) {
      if (levels[next] === -1) {
        levels[next] = levels[node] + 1;
        queue.push(next);
      }
    }
  }
  levels.forEach((level, index) => {
    if (level === -1) {
      levels[index] = Math.floor((index * 3) / Math.max(1, count));
    }
  });

  const columns = new Map<number, number[]>();
  levels.forEach((level, index) => {
    const column = columns.get(level) ?? [];
    column.push(index);
    columns.set(level, column);
  });

  for (const [level, nodes] of columns) {
    const offset = (nodes.length - 1) / 2;
    nodes.forEach((index, row) => {
      positions.set(index, {
        x: level * 258,
        y: (row - offset) * 126,
      });
    });
  }
  return positions;
}

function shortLabel(label: string): string | undefined {
  if (!label || label === "-") return undefined;
  const first = label.replace(/\n/g, " ").split(",")[0].trim();
  return first.length > 24 ? `${first.slice(0, 23)}...` : first;
}

interface GraphPreviewProps {
  graph: Graph;
  title: string;
  footer: string;
  onClose: () => void;
}

export function GraphPreview({ graph, title, footer, onClose }: GraphPreviewProps) {
  const { nodes, edges } = useMemo(() => {
    const positions = layoutGraph(graph);
    const flowNodes: FlowNode[] = graph.nodes.map((node, index) => ({
      id: String(index),
      type: "graphNode",
      position: positions.get(index) ?? { x: 0, y: 0 },
      data: {
        label: node.id,
        kind: node.kind,
        detail: node.detail,
        extra: node.extra,
        shape: node.shape,
      },
    }));
    const flowEdges: Edge[] = graph.edges.map((edge, index) => ({
      id: `e-${index}`,
      source: String(edge.from),
      target: String(edge.to),
      label: shortLabel(edge.label),
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#8ca9c8" },
      style: { stroke: "#b9d3ec", strokeWidth: 2.3 },
      labelStyle: { fill: "#7c8ca8", fontSize: 10 },
      labelBgStyle: { fill: "#0b1422", fillOpacity: 0.9 },
      labelBgPadding: [5, 2],
      labelBgBorderRadius: 3,
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [graph]);

  return (
    <div className="preview-backdrop" onMouseDown={onClose}>
      <div className="preview-window" onMouseDown={(event) => event.stopPropagation()}>
        <div className="preview-header">
          <div>
            <div className="preview-eyebrow">GRAPH PREVIEW</div>
            <div className="preview-title">{title}</div>
          </div>
          <div className="preview-footer-label">{footer}</div>
          <button className="btn ghost" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div className="preview-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.05, maxZoom: 1.2 }}
            minZoom={0.28}
            maxZoom={2.5}
            proOptions={{ hideAttribution: true }}
            style={{ background: "#081222" }}
            onInit={(instance) => {
              // Custom node dimensions settle after the first paint; fit again
              // once the browser has measured them.
              window.setTimeout(
                () => instance.fitView({ padding: 0.05, maxZoom: 1.2 }),
                40,
              );
            }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="#1d3350"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}

interface SvgPreviewProps {
  svg: string;
  title: string;
  footer: string;
  onClose: () => void;
}

/** Static preview image rendered from the Graphviz SVG output. */
export function SvgPreview({ svg, title, footer, onClose }: SvgPreviewProps) {
  const source = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    [svg],
  );
  return (
    <div className="preview-backdrop" onMouseDown={onClose}>
      <div className="preview-window" onMouseDown={(event) => event.stopPropagation()}>
        <div className="preview-header">
          <div>
            <div className="preview-eyebrow">IMAGE PREVIEW</div>
            <div className="preview-title">{title}</div>
          </div>
          <div className="preview-footer-label">{footer}</div>
          <button className="btn ghost" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div
          className="preview-canvas"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "auto",
            background: "#081222",
          }}
        >
          <img
            src={source}
            alt={title}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        </div>
      </div>
    </div>
  );
}


