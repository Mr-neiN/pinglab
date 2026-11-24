/**
 * The static checks: the things that are wrong before any test can run.
 *
 *   parse       every JavaScript entry point compiles, and every PowerShell file parses
 *   wiring      every element id public/app.js looks up exists in public/index.html
 *
 * This is deliberately dependency-free - the project has no installed packages, and adding a
 * linter plus its config to catch parse errors `node --check` already catches would be more
 * moving parts for the same guarantee. The id check is the one that has caught real bugs here:
 * a renamed element is not a syntax error, it is a dead button.
 *
 * Run with `npm run lint` or `node scripts/static-check.mjs`.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".github"]);

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  FAIL  ${message}`);
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ parse */

console.log("parse");
const scripts = walk(ROOT).sort();
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ["--check", file], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message)
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, 4)
      .join(" | ");
    fail(`${relative(ROOT, file)} does not parse: ${detail}`);
  }
}
console.log(`  ${scripts.length} JavaScript file(s) parse`);

const psFiles = [join(ROOT, "PingLab.ps1")];
try {
  for (const entry of readdirSync(join(ROOT, "installer"))) {
    if (entry.toLowerCase().endsWith(".ps1")) psFiles.push(join(ROOT, "installer", entry));
  }
} catch {
  // No installer folder is not a failure of the code that is here.
}

const powershell = process.platform === "win32" ? "powershell" : null;
if (!powershell) {
  console.log("  PowerShell parse skipped: this is not Windows");
} else {
  for (const file of psFiles) {
    const script = [
      `$tokens = $null; $errors = $null`,
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)`,
      `if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }`,
    ].join("; ");
    try {
      execFileSync(powershell, ["-NoProfile", "-Command", script], { cwd: ROOT, stdio: "pipe" });
    } catch (error) {
      const detail = String(error.stdout || error.stderr || error.message).trim().split("\n")[0];
      fail(`${relative(ROOT, file)} does not parse: ${detail}`);
    }
  }
  console.log(`  ${psFiles.length} PowerShell file(s) parse`);
}

/* ----------------------------------------------------------------------- wiring */

console.log("wiring");
const page = readFileSync(join(ROOT, "public", "index.html"), "utf8");
const app = readFileSync(join(ROOT, "public", "app.js"), "utf8");
const defined = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const looked = new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]));
const missing = [...looked].filter((id) => !defined.has(id)).sort();
if (missing.length) {
  fail(`public/app.js looks up id(s) that public/index.html does not define: ${missing.join(", ")}`);
} else {
  console.log(`  ${looked.size} element id(s) looked up, all defined in public/index.html`);
}

if (failures) {
  console.error(`\n${failures} static check(s) failed`);
  process.exit(1);
}
console.log("\nstatic checks passed");
