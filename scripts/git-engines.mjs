// Manage the engine submodules.
//
//   node scripts/git-engines.mjs init     clone/checkout the pinned engines
//   node scripts/git-engines.mjs update   move to the heads of the tracked branches
//   node scripts/git-engines.mjs status   print the pinned commits
//
// Reviewed `update` runs are the only supported way to bump the engine pins;
// release builds always use the commits recorded in the superproject.

import { paths, run, capture, gitTlsEnv } from "./lib.mjs";

const command = process.argv[2] ?? "status";

try {
  if (command === "init") {
    run("git", ["submodule", "sync"], { env: gitTlsEnv });
    run("git", ["submodule", "update", "--init"], { env: gitTlsEnv });
  } else if (command === "update") {
    run("git", ["submodule", "update", "--remote", "--merge"], { env: gitTlsEnv });
  } else if (command === "status") {
    console.log(capture("git", ["submodule", "status"], { env: gitTlsEnv }));
  } else {
    console.error(`error: unknown command "${command}" (use init|update|status)`);
    process.exit(1);
  }
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  process.exit(1);
}

if (command === "update") {
  console.log(
    "\nengine pins moved; run `just engines` and `just test`, then review " +
      "`git status` and commit the new gitlinks.",
  );
}
