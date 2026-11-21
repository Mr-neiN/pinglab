import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const PS_EXE = "powershell.exe";
const TMP_DIR = join(process.cwd(), "data", "tmp");

function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

/** Run a PowerShell snippet and return its stdout. Never throws. */
export async function runPs(script, { timeout = 30000 } = {}) {
  const wrapped =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
    "$ProgressPreference='SilentlyContinue'; " +
    "$ErrorActionPreference='SilentlyContinue'; " +
    script;
  const { err, stdout, stderr } = await execFileP(
    PS_EXE,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapped],
    { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
  );
  return {
    ok: !err,
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim(),
    error: err ? String(err.message || "").trim() : null,
    timedOut: Boolean(err && (err.killed || err.signal)),
  };
}

/** Run PowerShell that emitted JSON via ConvertTo-Json. Always returns an array. */
export async function runPsJson(script, opts = {}) {
  const raw = await runPs(script, opts);
  const text = raw.stdout;
  if (!text) return { ok: raw.ok, data: [], raw };
  try {
    const parsed = JSON.parse(text);
    return { ok: raw.ok, data: Array.isArray(parsed) ? parsed : [parsed], raw };
  } catch {
    return { ok: false, data: [], raw, error: "Could not parse PowerShell JSON output" };
  }
}

/** True when a failed elevated call was caused by the user dismissing the UAC prompt. */
function looksCancelled(text) {
  return /cancel|abgebrochen|abbrechen|denied|verweigert|0x800704c7/i.test(text || "");
}

function quotePsPath(p) {
  return p.replace(/'/g, "''");
}

/**
 * Run a script as administrator. The script must assign an object to $result;
 * this returns it as parsed JSON. Spawns a UAC prompt (user must approve).
 */
export async function runElevated(script, { timeout = 180000 } = {}) {
  mkdirSync(TMP_DIR, { recursive: true });
  const id = `t${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const psPath = join(TMP_DIR, `${id}.ps1`);
  const outPath = join(TMP_DIR, `${id}.out.json`);

  const body = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$ProgressPreference='SilentlyContinue'",
    "$ErrorActionPreference='Stop'",
    "$result = $null",
    "try {",
    script,
    "} catch {",
    "  $result = [ordered]@{ ok = $false; message = $_.Exception.Message }",
    "}",
    "if ($null -eq $result) { $result = [ordered]@{ ok = $true; message = 'done' } }",
    "try {",
    `  [System.IO.File]::WriteAllText('${quotePsPath(outPath)}', (ConvertTo-Json -InputObject $result -Compress -Depth 6), [System.Text.Encoding]::UTF8)`,
    "} catch {}",
  ].join("\n");
  writeFileSync(psPath, body, "utf8");

  const argString = `-NoProfile -ExecutionPolicy Bypass -File "${psPath}"`;
  const launcher =
    "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait " +
    `-ArgumentList '${argString.replace(/'/g, "''")}'`;
  const { err, stderr } = await execFileP(
    PS_EXE,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launcher],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
  );

  let data = null;
  if (existsSync(outPath)) {
    try {
      data = JSON.parse(readFileSync(outPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      data = null;
    }
  }
  for (const f of [psPath, outPath]) {
    try {
      rmSync(f, { force: true });
    } catch {}
  }

  if (data) return { ok: data.ok !== false, data, cancelled: false };
  const text = `${stderr || ""} ${err?.message || ""}`;
  return {
    ok: false,
    data: null,
    cancelled: looksCancelled(text),
    error: err ? String(err.message || "elevation failed").trim() : "no result returned",
  };
}

/** Start a non-elevated Windows URI/program, e.g. ms-settings:privacy-location */
export async function openTarget(target) {
  return runPs(`Start-Process '${target.replace(/'/g, "''")}'`, { timeout: 10000 });
}
