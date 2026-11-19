import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { InstructionTiming } from "./InstructionTiming";
import type { BinaryOptions, BinaryProfile, ElfWorkflow } from "./types";

const CPU_MODELS = [
  "cortex-m0", "cortex-m0plus", "cortex-m3", "cortex-m4", "cortex-m7",
  "cortex-m33", "riscv32", "riscv64", "aarch64", "x86-64",
];

export function BinaryConfiguration({
  binary,
  options,
  profiles,
  busy,
  onOptionsChange,
  onReloadProfiles,
}: {
  binary: ElfWorkflow | null;
  options: BinaryOptions;
  profiles: BinaryProfile[];
  busy: boolean;
  onOptionsChange: (next: BinaryOptions) => void;
  onReloadProfiles: () => void;
}) {
  const [problem, setProblem] = useState("");
  const selectedProfile = profiles.find((candidate) => candidate.path === options.board_profile);
  const openProfileFile = async () => {
    setProblem("");
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Board profiles", extensions: ["toml", "json"] }],
      });
      if (typeof path === "string") {
        onOptionsChange({ ...options, board_profile: path, cpu: undefined });
      }
    } catch (error) {
      setProblem(String(error));
    }
  };

  return (
    <div className="wb-document">
      <section className="wb-panel">
        <h2>Hardware model</h2>
        <p className="wb-muted">Configure the next run. A board profile can supply memory, cache, and pipeline settings.</p>
        <fieldset className="wb-fields" disabled={busy}>
          <label>
            <span>CPU timing model</span>
            <select
              value={options.cpu ?? ""}
              onChange={(event) => onOptionsChange({ ...options, cpu: event.target.value || undefined })}
            >
              <option value="">Auto-detect or use profile</option>
              {options.cpu && !CPU_MODELS.includes(options.cpu) && <option>{options.cpu}</option>}
              {CPU_MODELS.map((cpu) => <option key={cpu}>{cpu}</option>)}
            </select>
          </label>
          <label>
            <span>Board profile</span>
            <select
              value={options.board_profile ?? ""}
              onChange={(event) => {
                const path = event.target.value;
                const profile = profiles.find((candidate) => candidate.path === path);
                onOptionsChange({ ...options, board_profile: path || undefined, cpu: profile?.cpu ?? options.cpu });
              }}
            >
              <option value="">No board profile</option>
              {options.board_profile && !selectedProfile && (
                <option value={options.board_profile}>{options.board_profile.split(/[\\/]/).pop()}</option>
              )}
              {profiles.map((profile) => <option key={profile.path} value={profile.path}>{profile.name}</option>)}
            </select>
          </label>
          <label>
            <span>Core frequency</span>
            <input
              value={options.freq ?? ""}
              placeholder="Use default, e.g. 168MHz"
              onChange={(event) => onOptionsChange({ ...options, freq: event.target.value || undefined })}
            />
          </label>
        </fieldset>
        <div className="wb-actions">
          <button className="wb-button" disabled={busy} onClick={() => void openProfileFile()}>Open profile file</button>
          {profiles.length === 0 && <button className="wb-button wb-quiet" disabled={busy} onClick={onReloadProfiles}>Reload profiles</button>}
        </div>
        {selectedProfile?.cpu && options.cpu && selectedProfile.cpu !== options.cpu && (
          <p className="wb-warning" role="alert">This board profile requires {selectedProfile.cpu}.</p>
        )}
        {problem && <p className="wb-warning" role="alert">{problem}</p>}
      </section>
      {binary && (
        <details className="wb-panel wb-disclosure">
          <summary>Instruction timing and profile overrides</summary>
          <InstructionTiming
            binary={binary}
            boardProfile={options.board_profile ?? ""}
            onProfileSaved={(path) => onOptionsChange({ ...options, board_profile: path })}
          />
        </details>
      )}
    </div>
  );
}
