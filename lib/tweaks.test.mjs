/**
 * The apply / revert table, driven on a fake Windows.
 *
 * Every outcome a user can meet is pinned here without a UAC prompt:
 *   applied            - the restore point is written before the elevated call, and kept
 *   already in place   - success with no elevation and no second restore point
 *   unavailable        - refused with a reason, nothing written, no prompt
 *   refused            - the prompt or a policy refused it: nothing written, point discarded
 *   failed after a write - the point is kept, because a partial change still needs it
 *   reverted           - the inverse comes from the recorded values, then the point goes
 *
 * The fake is lib/ps-fake.mjs, loaded through PINGLAB_PS_STUB (see lib/ps.mjs). It answers
 * the real scripts by matching what they ask for and logs every call, so "no elevation was
 * requested" is asserted, not assumed.
 *
 * Nothing here touches this machine: the working directory is a throwaway folder, so
 * data/backups.json is the temp one, and no PowerShell process is started at all.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pinglab-tweaks-"));
const logFile = join(dir, "ps-calls.ndjson");
process.env.PINGLAB_PS_STUB = join(ROOT, "lib", "ps-fake.mjs");
process.env.PINGLAB_PS_LOG = logFile;
delete process.env.PINGLAB_ELEVATION; // the cancel/refuse stubs would pre-empt the fake

const previousCwd = process.cwd();
process.chdir(dir); // DATA_DIR is derived from the working directory when tweaks.mjs loads
const tw = await import("../lib/tweaks.mjs");
const { actionSpec, elevationText } = tw;
const BACKUP_FILE = join(dir, "data", "backups.json");
const EMPTY_BACKUPS = { dns: {}, planPower: {}, nicPower: {}, nagle: {}, adapterTuning: {}, wifiOrder: {}, history: [] };

/* ------------------------------------------------------------------ harness */

const resetLog = () => writeFileSync(logFile, "", "utf8");
const calls = () =>
  readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const elevatedCalls = () => calls().filter((c) => c.kind === "elevated");
const lastElevatedScript = () => elevatedCalls().at(-1)?.script || "";

const clearBackups = () => {
  rmSync(BACKUP_FILE, { force: true });
  tw.writeBackups(structuredClone(EMPTY_BACKUPS));
};

const seed = (sections) => {
  clearBackups();
  const b = tw.readBackups();
  Object.assign(b, sections);
  tw.writeBackups(b);
};

/** The machine a case needs: one adapter, a WLAN list, and whose DNS servers are known. */
function machineFor(alias, spec = {}, extra = {}) {
  return {
    elevatedUser: false,
    machines: { [alias]: spec },
    wlan: {
      wifi: true,
      joined: "HomeNet",
      profiles: ["Neighbour", "HomeNet"],
      profilesAfter: ["HomeNet", "Neighbour"],
      ...(spec.wlan || {}),
    },
    ...extra,
  };
}

async function act(alias, scenario, action, opts) {
  process.env.PINGLAB_PS_SCENARIO = JSON.stringify(scenario);
  resetLog();
  return tw.runTweakAction(alias, action, opts);
}

const expectOk = (res) => assert.equal(res.ok, true, `expected success, got: ${res.data?.message || res.error}`);
const expectFail = (res, pattern) => {
  assert.equal(res.ok, false, "expected a failure");
  assert.match(String(res.data?.message || res.error || ""), pattern);
};
const expectElevations = (n) =>
  assert.equal(elevatedCalls().length, n, `expected ${n} elevation prompt(s), saw ${elevatedCalls().length}`);

/* -------------------------------------------------------------------- cases */

const cases = [
  {
    name: "plan-power-off: writes the restore point first, then the elevated 0/0",
    run: () => act("planApply", machineFor("planApply", { power: { planAc: 1, planDc: 2 } }), "plan-power-off"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      assert.match(lastElevatedScript(), /powercfg \/setacvalueindex \$scheme \$sub \$setting 0/);
      assert.match(lastElevatedScript(), /powercfg \/setdcvalueindex \$scheme \$sub \$setting 0/);
      const b = tw.readBackups();
      assert.deepEqual({ ac: b.planPower.planApply.ac, dc: b.planPower.planApply.dc }, { ac: 1, dc: 2 });
      assert.equal(b.history[0].action, "plan-power-off");
      assert.equal(res.elevation.needed, true, "a standard account must be told the prompt is coming");
      assert.equal(res.elevation.command, "node pinglab.mjs --apply plan");
    },
  },
  {
    name: "plan-power-off again: already at maximum, no prompt, original point untouched",
    seed: { planPower: { planAlready: { ac: 1, dc: 2, at: "2026-01-01T00:00:00.000Z" } } },
    run: () => act("planAlready", machineFor("planAlready", { power: { planAc: 0, planDc: 0 } }), "plan-power-off"),
    check: (res) => {
      expectOk(res);
      assert.match(res.data.message, /already at maximum performance/);
      expectElevations(0);
      const b = tw.readBackups();
      assert.equal(b.planPower.planAlready.ac, 1, "a no-op must not record 0/0 as the original");
      assert.equal(b.history.length, 0, "a no-op is not history");
    },
  },
  {
    name: "plan-power-on with nothing recorded: refused, no prompt",
    run: () => act("planRevertMissing", machineFor("planRevertMissing"), "plan-power-on"),
    check: (res) => {
      expectFail(res, /Nothing recorded to restore for wireless power saving/);
      expectElevations(0);
      assert.deepEqual(tw.readBackups().planPower, {});
    },
  },
  {
    name: "plan-power-on: restores the recorded AC/DC values and drops the point",
    seed: { planPower: { planRevert: { ac: 1, dc: 2, acSource: "user", dcSource: "user", scheme: "SCHEME-1" } } },
    run: () => act("planRevert", machineFor("planRevert", { power: { planAc: 0, planDc: 0 } }), "plan-power-on"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      assert.match(lastElevatedScript(), /powercfg \/setacvalueindex \$scheme \$sub \$setting 1/);
      assert.match(lastElevatedScript(), /powercfg \/setdcvalueindex \$scheme \$sub \$setting 2/);
      const b = tw.readBackups();
      assert.deepEqual(b.planPower, {}, "the point is dropped only after the write is reported");
      assert.equal(b.history[0].action, "plan-power-on");
    },
  },
  {
    name: "plan-power-off with the prompt closed: one sentence, point discarded",
    run: () => act("planCancel", machineFor("planCancel", { power: { planAc: 1, planDc: 2 }, elevated: { mode: "cancel" } }), "plan-power-off"),
    check: (res) => {
      expectFail(res, /administrator prompt was closed/);
      assert.equal(res.cancelled, true);
      assert.equal(res.needsAdmin, true);
      expectElevations(1);
      assert.equal(
        res.data.message,
        elevationText(actionSpec("plan-power-off"), { cancelled: true }),
        "the TUI, GUI and web all print this exact sentence",
      );
      assert.deepEqual(tw.readBackups().planPower, {}, "a prompt that never ran leaves no restore point");
    },
  },
  {
    name: "plan-power-off refused by policy: nothing written, point discarded",
    run: () =>
      act(
        "planDenied",
        machineFor("planDenied", { power: { planAc: 1, planDc: 2 }, elevated: { mode: "fail", error: "Access is denied" } }),
        "plan-power-off",
      ),
    check: (res) => {
      expectFail(res, /needs administrator rights/);
      assert.match(res.data.message, /nothing was written/);
      assert.equal(res.needsAdmin, true);
      assert.deepEqual(tw.readBackups().planPower, {});
    },
  },
  {
    name: "plan-power-off failing after the write: the point is kept",
    run: () =>
      act(
        "planFail",
        machineFor("planFail", {
          power: { planAc: 1, planDc: 2 },
          elevated: { mode: "fail", error: "Power plan did not take the new value (AC=1 DC=2)" },
        }),
        "plan-power-off",
      ),
    check: (res) => {
      expectFail(res, /did not take the new value/);
      assert.notEqual(res.needsAdmin, true, "a driver failure is not an elevation problem");
      const b = tw.readBackups();
      assert.equal(b.planPower.planFail.ac, 1, "a partial change still needs its restore point");
      assert.equal(b.history.length, 0, "nothing changed, so nothing is logged as applied");
    },
  },
  {
    name: "nic-power-off on a driver without the setting: unavailable, no prompt",
    run: () =>
      act(
        "nicUnsupported",
        machineFor("nicUnsupported", { power: { ndis: "unreadable", wmiEnable: null } }),
        "nic-power-off",
      ),
    check: (res) => {
      expectFail(res, /no device power-management setting/);
      assert.equal(res.unsupported, true);
      expectElevations(0);
    },
  },
  {
    name: "nic-power-off: records what the device reported before disabling it",
    run: () => act("nicApply", machineFor("nicApply", { power: { ndis: "Enabled", wmiEnable: true } }), "nic-power-off"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      assert.match(lastElevatedScript(), /Disable-NetAdapterPowerManagement -Name \$alias/);
      assert.equal(tw.readBackups().nicPower.nicApply.before, "Enabled");
    },
  },
  {
    name: "nagle-off: records absent values as absent, not as a default",
    run: () => act("nagleApply", machineFor("nagleApply", { ack: null, nodelay: null }), "nagle-off"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      assert.match(lastElevatedScript(), /Set-ItemProperty -Path \$key -Name TcpAckFrequency -Value 1 -Type DWord/);
      const point = tw.readBackups().nagle.nagleApply;
      assert.deepEqual(point.before, { TcpAckFrequency: null, TCPNoDelay: null });
    },
  },
  {
    name: "nagle-off already disabled: no prompt and no new restore point",
    run: () => act("nagleAlready", machineFor("nagleAlready", { ack: 1, nodelay: null }), "nagle-off"),
    check: (res) => {
      expectOk(res);
      assert.match(res.data.message, /already disabled/);
      expectElevations(0);
      assert.deepEqual(tw.readBackups().nagle, {}, "recording 1/1 as the original would restore nothing");
    },
  },
  {
    name: "nagle-on: removes what was absent and puts back the recorded number",
    seed: { nagle: { nagleRevert: { before: { TcpAckFrequency: null, TCPNoDelay: 3 }, guid: "GUID-nagleRevert" } } },
    run: () => act("nagleRevert", machineFor("nagleRevert"), "nagle-on"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      const script = lastElevatedScript();
      assert.match(script, /Remove-ItemProperty -Path \$key -Name TcpAckFrequency -ErrorAction SilentlyContinue/);
      assert.match(script, /Set-ItemProperty -Path \$key -Name TCPNoDelay -Value 3 -Type DWord/);
      assert.deepEqual(tw.readBackups().nagle, {});
    },
  },
  {
    name: "dns-apply: records the servers in use, writes the chosen pair",
    run: () =>
      act("dnsApply", machineFor("dnsApply", {}, { dns: { dnsApply: ["192.168.1.1", "1.1.1.1"] } }), "dns-apply", {
        servers: ["9.9.9.9", "149.112.112.112"],
      }),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      const script = lastElevatedScript();
      assert.match(script, /'9\.9\.9\.9', '149\.112\.112\.112'/);
      assert.match(script, /DNS did not take the new servers/, "the write must compare what the adapter kept");
      const point = tw.readBackups().dns.dnsApply;
      assert.deepEqual(point.servers, ["192.168.1.1", "1.1.1.1"]);
      assert.equal(point.staticDns, false, "the record says the pair came from the router");
    },
  },
  {
    name: "dns-apply with an unreadable current list: refuses before writing",
    run: () => act("dnsUnreadable", machineFor("dnsUnreadable"), "dns-apply", { servers: ["9.9.9.9"] }),
    check: (res) => {
      expectFail(res, /Could not read the current DNS servers/);
      expectElevations(0);
      assert.deepEqual(tw.readBackups().dns, {});
    },
  },
  {
    name: "dns-reset on a record that says nothing about the DNS source: hands the adapter back",
    seed: { dns: { dnsReset: { servers: ["192.168.1.1"], at: "2026-01-01T00:00:00.000Z" } } },
    run: () => act("dnsReset", machineFor("dnsReset"), "dns-reset"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      assert.match(lastElevatedScript(), /-ResetServerAddresses/);
      assert.deepEqual(tw.readBackups().dns, {});
    },
  },
  {
    name: "dns-reset on a static DNS list: writes the recorded servers back, not DHCP",
    seed: {
      dns: { dnsResetStatic: { servers: ["192.168.1.1", "192.168.1.2"], staticDns: true, at: "2026-01-01T00:00:00.000Z" } },
    },
    run: () => act("dnsResetStatic", machineFor("dnsResetStatic", {}, { dns: { dnsResetStatic: ["9.9.9.9"] } }), "dns-reset"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      const script = lastElevatedScript();
      assert.match(script, /\$servers = @\('192\.168\.1\.1', '192\.168\.1\.2'\)/);
      assert.match(script, /-ServerAddresses \$servers/);
      assert.equal(script.includes("-ResetServerAddresses"), false, "a static config must not be replaced by DHCP");
      assert.deepEqual(tw.readBackups().dns, {});
    },
  },
  {
    name: "dns-reset on a DHCP-provided DNS list: hands the adapter back to automatic",
    seed: { dns: { dnsResetDhcp: { servers: ["192.168.1.1"], staticDns: false, at: "2026-01-01T00:00:00.000Z" } } },
    run: () => act("dnsResetDhcp", machineFor("dnsResetDhcp"), "dns-reset"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      assert.match(lastElevatedScript(), /-ResetServerAddresses/);
      assert.deepEqual(tw.readBackups().dns, {});
    },
  },
  {
    name: "dns-reset on a record written before the staticDns note, when it said static: writes the servers back",
    seed: { dns: { dnsResetLegacy: { servers: ["192.168.1.1"], dhcp: false, at: "2026-01-01T00:00:00.000Z" } } },
    run: () => act("dnsResetLegacy", machineFor("dnsResetLegacy"), "dns-reset"),
    check: (res) => {
      expectOk(res);
      const script = lastElevatedScript();
      assert.match(script, /\$servers = @\('192\.168\.1\.1'\)/);
      assert.equal(script.includes("-ResetServerAddresses"), false, "an old static record keeps its old meaning");
      assert.deepEqual(tw.readBackups().dns, {});
    },
  },
  {
    name: "dns: DHCP address plus hand-set DNS is static, so its undo writes the servers back",
    run: async () => {
      // The case the address's DHCP state gets wrong: the router hands out the IP, but the
      // resolvers were typed in (a Pi-hole). Undo must put them back, not reset the adapter.
      const scenario = machineFor(
        "dnsMixed",
        {},
        { dns: { dnsMixed: ["192.168.1.1", "10.0.0.53"] }, dnsStatic: { dnsMixed: true } },
      );
      const applied = await act("dnsMixed", scenario, "dns-apply", { servers: ["9.9.9.9"] });
      const point = { ...tw.readBackups().dns.dnsMixed };
      const reset = await act("dnsMixed", scenario, "dns-reset");
      return { applied, point, reset, resetScript: lastElevatedScript() };
    },
    check: ({ applied, point, reset, resetScript }) => {
      expectOk(applied);
      assert.equal(point.staticDns, true, "NameServer says these servers were set by hand");
      expectOk(reset);
      assert.match(resetScript, /\$servers = @\('192\.168\.1\.1', '10\.0\.0\.53'\)/);
      assert.equal(
        resetScript.includes("-ResetServerAddresses"),
        false,
        "the address came from DHCP, but the DNS list did not: resetting would lose the Pi-hole",
      );
      assert.deepEqual(tw.readBackups().dns, {});
    },
  },
  {
    name: "wifi-order-first: records the whole order, then moves the joined profile to #1",
    run: () => act("orderFirst", machineFor("orderFirst"), "wifi-order-first"),
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      assert.match(res.data.message, /is now first/);
      assert.match(lastElevatedScript(), /netsh wlan set profileorder name="\$n" interface="\$alias" priority=1/);
      assert.deepEqual(tw.readBackups().wifiOrder.orderFirst.profiles, ["Neighbour", "HomeNet"]);
    },
  },
  {
    name: "wifi-order-first when it is already first: no prompt, nothing recorded",
    run: () =>
      act(
        "orderAlready",
        machineFor("orderAlready", { wlan: { joined: "HomeNet", profiles: ["HomeNet", "Neighbour"] } }),
        "wifi-order-first",
      ),
    check: (res) => {
      expectOk(res);
      assert.match(res.data.message, /already first/);
      expectElevations(0);
      assert.deepEqual(tw.readBackups().wifiOrder, {});
    },
  },
  {
    name: "wifi-order-first on a wired adapter: refused with the reason",
    run: () => act("orderNotWifi", machineFor("orderNotWifi", { wlan: { wifi: false } }), "wifi-order-first"),
    check: (res) => {
      expectFail(res, /not wireless/);
      expectElevations(0);
    },
  },
  {
    name: "wifi-order-first whose read-back disagrees: reported as failed, point kept",
    run: () =>
      act(
        "orderMismatch",
        machineFor("orderMismatch", { wlan: { profilesAfter: ["Neighbour", "HomeNet"] } }),
        "wifi-order-first",
      ),
    check: (res) => {
      expectFail(res, /still reads/);
      expectElevations(1);
      assert.deepEqual(tw.readBackups().wifiOrder.orderMismatch.profiles, ["Neighbour", "HomeNet"]);
    },
  },
  {
    name: "an action the dispatch table does not know: an error, not a crash",
    run: () => act("unknownAction", machineFor("unknownAction"), "not-a-tweak"),
    check: (res) => {
      expectFail(res, /Unknown action: not-a-tweak/);
      expectElevations(0);
    },
  },
  {
    name: "safe preset: counts already-in-place and unavailable steps instead of failing",
    seed: { planPower: { presetSafe: { ac: 0, dc: 0, at: "2026-01-01T00:00:00.000Z" } } },
    run: async () => {
      process.env.PINGLAB_PS_SCENARIO = JSON.stringify(
        machineFor("presetSafe", {
          power: { planAc: 0, planDc: 0, ndis: "unreadable", wmiEnable: null },
          wlan: { joined: "HomeNet", profiles: ["HomeNet", "Neighbour"] },
        }),
      );
      resetLog();
      return tw.applyPreset("presetSafe", "safe");
    },
    check: (res) => {
      expectOk(res);
      assert.deepEqual(
        res.data.steps.map((s) => [s.id, s.status]),
        [
          ["plan-power", "already"],
          ["nic-power", "skipped"],
          ["wifi-order", "already"],
        ],
      );
      assert.match(res.data.message, /2 already in place/);
      assert.match(res.data.message, /1 skipped/);
      expectElevations(0);
    },
  },
  {
    name: "latency preset with the first prompt closed: stops, reports what was not reached",
    run: async () => {
      process.env.PINGLAB_PS_SCENARIO = JSON.stringify(
        machineFor("presetCancel", { power: { planAc: 1, planDc: 2 }, elevated: { mode: "cancel" } }),
      );
      resetLog();
      return tw.applyPreset("presetCancel", "latency");
    },
    check: (res) => {
      assert.equal(res.ok, false);
      assert.equal(res.data.steps.length, 1, "a closed prompt must not be asked for again");
      assert.equal(res.data.steps[0].id, "plan-power");
      assert.equal(res.data.steps[0].status, "skipped");
      assert.match(res.data.steps[0].message, /administrator prompt closed/);
      assert.match(res.data.message, /3 not reached/);
      expectElevations(1);
      assert.deepEqual(tw.readBackups().planPower, {});
    },
  },
  {
    name: "unknown preset: the error lists the real ones",
    run: async () => {
      resetLog();
      return tw.applyPreset("presetUnknown", "turbo");
    },
    check: (res) => {
      expectFail(res, /Unknown preset "turbo"/);
      assert.match(res.error, /safe \(Safe \/ recommended\)/);
      expectElevations(0);
    },
  },
  {
    name: "unreadable backups.json blocks a preset before the first step",
    run: async () => {
      resetLog();
      writeFileSync(BACKUP_FILE, '{"planPower": [}', "utf8");
      return tw.applyPreset("presetBlocked", "safe");
    },
    check: (res) => {
      expectFail(res, /Refusing to change anything/);
      assert.equal(res.backupProblem, true);
      expectElevations(0);
    },
  },
];

/* -------------------------------------------------------------- restore-all */

const at = "2026-01-01T00:00:00.000Z";

const restoreCases = [
  {
    name: "restore-all with nothing recorded: says so, no prompt",
    run: async () => {
      resetLog();
      return tw.restoreAll();
    },
    check: (res) => {
      expectOk(res);
      assert.match(res.data.message, /Nothing to restore/);
      expectElevations(0);
    },
  },
  {
    name: "restore-all: every recorded area verified, all points dropped, history kept",
    seed: {
      planPower: { "WLAN-r2": { ac: 1, dc: 2, acSource: "user", dcSource: "user", scheme: "SCHEME-1", at } },
      nicPower: { "WLAN-r2": { before: "Disabled", at } },
      nagle: { "WLAN-r2": { before: { TcpAckFrequency: null, TCPNoDelay: 3 }, guid: "GUID-WLAN-r2", at } },
      dns: { "WLAN-r2": { servers: ["192.168.1.1"], at } },
      adapterTuning: { "WLAN-r2": { values: { MIMOPowerSaveMode: 3, RoamAggressiveness: 0 }, at } },
      wifiOrder: { "WLAN-r2": { profiles: ["Neighbour", "HomeNet"], joined: "HomeNet", at } },
      history: [{ action: "nagle-off", detail: { alias: "WLAN-r2" }, at }],
    },
    run: async () => {
      process.env.PINGLAB_PS_SCENARIO = JSON.stringify(
        machineFor(
          "WLAN-r2",
          {
            ack: null,
            nodelay: 3,
            tuning: { MIMOPowerSaveMode: 3, RoamAggressiveness: 0 },
            wlan: { profiles: ["Neighbour", "HomeNet"], profilesAfter: ["Neighbour", "HomeNet"] },
          },
          { dns: { "WLAN-r2": ["192.168.1.1"] } },
        ),
      );
      resetLog();
      return tw.restoreAll();
    },
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      const script = lastElevatedScript();
      assert.match(script, /powercfg \/setacvalueindex \$scheme [^\n]* 1/);
      assert.match(script, /powercfg \/setdcvalueindex \$scheme [^\n]* 2/);
      assert.match(script, /Remove-ItemProperty -Path \$k -Name TcpAckFrequency/);
      assert.match(script, /Set-DnsClientServerAddress -InterfaceAlias 'WLAN-r2' -ServerAddresses @\('192\.168\.1\.1'\)/);
      assert.match(script, /Set-PingLabTuning -Alias 'WLAN-r2'/);
      const b = tw.readBackups();
      for (const area of ["dns", "planPower", "nicPower", "nagle", "adapterTuning", "wifiOrder"]) {
        assert.deepEqual(b[area], {}, `${area} should have no restore point left`);
      }
      assert.equal(b.history[0].action, "restore-all");
      assert.ok(
        b.history.some((h) => h.action === "nagle-off"),
        "a full restore must not erase the change history it just acted on",
      );
    },
  },
  {
    name: "restore-all order replay: a profile deleted since is left out, never recreated",
    seed: {
      wifiOrder: { "WLAN-r3": { profiles: ["Gone", "Neighbour", "HomeNet"], joined: "HomeNet", at } },
    },
    run: async () => {
      process.env.PINGLAB_PS_SCENARIO = JSON.stringify(
        machineFor("WLAN-r3", {
          wlan: { joined: "HomeNet", profiles: ["HomeNet", "Neighbour"], profilesAfter: ["Neighbour", "HomeNet"] },
        }),
      );
      resetLog();
      return tw.restoreAll();
    },
    check: (res) => {
      expectOk(res);
      expectElevations(1);
      const script = lastElevatedScript();
      assert.match(script, /netsh wlan set profileorder name="\$n" interface="\$alias" priority=1/);
      assert.equal(script.includes("Gone"), false, "a deleted profile cannot be put back");
      assert.deepEqual(tw.readBackups().wifiOrder, {}, "the order came back, so the point is dropped");
    },
  },
  {
    name: "restore-all where the radio values did not come back: reported, point kept",
    seed: {
      adapterTuning: { "WLAN-r4": { values: { MIMOPowerSaveMode: 3, RoamAggressiveness: 0 }, at } },
    },
    run: async () => {
      // The driver still reports the vendor values after the restore script ran.
      process.env.PINGLAB_PS_SCENARIO = JSON.stringify(
        machineFor("WLAN-r4", { tuning: { MIMOPowerSaveMode: 0, RoamAggressiveness: 2 } }),
      );
      resetLog();
      return tw.restoreAll();
    },
    check: (res) => {
      assert.equal(res.ok, false, "a restore that did not stick must not report success");
      assert.match(String(res.data?.message || res.error), /did not come back|not complete/i);
      const b = tw.readBackups();
      assert.ok(b.adapterTuning["WLAN-r4"], "the recorded values are the only way back, so the point stays");
    },
  },
  {
    name: "restore-all with the prompt closed: reports it and keeps every point",
    seed: { planPower: { "WLAN-r5": { ac: 1, dc: 2, at } } },
    run: async () => {
      process.env.PINGLAB_PS_SCENARIO = JSON.stringify(
        machineFor("WLAN-r5", { power: { planAc: 1, planDc: 2 } }, { elevatedMode: "cancel" }),
      );
      resetLog();
      return tw.restoreAll();
    },
    check: (res) => {
      assert.equal(res.ok, false);
      assert.equal(res.cancelled, true);
      expectElevations(1);
      assert.ok(tw.readBackups().planPower["WLAN-r5"], "nothing ran, so nothing may be cleared");
    },
  },
];

/* --------------------------------------------------------------------- run */

const passed = [];
for (const c of [...cases, ...restoreCases]) {
  if (c.seed) seed(c.seed);
  else clearBackups();
  const res = await c.run();
  await c.check(res);
  const unknown = calls().filter((call) => call.kind === "unknown");
  assert.deepEqual(unknown, [], `${c.name}: the fake had no answer for a script it was sent`);
  passed.push(c.name);
}

// Leave the throwaway folder as it was found, whatever happened above.
process.chdir(previousCwd);
rmSync(dir, { recursive: true, force: true });

console.log("\ntweaks dispatch");
console.log(`  cases        ${passed.length}`);
console.log("  applied      restore point before elevation, kept after success");
console.log("  no-op        no prompt, no second point, original values untouched");
console.log("  unavailable  refused with a reason, no prompt");
console.log("  refused      prompt closed or denied: nothing written, point discarded");
console.log("  failed       after a write: point kept; reverted: inverse from the record");
console.log("  restore all  every area read back, returned points dropped, history kept");
console.log("\nall tweak dispatch checks passed");
