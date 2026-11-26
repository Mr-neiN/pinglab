import { join, resolve } from "node:path";
import { DATA_DIR } from "./paths.mjs";
import { bufferbloat } from "./bufferbloat.mjs";
import { saveRun, listRuns, dbStatus } from "./db.mjs";
import { soakStatus, summarizeRun } from "./soak.mjs";
import { TWEAKS, PRESETS, RISK, presetById } from "./catalog.mjs";
import { applyPreset, tweakOutcome } from "./tweaks.mjs";
import { analyseWifi, wifiAdvice } from "./wifi.mjs";
import { bloatVerdict, scanFreshnessText, dnsVerdict, dnsWinner } from "./report.mjs";

/** Created by the terminal app; `root` is the folder the app runs from. */
export function createBridge(ctx) {
  const { ui, refreshCore, runProbe, runScan, runDns, soakStart, soakStop, runTweak, say, saveTargetAdapter, getUpdateInfo, root } = ctx;
/* ---------------------------------------------------------------- bridge */

/**
 * Line-delimited JSON over stdin/stdout, used by the desktop GUI so it can drive
 * the engine in-process instead of through a web server.
 *   in : {"id":"1","cmd":"state"}
 *   out: {"id":"1","ok":true,"data":{...}}
 */
async function bridgeCommand(cmd, args = {}) {
  switch (cmd) {
    case "state": {
      await refreshCore();
      return {
        connection: ui.core?.connection || null,
        // Which adapter the rows, restore points and applies use, and the list a picker offers.
        target: ui.core?.target || null,
        adapterChoices: ui.core?.adapterChoices || [],
        targetFallback: ui.core?.targetFallback || null,
        tweak: ui.core?.tw || null,
        pending: ui.core?.pending || null,
        drift: ui.core?.drift || null,
        // Reported once per run, like /api/state does for the page: the GUI's status row is
        // the only place a user who just starts the app would otherwise never hear about a
        // database that had to be set aside.
        history: dbStatus(),
        // The same reading /api/state gives the page, so the GUI's status row can report a
        // settings file that could not be used instead of starting from defaults silently.
        config: { problem: ui.core?.configProblem ?? null },
        // The start-up update answer, in the same sentence the page and the dashboard print;
        // `checked: false` means there is nothing to say, not that this copy is current.
        update: getUpdateInfo(),
        // And the same before/after and rollback words the page and the dashboard print.
        benchmark: ui.core?.benchmark ?? null,
        runs: ui.core?.runs || [],
        soaks: ui.core?.soaks || [],
        soak: soakStatus(),
        // The catalog travels with the state so the GUI draws its own labels and preset
        // buttons from the same list the other surfaces use.
        catalog: { tweaks: TWEAKS, presets: PRESETS, risk: RISK },
      };
    }
    case "probe":
      await runProbe();
      return { probe: ui.probe, message: ui.message?.text || null };
    case "bloat": {
      ui.busy = "loading the line (download, then upload)…";
      const result = await bufferbloat({
        seconds: args.seconds ? Number(args.seconds) : 6,
        direction: args.direction || "both",
      });
      saveRun("bufferbloat", `grade ${result.overallGrade} (down ${result.download?.grade ?? "n/a"}, up ${result.upload?.grade ?? "n/a"})`, result);
      ui.bloat = { result, at: Date.now() };
      ui.busy = null;
      return { bloat: result, verdict: bloatVerdict(result) };
    }
    case "wifi": {
      // The diagnosis reads ui.core.connection.wifi; without core state it would report
      // "not reporting Wi-Fi details" no matter what the adapter is doing.
      if (!ui.core) await refreshCore();
      await runScan();
      const scan = ui.scan?.scan || null;
      const advice = scan?.ok
        ? wifiAdvice(analyseWifi(scan, ui.core?.connection?.wifi || {}), ui.core?.connection?.wifi || {}, scan)
        : [];
      return { scan, advice, freshnessText: scanFreshnessText(scan?.freshness), message: ui.message?.text || null };
    }
    case "dns":
      await runDns();
      // The GUI draws the same table and sentence the page gets from /api/dns-bench: both are
      // computed from this result by lib/report.mjs, never assembled in the window script.
      return {
        dns: ui.dns,
        verdict: ui.dns?.result ? dnsVerdict(ui.dns.result) : null,
        winner: dnsWinner(ui.dns?.result),
        message: ui.message?.text || null,
      };
    case "soakStart": {
      const minutes = args.seconds ? Number(args.seconds) / 60 : Number(args.minutes) || 10;
      await soakStart(minutes);
      return { soak: soakStatus() };
    }
    case "soakStop":
      await soakStop();
      return { soak: soakStatus() };
    case "soakStatus": {
      const st = soakStatus();
      return { soak: st, summary: st?.summary || (ui.soak?.runId ? summarizeRun(ui.soak.runId) : null) };
    }
    case "adapter": {
      // A client picks the adapter here; the answer is read back from the machine, and the
      // choice is saved, so the page and the terminal follow it too.
      const saved = await saveTargetAdapter(args.alias);
      if (!saved.ok) throw new Error(saved.error || "That adapter could not be selected.");
      await refreshCore();
      return {
        target: ui.core?.target || null,
        adapterChoices: ui.core?.adapterChoices || [],
        targetFallback: ui.core?.targetFallback || null,
        tweak: ui.core?.tw || null,
        pending: ui.core?.pending || null,
        // The GUI redraws its drift sentence from the same answer the page gets.
        drift: ui.core?.drift || null,
      };
    }
    case "apply":
      // A bridge client may apply before it ever asked for state; without core state
      // runTweak would bail out with "No active adapter to change.".
      if (!ui.core) await refreshCore();
      if (args.preset) {
        const preset = presetById(String(args.preset));
        if (!preset) throw new Error(`Unknown preset: ${args.preset}`);
        if (!ui.core?.alias) throw new Error("No active adapter to change.");
        const res = await applyPreset(ui.core.alias, preset.id);
        const outcome = tweakOutcome(res);
        say(outcome.message, outcome.kind, 10000);
      } else {
        await runTweak(String(args.action || ""));
      }
      return {
        message: ui.message?.text || null,
        kind: ui.message?.kind || null,
        tweak: ui.core?.tw || null,
        pending: ui.core?.pending || null,
      };
    case "history":
      return { runs: listRuns(null, 30) };
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

async function bridge(outPath) {
  const { createInterface } = await import("node:readline");
  const { appendFileSync, writeFileSync } = await import("node:fs");
  // Responses go to a file the client polls: a Windows GUI process reading a pipe
  // asynchronously from PowerShell 5.1 cannot deliver the callbacks reliably.
  // The file is per process so a second bridge can never truncate one a client is
  // still polling; callers may name it themselves with --out.
  const outFile = outPath ? resolve(root, outPath) : join(DATA_DIR, `bridge-out.${process.pid}.jsonl`);
  try {
    writeFileSync(outFile, "");
  } catch {}
  const rl = createInterface({ input: process.stdin, terminal: false });
  const send = (obj) => {
    try {
      appendFileSync(outFile, JSON.stringify(obj) + "\n");
    } catch {}
  };
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    // A byte-order mark is transport noise, not part of the command: Windows PowerShell has
    // been seen to prefix the first line on a pipe. Dropping it here means a BOM can never
    // make the first request (the state read) disappear without a word.
    line = line.replace(/^\uFEFF/, "");
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      try {
        const data = await bridgeCommand(msg.cmd, msg.args || {});
        send({ id: msg.id, ok: true, data });
      } catch (err) {
        send({ id: msg.id, ok: false, error: String(err?.message || err) });
      }
    });
  });
  rl.on("close", () => chain.then(() => process.exit(0)));
}


  return { bridge };
}
