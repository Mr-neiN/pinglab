/**
 * The desktop GUI's adapter picker, driven headlessly.
 *
 * The page, the TUI and the CLI can all choose which adapter settings apply to; the WinForms app
 * could only show the default route's name. `PingLab.ps1` now builds the window, fills the picker
 * from the bridge's state and saves a choice through the same `adapter` command and
 * `lib/config.mjs` write the page uses. This suite runs that window without showing it:
 *
 *   PINGLAB_GUI_SELFTEST=1 powershell.exe -File PingLab.ps1
 *
 * and the script prints one `GUISELFTEST {json}` line with a check per rule. Everything inside
 * that run goes through the real controls and the real handlers: the ComboBox's
 * SelectedIndexChanged, the CheckBox's CheckedChanged, `Set-TargetAdapter`, `Update-Fixes` and
 * `Update-RestorePoints`, over a real `pinglab.mjs --bridge` against `lib/ps-fake.mjs`.
 *
 * Checked here: the picker preselects the physical adapter that carries the default route even
 * though a VPN tunnel owns the top of the routing table (with the same note the other surfaces
 * print); virtual adapters are absent until the box is ticked and revealing them does not move
 * the target; choosing another adapter persists it to config.json and re-reads the rows, drift,
 * DNS-in-use and restore points against it; an apply carries that adapter and lands a restore
 * point naming it; and an unknown name is refused, reported, and leaves the saved choice alone.
 *
 * This machine's Windows is required: the window cannot be built anywhere else.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

if (process.platform !== "win32") {
  console.log("the GUI picker test builds a WinForms window, so it only runs on Windows");
  console.log("\nall GUI adapter checks passed");
  process.exit(0);
}

/** Wi-Fi on the default route, Ethernet, and a VPN tunnel that owns the top route. */
function scenario() {
  return {
    elevatedUser: false,
    adapters: [
      {
        Name: "WLAN",
        InterfaceDescription: "Intel Wi-Fi 6 AX201",
        Status: "Up",
        LinkSpeed: "1 Gbps",
        MacAddress: "AA-BB-CC-DD-EE-FF",
        ifIndex: 1,
        InterfaceGuid: "GUID-WLAN",
        DriverVersion: "1.0.0.0",
      },
      {
        Name: "Ethernet 2",
        InterfaceDescription: "Intel(R) Ethernet Connection I219-V",
        Status: "Up",
        LinkSpeed: "2.5 Gbps",
        MacAddress: "AA-BB-CC-DD-EE-01",
        ifIndex: 2,
        InterfaceGuid: "GUID-ETH",
        DriverVersion: "2.0.0.0",
      },
      {
        Name: "Tailscale",
        InterfaceDescription: "Tailscale Tunnel",
        Status: "Up",
        LinkSpeed: "100 Gbps",
        MacAddress: "AA-BB-CC-DD-EE-02",
        ifIndex: 3,
        InterfaceGuid: "GUID-VPN",
        DriverVersion: "1.0.0.0",
      },
    ],
    // The VPN is the lowest-metric route, so the target rule has to pass over it. The physical
    // adapters keep their own default routes, which is what makes WLAN the honest target.
    routes: [
      { InterfaceAlias: "Tailscale", NextHop: "100.64.0.1", RouteMetric: 5, ifIndex: 3 },
      { InterfaceAlias: "WLAN", NextHop: "192.168.1.1", RouteMetric: 25, ifIndex: 1 },
      { InterfaceAlias: "Ethernet 2", NextHop: "192.168.1.1", RouteMetric: 35, ifIndex: 2 },
    ],
    profiles: [{ Name: "HomeNet", InterfaceAlias: "WLAN", IPv4Connectivity: "Internet", NetworkCategory: "Private" }],
    machines: {
      WLAN: {
        guid: "GUID-WLAN",
        ack: null,
        nodelay: null,
        power: { planAc: 1, planDc: 2, ndis: "enabled", wmiEnable: true, scheme: "SCHEME-1" },
        tuning: { MIMOPowerSaveMode: 0, RoamAggressiveness: 2 },
        profile: "HomeNet",
      },
      "Ethernet 2": {
        guid: "GUID-ETH",
        ack: null,
        nodelay: null,
        power: { planAc: 1, planDc: 2, ndis: "enabled", wmiEnable: true, scheme: "SCHEME-1" },
      },
    },
    wlan: { wifi: true, joined: "HomeNet", profiles: ["HomeNet"] },
    dns: { WLAN: ["192.168.1.1"], "Ethernet 2": ["192.168.1.1"] },
    dnsStatic: { WLAN: false, "Ethernet 2": false },
    stats: { rx: 1_000, tx: 1_000 },
  };
}

function runGui(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "PingLab.ps1")],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PINGLAB_DATA_DIR: dir,
          PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
          PINGLAB_PS_SCENARIO_FILE: join(dir, "scenario.json"),
          // No real GitHub request during a test: the check fails fast and says nothing.
          PINGLAB_UPDATE_URL: "http://127.0.0.1:9/releases/latest",
          PINGLAB_GUI_SELFTEST: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the GUI self-test did not finish in 120 s\nstdout:\n${out}\nstderr:\n${err}`));
    }, 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "pinglab-gui-adapter-"));
writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario(), null, 2), "utf8");

console.log("gui adapter picker");

let result;
try {
  result = await runGui(dir);

  const line = String(result.out)
    .split(/\r?\n/)
    .find((l) => l.startsWith("GUISELFTEST "));
  assert.ok(
    line,
    `no GUISELFTEST line in the output (exit ${result.code})\nstdout:\n${result.out}\nstderr:\n${result.err}`,
  );
  const resultFile = line.slice("GUISELFTEST ".length).trim();
  assert.ok(existsSync(resultFile), `the self-test result file was not written: ${resultFile}`);
  var checks = JSON.parse(readFileSync(resultFile, "utf8"));
} finally {
  // The window may still hold its log and response file for a moment on Windows.
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
// On a failure, the runner's own log is the only view into the hidden window: the bridge's
// state line and every render it did are there. Printing it beats guessing from one detail.
const guiLog = () => {
  try {
    return readFileSync(join(dir, "gui.log"), "utf8");
  } catch {
    return "(no gui.log written)";
  }
};
for (const [name, check] of Object.entries(checks)) {
  assert.equal(check.ok, true, `${name}: ${check.detail}\nchecks: ${JSON.stringify(checks)}\ngui.log:\n${guiLog()}`);
}

assert.deepEqual(
  Object.keys(checks),
  ["preselected", "physical-only", "vpn-note", "revealed", "switch-persisted", "apply-chosen-adapter", "rows-named", "refused"],
  "every rule the picker promises has a check",
);
assert.equal(
  result.code,
  0,
  `the self-test reported a failure (exit ${result.code})\nchecks: ${JSON.stringify(checks)}\nstdout:\n${result.out}\ngui.log:\n${guiLog()}`,
);

console.log("  preselected  the default route's physical adapter is selected, not the VPN tunnel");
console.log("  physical-only virtual adapters are absent until the box is ticked, and revealing them keeps the target");
console.log("  vpn-note     the same sentence the page and terminal print is shown");
console.log("  switch       the choice is saved through the bridge, and rows/drift/DNS/restore points re-read");
console.log("  apply        an apply carries the chosen adapter and its restore point names it");
console.log("  refused      an unknown name changes nothing, says so, and puts the picker back");
console.log("  saved        config.json holds the chosen adapter afterwards");
console.log("\nall GUI adapter checks passed");
