use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use crate::model::{Arc, PetriNet, Place, StateEdge, StateGraph, StateNode, Transition};

fn attr_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)""#).unwrap())
}

fn edge_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"^\s*("?[^"\s;]+"?)\s*->\s*("?[^"\s;]+"?)(?:\s*\[(.*)\])?\s*;?\s*$"#).unwrap()
    })
}

fn node_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^\s*("?[^"\s;]+"?)\s*\[(.*)\]\s*;?\s*$"#).unwrap())
}

fn token_regex(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

fn decode_escapes(mut value: String) -> String {
    value = value.replace("\\\\n", "\n");
    value = value.replace("\\n", "\n");
    value = value.replace("\\\\\"", "\"");
    value = value.replace("\\\"", "\"");
    value = value.replace("\\\\", "\\");
    value = value.replace("\\t", "\t");
    value
}

fn decode_id(mut id: String) -> String {
    if id.len() >= 2 && id.starts_with('"') && id.ends_with('"') {
        id = id[1..id.len() - 1].to_string();
    }
    id
}

fn parse_attributes(block: &str) -> HashMap<String, String> {
    let mut attributes = HashMap::new();
    for capture in attr_regex().captures_iter(block) {
        let key = capture.get(1).map(|m| m.as_str()).unwrap_or("");
        let value = capture.get(2).map(|m| m.as_str()).unwrap_or("");
        attributes.insert(key.to_string(), decode_escapes(value.to_string()));
    }
    attributes
}

#[derive(Default)]
struct RawNode {
    id: String,
    attributes: HashMap<String, String>,
}

#[derive(Default)]
struct RawEdge {
    from: String,
    to: String,
    label: String,
}

#[derive(Default)]
struct DotDocument {
    nodes: Vec<RawNode>,
    edges: Vec<RawEdge>,
}

fn parse_document(text: &str) -> DotDocument {
    let mut document = DotDocument::default();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty()
            || line.starts_with("digraph")
            || line.starts_with("graph")
            || line.starts_with("node ")
            || line.starts_with("edge ")
            || line == "{"
            || line == "}"
        {
            continue;
        }

        if let Some(capture) = edge_regex().captures(line) {
            let mut edge = RawEdge::default();
            edge.from = decode_id(capture.get(1).map(|m| m.as_str()).unwrap_or("").to_string());
            edge.to = decode_id(capture.get(2).map(|m| m.as_str()).unwrap_or("").to_string());
            edge.label = parse_attributes(capture.get(3).map(|m| m.as_str()).unwrap_or(""))
                .get("label")
                .cloned()
                .unwrap_or_default();
            document.edges.push(edge);
            continue;
        }

        if let Some(capture) = node_regex().captures(line) {
            let id = decode_id(capture.get(1).map(|m| m.as_str()).unwrap_or("").to_string());
            if id.is_empty() {
                continue;
            }
            let attributes = parse_attributes(capture.get(2).map(|m| m.as_str()).unwrap_or(""));
            document.nodes.push(RawNode { id, attributes });
        }
    }
    document
}

fn looks_like_place(node: &RawNode) -> bool {
    let shape = node
        .attributes
        .get("shape")
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if shape == "circle" || shape == "ellipse" || shape == "doublecircle" {
        return true;
    }
    let label = node.attributes.get("label").cloned().unwrap_or_default();
    label.contains("M=") && !label.contains("core=")
}

fn int_from(label: &str, pattern: &str) -> Option<i64> {
    token_regex(pattern)
        .captures(label)
        .and_then(|capture| capture.get(1))
        .and_then(|m| m.as_str().parse().ok())
}

pub fn parse_petri(text: &str) -> PetriNet {
    let document = parse_document(text);
    let mut net = PetriNet::default();
    let mut places: HashMap<String, usize> = HashMap::new();
    let mut transitions: HashMap<String, usize> = HashMap::new();

    for raw in &document.nodes {
        let label = raw.attributes.get("label").cloned().unwrap_or_default();
        if looks_like_place(raw) {
            let mut place = Place {
                id: raw.id.clone(),
                label: label.clone(),
                tokens: int_from(&label, r"M\s*=\s*(-?\d+)").unwrap_or(0),
                capacity: int_from(&label, r"C\s*=\s*(-?\d+)").unwrap_or(0),
            };
            if place.tokens < 0 {
                place.tokens = 0;
            }
            places.insert(place.id.clone(), net.places.len());
            net.places.push(place);
        } else {
            let mut transition = Transition {
                id: raw.id.clone(),
                label: label.clone(),
                core: int_from(&label, r"core\s*=\s*(-?\d+)").unwrap_or(-1),
                priority: int_from(&label, r"(?:π|priority|prio)\s*=\s*(-?\d+)").unwrap_or(0),
                suspendable: label.contains("suspendable"),
                has_interval: false,
                interval_min: 0.0,
                interval_max: 0.0,
            };
            if let Some(capture) =
                token_regex(r"I\s*=\s*\[\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)")
                    .captures(&label)
            {
                if let (Some(low), Some(high)) = (capture.get(1), capture.get(2)) {
                    transition.has_interval = true;
                    transition.interval_min = low.as_str().parse().unwrap_or(0.0);
                    transition.interval_max = high.as_str().parse().unwrap_or(0.0);
                }
            }
            transitions.insert(transition.id.clone(), net.transitions.len());
            net.transitions.push(transition);
        }
    }

    for raw in &document.edges {
        if let (Some(from), Some(to)) = (places.get(&raw.from), transitions.get(&raw.to)) {
            net.arcs.push(Arc {
                from: *from,
                to: *to,
                from_place: true,
            });
        } else if let (Some(from), Some(to)) = (transitions.get(&raw.from), places.get(&raw.to)) {
            net.arcs.push(Arc {
                from: *from,
                to: *to,
                from_place: false,
            });
        }
    }

    net.initial_marking = net.places.iter().map(|p| p.tokens).collect();
    net.valid = !net.places.is_empty() && !net.transitions.is_empty();
    net
}

fn parse_tooltip(tooltip: &str, node: &mut StateNode) {
    for raw_line in tooltip.lines() {
        let line = raw_line.trim();
        if let Some(value) = line.strip_prefix("Marking:") {
            node.marking = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("E_pri (active):") {
            node.active = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("Suspended:") {
            node.suspended = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("Elapsed time:") {
            node.elapsed = value.trim().to_string();
        }
    }
}

pub fn parse_state_graph(text: &str) -> StateGraph {
    let document = parse_document(text);
    let mut graph = StateGraph::default();
    let mut index_by_id: HashMap<String, usize> = HashMap::new();

    for raw in &document.nodes {
        let mut node = StateNode {
            id: raw.id.clone(),
            ..Default::default()
        };
        if let Some(tooltip) = raw.attributes.get("tooltip") {
            parse_tooltip(tooltip, &mut node);
        }
        node.index = token_regex(r"s?(\d+)")
            .captures(&raw.id)
            .and_then(|capture| capture.get(1))
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(graph.nodes.len() as i64);
        index_by_id.insert(raw.id.clone(), graph.nodes.len());
        graph.nodes.push(node);
    }

    for raw in &document.edges {
        let (Some(from), Some(to)) = (index_by_id.get(&raw.from), index_by_id.get(&raw.to)) else {
            continue;
        };
        graph.edges.push(StateEdge {
            from: *from,
            to: *to,
            label: raw.label.lines().next().unwrap_or("").trim().to_string(),
        });
    }

    graph.valid = !graph.nodes.is_empty();
    graph
}
