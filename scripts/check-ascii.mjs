import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const extensions = new Set([".ts", ".tsx", ".css"]);
const offenders = [];

function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      walk(path);
      continue;
    }
    if (!extensions.has(name.slice(name.lastIndexOf(".")))) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const character of line) {
        if (character.codePointAt(0) > 0x7f) {
          offenders.push(`${path}:${index + 1}: non-ASCII character U+` +
            character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
          break;
        }
      }
    });
  }
}

walk(root);
if (offenders.length > 0) {
  console.error("UI sources must be ASCII-only (English text and punctuation):");
  for (const offender of offenders) console.error(offender);
  process.exit(1);
}
console.log("UI ASCII check passed: no non-ASCII characters in src/**/*.{ts,tsx,css}.");
