# Binary analysis workspace — UI design proposal

Proposal for the ELF/CFG workspace built on the synced elf2tdg (CFG schema 2.4,
M3 static analysis: instruction/data caches, branch prediction, data-memory
latency, event-driven WCET longest-path analysis). Scheduling analysis stays in
its own workspace; this document is only about the binary side.

## 1. Goals

- Make the **CFG the primary artifact**, not a secondary text dump: ELF layout,
  roots/call graph, function/block structure, instructions and timing metadata
  all come from the same `cfg_schema_version: "2.4"` document.
- Keep the two workflows visually and structurally separate (binary accent:
  violet; scheduling accent: blue).
- Surface the new analysis dimensions honestly: every timing number is a
  **static estimate**, never a certified WCET bound. Caveats from
  `timing.models[].caveats` and `timing.caveats` must be visible, not buried.
- Optimise for research use: inspect a function, read its blocks and cycles,
  compare analysis profiles, export a reproducible report.

## 2. Layout

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ RT-PN   BINARY · firmware.elf     [Cortex-M4] [168 MHz]   RUN ANALYSIS  OPEN │
├──────────────┬───────────────────────────────────────────────┬─────────────┤
│ BINARY       │  OVERVIEW  ELF LAYOUT  FUNCTIONS  CFG  ANALYSIS│ INSPECTOR   │
│  file/arch   │  ─────────────────────────────────────────────│ selection   │
│  entry/sym   │                                               │ function /  │
│              │   ← stage content (cards, tables, graph) →    │ block /     │
│ PROFILE      │                                               │ instruction │
│  CPU model   │                                               │ diagnostics │
│  board .toml │                                               │ caveats     │
│  frequency   │                                               │             │
│              │                                               │             │
│ ROOTS/TASKS  │                                               │             │
│  startup     │                                               │             │
│  isr · main  │                                               │             │
│  spawn sites │                                               │             │
│              │                                               │             │
│ RUN + DIAG   │                                               │             │
└──────────────┴───────────────────────────────────────────────┴─────────────┘
```

Topbar: binary badge, file chip (`firmware.elf`), active CPU/frequency chips,
`RUN ANALYSIS`, `IMPORT ELF`. The scheduling-only controls never render here.

### Left rail (300 px)

1. **BINARY** — path, `image.arch`, entry point, `has_symbols` /
   `has_debug_info` badges. Missing debug info shows an amber warning because it
   degrades inline-frame recovery and call resolution.
2. **ANALYSIS PROFILE** — the configuration block:
   - CPU/timing model `<select>` (`--cpu`, e.g. `cortex-m4`, `riscv32`,
     `aarch64`, `x86-64`, or `auto`);
   - board profile picker (`--board-profile`, lists
     `examples/elf2tdg/profiles/*.toml` plus user-selected files): icache,
     dcache, branch predictor, data memory, WCET profile;
   - frequency field (`--freq`, accepts `168MHz` or `168000000`);
   - compact toggles: `--no-cfg-instructions`, `--all-functions`,
     `--max-diagnostics`.
   - A profile summary card: id, schema version, SHA-256, source path, and a
     caveat count. "Open in editor" arrives in phase 3.
3. **ROOTS & CONCURRENCY** — two short lists:
   - execution roots (`startup`, `main`, ISR vectors, tasks) with kind and
     confidence chips; clicking a root selects `--function`/`--reachable-from`;
   - concurrency sites (`spawn`, `lock`, …) with runtime/API and target entry;
     clicking jumps to the target function.
4. **RUN** — run/cancel, progress (decode → CFG → profile analysis), artifact
   folder link.
5. **DIAGNOSTICS** (collapsed) — severity-filtered list; clicking an entry
   opens the function/block/instruction it points at.

### Center stages

| Stage | Content |
|---|---|
| **OVERVIEW** | Image card (segments, sections, entry, arch, symbol/debug status); timing card (model id, determinism, caveats); counts (functions, roots, calls, concurrency sites); "hot functions" table ranked by `blocks[].cycles.max`; profile chip + schema badge. |
| **ELF LAYOUT** | Render the Mermaid layout (`--view elf`) with the existing `Mermaid` component instead of raw text; controls for `--elf-max-insns` (256 default, 0 = unlimited) and a warning that large images become unreadable. |
| **FUNCTIONS** | Virtualised table: primary name, address, size, kind, language, cycles min/max, inline-frame count, call count. Search by name/address; filter by kind (normal/ISR/task/startup). Row click → CFG stage for that function; right-click "export slice". |
| **CFG** | Function selector (search + address), block graph (React Flow, phase 2; phase 1 uses a readable block list). Nodes carry address, terminator, cycles min/max; edges typed `branch`/`fallthrough`/`call`; entry node and unresolved calls marked. Block click → inspector shows instructions, calls, inline frames; call edges clickable to navigate. |
| **ANALYSIS** | Profile-driven result cards, each with a compact table and caveat footnote: <br>• **Instruction cache** — hit/miss/dirty per function, LRU state highlights; <br>• **Data cache** — read/write accesses, hit/miss by region; <br>• **Branch prediction** — static/BTFN/two-bit, mispredict cost by block; <br>• **Data memory** — per-region latency and access coverage; <br>• **WCET longest path** — only with a WCET profile: path table, loop-bound assumptions, root scope, `not a bound` banner. |
| **REPORT** | Markdown/JSON export: image + timing metadata, profile id/SHA, roots, function index, analysis tables, diagnostics, caveats. Same `EXPORT MD/JSON` affordance as scheduling mode, with a reproducible "how to reproduce" block (`elf2tdg <elf> --board-profile … --freq …`). |

### Right inspector (320 px)

Contextual, follows the current selection:

- **Selection** — function (name, demangled name, address, size, language,
  kind, section, source file:line, inline frames), block (address, size,
  terminator, cycles), call (target, site, unresolved/conditional/noreturn),
  concurrency site (kind, runtime, API, target).
- **Block detail** — decoded instructions (address/mnemonic/operands/bytes),
  cycle cost, outgoing edges, call sites.
- **Diagnostics** — severity, code, message, location; clicking navigates.
- **Caveats** — the timing model caveats and the global "static estimates are
  not WCET bounds" note, always visible in ANALYSIS/CFG stages.

## 3. Visual language

- Fonts: `Segoe UI Variable Display` for stage titles, `Segoe UI Variable Text`
  for body, `Cascadia Code` for addresses, hex, cycle costs and instruction
  mnemonics. No serif.
- Palette: slate backgrounds (`#060d18` → `#0b1422`), violet accent
  (`#8f7bff`) for binary stages, amber (`#f2c14e`) for caveats/confidence
  medium, red (`#ff7b7b`) for unresolved calls/diagnostics/errors, green
  (`#67e8a2`) for confidence high / hit.
- Component tokens:
  - **address chip** — mono, dim background, click copies;
  - **cycles badge** — `6.0–9.0 cy` with a thin range bar;
  - **confidence chip** — high/medium/low;
  - **caveat strip** — amber left border, compact text, collapsible;
  - **graph node** — entry node with a notched left edge, call nodes with a
    dashed outline, diamond branch terminators.
- Motion: stage content fades/rises 8 px (existing `sem-rise`); graph selection
  pulses once; no continuous animation except the run progress bar.

## 4. Data mapping (elf2tdg schema 2.4)

| JSON | UI |
|---|---|
| `image` | OVERVIEW image card, arch/entry badges |
| `timing.models`, `timing.frequency_domains`, `timing.caveats` | ANALYSIS timing card, profile summary, caveats |
| `roots` | ROOTS & CONCURRENCY list, root filter |
| `concurrency` | spawn/lock list, links to `operation.entry` |
| `calls` | call graph edges, unresolved-call badge |
| `functions[].primary_name/address/size/kind/language/source` | FUNCTIONS table, CFG selector |
| `functions[].inline_frames` | inspector inline-frame list |
| `functions[].blocks[].instructions/calls/cycles/terminator` | CFG nodes, inspector disassembly |
| `functions[].edges` | CFG edges (typed in schema) |
| `diagnostics`, `diagnostics_omitted` | DIAGNOSTICS + inspector |

Backend commands planned:

- `analyze_binary(path, options { cpu, board_profile, freq, function,
  reachable_from, all_functions, max_diagnostics, elf_max_insns })`
  → ELF mermaid + CFG JSON + CFG DOT/SVG + parsed summary
  (`timing`, `roots`, `concurrency`, `functions`, `diagnostics`, `caveats`,
  `profile`).
- `binary_function(path, selector, options)` → a single-function slice for the
  CFG explorer.
- `read_board_profile(path)` / `write_board_profile(path, fields)` (phase 3)
  for the profile editor.

Mermaid-rendered ELF layout reuses `src/Mermaid.tsx`; the CFG explorer is
React Flow with a readable block-list fallback so it works without layout
heuristics for large functions.

## 5. Interaction flows

1. **Import & first look** — choose ELF → auto-run with the detected CPU and no
   board profile → OVERVIEW shows image/timing/caveats and hot functions.
2. **Pick a profile** — select an icache/dcache/branch/memory/WCET TOML →
   re-run → ANALYSIS cards populate and profile SHA appears in the report.
3. **Navigate** — click a root/task/spawn site → FUNCTIONS filtered → click a
   function → CFG focused → click a block → inspector instructions; clicking a
   call target navigates to that function (breadcrumb back).
4. **Investigate a warning** — DIAGNOSTICS entry → focused function/block;
   unresolved calls are red chips with the call site address.
5. **Export** — REPORT → `EXPORT MD` produces a self-contained, reproducible
   report; `EXPORT JSON` carries the raw cfg + selected profile metadata.

## 6. Phasing

- **Phase 0 (with this sync)**: keep the existing ELF/CFG text stages working
  with schema 2.4; show timing model/caveats and the new concurrency count in
  the sidebar artifacts.
- **Phase 1**: OVERVIEW stage, Mermaid ELF stage, FUNCTIONS table, profile
  picker + run control, diagnostics fold.
- **Phase 2**: CFG explorer (React Flow + block list fallback), right-panel
  selection/inspector, inline-frame display.
- **Phase 3**: ANALYSIS cards for cache/branch/memory/WCET, board-profile
  editor, reproducible report export.
- **Phase 4**: profile A/B comparison, longest-path walkthrough (replay-style),
  export of a grouped analysis bundle.

## 7. Non-goals

- No scheduling/PTPN analysis inside the binary workspace, and no TDG stage.
- No claim that static cycle estimates are WCET or schedulability bounds; the
  UI must repeat the caveat wherever timing numbers appear.
- No instruction editing or patching — this is an inspection workbench.
