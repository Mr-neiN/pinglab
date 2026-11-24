/**
 * "Ask Windows to scan now, and tell me when it finished."
 *
 * `netsh wlan show networks` returns the BSS list Windows last built, and neither its text
 * nor any other command dates it. The WLAN API does know: `WlanScan` queues a scan and
 * WLAN AutoConfig raises `wlan_notification_acm_scan_complete` when it finishes. Reaching
 * that needs P/Invoke, so a small C# type is compiled on the fly with Add-Type, registers
 * for the ACM notifications, triggers the scan and waits for the completion code.
 *
 * Everything here is bounded and optional. The wait is clamped (1 s .. 15 s, 6 s default),
 * the PowerShell call gets that plus compile time, and every failure - no compiler, no WLAN
 * service, access denied, no notification, a bad adapter id - returns `ok: false` with a
 * sentence instead of a guess. The caller keeps reading netsh either way; what changes is
 * whether the result may say when the scan finished.
 *
 * The C# is deliberately C# 5 syntax: Windows PowerShell 5.1 compiles Add-Type with the
 * in-box compiler, where `out var`, expression-bodied members and string interpolation do
 * not exist.
 */
import { runPsJson } from "./ps.mjs";

const SCAN_SHIM_TIMEOUT_MS = 6000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;

/** A GUID as Windows prints adapter ids; anything else never reaches the script. */
const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

function clampTimeout(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return SCAN_SHIM_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

const CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class PingLabWlanScan
{
    private const int WLAN_NOTIFICATION_SOURCE_ACM = 0x00000008;
    private const int WLAN_NOTIFICATION_SOURCE_NONE = 0x00000000;
    private const int WLAN_NOTIFICATION_ACM_SCAN_COMPLETE = 7;
    private const int WLAN_NOTIFICATION_ACM_SCAN_FAIL = 8;

    private delegate void WlanNotificationCallback(IntPtr data, IntPtr context);

    [DllImport("wlanapi.dll")]
    private static extern int WlanOpenHandle(int clientVersion, IntPtr reserved, out int negotiated, out IntPtr handle);

    [DllImport("wlanapi.dll")]
    private static extern int WlanCloseHandle(IntPtr handle, IntPtr reserved);

    [DllImport("wlanapi.dll")]
    private static extern int WlanRegisterNotification(IntPtr handle, int source, bool ignoreDuplicate,
        WlanNotificationCallback callback, IntPtr context, IntPtr reserved, out int previousSource);

    [DllImport("wlanapi.dll")]
    private static extern int WlanScan(IntPtr handle, ref Guid interfaceGuid, IntPtr ssid, IntPtr ieData, IntPtr reserved);

    // "state|elapsedMs|errorCode": the caller parses the fields and decides what to say.
    public static string Run(string interfaceGuid, int timeoutMs)
    {
        Guid guid;
        try
        {
            guid = new Guid(interfaceGuid);
        }
        catch (Exception)
        {
            return "bad-guid||";
        }

        IntPtr handle = IntPtr.Zero;
        int negotiated = 0;
        int rc = WlanOpenHandle(2, IntPtr.Zero, out negotiated, out handle);
        if (rc != 0 || handle == IntPtr.Zero)
        {
            return "open||" + rc;
        }

        ManualResetEventSlim done = new ManualResetEventSlim(false);
        WlanNotificationCallback callback = null;
        string outcome = null;
        int previousSource = 0;
        try
        {
            callback = delegate(IntPtr data, IntPtr context)
            {
                // WLAN_NOTIFICATION_DATA: source (4), code (4), interface GUID (16), ...
                int source = Marshal.ReadInt32(data, 0);
                if (source != WLAN_NOTIFICATION_SOURCE_ACM)
                {
                    return;
                }
                int code = Marshal.ReadInt32(data, 4);
                if (code == WLAN_NOTIFICATION_ACM_SCAN_COMPLETE)
                {
                    outcome = "complete";
                    done.Set();
                }
                else if (code == WLAN_NOTIFICATION_ACM_SCAN_FAIL)
                {
                    outcome = "failed";
                    done.Set();
                }
            };

            rc = WlanRegisterNotification(handle, WLAN_NOTIFICATION_SOURCE_ACM, false, callback,
                IntPtr.Zero, IntPtr.Zero, out previousSource);
            if (rc != 0)
            {
                return "register||" + rc;
            }

            System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
            rc = WlanScan(handle, ref guid, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (rc != 0)
            {
                return "scan||" + rc;
            }

            // Bounded: a scan Windows never reports cannot hold a surface open.
            bool notified = done.Wait(timeoutMs);
            long elapsed = watch.ElapsedMilliseconds;
            GC.KeepAlive(callback);
            if (!notified)
            {
                return "timeout|" + elapsed + "|";
            }
            if (outcome == "failed")
            {
                return "failed|" + elapsed + "|";
            }
            return "complete|" + elapsed + "|";
        }
        finally
        {
            // Deregister before closing, so no callback can fire into a closed handle.
            WlanRegisterNotification(handle, WLAN_NOTIFICATION_SOURCE_NONE, false, null,
                IntPtr.Zero, IntPtr.Zero, out previousSource);
            done.Dispose();
            WlanCloseHandle(handle, IntPtr.Zero);
        }
    }
}
`;

/**
 * The PowerShell that compiles the shim and runs it once. Kept as a function so the suite can
 * read the exact script (bounded timeout, adapter GUID) without a radio.
 */
export function shimScript(guid, timeoutMs = SCAN_SHIM_TIMEOUT_MS) {
  const safeGuid = String(guid).replace(/'/g, "");
  return `$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
${CSHARP}
'@ -ErrorAction Stop
  $r = [PingLabWlanScan]::Run('${safeGuid}', ${clampTimeout(timeoutMs)})
} catch {
  $r = 'unavailable||'
}
$parts = $r -split '\\|'
$state = $parts[0]
$ms = $null
if ($parts.Count -ge 2 -and $parts[1]) { $ms = [int]$parts[1] }
$code = $null
if ($parts.Count -ge 3 -and $parts[2]) { $code = [int]$parts[2] }
[pscustomobject]@{ state = $state; elapsedMs = $ms; code = $code } | ConvertTo-Json -Compress`;
}

/** Why a scan could not be confirmed, in a sentence a surface can print. */
function scanShimReason(state, code) {
  const errno = Number.isFinite(code) ? code : null;
  switch (state) {
    case "failed":
      return "Windows reported the scan failed";
    case "timeout":
      return "no scan-complete notification arrived inside the time limit";
    case "scan":
      return errno === 5
        ? "Windows refused the scan (access denied — Location services or permission)"
        : `Windows refused to start the scan (error ${errno ?? "unknown"})`;
    case "register":
      return `Windows refused the scan-complete notification (error ${errno ?? "unknown"})`;
    case "open":
      return `the WLAN service could not be opened (error ${errno ?? "unknown"})`;
    case "bad-guid":
      return "the Wi-Fi adapter reported an id that is not a GUID";
    case "no-adapter":
      return "no Wi-Fi adapter id was available to scan with";
    case "unavailable":
      return "the Windows scan shim could not be loaded";
    default:
      return "the scan shim returned an unknown result";
  }
}

function result({ attempted, ok, elapsedMs = null, state, reason = null }) {
  return { attempted, ok, elapsedMs: ok ? elapsedMs : null, state, reason: ok ? null : reason };
}

/**
 * Trigger one scan and wait for WLAN AutoConfig to report it finished.
 *
 * `ok` means exactly one thing: a scan-complete notification arrived after this process asked
 * Windows to scan. It does not mean every row netsh then returns is live.
 */
export async function triggerScan({ guid = null, timeoutMs = SCAN_SHIM_TIMEOUT_MS } = {}) {
  const bound = clampTimeout(timeoutMs);
  if (process.platform !== "win32") {
    return result({ attempted: false, ok: false, state: "unavailable", reason: "the WLAN scan shim needs Windows" });
  }
  if (!guid) {
    return result({ attempted: false, ok: false, state: "no-adapter", reason: scanShimReason("no-adapter") });
  }
  if (!GUID_RE.test(String(guid))) {
    return result({ attempted: false, ok: false, state: "bad-guid", reason: scanShimReason("bad-guid") });
  }

  // Compiling C# with Add-Type is the slow part on a cold machine; the wait itself is bounded
  // inside the shim, so this ceiling only stops a wedged PowerShell from holding the caller.
  const { data } = await runPsJson(shimScript(guid, bound), { timeout: bound + 15000 });
  const row = data?.[0];
  if (!row || typeof row.state !== "string") {
    return result({ attempted: true, ok: false, state: "unavailable", reason: scanShimReason("unavailable") });
  }
  const state = row.state;
  const code = Number.isFinite(Number(row.code)) ? Number(row.code) : null;
  if (state === "complete") {
    const elapsedMs = Number.isFinite(Number(row.elapsedMs)) ? Number(row.elapsedMs) : null;
    return result({ attempted: true, ok: elapsedMs !== null, elapsedMs, state });
  }
  return result({ attempted: true, ok: false, state, reason: scanShimReason(state, code) });
}
