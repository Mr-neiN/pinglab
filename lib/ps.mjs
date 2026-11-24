import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acceptsResult, encodeCommand, openChannel } from "./elevation-channel.mjs";

/**
 * The real PowerShell, by full path. A bare "powershell.exe" is resolved through the current
 * directory and PATH, where a dropped file could answer instead - including for the elevated
 * start below, whose launcher also names this path. The system copy is the only one Windows
 * itself trusts; if it is somehow missing, the bare name is the last resort.
 */
export const PS_EXE =
  process.env.SystemRoot &&
  existsSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

/**
 * Test-only stand-in: PINGLAB_PS_STUB names a module exporting `ps(script)` and
 * `elevated(script)`, and every PowerShell call goes there instead of a process. It lets
 * lib/tweaks.test.mjs drive the apply and revert paths on a fake Windows without a UAC
 * prompt. Nothing changes unless the variable is set; see README -> Test hooks.
 */
let stubModule = null;
async function psStub() {
  const path = process.env.PINGLAB_PS_STUB;
  if (!path) return null;
  if (!stubModule) stubModule = import(pathToFileURL(path).href);
  return stubModule;
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

/** Run a PowerShell snippet and return its stdout. Never throws. */
export async function runPs(script, { timeout = 30000 } = {}) {
  const fake = await psStub();
  if (fake) {
    const res = await fake.ps(script, { timeout });
    return {
      ok: res?.ok !== false,
      stdout: String(res?.stdout ?? "").trim(),
      stderr: String(res?.stderr ?? "").trim(),
      error: res?.error ? String(res.error) : null,
      timedOut: false,
    };
  }
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

let elevatedCache = null;

/**
 * Whether this process already runs with administrator rights. Cached: it cannot change
 * while the process lives, and every action asks.
 */
export async function isElevated() {
  if (elevatedCache !== null) return elevatedCache;
  const res = await runPs(
    "[bool]((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))",
    { timeout: 10000 },
  );
  elevatedCache = res.ok && /true/i.test(res.stdout);
  return elevatedCache;
}

function quotePsPath(p) {
  return p.replace(/'/g, "''");
}

/**
 * The switches the elevated PowerShell is started with. `-EncodedCommand` is the one that
 * makes it run the base64 text at all: handed the blob alone, PowerShell reads it as a
 * command name and exits with "not recognized as the name of a cmdlet" - which is what
 * 1.0.18 did, after the prompt had already been answered. Kept as a function so the suite
 * can start a real PowerShell with exactly these arguments.
 */
export function elevatedArgs(encoded) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", String(encoded)];
}

/**
 * The Start-Process line that asks Windows for the prompt. `verb: null` starts the same
 * executable with the same arguments without UAC, which is how the suite proves the launch
 * really runs the bootstrap: no test can click a prompt.
 */
export function launcherCommand(exe, encoded, { verb = "RunAs" } = {}) {
  const list = elevatedArgs(encoded)
    .map((arg) => `'${quotePsPath(arg)}'`)
    .join(",");
  return `Start-Process -FilePath '${quotePsPath(exe)}'${verb ? ` -Verb ${verb}` : ""} -Wait -ArgumentList @(${list})`;
}

/**
 * Run a script as administrator. The script must assign an object to $result;
 * this returns it as parsed JSON. Spawns a UAC prompt (user must approve).
 */
export async function runElevated(script, { timeout = 180000 } = {}) {
  // Deterministic stand-ins for a prompt nobody can click in a test run. They return before
  // anything is written, exactly like a dismissed or refused prompt.
  const stub = process.env.PINGLAB_ELEVATION;
  if (stub === "cancel") {
    return { ok: false, data: null, cancelled: true, reason: "cancelled", error: "the administrator prompt was closed" };
  }
  if (stub === "refuse") {
    return { ok: false, data: null, cancelled: false, reason: "refused", error: "Windows did not grant administrative rights" };
  }
  const fake = await psStub();
  if (fake) return fake.elevated(script, { timeout });

  // No file. The script goes down a pipe this process owns, once the elevated PowerShell on
  // the other end has connected; see lib/elevation-channel.mjs for why that matters.
  let channel;
  try {
    channel = await openChannel(script);
  } catch (e) {
    return {
      ok: false,
      data: null,
      cancelled: false,
      reason: "refused",
      error: `Could not open the channel the elevated script needs (${String(e?.message || e).trim()}). Nothing was changed.`,
    };
  }

  try {
    const launcher =
      launcherCommand(PS_EXE, encodeCommand(channel.bootstrap));
    const { err, stderr } = await execFileP(
      PS_EXE,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launcher],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
    );

    const payload = await channel.result(2000);
    // A result is only trusted when it carries this call's nonce: a forged one cannot.
    const data = acceptsResult(payload, channel.nonce) ? payload.result : null;
    if (data) {
      return { ok: data.ok !== false, data, cancelled: false, reason: null };
    }

    const text = `${stderr || ""} ${err?.message || ""}`;
    const cancelled = looksCancelled(text);
    return {
      ok: false,
      data: null,
      cancelled,
      reason: cancelled ? "cancelled" : err?.killed ? "timeout" : "refused",
      error: err ? String(err.message || "elevation failed").trim() : "no result returned",
    };
  } finally {
    channel.close();
  }
}

/** Start a non-elevated Windows URI/program, e.g. ms-settings:privacy-location */
export async function openTarget(target) {
  return runPs(`Start-Process '${target.replace(/'/g, "''")}'`, { timeout: 10000 });
}
