import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";

import { writeTextFile } from "./api";
import { InstructionTiming } from "./InstructionTiming";
import type { BinaryOptions, BinaryProfile, ElfWorkflow } from "./types";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const fmtNumber = (value: unknown, digits = 0): string => {
  const number = num(value);
  if (number === null) return "—";
  return digits > 0 ? number.toFixed(digits) : String(Math.round(number));
};

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function CaveatList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="analysis-caveats">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function BinaryAnalysisView({
  binary,
  boardProfile,
  options,
  profiles,
  busy,
  canRun,
  onOptionsChange,
  onReloadProfiles,
  onRun,
  onProfileSaved,
  onOpenPath,
}: {
  binary: ElfWorkflow;
  boardProfile: string;
  options: BinaryOptions;
  profiles: BinaryProfile[];
  busy: boolean;
  canRun: boolean;
  onOptionsChange: (next: BinaryOptions) => void;
  onReloadProfiles: () => void;
  onRun: () => void;
  onProfileSaved: (path: string) => void;
  onOpenPath: (selector: string, path: string[]) => void;
}) {
  const analysis = binary.analysis;
  const model = record(analysis?.model) ?? {};
  const profile = record(analysis?.profile) ?? {};
  const analysisCaveats = Array.isArray(analysis?.caveats) ? analysis!.caveats : [];
  const wcet = record(analysis?.wcet);
  const icache = record(analysis?.cache);
  const dcache = record(analysis?.data_cache);
  const memory = record(analysis?.data_memory);
  const branch = record(analysis?.branch_prediction);
  const wcetRoots = Array.isArray(wcet?.roots)
    ? (wcet!.roots as Array<Record<string, unknown>>)
    : [];
  const extras = profile;
  const profileId = str(extras?.board_profile_id) || "no board profile";
  const profileSha = str(extras?.board_profile_sha256);
  const profileSource = str(extras?.board_profile_source);

  const selectedProfile = profiles.find(
    (profile) => profile.path === options.board_profile,
  );
  const runCpu = str(model.id);
  const runProfileSource = str(profileSource);
  const selectedProfileFile = (options.board_profile ?? "").split(/[\\/]/).pop() ?? "";
  const configDirty =
    (Boolean(options.cpu) && options.cpu !== runCpu) ||
    (Boolean(options.board_profile) &&
      (runProfileSource === "" ||
        !runProfileSource.endsWith(selectedProfileFile))) ||
    (!options.board_profile && runProfileSource !== "");
  const frequency = num(wcet?.frequency_hz);

  const [exportNote, setExportNote] = useState("");
  const [tab, setTab] = useState<
    "summary" | "wcet" | "cache" | "memory" | "branch" | "timing"
  >("summary");

  const importProfileFile = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Board profile", extensions: ["toml"] }],
    });
    if (typeof path === "string" && path) {
      onOptionsChange({ ...options, board_profile: path });
    }
  };

  const reproduceCommand = [
    "elf2tdg",
    binary.elf_path,
    "--view cfg",
    "--format json",
    "--cpu",
    str(model.id) || "auto",
    boardProfile ? `--board-profile ${boardProfile}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const reportText = () => {
    const lines = [
      `# Binary analysis — ${binary.elf_path.split(/[\\/]/).pop()}`,
      "",
      `- image: ${str(binary.image.path)}`,
      `- arch: ${str(binary.image.arch)} · entry ${str(binary.image.entry)}`,
      `- cfg schema: ${binary.schema}`,
      `- functions: ${binary.functions} · blocks: ${binary.blocks} · calls: ${binary.calls}`,
      `- timing model: ${str(model.id)} (${str(model.determinism)})`,
      `- board profile: ${profileId}`,
      profileSha ? `- profile sha256: ${profileSha}` : "",
      profileSource ? `- profile source: ${profileSource}` : "",
      "",
      "## Reproduce",
      "",
      "```sh",
      reproduceCommand,
      "```",
      "",
    ];
    if (wcet) {
      lines.push(
        "## WCET (CFG longest path)",
        "",
        `- functions analyzed: ${fmtNumber(wcet.functions_analyzed)} · partial ${fmtNumber(wcet.functions_partial)} · unbounded ${fmtNumber(wcet.functions_unbounded)}`,
        "",
        "| root | kind | status | cycles | time (ns) |",
        "| --- | --- | --- | ---: | ---: |",
        ...wcetRoots.map(
          (root) =>
            `| ${str(root.name)} | ${str(root.kind)} | ${str(root.status)} | ${fmtNumber(root.cycles, 1)} | ${fmtNumber(root.time_ns, 1)} |`,
        ),
        "",
      );
    }
    if (icache) {
      lines.push(
        "## Instruction cache",
        "",
        `- ${fmtNumber(icache.size)} B · ${fmtNumber(icache.line_bytes)} B lines · ${fmtNumber(icache.ways)} ways · miss penalty ${fmtNumber(icache.miss_penalty)} cy`,
        `- blocks analyzed ${fmtNumber(icache.blocks_analyzed)} · fallback ${fmtNumber(icache.blocks_fallback)}`,
        "",
      );
    }
    if (dcache) {
      lines.push(
        "## Data cache",
        "",
        `- accesses ${fmtNumber(dcache.memory_accesses)} · resolved ${fmtNumber(dcache.resolved_memory_accesses)} · lines ${fmtNumber(dcache.line_accesses)}`,
        `- miss penalty ${fmtNumber(dcache.miss_penalty)} cy · write allocate ${String(dcache.write_allocate)}`,
        "",
      );
    }
    if (memory) {
      lines.push(
        "## Data memory",
        "",
        `- accesses ${fmtNumber(memory.accesses)} · mapped ${fmtNumber(memory.mapped_accesses)} · wait cycles ${fmtNumber(memory.wait_cycles)}`,
        "",
      );
    }
    if (branch) {
      lines.push(
        "## Branch prediction",
        "",
        `- model ${str(branch.model)} · branches analyzed ${fmtNumber(branch.branches_analyzed)} · penalty ${fmtNumber(branch.mispredict_penalty)} cy`,
        "",
      );
    }
    lines.push("## Caveats", "", ...analysisCaveats.map((caveat) => `- ${caveat}`), "");
    return lines.join("\n");
  };

  const exportReport = async (format: "md" | "json") => {
    setExportNote("");
    try {
      const target = await save({
        defaultPath: `${binary.elf_path.split(/[\\/]/).pop() ?? "binary"}.analysis.${format}`,
        filters: [
          { name: format === "md" ? "Analysis report" : "Analysis JSON", extensions: [format] },
        ],
      });
      if (!target) return;
      const contents =
        format === "md"
          ? reportText()
          : JSON.stringify(
              {
                image: binary.image,
                schema: binary.schema,
                timing: binary.timing,
                analysis,
                reproduce: reproduceCommand,
              },
              null,
              2,
            );
      await writeTextFile(target, contents);
      setExportNote(`saved ${target}`);
    } catch (reason) {
      setExportNote(String(reason));
    }
  };

  return (
    <div className="bin-analysis">
      <section className="analysis-setup">
        <div className="analysis-setup-head">
          <div>
            <div className="sem-eyebrow">ANALYSIS SETUP · RUN CONFIGURATION</div>
            <h3>Choose how the static timing model is built</h3>
            <div className="faint">
              CPU model supplies the built-in instruction costs. A board profile adds
              caches, branch prediction, data-memory timing and WCET bounds, and pins the
              CPU model. Frequency converts cycles to nanoseconds. Press RUN ANALYSIS to
              rebuild the cached results.
            </div>
          </div>
          <button className="btn accent" disabled={!canRun || busy} onClick={onRun}>
            {busy ? "ANALYZING…" : "RUN ANALYSIS"}
          </button>
        </div>
        <div className="analysis-setup-grid">
          <label>
            <span>1 · CPU TIMING MODEL</span>
            <select
              value={options.cpu ?? ""}
              disabled={busy}
              onChange={(event) =>
                onOptionsChange({ ...options, cpu: event.target.value || undefined })
              }
            >
              <option value="">auto-detect</option>
              {["cortex-m4", "cortex-m7", "cortex-m33", "riscv32", "aarch64", "x86-64"].map(
                (cpu) => (
                  <option key={cpu} value={cpu}>
                    {cpu}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            <span>2 · BOARD PROFILE</span>
            <select
              value={options.board_profile ?? ""}
              disabled={busy}
              onChange={(event) => {
                const path = event.target.value;
                const chosen = profiles.find((profile) => profile.path === path);
                onOptionsChange({
                  ...options,
                  board_profile: path || undefined,
                  cpu: chosen?.cpu ?? options.cpu,
                });
              }}
            >
              <option value="">none (built-in CPU table only)</option>
              {options.board_profile &&
                !profiles.some((profile) => profile.path === options.board_profile) && (
                  <option value={options.board_profile}>
                    {(options.board_profile.split(/[\\/]/).pop() ?? "custom profile") +
                      " (custom file)"}
                  </option>
                )}
              {profiles.map((profile) => (
                <option key={profile.path} value={profile.path}>
                  {profile.name}
                  {profile.cpu ? ` · ${profile.cpu}` : ""}
                </option>
              ))}
            </select>
            <button className="btn small" disabled={busy} onClick={() => void importProfileFile()}>
              OPEN PROFILE FILE…
            </button>
          </label>
          <label>
            <span>3 · FREQUENCY</span>
            <input
              value={options.freq ?? ""}
              disabled={busy}
              placeholder="e.g. 168MHz"
              onChange={(event) =>
                onOptionsChange({ ...options, freq: event.target.value || undefined })
              }
            />
          </label>
        </div>
        <div className="action-row" style={{ marginBottom: 8 }}>
          <button className="btn small" onClick={() => setTab("timing")}>
            EDIT INSTRUCTION TIMING &amp; PROFILE
          </button>
          <span className="faint">
            CPU selects the built-in instruction timing table. A board profile is an
            optional TOML file with caches/branch/memory/WCET settings; choose one above,
            open your own file, or edit the selected one in the TIMING &amp; PROFILE tab.
          </span>
        </div>
        {configDirty && (
          <div className="faint" style={{ color: "#f2c14e" }}>
            Configuration changed since this run — press RUN ANALYSIS to rebuild. The
            results and caveats below still describe the previous run.
          </div>
        )}
        {selectedProfile?.cpu && options.cpu && selectedProfile.cpu !== options.cpu && (
          <div className="faint" style={{ color: "#ff9b9b" }}>
            This profile pins CPU <code>{selectedProfile.cpu}</code>, but the selected CPU
            is <code>{options.cpu}</code>; RUN ANALYSIS would fail.{" "}
            <button
              className="btn small"
              onClick={() =>
                onOptionsChange({ ...options, cpu: selectedProfile.cpu })
              }
            >
              SET CPU TO {selectedProfile.cpu}
            </button>
          </div>
        )}
        <div className="faint">
          Without a board profile only the CPU's built-in instruction table is applied,
          so CACHES / DATA MEMORY / BRANCHES / WCET stay empty — that is expected, not a
          failure. With <code>cortex-m4-pipeline</code> you get pipeline cycle costs;
          cache/WCET profiles must match the selected CPU (e.g. <code>cortex-m7-wcet</code>{" "}
          needs CPU <code>cortex-m7</code>).{" "}
          {profiles.length === 0 && (
            <>
              <button className="btn small" onClick={onReloadProfiles}>
                RELOAD PROFILES
              </button>
            </>
          )}
        </div>
      </section>

      <div className="analysis-toolbar">
        <div>
          <div className="sem-eyebrow">STATIC ANALYSIS · BOARD PROFILE</div>
          <h3 className="analysis-title">
            {str(model.id) || "no timing model"} · {profileId}
          </h3>
          <div className="mono faint">
            {str(model.core) || "—"} · {str(model.determinism) || "—"} ·{" "}
            {frequency !== null
              ? `${(frequency / 1_000_000).toFixed(1)} MHz`
              : "no frequency"}
            {profileSha ? ` · sha ${profileSha.slice(0, 12)}…` : ""}
          </div>
        </div>
        <div className="action-row">
          <button className="btn small" onClick={() => void exportReport("md")}>
            EXPORT MD
          </button>
          <button className="btn small" onClick={() => void exportReport("json")}>
            EXPORT JSON
          </button>
        </div>
      </div>
      {exportNote && <div className="faint analysis-note">{exportNote}</div>}

      <div className="cfg-tabs result-tabs">
        {(
          [
            ["summary", "SUMMARY"],
            ["wcet", "WCET"],
            ["cache", "CACHES"],
            ["memory", "DATA MEMORY"],
            ["branch", "BRANCHES"],
            ["timing", "TIMING & PROFILE"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={`btn small ${tab === value ? "accent" : ""}`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "summary" && (
        <>
          <div className="analysis-facts">
            <Fact label="model" value={str(model.id) || "none"} />
            <Fact label="board profile" value={profileId} />
            <Fact
              label="frequency"
              value={frequency !== null ? `${(frequency / 1_000_000).toFixed(1)} MHz` : "—"}
            />
            <Fact label="wcet roots" value={String(wcetRoots.length)} />
            <Fact label="functions" value={String(binary.functions)} />
            <Fact label="instructions" value={String(binary.coverage.total_instructions)} />
          </div>
          <CaveatList items={analysisCaveats} />
          <div className="faint">
            Pick a tab above for WCET roots, cache, data-memory, branch-prediction or the
            instruction-timing model. Export buttons above save the current run as MD/JSON.
          </div>
        </>
      )}

      {!wcet && !icache && !dcache && !memory && !branch && (
        <div className="bin-caveats">
          <div className="sem-eyebrow">NO ANALYSIS DATA IN THIS RUN</div>
          <div className="faint" style={{ marginTop: 6 }}>
            This run used no timing model or board profile, so the result cards are empty.
            Set a CPU (and optionally a board profile) in the ANALYSIS SETUP panel above,
            then press RUN ANALYSIS. Use the bundled ELF EXAMPLE if you want a ready-made
            configuration.
          </div>
        </div>
      )}

      <div className="analysis-grid">
      {tab === "wcet" && wcet && (
          <section className="analysis-card analysis-card-wide">
            <div className="sem-eyebrow">WCET · CFG LONGEST PATH</div>
            <div className="analysis-facts">
              <Fact label="model" value={str(wcet.model) || "—"} />
              <Fact label="functions" value={fmtNumber(wcet.functions_analyzed)} />
              <Fact label="partial" value={fmtNumber(wcet.functions_partial)} />
              <Fact label="unbounded" value={fmtNumber(wcet.functions_unbounded)} />
              <Fact label="loop bound" value={fmtNumber(wcet.default_loop_bound)} />
              <Fact label="max states" value={fmtNumber(wcet.max_states)} />
            </div>
            <table className="bin-table">
              <thead>
                <tr>
                  <th align="left">root</th>
                  <th align="left">kind</th>
                  <th align="left">status</th>
                  <th align="right">cycles</th>
                  <th align="right">time (ns)</th>
                  <th align="right">path</th>
                  <th align="right">walk</th>
                </tr>
              </thead>
              <tbody>
                {wcetRoots.map((root, index) => (
                  <tr key={`${str(root.function)}-${index}`}>
                    <td className="bin-name">{str(root.name) || "—"}</td>
                    <td>{str(root.kind)}</td>
                    <td className={`wcet-status ${str(root.status)}`}>{str(root.status)}</td>
                    <td align="right">{fmtNumber(root.cycles, 1)}</td>
                    <td align="right">{fmtNumber(root.time_ns, 1)}</td>
                    <td align="right">
                      {Array.isArray(root.path) ? root.path.length : "—"}
                    </td>
                    <td align="right">
                      {Array.isArray(root.path) && root.path.length > 0 ? (
                        <button
                          className="btn small"
                          onClick={() => {
                            const selector =
                              str(root.name) || str(root.function).replace(/^fn:/, "");
                            onOpenPath(selector, root.path as string[]);
                          }}
                        >
                          CFG
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <CaveatList items={Array.isArray(wcet.caveats) ? (wcet.caveats as string[]) : []} />
          </section>
        )}

        {tab === "cache" && icache && (
          <section className="analysis-card">
            <div className="sem-eyebrow">INSTRUCTION CACHE</div>
            <div className="analysis-facts">
              <Fact label="model" value={str(icache.model)} />
              <Fact label="size" value={`${fmtNumber(icache.size)} B`} />
              <Fact label="line" value={`${fmtNumber(icache.line_bytes)} B · ${fmtNumber(icache.ways)} ways`} />
              <Fact label="miss penalty" value={`${fmtNumber(icache.miss_penalty)} cy`} />
              <Fact label="blocks" value={fmtNumber(icache.blocks_analyzed)} />
              <Fact label="fallback" value={fmtNumber(icache.blocks_fallback)} />
            </div>
            <CaveatList items={Array.isArray(icache.caveats) ? (icache.caveats as string[]) : []} />
          </section>
        )}

        {tab === "cache" && dcache && (
          <section className="analysis-card">
            <div className="sem-eyebrow">DATA CACHE</div>
            <div className="analysis-facts">
              <Fact label="model" value={str(dcache.model)} />
              <Fact label="size" value={`${fmtNumber(dcache.size)} B`} />
              <Fact label="miss penalty" value={`${fmtNumber(dcache.miss_penalty)} cy`} />
              <Fact label="accesses" value={fmtNumber(dcache.memory_accesses)} />
              <Fact label="resolved" value={fmtNumber(dcache.resolved_memory_accesses)} />
              <Fact label="line accesses" value={fmtNumber(dcache.line_accesses)} />
            </div>
            <CaveatList items={Array.isArray(dcache.caveats) ? (dcache.caveats as string[]) : []} />
          </section>
        )}

        {tab === "memory" && memory && (
          <section className="analysis-card">
            <div className="sem-eyebrow">DATA MEMORY</div>
            <div className="analysis-facts">
              <Fact label="model" value={str(memory.model)} />
              <Fact label="accesses" value={fmtNumber(memory.accesses)} />
              <Fact label="mapped" value={fmtNumber(memory.mapped_accesses)} />
              <Fact label="unmapped" value={fmtNumber(memory.unmapped_accesses)} />
              <Fact label="wait cycles" value={fmtNumber(memory.wait_cycles)} />
              <Fact label="read / write" value={`${fmtNumber(memory.read_wait_cycles)} / ${fmtNumber(memory.write_wait_cycles)}`} />
            </div>
            <CaveatList items={Array.isArray(memory.caveats) ? (memory.caveats as string[]) : []} />
          </section>
        )}

        {tab === "branch" && branch && (
          <section className="analysis-card">
            <div className="sem-eyebrow">BRANCH PREDICTION</div>
            <div className="analysis-facts">
              <Fact label="model" value={str(branch.model)} />
              <Fact label="branches" value={fmtNumber(branch.branches_analyzed)} />
              <Fact label="fallback" value={fmtNumber(branch.branches_fallback)} />
              <Fact label="penalty" value={`${fmtNumber(branch.mispredict_penalty)} cy`} />
              <Fact label="functions" value={fmtNumber(branch.functions_analyzed)} />
              <Fact label="max states" value={fmtNumber(branch.max_states)} />
            </div>
            <CaveatList items={Array.isArray(branch.caveats) ? (branch.caveats as string[]) : []} />
          </section>
        )}
      </div>

      {tab === "timing" && (
        <InstructionTiming
          binary={binary}
          boardProfile={boardProfile}
          onProfileSaved={onProfileSaved}
        />
      )}
    </div>
  );
}
