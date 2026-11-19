import { useMemo, useState } from "react";

import type { BinaryFunctionRow, ElfWorkflow } from "./types";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const formatCycles = (row: BinaryFunctionRow): string => {
  if (row.cycles_max === null && row.cycles_min === null) return "-";
  const min = row.cycles_min === null ? "-" : row.cycles_min.toFixed(1);
  const max = row.cycles_max === null ? "-" : row.cycles_max.toFixed(1);
  return `${min}-${max} cy`;
};

const ARCH_PRESETS: Record<string, { label: string; cpu: string; freq: string }> = {
  thumb: { label: "Arm Cortex-M", cpu: "cortex-m4", freq: "168MHz" },
  aarch64: { label: "Arm AArch64", cpu: "aarch64", freq: "1GHz" },
  riscv: { label: "RISC-V", cpu: "riscv32", freq: "100MHz" },
  riscv32: { label: "RISC-V 32", cpu: "riscv32", freq: "100MHz" },
  "x86-64": { label: "x86-64", cpu: "x86-64", freq: "3GHz" },
  x86_64: { label: "x86-64", cpu: "x86-64", freq: "3GHz" },
};

function presetForArch(arch: string): { label: string; cpu: string; freq: string } | null {
  const normalized = arch.toLowerCase();
  const direct = ARCH_PRESETS[normalized];
  if (direct) return direct;
  const match = Object.entries(ARCH_PRESETS).find(([key]) => normalized.includes(key));
  return match ? match[1] : null;
}

function friendlyCaveat(caveat: string): string {
  if (caveat.includes("No instruction timing model is available")) {
    return "No instruction timing model was resolved. Configure a compatible CPU to add timing estimates.";
  }
  return caveat;
}

export function BinaryOverview({
  binary,
  onApplyPreset,
  onSelectFunction,
}: {
  binary: ElfWorkflow;
  onApplyPreset: (cpu: string, freq: string) => void;
  onSelectFunction: (row: BinaryFunctionRow) => void;
}) {
  const timing = binary.timing as Record<string, unknown>;
  const image = binary.image;
  const models = Array.isArray(timing.models)
    ? (timing.models as Array<Record<string, unknown>>)
    : [];
  const domains = Array.isArray(timing.frequency_domains)
    ? (timing.frequency_domains as Array<Record<string, unknown>>)
    : [];
  const hot = useMemo(
    () =>
      [...binary.function_rows]
        .sort(
          (left, right) =>
            (right.cycles_max ?? -1) - (left.cycles_max ?? -1) ||
            (right.size ?? 0) - (left.size ?? 0),
        )
        .slice(0, 12),
    [binary.function_rows],
  );
  const model = models[0] ?? {};
  const firstDomain = domains[0] ?? {};
  const arch = text(image.arch);
  const preset = presetForArch(arch);

  return (
    <div className="bin-overview">
      <div className="bin-cards">
        <section className="bin-card">
          <div className="sem-eyebrow">IMAGE</div>
          <h3 className="bin-card-title">{binary.elf_path.split(/[\\/]/).pop() ?? "ELF"}</h3>
          <div className="bin-facts">
            {[
              ["arch", text(image.arch) || "-"],
              ["entry", text(image.entry) || "-"],
              ["type", text(image.elf_type) || "-"],
              ["symbols", image.has_symbols === true ? "yes" : "no"],
              ["debug info", image.has_debug_info === true ? "yes" : "no"],
              ["size", `${(binary.file_size / 1024).toFixed(1)} KB`],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <b>{String(value)}</b>
              </div>
            ))}
          </div>
        </section>

        <section className="bin-card">
          <div className="sem-eyebrow">TIMING MODEL</div>
          <h3 className="bin-card-title">
            {text(model.id) || "no instruction model"}
          </h3>
          <div className="bin-facts">
            {[
              ["core", text(model.core) || "-"],
              ["determinism", text(model.determinism) || "-"],
              ["table", text(model.table_version) || "-"],
              [
                "frequency",
                numeric(firstDomain.hz) !== null
                  ? `${(numeric(firstDomain.hz)! / 1_000_000).toFixed(1)} MHz`
                  : "-",
              ],
              ["domains", String(domains.length)],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <b>{String(value)}</b>
              </div>
            ))}
          </div>
        </section>

        <section className="bin-card">
          <div className="sem-eyebrow">PROGRAM CFG | SCHEMA {binary.schema || "-"}</div>
          <div className="bin-stat-grid">
            <span>
              <b>{binary.functions}</b>
              <small>functions</small>
            </span>
            <span>
              <b>{binary.blocks}</b>
              <small>blocks</small>
            </span>
            <span>
              <b>{binary.calls}</b>
              <small>calls</small>
            </span>
            <span>
              <b>{binary.roots.length}</b>
              <small>roots</small>
            </span>
            <span>
              <b>{binary.concurrency.length}</b>
              <small>concurrency</small>
            </span>
            <span>
              <b>{binary.diagnostics}</b>
              <small>diagnostics</small>
            </span>
          </div>
        </section>
      </div>

      {preset && (
        <section className="bin-card bin-card-wide bin-arch-banner">
          <div className="bin-arch-text">
            <span className="sem-eyebrow">DETECTED ARCHITECTURE</span>
            <b>
              {arch || "unknown"} to preset {preset.label} | {preset.cpu} @ {preset.freq}
            </b>
            <span className="faint">Review this suggested CPU and frequency in Configuration before the next run.</span>
          </div>
          <button className="btn small accent" onClick={() => onApplyPreset(preset.cpu, preset.freq)}>
            Review preset
          </button>
        </section>
      )}

      {binary.caveats.length > 0 && (
        <section className="bin-caveats">
          <div className="sem-eyebrow">ANALYSIS CAVEATS</div>
          <ul>
            {binary.caveats.map((caveat) => (
              <li key={caveat}>{friendlyCaveat(caveat)}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="bin-card bin-card-wide">
        <div className="sem-eyebrow">HOT FUNCTIONS | MAX BLOCK CYCLES (STATIC ESTIMATE)</div>
        <table className="bin-table">
          <thead>
            <tr>
              <th align="left">function</th>
              <th align="left">address</th>
              <th align="left">kind</th>
              <th align="right">size</th>
              <th align="right">blocks</th>
              <th align="right">cycles</th>
            </tr>
          </thead>
          <tbody>
            {hot.map((row) => (
              <tr key={row.id ?? row.address ?? row.name}>
                <td className="bin-name">
                  <button className="wb-button wb-quiet" onClick={() => onSelectFunction(row)}>
                    {row.name || row.address || "Unnamed function"}
                  </button>
                </td>
                <td className="mono">{row.address ?? "-"}</td>
                <td>{row.kind ?? "-"}</td>
                <td align="right">{row.size ?? "-"}</td>
                <td align="right">{row.blocks}</td>
                <td align="right">{formatCycles(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="faint">
          Cycle values are static estimates. Open a function to inspect its blocks and instructions.
        </div>
      </section>
    </div>
  );
}

export function BinaryFunctions({
  binary,
  onSelect,
}: {
  binary: ElfWorkflow;
  onSelect: (row: BinaryFunctionRow) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const kinds = useMemo(() => {
    const values = new Set<string>();
    for (const row of binary.function_rows) {
      if (row.kind) values.add(row.kind);
    }
    return ["all", ...[...values].sort()];
  }, [binary.function_rows]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return binary.function_rows.filter((row) => {
      if (kind !== "all" && row.kind !== kind) return false;
      if (!needle) return true;
      return (
        (row.name ?? "").toLowerCase().includes(needle) ||
        (row.demangled_name ?? "").toLowerCase().includes(needle) ||
        (row.address ?? "").toLowerCase().includes(needle)
      );
    });
  }, [binary.function_rows, kind, query]);

  return (
    <div className="bin-functions">
      <div className="bin-toolbar">
        <input
          type="search"
          aria-label="Filter by function name or address"
          placeholder="Filter by name or address..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select aria-label="Function kind" value={kind} onChange={(event) => setKind(event.target.value)}>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All kinds" : value}
            </option>
          ))}
        </select>
        <span className="faint">
          {rows.length} / {binary.function_rows.length} functions
        </span>
      </div>
      <table className="bin-table bin-table-wide">
        <thead>
          <tr>
            <th align="left">function</th>
            <th align="left">address</th>
            <th align="left">kind</th>
            <th align="right">size</th>
            <th align="right">blocks</th>
            <th align="right">calls</th>
            <th align="right">cycles</th>
            <th align="right">inline</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id ?? row.address ?? row.name}>
              <td className="bin-name">
                <button className="wb-button wb-quiet" onClick={() => onSelect(row)}>
                  {row.name || row.address || "Unnamed function"}
                </button>
              </td>
              <td className="mono">{row.address ?? "-"}</td>
              <td>{row.kind ?? "-"}</td>
              <td align="right">{row.size ?? "-"}</td>
              <td align="right">{row.blocks}</td>
              <td align="right">{row.calls}</td>
              <td align="right">{formatCycles(row)}</td>
              <td align="right">{row.inline_frames > 0 ? row.inline_frames : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="wb-muted">No functions match these filters.</p>}
    </div>
  );
}
