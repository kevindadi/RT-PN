import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import { readTextFile, writeTextFile } from "./api";
import type { ElfWorkflow } from "./types";

const CLASSES = [
  ["alu", "整数/逻辑运算（add, mov, cmp, …）"],
  ["load", "内存读取（ldr/ldrb/ldrh, …）"],
  ["store", "内存写入（str/strb/strh, …）"],
  ["push-pop", "栈操作（push/pop）"],
  ["ldm-stm", "多寄存器 load/store（ldm/stm）"],
  ["branch", "条件/无条件分支，含 bx"],
  ["call", "函数调用（bl/blx）"],
  ["return", "返回路径（当前由 branch/call 推导）"],
  ["multiply", "乘法（mul/mla/umull, …）"],
  ["divide", "除法（sdiv/udiv）"],
  ["barrier", "内存屏障（dmb/dsb/isb）"],
  ["nop", "空操作"],
  ["other", "未分类/回退"],
] as const;

interface OverrideRow {
  selector: string;
  cycles: string;
}

interface ParsedOverride extends OverrideRow {
  class?: string;
  mnemonic?: string;
  min?: number;
  max?: number;
}

function parseOverrides(text: string): ParsedOverride[] {
  const rows: ParsedOverride[] = [];
  const blocks = text.split("[[instruction_costs]]").slice(1);
  for (const block of blocks) {
    const end = block.search(/\n\s*\[/);
    const body = end >= 0 ? block.slice(0, end) : block;
    const classMatch = body.match(/^\s*class\s*=\s*"([^"]+)"/m);
    const mnemonicMatch = body.match(/^\s*mnemonic\s*=\s*"([^"]+)"/m);
    const cyclesMatch = body.match(/cycles\s*=\s*(\{[^}]*\}|\d+)/);
    const selector =
      [classMatch?.[1], mnemonicMatch?.[1]].filter(Boolean).join(" · ") || "?";
    const minMatch = cyclesMatch?.[1]?.match(/min\s*=\s*(\d+)/);
    const maxMatch = cyclesMatch?.[1]?.match(/max\s*=\s*(\d+)/);
    const exact = cyclesMatch?.[1]?.match(/^\d+$/);
    rows.push({
      selector,
      cycles: cyclesMatch?.[1]?.replace(/\s+/g, " ") ?? "?",
      class: classMatch?.[1],
      mnemonic: mnemonicMatch?.[1],
      min: minMatch ? Number(minMatch[1]) : exact ? Number(exact[0]) : undefined,
      max: maxMatch ? Number(maxMatch[1]) : exact ? Number(exact[0]) : undefined,
    });
  }
  return rows;
}

export function InstructionTiming({
  binary,
  boardProfile,
  onProfileSaved,
}: {
  binary: ElfWorkflow;
  boardProfile: string;
  onProfileSaved: (path: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [classSel, setClassSel] = useState("load");
  const [mnemonic, setMnemonic] = useState("");
  const [minCycles, setMinCycles] = useState("2");
  const [maxCycles, setMaxCycles] = useState("3");

  useEffect(() => {
    if (!boardProfile) {
      setText("");
      return;
    }
    let alive = true;
    setBusy(true);
    readTextFile(boardProfile)
      .then((value) => {
        if (alive) setText(value);
      })
      .catch((reason) => {
        if (alive) setNote(String(reason));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [boardProfile]);

  const overrides = parseOverrides(text);
  const coverage = binary.coverage;
  const maxClass = coverage.classes[0]?.count || 1;

  const addOverride = () => {
    setNote("");
    const min = Number(minCycles);
    const max = Number(maxCycles);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      setNote("cycle bounds must be non-negative and ordered (min ≤ max)");
      return;
    }
    const selector = mnemonic.trim()
      ? `mnemonic = "${mnemonic.trim().toLowerCase()}"\n`
      : `class = "${classSel}"\n`;
    const snippet =
      `\n[[instruction_costs]]\n${selector}` +
      `cycles = { min = ${min}, max = ${max} }\n`;
    setText((previous) => previous + snippet);
    setNote(
      `added override (${mnemonic.trim() || classSel}, ${min}–${max} cycles) — SAVE AS a profile copy to use it`,
    );
  };

  const saveProfileAs = async () => {
    setNote("");
    try {
      const target = await save({
        defaultPath: "board-profile.toml",
        filters: [{ name: "Board profile", extensions: ["toml"] }],
      });
      if (!target) return;
      await writeTextFile(target, text);
      onProfileSaved(target);
      setNote(`saved ${target} — press RUN ANALYSIS to apply it`);
    } catch (reason) {
      setNote(String(reason));
    }
  };

  return (
    <section className="timing-editor">
      <div className="analysis-toolbar">
        <div>
          <div className="sem-eyebrow">INSTRUCTION TIMING</div>
          <h3 className="analysis-title">
            {binary.analysis.model && typeof binary.analysis.model.id === "string"
              ? String(binary.analysis.model.id)
              : "no timing model"}{" "}
            · {binary.analysis.model && typeof binary.analysis.model.determinism === "string"
              ? String(binary.analysis.model.determinism)
              : "—"}
          </h3>
          <div className="faint">
            Built-in instruction classes come from the selected CPU model. Add overrides
            here; they are written to a board profile copy, so the next run uses them.
          </div>
        </div>
        <div className="action-row">
          <button className="btn small" onClick={() => void saveProfileAs()} disabled={!text}>
            SAVE AS PROFILE
          </button>
        </div>
      </div>

      <div className="timing-grid">
        <div className="timing-card">
          <div className="sem-eyebrow">COVERAGE (STATIC CFG INSTRUCTIONS)</div>
          <div className="analysis-facts">
            <div>
              <span>total instructions</span>
              <b>{coverage.total_instructions.toLocaleString()}</b>
            </div>
            <div>
              <span>classes present</span>
              <b>{coverage.classes.length}</b>
            </div>
            <div>
              <span>unknown mnemonics</span>
              <b className={coverage.unknown_mnemonics > 0 ? "bin-delta-bad" : ""}>
                {coverage.unknown_mnemonics}
              </b>
            </div>
          </div>
          <div className="coverage-bars">
            {coverage.classes.map((row) => (
              <div key={row.class} className="coverage-row">
                <span>{row.class}</span>
                <div className="coverage-track">
                  <div
                    className="coverage-fill"
                    style={{ width: `${Math.max(2, (row.count / maxClass) * 100)}%` }}
                  />
                </div>
                <b>{row.count.toLocaleString()}</b>
              </div>
            ))}
            {coverage.classes.length === 0 && (
              <div className="faint">run an analysis to see instruction-class coverage</div>
            )}
          </div>
          <div className="faint" style={{ marginTop: 6 }}>
            Classification is a static mnemonic heuristic over the whole CFG. Unknown
            mnemonics are counted by elf2tdg and fall back to the <code>other</code> class.
          </div>
        </div>

        <div className="timing-card">
          <div className="sem-eyebrow">CURRENT OVERRIDES</div>
          <table className="bin-table">
            <thead>
              <tr>
                <th align="left">selector</th>
                <th align="left">cycles</th>
              </tr>
            </thead>
            <tbody>
              {overrides.map((row, index) => (
                <tr key={`${row.selector}-${index}`}>
                  <td className="mono">{row.selector}</td>
                  <td className="mono">{row.cycles}</td>
                </tr>
              ))}
              {overrides.length === 0 && (
                <tr>
                  <td colSpan={2} className="faint">
                    no overrides in this profile — the CPU model's built-in class table is
                    used
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="faint" style={{ marginTop: 6 }}>
            Board profile: {boardProfile || "none"} {busy ? "· loading…" : ""}
          </div>
        </div>
      </div>

      <div className="timing-card" style={{ marginTop: 12 }}>
        <div className="sem-eyebrow">ADD OVERRIDE</div>
        <div className="timing-form">
          <label>
            <span>CLASS</span>
            <select value={classSel} onChange={(event) => setClassSel(event.target.value)}>
              {CLASSES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>MNEMONIC (OPTIONAL)</span>
            <input
              value={mnemonic}
              placeholder="e.g. ldr"
              onChange={(event) => setMnemonic(event.target.value)}
            />
          </label>
          <label>
            <span>MIN</span>
            <input
              type="number"
              min={0}
              value={minCycles}
              onChange={(event) => setMinCycles(event.target.value)}
            />
          </label>
          <label>
            <span>MAX</span>
            <input
              type="number"
              min={0}
              value={maxCycles}
              onChange={(event) => setMaxCycles(event.target.value)}
            />
          </label>
          <button className="btn small accent" onClick={addOverride}>
            ADD TO PROFILE
          </button>
        </div>
        <div className="faint" style={{ marginTop: 6 }}>
          Class list: {CLASSES.map(([value]) => value).join(" · ")}. A mnemonic beats a
          class selector; matching is case-insensitive and ignores a trailing .w/.n.
        </div>
        {note && <div className="faint analysis-note">{note}</div>}
      </div>

      <details className="timing-raw">
        <summary>RAW PROFILE TOML</summary>
        <div className="faint">
          {boardProfile
            ? "advanced editing — changes above are appended here"
            : "select a board profile in RUN CONFIGURATION to edit its TOML"}
        </div>
        <textarea
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          placeholder="no board profile selected"
        />
      </details>
    </section>
  );
}
