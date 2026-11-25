/**
 * Everything GET /api/state answers with, assembled in one place.
 *
 * The server's cache decides when this runs; the assembly lives here so the route, the GUI
 * bridge and any test read the same shape. Nothing here touches a socket: it reads the
 * persisted settings, the Windows snapshot, the catalog and the stored history, and names
 * every figure the page needs — including the UDP sampling policy and the sentence that says
 * a UDP figure is a query round trip, not in-game ping.
 */
import { loadConfig } from "./config.mjs";
import { snapshot } from "./net.mjs";
import { RESOLVERS } from "./dns.mjs";
import { adapterChoices } from "./target.mjs";
import { tweakState, pendingTweaks } from "./tweaks.mjs";
import { driftStatus } from "./drift.mjs";
import { dbStatus, listRuns } from "./db.mjs";
import { probeTrend } from "./trend.mjs";
import { currentVersion } from "./update.mjs";
import { BENCH } from "./bench.mjs";
import { TWEAKS, PRESETS, RISK } from "./catalog.mjs";
import { UDP_PROTOCOLS } from "./udp-proto.mjs";
import { UDP_POLICY } from "./probe.mjs";
import { udpCaveatText } from "./report.mjs";

/** The benchmark policy, so a surface can say how many repeats a phase takes. */
export const benchPolicy = () => ({
  repeats: BENCH.repeats,
  minRepeats: BENCH.minRepeats,
  count: BENCH.count,
  floors: BENCH.floors,
});

export async function buildState() {
  const config = await loadConfig();
  const connection = await snapshot();
  // Which adapter the settings are aimed at is a persisted choice, not an inference: the rows,
  // the restore points and every apply read the same answer, so a docked laptop or a VPN cannot
  // have one surface tuning Wi-Fi while another says it is tuning Ethernet.
  const pick = adapterChoices({
    adapters: connection.adapters,
    routes: connection.routes,
    activeRoute: connection.activeRoute,
    chosen: config.adapter,
  });
  const alias = pick.target?.alias || null;
  const dnsForTarget = alias ? connection.dns.find((d) => d.alias === alias) || null : null;
  const [tw, tweaks] = await Promise.all([
    alias ? tweakState(alias, { dns: connection.dns }) : Promise.resolve(null),
    Promise.resolve(pendingTweaks()),
  ]);
  return {
    // The version this copy actually runs as, read from package.json beside it. The page shows
    // it, so a copy that was upgraded (or one that was not) is visible instead of inferred,
    // and it is the same value the update check compares against the newest release.
    version: currentVersion(),
    // The benchmark policy, so a surface can say how many repeats a phase takes without
    // keeping a second copy of the number that can drift from lib/bench.mjs.
    benchPolicy: benchPolicy(),
    // How many UDP probes a figure comes from, and what such a figure is not: the page prints
    // both, so the sampling policy and the "not in-game ping" caveat cannot drift from
    // lib/probe.mjs and lib/report.mjs.
    udpPolicy: UDP_POLICY,
    udpCaveat: udpCaveatText(UDP_POLICY),
    connection: { ...connection, dnsForTarget },
    // The adapter every setting below is read from and written to, and the list a picker may
    // offer. The default route is marked on it; a virtual adapter is offered but never picked
    // on its own (lib/target.mjs), and `fallback` explains a remembered adapter that is gone.
    target: pick.target,
    adapterChoices: pick.choices,
    targetFallback: pick.fallback,
    tweakState: tw,
    pending: tweaks,
    // A change PingLab made that Windows has since put back travels with the state, so the
    // page can say it above the rows instead of leaving it to be noticed.
    drift: driftStatus(tw),
    // A database that had to be set aside during start-up is not a silent reset: the page
    // says so above the verdict, the way the GUI says it in its status row.
    history: dbStatus(),
    // A settings file that could not be used is reported the same way, once, in the state
    // every surface draws: the page above the verdict, the GUI in its status row.
    config: { problem: config.problem },
    endpoints: config.endpoints,
    resolvers: RESOLVERS,
    recentRuns: listRuns(null, 12),
    // Long-term latency and jitter from the stored probe runs - the same history the page's
    // "previous run" figure comes from, read back as a series instead of one comparison.
    trend: probeTrend(listRuns("probe", 60)),
    // The last comparison and the last rollback travel with the state, so the GUI and the
    // terminal print the same words the page shows rather than only a history row.
    benchmark: {
      latest: listRuns("benchmark", 1)[0] ?? null,
      lastRevert: listRuns("benchmark-revert", 1)[0] ?? null,
    },
    // Same catalog the TUI and the GUI render, so labels, trade-offs, risk levels and
    // preset contents cannot differ between surfaces.
    catalog: { tweaks: TWEAKS, presets: PRESETS, risk: RISK },
    // The UDP queries an endpoint may name, from the engine's own registry: the page's editor
    // cannot offer a protocol the server would refuse, or miss one it accepts.
    protocols: Object.values(UDP_PROTOCOLS).map(({ id, label, describe }) => ({ id, label, describe })),
  };
}
