import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import { analyzeElf, writeTextFile } from "./api";
import type { BinaryProfile, ElfWorkflow } from "./types";

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const show = (value: number | null, digits = 1): string =>
  value === null ? "-" : digits > 0 ? value.toFixed(digits) : String(Math.round(value));

interface RootWcet {
  status: string;
  cycles: number | null;
  time: number | null;
}

interface ProfileSummary {
  label: string;
  path: string;
  model: string;
  determinism: string;
  functions: number;
  blocks: number;
  wcet: {
    analyzed: number;
    partial: number;
    unbounded: number;
    roots: Record<string, RootWcet>;
  } | null;
  icache: { blocks: number; fallback: number; size: number } | null;
  dcache: { accesses: number; resolved: number; lines: number } | null;
  memory: { accesses: number; mapped: number; wait: number } | null;
  branch: { analyzed: number; fallback: number; penalty: number } | null;
}

function summarize(label: string, path: string, payload: ElfWorkflow): ProfileSummary {
  const analysis = payload.analysis;
  const model = record(analysis?.model) ?? {};
  const wcet = record(analysis?.wcet);
  const icache = record(analysis?.cache);
  const dcache = record(analysis?.data_cache);
  const memory = record(analysis?.data_memory);
  const branch = record(analysis?.branch_prediction);
  const roots: Record<string, RootWcet> = {};
  if (Array.isArray(wcet?.roots)) {
    for (const root of wcet!.roots as Array<Record<string, unknown>>) {
      const key = str(root.name) || str(root.function);
      if (!key) continue;
      roots[key] = {
        status: str(root.status) || "unknown",
        cycles: num(root.cycles),
        time: num(root.time_ns),
      };
    }
  }
  return {
    label,
    path,
    model: str(model.id),
    determinism: str(model.determinism),
    functions: payload.functions,
    blocks: payload.blocks,
    wcet: wcet
      ? {
          analyzed: num(wcet.functions_analyzed) ?? 0,
          partial: num(wcet.functions_partial) ?? 0,
          unbounded: num(wcet.functions_unbounded) ?? 0,
          roots,
        }
      : null,
    icache: icache
      ? {
          blocks: num(icache.blocks_analyzed) ?? 0,
          fallback: num(icache.blocks_fallback) ?? 0,
          size: num(icache.size) ?? 0,
        }
      : null,
    dcache: dcache
      ? {
          accesses: num(dcache.memory_accesses) ?? 0,
          resolved: num(dcache.resolved_memory_accesses) ?? 0,
          lines: num(dcache.line_accesses) ?? 0,
        }
      : null,
    memory: memory
      ? {
          accesses: num(memory.accesses) ?? 0,
          mapped: num(memory.mapped_accesses) ?? 0,
          wait: num(memory.wait_cycles) ?? 0,
        }
      : null,
    branch: branch
      ? {
          analyzed: num(branch.branches_analyzed) ?? 0,
          fallback: num(branch.branches_fallback) ?? 0,
          penalty: num(branch.mispredict_penalty) ?? 0,
        }
      : null,
  };
}

function profileName(profiles: BinaryProfile[], path: string): string {
  return profiles.find((profile) => profile.path === path)?.name ?? "no profile";
}

function StatusCell({ value }: { value: RootWcet | undefined }) {
  if (!value) return <td align="right">-</td>;
  return (
    <td align="right" className={`wcet-status ${value.status}`}>
      {value.status}
    </td>
  );
}

export function BinaryCompare({
  elfPath,
  profiles,
  cpu,
  freq,
  defaultProfile,
}: {
  elfPath: string;
  profiles: BinaryProfile[];
  cpu: string;
  freq: string;
  defaultProfile: string;
}) {
  const fallbackA = defaultProfile || profiles[0]?.path || "";
  const [profileA, setProfileA] = useState(fallbackA);
  const [profileB, setProfileB] = useState(
    profiles.find((profile) => profile.path !== fallbackA)?.path ?? "",
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [summaryA, setSummaryA] = useState<ProfileSummary | null>(null);
  const [summaryB, setSummaryB] = useState<ProfileSummary | null>(null);
  const [exportNote, setExportNote] = useState("");

  useEffect(() => {
    if (!profileA) {
      const next = defaultProfile || profiles[0]?.path || "";
      if (next) setProfileA(next);
    }
    if (!profileB) {
      const preferred = defaultProfile || profiles[0]?.path || "";
      const next = profiles.find((profile) => profile.path !== preferred)?.path ?? "";
      if (next) setProfileB(next);
    }
  }, [defaultProfile, profiles, profileA, profileB]);

  const options = (profile: string) => ({
    cpu: cpu || undefined,
    freq: freq || undefined,
    board_profile: profile || undefined,
  });

  const runComparison = async () => {
    if (!elfPath || !profileA || !profileB || profileA === profileB) return;
    setRunning(true);
    setError("");
    setSummaryA(null);
    setSummaryB(null);
    try {
      const [a, b] = await Promise.all([
        analyzeElf(elfPath, options(profileA)),
        analyzeElf(elfPath, options(profileB)),
      ]);
      setSummaryA(summarize(profileName(profiles, profileA), profileA, a));
      setSummaryB(summarize(profileName(profiles, profileB), profileB, b));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRunning(false);
    }
  };

  const roots = Object.keys({
    ...(summaryA?.wcet?.roots ?? {}),
    ...(summaryB?.wcet?.roots ?? {}),
  }).sort();

  const counterRows: Array<[string, (s: ProfileSummary) => string]> = [
    ["model", (s) => `${s.model || "-"}${s.determinism ? ` (${s.determinism})` : ""}`],
    ["functions / blocks", (s) => `${s.functions} / ${s.blocks}`],
    [
      "wcet analyzed / partial / unbounded",
      (s) =>
        s.wcet
          ? `${s.wcet.analyzed} / ${s.wcet.partial} / ${s.wcet.unbounded}`
          : "-",
    ],
    [
      "icache blocks / fallback",
      (s) => (s.icache ? `${s.icache.blocks} / ${s.icache.fallback}` : "-"),
    ],
    [
      "dcache accesses / resolved / lines",
      (s) =>
        s.dcache ? `${s.dcache.accesses} / ${s.dcache.resolved} / ${s.dcache.lines}` : "-",
    ],
    [
      "data-memory accesses / mapped / wait",
      (s) => (s.memory ? `${s.memory.accesses} / ${s.memory.mapped} / ${s.memory.wait}` : "-"),
    ],
    [
      "branch branches / fallback / penalty",
      (s) =>
        s.branch
          ? `${s.branch.analyzed} / ${s.branch.fallback} / ${s.branch.penalty} cy`
          : "-",
    ],
  ];

  const wcetRows = () => {
    if (!summaryA || !summaryB) return [];
    const keys = Object.keys({
      ...(summaryA.wcet?.roots ?? {}),
      ...(summaryB.wcet?.roots ?? {}),
    }).sort();
    return keys.map((root) => {
      const a = summaryA.wcet?.roots[root];
      const b = summaryB.wcet?.roots[root];
      const delta =
        a?.cycles !== undefined &&
        a?.cycles !== null &&
        b?.cycles !== undefined &&
        b?.cycles !== null
          ? b.cycles - a.cycles
          : null;
      return { root, a, b, delta };
    });
  };

  const exportComparison = async (format: "md" | "json") => {
    if (!summaryA || !summaryB) return;
    setExportNote("");
    try {
      const base = (elfPath.split(/[\\/]/).pop() ?? "binary").replace(/\.[^.]+$/, "");
      const target = await save({
        defaultPath: `${base}.profile-compare.${format}`,
        filters: [
          {
            name: format === "md" ? "Comparison report" : "Comparison JSON",
            extensions: [format],
          },
        ],
      });
      if (!target) return;
      const rows = wcetRows();
      let contents: string;
      if (format === "md") {
        const lines = [
          `# Binary profile comparison - ${base}`,
          "",
          `- ELF: ${elfPath}`,
          `- CPU: ${cpu || "auto"} | frequency: ${freq || "profile default"}`,
          `- profile A: ${profileName(profiles, profileA)} (${profileA})`,
          `- profile B: ${profileName(profiles, profileB)} (${profileB})`,
          "",
          "## Metrics",
          "",
          "| metric | A | B |",
          "| --- | --- | --- |",
          ...counterRows.map(
            ([label, value]) => `| ${label} | ${value(summaryA)} | ${value(summaryB)} |`,
          ),
          "",
          "## WCET roots",
          "",
          "| root | A status | A cycles | B status | B cycles | Delta cycles (B-A) |",
          "| --- | --- | ---: | --- | ---: | ---: |",
          ...rows.map(
            (row) =>
              `| ${row.root} | ${row.a?.status ?? "-"} | ${show(row.a?.cycles ?? null)} | ${row.b?.status ?? "-"} | ${show(row.b?.cycles ?? null)} | ${row.delta === null ? "-" : `${row.delta > 0 ? "+" : ""}${row.delta.toFixed(1)}`} |`,
          ),
          "",
          "## Note",
          "",
          "Static estimates only - WCET is a CFG longest-path bound under the profile's",
          "loop bounds, not a hardware proof. CPU/frequency come from run control.",
          "",
        ];
        contents = lines.join("\n");
      } else {
        contents = JSON.stringify(
          {
            elf: elfPath,
            cpu,
            frequency: freq,
            profileA: { name: profileName(profiles, profileA), path: profileA },
            profileB: { name: profileName(profiles, profileB), path: profileB },
            metrics: counterRows.map(([label, value]) => ({
              metric: label,
              a: value(summaryA),
              b: value(summaryB),
            })),
            wcet: rows.map((row) => ({
              root: row.root,
              a: row.a ?? null,
              b: row.b ?? null,
              delta_cycles: row.delta,
            })),
            timing_model: {
              a: summaryA.model,
              b: summaryB.model,
            },
          },
          null,
          2,
        );
      }
      await writeTextFile(target, contents);
      setExportNote(`saved ${target}`);
    } catch (reason) {
      setExportNote(String(reason));
    }
  };

  return (
    <section className="bin-compare">
      <div className="analysis-toolbar">
        <div>
          <div className="sem-eyebrow">PROFILE A/B COMPARISON</div>
          <h3 className="analysis-title">Same image, two board profiles</h3>
          <div className="faint">
            Runs the ELF twice with the current CPU/frequency and the selected profiles,
            then compares WCET roots and static-analysis counters.
          </div>
        </div>
        <div className="action-row">
          <button
            className="btn small accent"
            disabled={running || !profileA || !profileB || profileA === profileB}
            onClick={() => void runComparison()}
          >
            {running ? "COMPARING..." : "RUN COMPARISON"}
          </button>
          <button
            className="btn small"
            disabled={!summaryA || !summaryB}
            onClick={() => void exportComparison("md")}
          >
            EXPORT MD
          </button>
          <button
            className="btn small"
            disabled={!summaryA || !summaryB}
            onClick={() => void exportComparison("json")}
          >
            EXPORT JSON
          </button>
        </div>
      </div>
      {exportNote && <div className="faint analysis-note">{exportNote}</div>}

      <div className="bin-compare-pickers">
        <label>
          <span>PROFILE A</span>
          <select value={profileA} onChange={(event) => setProfileA(event.target.value)}>
            <option value="">no board profile</option>
            {profiles.map((profile) => (
              <option key={profile.path} value={profile.path}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>PROFILE B</span>
          <select value={profileB} onChange={(event) => setProfileB(event.target.value)}>
            {profiles.map((profile) => (
              <option key={profile.path} value={profile.path}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        {profileA === profileB && (
          <span className="faint">pick two different profiles</span>
        )}
      </div>

      {error && <div className="bin-cfg-error">{error}</div>}

      {summaryA && summaryB && (
        <>
          <table className="bin-table bin-compare-table">
            <thead>
              <tr>
                <th align="left">metric</th>
                <th align="left">A | {summaryA.label}</th>
                <th align="left">B | {summaryB.label}</th>
              </tr>
            </thead>
            <tbody>
              {counterRows.map(([label, value]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="mono">{value(summaryA)}</td>
                  <td className="mono">{value(summaryB)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="bin-table bin-compare-table">
            <thead>
              <tr>
                <th align="left">wcet root</th>
                <th align="right">A status</th>
                <th align="right">A cycles</th>
                <th align="right">B status</th>
                <th align="right">B cycles</th>
                <th align="right">Delta cycles (B-A)</th>
              </tr>
            </thead>
            <tbody>
              {roots.map((root) => {
                const a = summaryA.wcet?.roots[root];
                const b = summaryB.wcet?.roots[root];
                const delta =
                  a?.cycles !== null &&
                  a?.cycles !== undefined &&
                  b?.cycles !== null &&
                  b?.cycles !== undefined
                    ? b.cycles - a.cycles
                    : null;
                return (
                  <tr key={root}>
                    <td className="bin-name">{root}</td>
                    <StatusCell value={a} />
                    <td align="right">{show(a?.cycles ?? null)}</td>
                    <StatusCell value={b} />
                    <td align="right">{show(b?.cycles ?? null)}</td>
                    <td
                      align="right"
                      className={
                        delta === null ? "faint" : delta > 0 ? "bin-delta-bad" : delta < 0 ? "bin-delta-good" : ""
                      }
                    >
                      {delta === null
                        ? "-"
                        : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`}
                    </td>
                  </tr>
                );
              })}
              {roots.length === 0 && (
                <tr>
                  <td colSpan={6} className="faint">
                    Neither profile produced WCET roots; select WCET board profiles.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {!summaryA && !summaryB && !running && (
        <div className="faint">
          Choose two board profiles (e.g. icache vs dcache/WCET) and run the comparison.
        </div>
      )}
      <div className="faint" style={{ marginTop: 8 }}>
        Static estimates only - WCET is a CFG longest-path bound under the profile's loop
        bounds, not a hardware proof. CPU/frequency come from RUN CONTROL; use a matching
        CPU when profiles target different cores.
      </div>
    </section>
  );
}
