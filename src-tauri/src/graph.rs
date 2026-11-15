use serde::Serialize;

use crate::model::{PetriNet, StateGraph};

#[derive(Clone, Debug, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub detail: String,
    pub extra: String,
    pub shape: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphEdge {
    pub from: usize,
    pub to: usize,
    pub label: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Graph {
    pub title: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

impl Graph {
    pub fn from_petri(net: &PetriNet) -> Self {
        let mut graph = Self {
            title: "PTPN structure".to_string(),
            ..Default::default()
        };
        for place in &net.places {
            graph.nodes.push(GraphNode {
                id: place.id.clone(),
                kind: "place".to_string(),
                detail: format!("M={}", place.tokens),
                extra: if place.capacity > 0 {
                    format!("C={}", place.capacity)
                } else {
                    String::new()
                },
                shape: "circle".to_string(),
            });
        }
        let place_offset = graph.nodes.len();
        for transition in &net.transitions {
            graph.nodes.push(GraphNode {
                id: transition.id.clone(),
                kind: "transition".to_string(),
                detail: if transition.has_interval {
                    format!(
                        "[{}, {}]",
                        crate::model::number(transition.interval_min),
                        crate::model::number(transition.interval_max)
                    )
                } else {
                    "untimed".to_string()
                },
                extra: format!("{} / c{}", transition.priority, transition.core),
                shape: "rect".to_string(),
            });
        }
        for arc in &net.arcs {
            let (from, to) = if arc.from_place {
                (arc.from, place_offset + arc.to)
            } else {
                (place_offset + arc.from, arc.to)
            };
            graph.edges.push(GraphEdge {
                from,
                to,
                label: String::new(),
            });
        }
        graph
    }

    pub fn from_state(graph: &StateGraph) -> Self {
        let nodes = graph
            .nodes
            .iter()
            .map(|node| GraphNode {
                id: if node.id.is_empty() {
                    format!("S{}", node.index)
                } else {
                    node.id.clone()
                },
                kind: "state class".to_string(),
                detail: node.marking.clone(),
                extra: if node.active.is_empty() {
                    node.elapsed.clone()
                } else {
                    node.active.clone()
                },
                shape: "rect".to_string(),
            })
            .collect();
        let edges = graph
            .edges
            .iter()
            .map(|edge| GraphEdge {
                from: edge.from,
                to: edge.to,
                label: edge.label.clone(),
            })
            .collect();
        Self {
            title: "State-class graph".to_string(),
            nodes,
            edges,
        }
    }

    pub fn from_records(
        title: &str,
        records: Vec<(String, String, String, String)>,
        edges: Vec<(usize, usize, String)>,
    ) -> Self {
        Self {
            title: title.to_string(),
            nodes: records
                .into_iter()
                .map(|(id, kind, detail, extra)| GraphNode {
                    id,
                    kind,
                    detail,
                    extra,
                    shape: "rect".to_string(),
                })
                .collect(),
            edges: edges
                .into_iter()
                .map(|(from, to, label)| GraphEdge { from, to, label })
                .collect(),
        }
    }
}
