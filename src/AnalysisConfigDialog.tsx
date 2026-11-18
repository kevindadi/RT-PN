import { open } from "@tauri-apps/plugin-dialog";

import { InstructionTiming } from "./InstructionTiming";
import type { BinaryOptions, BinaryProfile, ElfWorkflow } from "./types";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function AnalysisConfigDialog({
  binary,
  options,
  profiles,
  busy,
  canRun,
  onOptionsChange,
  onReloadProfiles,
  onRun,
  onProfileSaved,
  onClose,
}: {
  binary: ElfWorkflow;
  options: BinaryOptions;
  profiles: BinaryProfile[];
  busy: boolean;
  canRun: boolean;
  onOptionsChange: (next: BinaryOptions) => void;
  onReloadProfiles: () => void;
  onRun: () => void;
  onProfileSaved: (path: string) => void;
  onClose: () => void;
}) {
  const analysis = binary.analysis;
  const model =
    analysis?.model && typeof analysis.model === "object"
      ? (analysis.model as Record<string, unknown>)
      : {};
  const profile =
    analysis?.profile && typeof analysis.profile === "object"
      ? (analysis.profile as Record<string, unknown>)
      : {};
  const runCpu = str(model.id);
  const runProfileSource = str(profile.board_profile_source);
  const profileId = str(profile.board_profile_id) || "no board profile";
  const selectedProfile = profiles.find(
    (candidate) => candidate.path === options.board_profile,
  );
  const selectedProfileFile = (options.board_profile ?? "").split(/[\\/]/).pop() ?? "";
  const configDirty =
    (Boolean(options.cpu) && options.cpu !== runCpu) ||
    (Boolean(options.board_profile) &&
      (runProfileSource === "" || !runProfileSource.endsWith(selectedProfileFile))) ||
    (!options.board_profile && runProfileSource !== "");

  const openProfileFile = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Board profile", extensions: ["toml"] }],
    });
    if (typeof path === "string" && path) {
      onOptionsChange({ ...options, board_profile: path });
    }
  };

  return (
    <div className="guide-overlay" onClick={onClose}>
      <div className="guide-dialog config-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="guide-head">
          <div>
            <div className="sem-eyebrow">CONFIGURATION | STATIC TIMING</div>
            <h2>Analysis configuration</h2>
            <div className="faint">
              CPU supplies the built-in instruction cost table. A board profile adds caches,
              branch prediction, data-memory timing and WCET bounds, and pins the CPU.
              Frequency converts cycles to nanoseconds. Press RUN ANALYSIS to create a new
              immutable run; configuration changes never rewrite previous results.
            </div>
          </div>
          <button className="btn small" onClick={onClose}>
            CLOSE
          </button>
        </div>

        <div className="analysis-setup-grid">
          <label>
            <span>1 | CPU TIMING MODEL</span>
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
            <span>2 | BOARD PROFILE</span>
            <select
              value={options.board_profile ?? ""}
              disabled={busy}
              onChange={(event) => {
                const path = event.target.value;
                const chosen = profiles.find((candidate) => candidate.path === path);
                onOptionsChange({
                  ...options,
                  board_profile: path || undefined,
                  cpu: chosen?.cpu ?? options.cpu,
                });
              }}
            >
              <option value="">none (built-in CPU table only)</option>
              {options.board_profile &&
                !profiles.some((candidate) => candidate.path === options.board_profile) && (
                  <option value={options.board_profile}>
                    {(options.board_profile.split(/[\\/]/).pop() ?? "custom profile") +
                      " (custom file)"}
                  </option>
                )}
              {profiles.map((candidate) => (
                <option key={candidate.path} value={candidate.path}>
                  {candidate.name}
                  {candidate.cpu ? ` | ${candidate.cpu}` : ""}
                </option>
              ))}
            </select>
            <button className="btn small" disabled={busy} onClick={() => void openProfileFile()}>
              OPEN PROFILE FILE...
            </button>
          </label>
          <label>
            <span>3 | FREQUENCY</span>
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

        {selectedProfile?.cpu && options.cpu && selectedProfile.cpu !== options.cpu && (
          <div className="faint" style={{ color: "#ff9b9b" }}>
            This profile pins CPU <code>{selectedProfile.cpu}</code>, but the selected CPU is{" "}
            <code>{options.cpu}</code>; RUN ANALYSIS would fail.{" "}
            <button
              className="btn small"
              onClick={() => onOptionsChange({ ...options, cpu: selectedProfile.cpu })}
            >
              SET CPU TO {selectedProfile.cpu}
            </button>
          </div>
        )}

        {configDirty && (
          <div className="faint" style={{ color: "#f2c14e" }}>
            Configuration changed since the displayed run. Press RUN ANALYSIS to rebuild;
            the results in the ANALYSIS document still describe the previous run.
          </div>
        )}

        <div className="faint">
          Current run: {runCpu || "no model"} | {profileId}.{" "}
          {profiles.length === 0 && (
            <button className="btn small" onClick={onReloadProfiles}>
              RELOAD PROFILES
            </button>
          )}
        </div>

        <div className="action-row" style={{ margin: "12px 0" }}>
          <button className="btn accent" disabled={!canRun || busy} onClick={onRun}>
            {busy ? "ANALYZING..." : "RUN ANALYSIS"}
          </button>
        </div>

        <InstructionTiming
          binary={binary}
          boardProfile={options.board_profile ?? ""}
          onProfileSaved={onProfileSaved}
        />
      </div>
    </div>
  );
}
