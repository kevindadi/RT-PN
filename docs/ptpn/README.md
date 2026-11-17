# PTPN engine documentation

Documentation for the `ptpn` real-time scheduling analyzer. These pages were
moved here from the analyzer repository when it became the
[`engines/prioritized-tpn`](../..) submodule of the RT-PN workbench. The engine
repository stays CLI-only: its README covers building, testing, Docker and the
test layout.

| Document | Contents |
|----------|----------|
| [install.md](install.md) | Dependencies, native builds, vcpkg, tests and the Docker images |
| [usage.md](usage.md) | Subcommands, reductions, core allocation, RTSL workflow and result interpretation |
| [rtsl.md](rtsl.md) | RTSL v1 reference: lexical rules, system/task syntax, units, cores, locks, provenance, bindings |
| [rtsl.ebnf](rtsl.ebnf) | Complete RTSL v1 grammar (the engine also keeps a copy as `test/reference/rtsl.ebnf` for its grammar tests) |
| [diagnostics.md](diagnostics.md) | Authoritative diagnostic code catalog: severity/exit codes, JSON envelope, command behavior |
| [architecture.md](architecture.md) | Pipeline layers, source/CMake layout, application-layer responsibilities |
| [json_format.md](json_format.md) | TDG JSON input format |

## Regenerating the diagnostic catalog

The analyzer embeds the catalog as generated C++ string literals
(`src/common/diagnostic_codes.inc`). After editing [diagnostics.md](diagnostics.md),
regenerate it from the workbench checkout:

```bash
python3 engines/prioritized-tpn/tools/gen_diagnostic_codes.py \
    --doc docs/ptpn/diagnostics.md
```

or set `PTPN_DIAGNOSTICS_MD=docs/ptpn/diagnostics.md` before running the script.

## Docker

The engine repository builds its Linux image from the repository root:

```bash
cd engines/prioritized-tpn
docker build -f Dockerfile -t ptpn .
docker run --rm -v "$PWD/example:/data" ptpn tdg -f /data/l-bench/pipeline-40t-8c-5l.json
```
