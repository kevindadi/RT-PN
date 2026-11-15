# RT-PN

Native desktop workbench for the **Priority Timed Petri Net (PTPN)** analyzer.

RT-PN is the Rust desktop front-end of
[PrioritizedTPN](https://github.com/kevindadi/PrioritizedTPN). The analyzer,
lowering and scheduling analysis stay in the original C++17 CLI; RT-PN owns the
desktop workflow, text-first presentation and explicit graph previews.

Built with **Tauri 2 + React + TypeScript**:

- native window and file dialogs, Rust command boundary
- CodeMirror 6 for dense text stages, line numbers, search and selection
- React Flow for on-demand PTPN / state-class / CFG / thread previews
- no graph is shown by default; text remains the primary representation

## Workflows

### Specification-first

`RTSL` / TDG JSON / PTPN → analyzer → `DAG`, `PTPN`, `STATE SPACE`, `TIMELINE`,
`REPORT` text stages. Assumptions, core/priority coverage, exactness and
truncation stay visible in the inspector; `PREVIEW` opens a PTPN or state-class
graph.

### Binary-first

`ELF` + an external parser bundle → `ELF`, `CFG`, `THREADS`, `NET` text stages.
The binary analysis backend is intentionally pending: these views are parser
artifacts and preview only, not a certified schedulability verdict.

Bundle discovery supports both names:

```text
<elf>.bundle.json
<stem>.bundle.json
```

and the legacy `<elf>.dag.json` / `<elf>.tdg.json` net-only sidecars. Expected
sections are `elf`, `cfg`, `threads` and `net`; nested `cfg.functions[]` blocks
are also accepted. Binary analysis is intentionally pending, so these views are
parser artifacts and previews, not a certified schedulability verdict.

## Development

Prerequisites:

- Rust (MSVC toolchain on Windows)
- Node.js 20+ and npm
- WebView2 (included with Windows 11)
- the C++ `ptpn` analyzer built from the parent repository

```bash
npm install
npm run tauri dev
```

`ptpn` discovery order:

1. `PTPN_BIN`
2. `cmake-build-debug-mingw/ptpn.exe` (and the release/desktop variants)
3. executable-relative build directories
4. `PATH`

The desktop app never reimplements analysis. It launches the CLI with
`tdg|rtsl|ptpn -f … --export-ptpn --export-scg --export-metrics --export-wcet`
and parses the exports.

Exports default to `%LOCALAPPDATA%\RT-PN\artifacts` on Windows. If that
directory is not writable (for example under a restricted runner), RT-PN probes
and falls back to `.rt-pn-artifacts` in the current workspace. Override with:

```text
PTPN_ARTIFACT_DIR
PTPN_MINGW_BIN        # MinGW runtime `bin` directory, if needed
```

A model can also be opened by launching the app with a path argument:

```bash
rt-pn.exe example/motivating-examples/hw.json
rt-pn.exe firmware.elf
```

## Build

```bash
npm run tauri build
```

The standalone executable is produced under `src-tauri/target/release/`.
Installers use the Tauri bundle configuration in `src-tauri/tauri.conf.json`.

## Keyboard

- `Ctrl+F` / `Cmd+F` — search within the active text stage
- `Esc` — close a graph preview
- drag an `.rtsl`, `.json`, `.ptpn`, `.elf`, `.out` or `.axf` file onto the window

## Layout

```text
src/                 React workbench
  App.tsx            workflow, stages, inspector, run history
  CodeStage.tsx      CodeMirror text surface
  GraphPreview.tsx   React Flow preview
  api.ts             Tauri commands and native dialogs
src-tauri/src/       Rust backend
  lib.rs             Tauri commands
  cli.rs             ptpn discovery + export orchestration
  model.rs           analysis result model
  dot.rs             PTPN / state-class DOT parser
  workbench.rs       text stage renderers
  binary.rs          ELF parser bundle loader
  graph.rs           serializable preview graph
```

![RT-PN workbench](docs/workbench.png)

## Status

- Specification-first: functional.
- Binary-first: parser artifacts, CFG / thread / net previews; analysis pending.
- Qt desktop: replaced by RT-PN; the C++ CLI remains unchanged.


