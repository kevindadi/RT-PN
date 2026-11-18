# RT-PN unified build entry. Run `just` (or `just --list`) to see the recipes.
#
# The desktop app is Tauri 2 + React; the two analysis engines are git submodules
# under engines/:
#   engines/prioritized-tpn  C++17 / CMake / MinGW static  -> ptpn CLI
#   engines/elf2tdg          Rust / cargo                 -> elf2tdg CLI
#
# Machine-local tool paths can be placed in .env.local (see .env.local.example).
# Scripts under scripts/ do the platform work; this file only sequences them.

set dotenv-load := true
set dotenv-filename := ".env.local"
set windows-shell := ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]

default:
    @just --list

# Check the host toolchain and the engine checkouts.
doctor:
    node scripts/env.mjs --check

# Write local VS Code CMake Tools presets for engine-only debugging (MinGW).
# Machine-local files only; the unified `just` build is not affected.
vscode-setup:
    node scripts/vscode-cmake-setup.mjs

# Initialize the engine submodules and report the toolchain.
setup:
    node scripts/git-engines.mjs init
    node scripts/env.mjs --check

# Build both analysis engines.
engines:
    node scripts/engines.mjs

engine-ptpn:
    node scripts/engines.mjs ptpn

engine-elf2tdg:
    node scripts/engines.mjs elf2tdg

# Copy the built CLIs into src-tauri/binaries as Tauri sidecars.
stage: engines
    node scripts/stage-sidecars.mjs

# Desktop development with bundled sidecars.
dev: stage
    npm run tauri dev

# Release build: frontend + Tauri app + NSIS/MSI installers.
build: stage
    npm run tauri build

# Full release: installers + portable zip + versions.json.
dist: build
    node scripts/package-portable.mjs

# Regenerate the build manifest only (build/versions.json + portable copy).
versions:
    node scripts/versions.mjs

# Engine tests, desktop backend tests, typecheck and the end-to-end smoke test.
test: test-engines
    npm run typecheck
    node scripts/test-desktop.mjs
    node scripts/e2e.mjs

test-engines:
    node scripts/test-engines.mjs

# Fast end-to-end smoke test only (requires `just stage`).
e2e:
    node scripts/e2e.mjs

# Move both engine submodules to the heads of their tracked branches.
# Review the resulting `git status` before committing the new pins.
update-engines:
    node scripts/git-engines.mjs update

# Remove build outputs. Engine checkouts and node_modules stay in place.
clean:
    node scripts/clean.mjs
