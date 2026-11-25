/**
 * Which adapter a setting is read from and written to.
 *
 * Every apply used to go to whichever adapter carried the default route, and nothing said so.
 * On a laptop that is the dock's Ethernet port while docked and the Wi-Fi card when it is not,
 * and behind a VPN the default route belongs to a virtual tunnel device - Windows settings
 * written there describe a device that carries no game traffic. The choice is therefore a
 * setting of its own: persisted, shown on every surface, and made once instead of being
 * guessed per click.
 *
 * The rule this module owns:
 *
 *   physical first   a virtual or VPN adapter is never picked on its own; it is offered, and it
 *                    can be chosen by name, but silence never selects one.
 *   default route    the adapter carrying the default route is preselected, because that is the
 *                    one whose traffic the app is measuring - unless it is virtual, in which
 *                    case a physical adapter is preselected and the target says why.
 *   remembered       a choice made earlier wins, even a virtual one, because changing it again
 *                    without being asked would be the same silent surprise this fixes.
 *   vanished         a remembered adapter that is not on the machine any more falls back to the
 *                    rule above and says so, instead of aiming at nothing.
 *
 * Pure: the adapter list, the active route and the remembered name go in; a choice, a list to
 * offer and the sentences the surfaces print come out. No PowerShell, no files.
 */

/** The shape each choice is offered with, so every surface renders the same facts. */
function choiceOf(adapter, routeAliases) {
  return {
    alias: adapter.name,
    description: adapter.description || "",
    status: adapter.status || null,
    virtual: Boolean(adapter.virtual),
    // Any default route counts, not only the lowest-metric one: behind a VPN the tunnel wins the
    // table, and the physical adapter that carries the real traffic still has its own entry.
    defaultRoute: routeAliases.has(String(adapter.name).toLowerCase()),
  };
}

const up = (entry) => (entry.status === "Up" ? 0 : 1);

/**
 * The target for this machine, the adapters a picker may offer, and why if either is a fallback.
 *
 * `chosen` is the remembered name from config.json. A remembered virtual adapter stays the
 * target: the user asked for it, and the UI labels it as virtual rather than overruling it.
 */
export function adapterChoices({ adapters = [], routes = [], activeRoute = null, chosen = null } = {}) {
  const routeOrder = (Array.isArray(routes) && routes.length
    ? routes.map((r) => r?.alias)
    : [activeRoute?.alias]
  )
    .map((alias) => (typeof alias === "string" ? alias.trim() : ""))
    .filter(Boolean);
  const routeAliases = new Set(routeOrder.map((alias) => alias.toLowerCase()));
  const entries = (adapters || [])
    .filter((a) => a && typeof a.name === "string" && a.name.trim())
    .map((a) => choiceOf(a, routeAliases));

  // Physical adapters first, connected ones before disconnected, then by description. The order
  // is what a picker shows; it never decides the target.
  entries.sort(
    (a, b) =>
      Number(a.virtual) - Number(b.virtual) ||
      Number(b.defaultRoute) - Number(a.defaultRoute) ||
      up(a) - up(b) ||
      String(a.description || a.alias).localeCompare(String(b.description || b.alias)),
  );

  const wanted = typeof chosen === "string" && chosen.trim() ? chosen.trim() : null;
  const explicit = wanted
    ? entries.find((e) => e.alias.toLowerCase() === wanted.toLowerCase()) || null
    : null;
  // The route at the top of the table decides the target when it is physical; when it is a VPN
  // tunnel, the physical adapter with its own default route is the one that carries traffic.
  const routeEntry =
    routeOrder
      .map((alias) => entries.find((e) => e.alias.toLowerCase() === alias.toLowerCase()))
      .find(Boolean) || null;

  const fallbackEntry =
    (routeEntry && !routeEntry.virtual ? routeEntry : null) ||
    entries.find((e) => !e.virtual && e.defaultRoute && e.status === "Up") ||
    entries.find((e) => !e.virtual && e.status === "Up") ||
    entries.find((e) => !e.virtual) ||
    routeEntry ||
    entries[0] ||
    null;

  const targetEntry = explicit || fallbackEntry;

  const note =
    !explicit && routeEntry && targetEntry && routeEntry.alias !== targetEntry.alias
      ? `The default route is ${routeEntry.virtual ? "the virtual adapter" : "the adapter"} “${routeEntry.alias}”, so settings are aimed at “${targetEntry.alias}” instead. Choose “${routeEntry.alias}” only if you really mean to tune it.`
      : null;

  const fallback =
    wanted && !explicit
      ? `“${wanted}” was chosen earlier and is not on this machine now, so settings are aimed at ${fallbackEntry ? `“${fallbackEntry.alias}”` : "no adapter"}.`
      : null;

  return {
    choices: entries.map((entry) => ({
      ...entry,
      selected: Boolean(targetEntry && entry.alias === targetEntry.alias),
      chosen: Boolean(explicit && entry.alias === explicit.alias),
    })),
    target: targetEntry ? { ...targetEntry, chosen: Boolean(explicit), note } : null,
    fallback,
  };
}
