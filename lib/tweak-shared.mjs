/** Values shared by more than one tweak module: quoting for generated PowerShell, the
 * recorded source of a DNS list, and the Windows power-saving labels. */
export const sq = (s) => String(s).replace(/'/g, "''");

/**
 * Where a recorded DNS list came from: "static" (set by hand), "automatic" (supplied by the
 * router) or "unknown". `staticDns` answers it directly. Builds before it recorded `dhcp` -
 * the address's source, used as their stand-in for the same question - so that keeps exactly
 * the meaning it had when it was written. A record with neither field (the first builds wrote
 * only the server list) is unknown, and the callers refuse to guess: "automatic" would hand
 * a hand-set list to DHCP, "static" would pin a router list that may have changed since.
 */
export function dnsSourceOf(rec) {
  if (!rec || typeof rec !== "object") return "unknown";
  if (typeof rec.staticDns === "boolean") return rec.staticDns ? "static" : "automatic";
  if (typeof rec.dhcp === "boolean") return rec.dhcp ? "automatic" : "static";
  return "unknown";
}

/** True when a failure is Windows refusing elevation rather than the setting refusing the value. */
export function looksDenied(text) {
  return /denied|zugriff|verweigert|privilege|administr|elevat|did not grant|0x80070005|0x800704c7|requires elevation/i.test(
    String(text || ""),
  );
}

export const POWER_LABELS = {
  0: "maximum performance",
  1: "low power saving",
  2: "medium power saving",
  3: "maximum power saving",
};
