// Desktop backend tests.
//
// Builds the frontend assets that `tauri::generate_context!` embeds, then runs
// the src-tauri Rust unit tests. One test drives `binary::analyze` end-to-end
// against the checked-in example ELF (requires the staged sidecars, like the
// e2e script).

import path from "node:path";

import { detectToolchain, isWindows, paths, run } from "./lib.mjs";

const toolchain = detectToolchain({ required: true });

// Windows cannot spawn npm.cmd directly (EINVAL); route it through cmd.exe.
if (isWindows) {
  run(process.env.ComSpec ?? "cmd.exe", ["/c", "npm run build"], { cwd: paths.root });
} else {
  run("npm", ["run", "build"], { cwd: paths.root });
}
run(
  toolchain.cargo,
  ["test", "--manifest-path", path.join(paths.root, "src-tauri", "Cargo.toml"), "--lib"],
  { cwd: paths.root },
);
