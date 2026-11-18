import type { ReplayStep } from "./replayModel";

export interface CompareExportLane {
  policy: string;
  label: string;
  status: string;
  mode: string;
  error: string;
  steps: ReplayStep[];
}

export interface CompareExport {
  version: number;
  model: string;
  tie: string;
  generatedAt: string;
  maxStates: number;
  timeoutSecs: number;
  lanes: CompareExportLane[];
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);

const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** Self-contained side-by-side policy replay player: one synchronized playhead,
 * one card per scheduling policy, no external assets. */
export function buildCompareHtml(exportData: CompareExport): string {
  const title = escapeHtml(exportData.model || "policy comparison");
  const tie = escapeHtml(exportData.tie || "fifo");
  const data = jsonForScript(exportData);
  const stamp = escapeHtml(exportData.generatedAt);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · policy-aware replay</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 48px; color: #dce8f5;
    background:
      radial-gradient(1000px 500px at 15% -10%, rgba(79,163,255,.08), transparent 60%),
      radial-gradient(900px 420px at 95% 0%, rgba(150,120,255,.06), transparent 55%),
      #060d18;
    font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  }
  .wrap { max-width: 1280px; margin: 0 auto; }
  .eyebrow { font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace; font-size: 9.5px; letter-spacing: 1.6px; text-transform: uppercase; color: #7c8ca8; }
  h1 { margin: 4px 0 8px; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: 26px; font-weight: 600; color: #eef6ff; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .badge { padding: 2px 8px; border: 1px solid #244a73; border-radius: 999px; background: rgba(79,163,255,.08); color: #b9d3ec; font-size: 10px; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; margin-bottom: 14px; border: 1px solid #17304d; border-radius: 8px; background: rgba(8,17,31,.92); }
  button { padding: 5px 10px; border: 1px solid #244a73; border-radius: 4px; background: #0b1728; color: #dce8f5; font: inherit; font-size: 11px; cursor: pointer; }
  button:hover { border-color: #4fa3ff; }
  button.primary { border-color: #4fa3ff; background: #123a61; }
  input[type="range"] { flex: 1 1 200px; min-width: 120px; accent-color: #4fa3ff; }
  select { padding: 4px 8px; border: 1px solid #1d3350; border-radius: 4px; background: #0b1422; color: #dce8f5; font: inherit; font-size: 10.5px; }
  .counter { color: #b9d3ec; font-size: 11px; min-width: 64px; text-align: center; }
  .lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  section { padding: 14px 16px; border: 1px solid #17304d; border-radius: 10px; background: linear-gradient(180deg, rgba(13,26,44,.95), rgba(9,18,32,.95)); min-width: 0; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .lane-title { font-family: "Cascadia Code", Consolas, monospace; font-size: 10px; letter-spacing: .8px; color: #cfe6ff; }
  .status { padding: 1px 7px; border-radius: 999px; border: 1px solid #244a73; font-family: "Cascadia Code", Consolas, monospace; font-size: 8.5px; color: #b9d3ec; white-space: nowrap; }
  .status.ok { border-color: #1f6f4a; color: #67e8a2; background: rgba(31,111,74,.18); }
  .status.warn { border-color: #6f5a1f; color: #f2c14e; background: rgba(111,90,31,.18); }
  .status.bad { border-color: #6f1f2c; color: #ff7b7b; background: rgba(111,31,44,.18); }
  .meta { margin: 4px 0 10px; font-size: 9.5px; color: #7c8ca8; font-family: "Cascadia Code", Consolas, monospace; word-break: break-word; }
  h3 { margin: 10px 0 4px; font-family: "Cascadia Code", Consolas, monospace; font-size: 9px; letter-spacing: 1.2px; color: #7fb2e8; }
  .marking { display: flex; flex-wrap: wrap; gap: 5px; max-height: 150px; overflow: auto; }
  .place { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border: 1px solid #244a73; border-radius: 5px; background: #0b1728; }
  .place.added { border-color: #4fa3ff; box-shadow: 0 0 10px rgba(79,163,255,.3); }
  .place-name { font-family: "Cascadia Code", Consolas, monospace; font-size: 8.5px; color: #9fc0de; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tokens { display: inline-flex; gap: 2px; }
  .tok { width: 6px; height: 6px; border-radius: 50%; background: radial-gradient(circle at 32% 30%, #d8efff, #4fa3ff 60%, #1f6feb); box-shadow: 0 0 6px rgba(79,163,255,.7); }
  .count { font-family: "Cascadia Code", Consolas, monospace; font-size: 8px; color: #566f8a; }
  .fired { margin-top: 3px; font-family: "Cambria Math", "STIX Two Math", Georgia, serif; font-size: 10.5px; color: #d9ecff; word-break: break-word; }
  .step-meta { margin-top: 3px; font-family: "Cascadia Code", Consolas, monospace; font-size: 9px; color: #7c8ca8; }
  .chips { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .chip { padding: 3px 7px; border: 1px solid #244a73; border-radius: 4px; background: rgba(79,163,255,.06); color: #b9d3ec; font-family: "Cascadia Code", Consolas, monospace; font-size: 8.5px; line-height: 1.4; word-break: break-word; }
  footer { margin-top: 22px; color: #566f8a; font-size: 10px; line-height: 1.6; font-family: "Cascadia Code", Consolas, monospace; }
  @media (max-width: 900px) { .lanes { grid-template-columns: 1fr; } }
  @media print { body { background: #fff; color: #111; } section { break-inside: avoid; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">POLICY-AWARE REPLAY</div>
    <h1>${title}</h1>
    <div class="badges">
      <span class="badge">${exportData.lanes.length} policies</span>
      <span class="badge">tie ${tie}</span>
      <span class="badge">bounded ${exportData.maxStates} states · ${exportData.timeoutSecs || "∞"} s each</span>
    </div>
  </header>

  <div class="controls">
    <button id="reset" title="reset">⏮</button>
    <button id="prev">◀</button>
    <button id="play" class="primary">PAUSE</button>
    <button id="next">▶</button>
    <button id="end">⏭</button>
    <input id="range" type="range" min="0" max="0" value="0" />
    <span id="counter" class="counter"></span>
    <select id="speed">
      <option value="0.5">0.5×</option>
      <option value="1" selected>1×</option>
      <option value="2">2×</option>
    </select>
  </div>

  <div id="lanes" class="lanes"></div>
  <footer>
    Generated by RT-PN on ${stamp}.<br />
    Each lane replays its own deadlock counterexample or shortest state-class path; the
    playhead is synchronized across lanes, so a shorter lane holds on its last step.
  </footer>
</div>
<script>
(function () {
  "use strict";
  var DATA = ${data};
  var lanes = DATA.lanes;
  var maxSteps = 1;
  lanes.forEach(function (lane) { maxSteps = Math.max(maxSteps, lane.steps.length); });
  var last = maxSteps - 1;
  var index = 0;
  var playing = true;
  var speed = 1;
  var timer = null;

  function esc(value) {
    return String(value).replace(/[&<>"]/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character];
    });
  }

  function parseMarking(text) {
    var inner = String(text || "").trim().replace(/^\\[/, "").replace(/\\]$/, "").trim();
    if (!inner || inner === "empty") return [];
    var counts = {};
    inner.split(",").forEach(function (part) {
      var entry = part.trim();
      if (!entry) return;
      var match = entry.match(/^(.*?)(?:\\((\\d+)\\))?$/);
      var name = (match && match[1] ? match[1] : entry).trim();
      var tokens = match && match[2] ? Number(match[2]) : 1;
      if (name) counts[name] = (counts[name] || 0) + tokens;
    });
    return Object.keys(counts).map(function (name) { return { name: name, tokens: counts[name] }; });
  }

  function parseEntries(text) {
    if (!text || String(text).trim() === "(none)") return [];
    var entries = [];
    var depth = 0;
    var current = "";
    String(text).split("").forEach(function (character) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        if (current.trim()) entries.push(current.trim());
        current = "";
        return;
      }
      current += character;
    });
    if (current.trim()) entries.push(current.trim());
    return entries;
  }

  var lanesEl = document.getElementById("lanes");
  lanes.forEach(function (lane) {
    var section = document.createElement("section");
    var statusClass = lane.status === "ERROR" || lane.status === "DEADLOCK"
      ? "bad" : lane.status === "PARTIAL" ? "warn" : "ok";
    section.innerHTML =
      '<div class="head"><span class="lane-title">' + esc(lane.label) + '</span>' +
      '<span class="status ' + statusClass + '">' + esc(lane.status) + "</span></div>" +
      '<div class="meta">' + esc(lane.mode || lane.error || "no replay path") + "</div>" +
      '<h3>MARKING · M</h3><div class="marking" data-role="marking"></div>' +
      '<h3>FIRED</h3><div class="fired" data-role="fired"></div>' +
      '<div class="step-meta" data-role="stepmeta"></div>' +
      '<h3>SELECTED ACTIVE SET · E_pri</h3><div class="chips" data-role="active"></div>';
    lanesEl.appendChild(section);
  });

  function render() {
    var sections = lanesEl.children;
    for (var position = 0; position < lanes.length; position += 1) {
      var lane = lanes[position];
      var section = sections[position];
      var laneIndex = Math.min(index, Math.max(lane.steps.length - 1, 0));
      var step = lane.steps[laneIndex];
      var markingEl = section.querySelector('[data-role="marking"]');
      var firedEl = section.querySelector('[data-role="fired"]');
      var metaEl = section.querySelector('[data-role="stepmeta"]');
      var activeEl = section.querySelector('[data-role="active"]');
      if (!step) { markingEl.innerHTML = '<span style="color:#8fa8c0">no replay path</span>'; continue; }
      var previous = laneIndex > 0 ? parseMarking(lane.steps[laneIndex - 1].marking) : [];
      var previousCounts = {};
      previous.forEach(function (place) { previousCounts[place.name] = place.tokens; });
      var places = parseMarking(step.marking);
      markingEl.innerHTML = places.length === 0 ? '<span style="color:#8fa8c0">[empty]</span>' : places.map(function (place) {
        var dots = "";
        for (var slot = 0; slot < Math.min(place.tokens, 4); slot += 1) dots += '<i class="tok"></i>';
        var added = (previousCounts[place.name] || 0) > 0 ? "" : " added";
        return '<span class="place' + added + '"><span class="place-name">' + esc(place.name) +
          '</span><span class="tokens">' + dots + '</span><span class="count">×' + place.tokens + "</span></span>";
      }).join("");
      firedEl.textContent = step.transition || "(initial state)";
      metaEl.textContent = step.state + " · t = " + (step.elapsed || "0") + " · step " + (laneIndex + 1) + "/" + lane.steps.length;
      var active = parseEntries(step.active);
      activeEl.innerHTML = active.length === 0 ? '<span style="color:#8fa8c0">(none)</span>' : active.slice(0, 4).map(function (entry) {
        return '<span class="chip">' + esc(entry) + "</span>";
      }).join("") + (active.length > 4 ? '<span class="chip">+' + (active.length - 4) + "</span>" : "");
    }
    document.getElementById("range").value = String(index);
    document.getElementById("counter").textContent = (index + 1) + " / " + maxSteps;
  }

  function stop() {
    playing = false;
    if (timer) { clearTimeout(timer); timer = null; }
    document.getElementById("play").textContent = "PLAY";
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!playing) return;
    if (index >= last) { stop(); return; }
    timer = window.setTimeout(function () {
      index += 1;
      render();
      schedule();
    }, 950 / speed);
  }

  function play() {
    if (index >= last) index = 0;
    playing = true;
    document.getElementById("play").textContent = "PAUSE";
    render();
    schedule();
  }

  var range = document.getElementById("range");
  range.max = String(last);
  document.getElementById("play").addEventListener("click", function () { if (playing) stop(); else play(); });
  document.getElementById("reset").addEventListener("click", function () { stop(); index = 0; render(); });
  document.getElementById("prev").addEventListener("click", function () { stop(); index = Math.max(0, index - 1); render(); });
  document.getElementById("next").addEventListener("click", function () { stop(); index = Math.min(last, index + 1); render(); });
  document.getElementById("end").addEventListener("click", function () { stop(); index = last; render(); });
  range.addEventListener("input", function () { stop(); index = Number(range.value); render(); });
  document.getElementById("speed").addEventListener("change", function (event) {
    speed = Number(event.target.value);
    if (playing) schedule();
  });

  render();
  schedule();
})();
</script>
</body>
</html>`;
}
