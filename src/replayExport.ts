export interface ReplayStepData {
  state: string;
  transition: string;
  marking: string;
  active: string;
  suspended: string;
  elapsed: string;
}

export interface ReplayExport {
  version: number;
  model: string;
  policy: string;
  tie: string;
  mode: string;
  generatedAt: string;
  stepCount: number;
  steps: ReplayStepData[];
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);

const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/**
 * Self-contained presentation of a state-class replay: no external assets,
 * no network, works offline in any browser and can be attached to a paper or
 * review bundle.
 */
export function buildReplayHtml(exportData: ReplayExport): string {
  const title = escapeHtml(exportData.model || "state-class replay");
  const policy = escapeHtml(exportData.policy || "—");
  const tie = escapeHtml(exportData.tie || "—");
  const mode = escapeHtml(exportData.mode);
  const data = jsonForScript(exportData);
  const stamp = escapeHtml(exportData.generatedAt);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · state-class replay</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px 48px;
    background:
      radial-gradient(1000px 500px at 15% -10%, rgba(79, 163, 255, 0.08), transparent 60%),
      radial-gradient(800px 400px at 100% 10%, rgba(150, 120, 255, 0.06), transparent 55%),
      #060d18;
    color: #dce8f5;
    font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  .eyebrow {
    font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
    font-size: 9.5px; letter-spacing: 1.6px; text-transform: uppercase; color: #7c8ca8;
  }
  h1 {
    margin: 4px 0 8px;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    font-size: 26px; font-weight: 600; color: #eef6ff;
  }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .badge {
    padding: 2px 8px; border: 1px solid #244a73; border-radius: 999px;
    background: rgba(79, 163, 255, 0.08); color: #b9d3ec; font-size: 10px;
  }
  .controls {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 10px 12px; margin-bottom: 14px;
    border: 1px solid #17304d; border-radius: 8px; background: rgba(8, 17, 31, 0.92);
  }
  button {
    padding: 5px 10px; border: 1px solid #244a73; border-radius: 4px;
    background: #0b1728; color: #dce8f5; font: inherit; font-size: 11px; cursor: pointer;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  button:hover { border-color: #4fa3ff; }
  button.primary { border-color: #4fa3ff; background: #123a61; }
  input[type="range"] { flex: 1 1 180px; min-width: 120px; accent-color: #4fa3ff; }
  select {
    padding: 4px 8px; border: 1px solid #1d3350; border-radius: 4px;
    background: #0b1422; color: #dce8f5; font: inherit; font-size: 10.5px;
  }
  .counter { color: #b9d3ec; font-size: 11px; min-width: 64px; text-align: center; }
  .stage { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 12px; }
  section {
    padding: 14px 16px; border: 1px solid #17304d; border-radius: 10px;
    background: linear-gradient(180deg, rgba(13, 26, 44, 0.95), rgba(9, 18, 32, 0.95));
  }
  h3 {
    margin: 0 0 10px; font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
    font-size: 10px; letter-spacing: 1.4px; color: #7fb2e8;
  }
  .marking { display: flex; flex-wrap: wrap; gap: 7px; }
  .place {
    display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px;
    border: 1px solid #244a73; border-radius: 6px; background: #0b1728;
  }
  .place.added { border-color: #4fa3ff; box-shadow: 0 0 12px rgba(79, 163, 255, 0.35); }
  .place-name { font-family: "Cascadia Code", Consolas, monospace; font-size: 9.5px; color: #9fc0de; }
  .tokens { display: inline-flex; gap: 3px; align-items: center; }
  .tok {
    width: 8px; height: 8px; border-radius: 50%;
    background: radial-gradient(circle at 32% 30%, #d8efff, #4fa3ff 60%, #1f6feb);
    box-shadow: 0 0 8px rgba(79, 163, 255, 0.7);
  }
  .count { font-family: "Cascadia Code", Consolas, monospace; font-size: 9px; color: #566f8a; }
  .chips { display: flex; flex-direction: column; gap: 5px; }
  .chip {
    padding: 4px 8px; border: 1px solid #244a73; border-radius: 4px;
    background: rgba(79, 163, 255, 0.06); color: #b9d3ec;
    font-family: "Cascadia Code", Consolas, monospace; font-size: 9.5px; line-height: 1.45;
  }
  .chip.suspended { border-color: #4a3f8f; color: #c9c2ff; background: rgba(143, 123, 255, 0.08); }
  .meta {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
    margin-top: 14px; padding-top: 10px; border-top: 1px solid #17304d;
  }
  .meta span { display: block; }
  .meta b {
    display: block; margin-top: 2px; font-family: "Cambria Math", "STIX Two Math", Georgia, serif;
    font-size: 10.5px; font-weight: 500; color: #cfe6ff; word-break: break-word;
  }
  .timeline { display: flex; gap: 6px; overflow-x: auto; margin-top: 14px; padding-bottom: 10px; }
  .step {
    flex: 0 0 auto; display: flex; flex-direction: column; gap: 2px;
    padding: 6px 10px; border: 1px solid #1d3350; border-radius: 6px;
    background: #0a1526; color: #7c8ca8;
    font-family: "Cascadia Code", Consolas, monospace; font-size: 9px; cursor: pointer;
    transition: border-color 180ms ease, color 180ms ease, box-shadow 180ms ease;
  }
  .step small { font-size: 8px; color: #566f8a; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step.past { color: #9cc0e2; border-color: #244a73; }
  .step.active { color: #eaf5ff; border-color: #4fa3ff; box-shadow: 0 0 14px rgba(79, 163, 255, 0.35); }
  footer {
    margin-top: 22px; color: #566f8a; font-size: 10px; line-height: 1.6;
    font-family: "Cascadia Code", Consolas, monospace;
  }
  @media (max-width: 860px) { .stage { grid-template-columns: 1fr; } .meta { grid-template-columns: 1fr; } }
  @media print { body { background: #fff; color: #111; } section { break-inside: avoid; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">SCG REPLAY</div>
    <h1>${title}</h1>
    <div class="badges">
      <span class="badge">${mode}</span>
      <span class="badge">${exportData.stepCount} transitions</span>
      <span class="badge">policy ${policy}</span>
      <span class="badge">tie ${tie}</span>
    </div>
  </header>

  <div class="controls">
    <button id="reset" title="reset">⏮</button>
    <button id="prev">◀</button>
    <button id="play" class="primary">PAUSE</button>
    <button id="next">▶</button>
    <button id="end">⏭</button>
    <input id="range" type="range" min="0" max="${Math.max(exportData.stepCount - 1, 0)}" value="0" />
    <span id="counter" class="counter">1 / ${exportData.stepCount}</span>
    <select id="speed">
      <option value="0.5">0.5×</option>
      <option value="1" selected>1×</option>
      <option value="2">2×</option>
    </select>
  </div>

  <div class="stage">
    <section>
      <h3>MARKING · M</h3>
      <div id="marking" class="marking"></div>
    </section>
    <section>
      <h3>SELECTED ACTIVE SET · E_pri</h3>
      <div id="active" class="chips"></div>
      <div id="suspended-wrap" hidden>
        <h3 style="margin-top: 12px">SUSPENDED</h3>
        <div id="suspended" class="chips"></div>
      </div>
      <div class="meta">
        <div><span class="eyebrow">fired</span><b id="fired"></b></div>
        <div><span class="eyebrow">elapsed</span><b id="elapsed"></b></div>
        <div><span class="eyebrow">state class</span><b id="state"></b></div>
      </div>
    </section>
  </div>

  <div id="timeline" class="timeline"></div>
  <footer>
    Generated by RT-PN on ${stamp}.<br />
    Marking token counts, the selected active set E_pri, suspended transitions and the fired
    transition are taken verbatim from the analyzer's state-class graph.
  </footer>
</div>

<script>
(function () {
  "use strict";
  var DATA = ${data};
  var steps = DATA.steps;
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
    return Object.keys(counts).map(function (name) {
      return { name: name, tokens: counts[name] };
    });
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

  var markingEl = document.getElementById("marking");
  var activeEl = document.getElementById("active");
  var suspendedEl = document.getElementById("suspended");
  var suspendedWrap = document.getElementById("suspended-wrap");
  var firedEl = document.getElementById("fired");
  var elapsedEl = document.getElementById("elapsed");
  var stateEl = document.getElementById("state");
  var timelineEl = document.getElementById("timeline");
  var rangeEl = document.getElementById("range");
  var counterEl = document.getElementById("counter");
  var playEl = document.getElementById("play");

  steps.forEach(function (step, position) {
    var button = document.createElement("button");
    button.className = "step";
    button.innerHTML = "<span>" + esc(step.state) + "</span><small>" + esc(step.transition || "init") + "</small>";
    button.addEventListener("click", function () {
      index = position;
      stop();
      render();
    });
    timelineEl.appendChild(button);
  });

  function render() {
    var step = steps[index];
    var previous = index > 0 ? parseMarking(steps[index - 1].marking) : [];
    var previousCounts = {};
    previous.forEach(function (place) { previousCounts[place.name] = place.tokens; });
    var places = parseMarking(step.marking);
    if (places.length === 0) {
      markingEl.innerHTML = '<div style="color:#8fa8c0">[empty]</div>';
    } else {
      markingEl.innerHTML = places.map(function (place) {
        var dots = "";
        for (var slot = 0; slot < Math.min(place.tokens, 6); slot += 1) dots += '<i class="tok"></i>';
        var more = place.tokens > 6 ? "<em>+" + (place.tokens - 6) + "</em>" : "";
        var added = (previousCounts[place.name] || 0) > 0 ? "" : " added";
        return '<div class="place' + added + '"><span class="place-name">' + esc(place.name) +
          '</span><span class="tokens">' + dots + more + '</span><span class="count">×' +
          place.tokens + "</span></div>";
      }).join("");
    }
    var active = parseEntries(step.active);
    activeEl.innerHTML = active.length === 0
      ? '<div style="color:#8fa8c0">(none)</div>'
      : active.map(function (entry) { return '<span class="chip">' + esc(entry) + "</span>"; }).join("");
    var suspended = parseEntries(step.suspended);
    suspendedWrap.hidden = suspended.length === 0;
    suspendedEl.innerHTML = suspended.map(function (entry) {
      return '<span class="chip suspended">' + esc(entry) + "</span>";
    }).join("");
    firedEl.textContent = step.transition || "(initial state)";
    elapsedEl.textContent = "t = " + (step.elapsed || "0");
    stateEl.textContent = step.state;
    rangeEl.value = String(index);
    counterEl.textContent = (index + 1) + " / " + steps.length;
    var buttons = timelineEl.children;
    for (var position = 0; position < buttons.length; position += 1) {
      buttons[position].className = "step" + (position === index ? " active" : position < index ? " past" : "");
    }
  }

  function stop() {
    playing = false;
    if (timer) { clearTimeout(timer); timer = null; }
    playEl.textContent = "PLAY";
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!playing) return;
    if (index >= steps.length - 1) { stop(); return; }
    timer = window.setTimeout(function () {
      index += 1;
      render();
      schedule();
    }, 900 / speed);
  }

  function play() {
    if (index >= steps.length - 1) index = 0;
    playing = true;
    playEl.textContent = "PAUSE";
    render();
    schedule();
  }

  playEl.addEventListener("click", function () {
    if (playing) { stop(); } else { play(); }
  });
  document.getElementById("reset").addEventListener("click", function () { stop(); index = 0; render(); });
  document.getElementById("prev").addEventListener("click", function () {
    stop(); index = Math.max(0, index - 1); render();
  });
  document.getElementById("next").addEventListener("click", function () {
    stop(); index = Math.min(steps.length - 1, index + 1); render();
  });
  document.getElementById("end").addEventListener("click", function () {
    stop(); index = steps.length - 1; render();
  });
  rangeEl.addEventListener("input", function () {
    stop(); index = Number(rangeEl.value); render();
  });
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
