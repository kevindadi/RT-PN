import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowRight, Cpu } from "lucide-react";

import { writeTextFile } from "./api";
import type { BinaryOptions, ElfWorkflow } from "./types";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const fmtNumber = (value: unknown, digits = 0): string => {
  const number = num(value);
  if (number === null) return "-";
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
  options,
  onOpenPath,
  onOpenConfig,
  onOpenCfg,
}: {
  binary: ElfWorkflow;
  options: BinaryOptions;
  onOpenPath: (selector: string, path: string[]) => void;
  onOpenConfig: () => void;
  onOpenCfg: () => void;
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
  const pipeline = str(extras.board_profile_pipeline);

  const domains = Array.isArray(binary.timing?.frequency_domains) ? binary.timing.frequency_domains as unknown[] : [];
  const frequency = num(wcet?.frequency_hz) ?? num(record(domains[0])?.hz);
  const runCpu = str(model.id);
  const [exportNote, setExportNote] = useState("");
  const [selectedTab, setTab] = useState("summary");
  const tabs = [
    { id: "summary", label: "Summary", available: true },
    { id: "wcet", label: "Longest path", available: Boolean(wcet) },
    { id: "cache", label: "Caches", available: Boolean(icache || dcache) },
    { id: "memory", label: "Data memory", available: Boolean(memory) },
    { id: "pipeline", label: "Pipeline", available: Boolean(pipeline) },
    { id: "branch", label: "Branches", available: Boolean(branch) },
  ].filter((item) => item.available);
  const tab = tabs.some((item) => item.id === selectedTab) ? selectedTab : "summary";

  const reproduceCommand = [
    "elf2tdg --view cfg --format json",
    options.cpu ? `--cpu ${options.cpu}` : "",
    options.board_profile ? `--board-profile "${options.board_profile}"` : "",
    options.freq ? `--freq ${options.freq}` : "",
    `"${binary.elf_path}"`,
  ].filter(Boolean).join(" ");

  const reportText = () => {
    const lines = [
      `# Binary analysis - ${binary.elf_path.split(/[\\/]/).pop()}`,
      "",
      `- image: ${str(binary.image.path)}`,
      `- arch: ${str(binary.image.arch)} | entry ${str(binary.image.entry)}`,
      `- cfg schema: ${binary.schema}`,
      `- functions: ${binary.functions} | blocks: ${binary.blocks} | calls: ${binary.calls}`,
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
        `- functions analyzed: ${fmtNumber(wcet.functions_analyzed)} | partial ${fmtNumber(wcet.functions_partial)} | unbounded ${fmtNumber(wcet.functions_unbounded)}`,
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
        `- ${fmtNumber(icache.size)} B | ${fmtNumber(icache.line_bytes)} B lines | ${fmtNumber(icache.ways)} ways | miss penalty ${fmtNumber(icache.miss_penalty)} cy`,
        `- blocks analyzed ${fmtNumber(icache.blocks_analyzed)} | fallback ${fmtNumber(icache.blocks_fallback)}`,
        "",
      );
    }
    if (dcache) {
      lines.push(
        "## Data cache",
        "",
        `- accesses ${fmtNumber(dcache.memory_accesses)} | resolved ${fmtNumber(dcache.resolved_memory_accesses)} | lines ${fmtNumber(dcache.line_accesses)}`,
        `- miss penalty ${fmtNumber(dcache.miss_penalty)} cy | write allocate ${String(dcache.write_allocate)}`,
        "",
      );
    }
    if (memory) {
      lines.push(
        "## Data memory",
        "",
        `- accesses ${fmtNumber(memory.accesses)} | mapped ${fmtNumber(memory.mapped_accesses)} | wait cycles ${fmtNumber(memory.wait_cycles)}`,
        "",
      );
    }
    if (branch) {
      lines.push(
        "## Branch prediction",
        "",
        `- model ${str(branch.model)} | branches analyzed ${fmtNumber(branch.branches_analyzed)} | penalty ${fmtNumber(branch.mispredict_penalty)} cy`,
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
    <div className="bin-analysis wb-document">
      <section className={`wb-notice ${runCpu ? "wb-notice-neutral" : "wb-notice-warning"}`}>
        <Cpu size={22} aria-hidden="true" />
        <div>
          <h2>{runCpu ? "Static timing estimate" : "Control flow is ready"}</h2>
          <p>{runCpu
            ? `Estimates use ${runCpu} and ${profileId === "no board profile" ? "the built-in timing table" : profileId}.${frequency !== null ? ` Core frequency ${(frequency / 1_000_000).toFixed(1)} MHz.` : ""} Hardware execution-time bounds have not been verified.`
            : "This run has no instruction timing model. Browse the CFG or configure a CPU and board profile."}</p>
        </div>
        {runCpu
          ? <button className="wb-button" onClick={onOpenConfig}>Edit configuration</button>
          : <div className="wb-actions"><button className="wb-button" onClick={onOpenCfg}>Browse CFG</button><button className="wb-button" onClick={onOpenConfig}>Configure timing</button></div>}
      </section>

      <div className="wb-analysis-actions">
        {tabs.length > 1 && (
          <nav className="wb-subnav wb-subnav-inline" aria-label="Timing result views">
            {tabs.map((item) => (
              <button key={item.id} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>{item.label}</button>
            ))}
          </nav>
        )}
        <details className="wb-menu">
          <summary className="wb-button">Export report</summary>
          <div className="wb-menu-content">
            <button onClick={() => void exportReport("md")}>Markdown report</button>
            <button onClick={() => void exportReport("json")}>JSON report</button>
          </div>
        </details>
      </div>
      {exportNote && <p className="wb-muted" role="status">{exportNote}</p>}

      {tab === "summary" && (
        <>
          <dl className="wb-facts">
            <div><dt>Functions recovered</dt><dd>{binary.functions.toLocaleString("en-US")}</dd></div>
            <div><dt>Instructions counted</dt><dd>{binary.coverage?.total_instructions?.toLocaleString("en-US") ?? "-"}</dd></div>
            <div><dt>Unknown mnemonics</dt><dd>{binary.coverage?.unknown_mnemonics?.toLocaleString("en-US") ?? "-"}</dd></div>
          </dl>
          {wcetRoots.length > 0 && (
            <section className="wb-panel">
              <div className="wb-panel-heading">
                <h2>Timing by entry point</h2>
                <button className="wb-button wb-quiet" onClick={() => setTab("wcet")}>Longest-path details <ArrowRight size={15} /></button>
              </div>
              <div className="wb-table-scroll">
                <table className="wb-table">
                  <thead><tr><th>Entry point</th><th>Status</th><th>Cycles</th><th>Time (ns)</th><th>Evidence</th></tr></thead>
                  <tbody>{wcetRoots.map((root, index) => (
                    <tr key={`${str(root.function)}-${index}`}>
                      <th scope="row">{str(root.name) || str(root.function) || "-"}</th>
                      <td>{str(root.status)}</td>
                      <td>{fmtNumber(root.cycles, 1)}</td>
                      <td>{fmtNumber(root.time_ns, 1)}</td>
                      <td>{Array.isArray(root.path) && root.path.length > 0
                        ? <button className="wb-button wb-quiet" onClick={() => onOpenPath(str(root.function).replace(/^fn:/, "") || str(root.name), root.path as string[])}>View path <ArrowRight size={14} /></button>
                        : "-"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          )}
          {analysisCaveats.length > 0 && (
            <details className="wb-panel wb-disclosure">
              <summary>Assumptions and diagnostics</summary>
              <CaveatList items={analysisCaveats} />
            </details>
          )}
        </>
      )}

      <div className="analysis-grid">
      {tab === "wcet" && wcet && (
          <section className="analysis-card analysis-card-wide">
            <div className="sem-eyebrow">WCET | CFG LONGEST PATH</div>
            <div className="analysis-facts">
              <Fact label="model" value={str(wcet.model) || "-"} />
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
                    <td className="bin-name">{str(root.name) || "-"}</td>
                    <td>{str(root.kind)}</td>
                    <td className={`wcet-status ${str(root.status)}`}>{str(root.status)}</td>
                    <td align="right">{fmtNumber(root.cycles, 1)}</td>
                    <td align="right">{fmtNumber(root.time_ns, 1)}</td>
                    <td align="right">
                      {Array.isArray(root.path) ? root.path.length : "-"}
                    </td>
                    <td align="right">
                      {Array.isArray(root.path) && root.path.length > 0 ? (
                        <button
                          className="btn small"
                          onClick={() => {
                            const selector =
                              str(root.function).replace(/^fn:/, "") || str(root.name);
                            onOpenPath(selector, root.path as string[]);
                          }}
                        >
                          View path
                        </button>
                      ) : (
                        "-"
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
              <Fact label="line" value={`${fmtNumber(icache.line_bytes)} B | ${fmtNumber(icache.ways)} ways`} />
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
        {tab === "pipeline" && pipeline && (
          <section className="wb-panel">
            <h2>Instruction pipeline</h2>
            <p className="wb-muted">The selected pipeline model contributes to the basic-block cycle estimates.</p>
            <div className="analysis-facts">
              <Fact label="Issue width" value={str(extras.board_profile_pipeline_issue_width) || "-"} />
              <Fact label="Instruction overrides" value={str(extras.board_profile_pipeline_instruction_overrides) || "-"} />
            </div>
            <button className="wb-button" onClick={onOpenCfg}>Inspect block timings <ArrowRight size={15} /></button>
          </section>
        )}
      </div>

    </div>
  );
}
