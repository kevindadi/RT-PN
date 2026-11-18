import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import { readTextFile, writeTextFile } from "./api";
import type { ElfWorkflow } from "./types";

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
  onProfileSaved,
  onOpenPath,
}: {
  binary: ElfWorkflow;
  boardProfile: string;
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
  const frequency = num(wcet?.frequency_hz);

  const [profileText, setProfileText] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNote, setProfileNote] = useState("");
  const [exportNote, setExportNote] = useState("");

  useEffect(() => {
    if (!boardProfile) {
      setProfileText("");
      return;
    }
    let alive = true;
    setProfileBusy(true);
    readTextFile(boardProfile)
      .then((text) => {
        if (alive) setProfileText(text);
      })
      .catch((reason) => {
        if (alive) setProfileNote(String(reason));
      })
      .finally(() => {
        if (alive) setProfileBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [boardProfile]);

  const saveProfileAs = async () => {
    setProfileNote("");
    try {
      const target = await save({
        defaultPath: "board-profile.toml",
        filters: [{ name: "Board profile", extensions: ["toml"] }],
      });
      if (!target) return;
      await writeTextFile(target, profileText);
      onProfileSaved(target);
      setProfileNote(`saved ${target} — re-run with the profile to apply it`);
    } catch (reason) {
      setProfileNote(String(reason));
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

      {!wcet && !icache && !dcache && !memory && !branch && (
        <div className="bin-caveats">
          <div className="sem-eyebrow">NO ANALYSIS PROFILE ENABLED</div>
          <div className="faint" style={{ marginTop: 6 }}>
            Pick an icache / dcache / branch / data-memory / WCET board profile in the
            sidebar and run with the profile to populate these cards.
          </div>
        </div>
      )}

      <div className="analysis-grid">
        {wcet && (
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

        {icache && (
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

        {dcache && (
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

        {memory && (
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

        {branch && (
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

      <section className="analysis-editor">
        <div className="sem-eyebrow">BOARD PROFILE EDITOR</div>
        {boardProfile ? (
          <>
            <div className="mono faint analysis-note">{boardProfile}</div>
            <textarea
              value={profileText}
              spellCheck={false}
              onChange={(event) => setProfileText(event.target.value)}
              placeholder="loading profile…"
            />
            <div className="action-row">
              <button className="btn small accent" onClick={() => void saveProfileAs()}>
                SAVE AS…
              </button>
              <span className="faint">
                {profileBusy ? "loading…" : "edit the TOML, save a copy, then re-run with it"}
              </span>
            </div>
            {profileNote && <div className="faint analysis-note">{profileNote}</div>}
          </>
        ) : (
          <div className="faint">
            Select a board profile in the sidebar to inspect and edit its TOML here.
          </div>
        )}
      </section>
    </div>
  );
}
