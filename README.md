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

`ELF` → readable ELF layout → readable CFG + preview image.

Importing an `.elf`, `.out` or `.axf` binary now runs the bundled `elf2tdg`
extractor instead of loading a pre-made parser bundle:

1. `elf2tdg <elf> --view elf` writes a readable ELF loader view
   (`<stem>.elf.mmd`, Mermaid layout source) shown in the `ELF` stage.
2. `elf2tdg <elf> --view cfg --format json` writes a readable CFG document
   (`<stem>.cfg.json`); the `CFG` stage renders a compact listing of functions,
   blocks and calls, and `PREVIEW` shows the Graphviz SVG rendering of
   `<stem>.cfg.dot` (falling back to an interactive function-level graph when
   Graphviz is not installed).
3. Raw `elf2tdg` outputs are kept next to the analysis artifacts
   (`%LOCALAPPDATA%\RT-PN\artifacts\elf-*` on Windows; override with
   `PTPN_ARTIFACT_DIR`).

Threads/net stages and the PTPN analysis backend are intentionally pending:
these views are parser artifacts and previews, not a certified schedulability
verdict. The Rust Petri-net simulator backend is developed separately.

## Development

Prerequisites:

- Rust (MSVC toolchain on Windows)
- Node.js 20+ and npm
- WebView2 (included with Windows 11)
- CMake 3.27+, Ninja, a vcpkg checkout, and the Visual Studio C++ build tools
  (the release `ptpn` is a static MSVC build)
- `just` (`winget install --id Casey.Just`)

The two analysis engines are git submodules under `engines/`; the top-level
`just` recipes build them and stage them as Tauri sidecars:

```bash
git submodule update --init
npm install
just doctor        # report the detected CMake/Ninja/C++/vcpkg/rustc
just dev           # build + stage the engines, then start the desktop app
```

Machine-local tool paths can live in `.env.local` (start from
`.env.local.example`). Detection prefers the environment overrides, then `PATH`,
then the Visual Studio toolchain (CMake, `cl.exe` via `vcvars64.bat`) and the
CMake/Ninja bundled with CLion, then `D:/vcpkg` for vcpkg.

The desktop window is created in Rust, so WebView2 state is kept in
`.webview2/` during development and under the portable package's `webview2/`
directory when `RT_PN_WEBVIEW_DATA_DIR` is set.

The plain `npm run tauri dev` still works once the sidecars are staged with
`just stage`.

`ptpn` discovery order:

1. `PTPN_BIN`
2. `ptpn.exe` next to the app executable (Tauri sidecar)
3. `cmake-build-debug-mingw/ptpn.exe` (and the release/desktop variants)
4. executable-relative build directories
5. `PATH`

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
just build     # stage the engines, then `tauri build`
just dist      # installers + portable zip + versions.json
```

Artifacts:

- `src-tauri/target/release/bundle/` — NSIS installer and MSI
- `dist/rt-pn-portable/` and `dist/RT-PN-<version>-portable-<arch>.zip` —
  portable package with both engine CLIs in `bin/`
- `dist/rt-pn-portable/versions.json` — exact engine commits and tool versions

Plain `npm run tauri build` works too, but requires the sidecars to be staged
first (`just stage`): Tauri validates `bundle.externalBin` at build time.

The application icon is generated from `scripts/make-icon.ps1`
(`npm run tauri -- icon src-tauri/icons/source.png`); the generated
`src-tauri/icons/` set is committed because the Windows bundlers need it.

Other recipes: `just test` (engine tests + typecheck + e2e), `just engines`
(engine builds only), `just update-engines` (bump the submodule pins), and
`just clean`.

## Keyboard

- `Ctrl+F` / `Cmd+F` — search within the active text stage
- `Esc` — close a graph preview
- drag an `.rtsl`, `.json`, `.ptpn`, `.elf`, `.out` or `.axf` file onto the window

## Layout

```text
engines/prioritized-tpn/  C++ analyzer submodule (PTPN / WCRT / deadlock CLI)
engines/elf2tdg/          Rust ELF -> Task Dependency Graph submodule
docs/ptpn/                Analyzer documentation moved from the CLI repository
scripts/                  build / stage / package / version scripts
Justfile                  unified build entry
build/                    generated engine build outputs (ignored)
src-tauri/binaries/       generated Tauri sidecars (ignored)
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
- Binary-first: `elf2tdg` drives the ELF loader view, readable CFG and Graphviz
  preview image; threads/net and the analysis backend are pending.
- Unified build: `just` + engine submodules; both CLIs ship as Tauri sidecars.
- Qt desktop: replaced by RT-PN; the C++ CLI remains unchanged.


