/**
 * The channel an elevated PowerShell reads its script from.
 *
 * Elevation used to work like this: the non-elevated app wrote the script to
 * `<data>\tmp\<id>.ps1`, then asked Windows to start that path as administrator. The folder
 * is the user's own (`%LOCALAPPDATA%\PingLab` or `<repo>\data`), so anything running as that
 * user could rewrite the file in the moment between the write and the admin prompt, and the
 * changed script would then run with administrator rights. The result file next to it had the
 * same problem in the other direction: a forged result could make an unchanged machine look
 * fixed.
 *
 * There is no file now. The app owns one named pipe, passes its unguessable name to the
 * elevated process, and sends the script down that pipe once the elevated side has connected.
 * The elevated side reads the text into memory, runs it, and sends the result back on the same
 * pipe. Nothing on disk can be swapped, because nothing on disk is executed.
 *
 * Messages are length-framed (4-byte little-endian length, then UTF-8 bytes) rather than
 * terminated by closing the write side: Windows named pipes do not have a half-close, and a
 * pipe that is ended on one side cannot be answered on the other.
 *
 * What a same-user attacker can still try, and what happens:
 *   - connect to the pipe first (it has to guess 128 random bits): it receives the script and
 *     a useless nonce; the real elevated process cannot connect, so no elevated code runs
 *     (fail closed, and the caller reports the prompt as failed).
 *   - hand back a forged result: it cannot, unless it guessed the name. Every result carries
 *     the nonce from this call, and a result with a different one is discarded.
 *
 * The pipe is single-use: one connection, one script, one result, then the server closes.
 *
 * Access: Windows gives a pipe the creating process's default DACL. For an ordinary user that
 * is full control to that user, SYSTEM and BUILTIN\Administrators, and read-only to everyone
 * else. The elevated process therefore reaches it even when elevation switches to a different
 * administrator account, while another local user can at most read (and so consume) a script
 * that contains no secrets - it cannot write the result back.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

/** How long the elevated side waits for the app's pipe to appear. */
const CONNECT_TIMEOUT_MS = 15000;

/**
 * How long to wait for a connection that was already in flight when the elevated process
 * exited. Windows accepts the connection before the client's exit is reported, but the
 * callback can land a tick later.
 */
const CONNECT_GRACE_MS = 250;

/** A result larger than this is not one of ours. */
const MAX_FRAME = 1024 * 1024;

const QUOTE = (value) => String(value).replace(/'/g, "''");

/**
 * The PowerShell that runs as administrator. It contains no user data at all - only the pipe
 * name and the nonce, both from randomBytes - so there is nothing here to escape.
 */
export function bootstrapText(name, nonce) {
  return [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$ProgressPreference='SilentlyContinue'",
    "$ErrorActionPreference='Stop'",
    `$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${QUOTE(name)}', [System.IO.Pipes.PipeDirection]::InOut)`,
    `try { $pipe.Connect(${CONNECT_TIMEOUT_MS}) } catch { [Console]::Error.WriteLine('PingLab: the script channel did not answer'); exit 2 }`,
    "function Read-Exact([int]$want) {",
    "  $buf = New-Object byte[] $want",
    "  $read = 0",
    "  while ($read -lt $want) {",
    "    $n = $pipe.Read($buf, $read, $want - $read)",
    "    if ($n -le 0) { throw 'the script channel closed early' }",
    "    $read += $n",
    "  }",
    "  return ,$buf",
    "}",
    "$head = Read-Exact 4",
    "$length = [System.BitConverter]::ToInt32($head, 0)",
    "if ($length -le 0 -or $length -gt 1048576) { throw 'the script channel sent an impossible length' }",
    "$script = [System.Text.Encoding]::UTF8.GetString((Read-Exact $length))",
    "$result = $null",
    "try {",
    "  . ([ScriptBlock]::Create($script))",
    "} catch {",
    "  $result = [ordered]@{ ok = $false; message = $_.Exception.Message }",
    "}",
    "if ($null -eq $result) { $result = [ordered]@{ ok = $true; message = 'done' } }",
    `$payload = [ordered]@{ nonce = '${QUOTE(nonce)}'; result = $result }`,
    "$json = ConvertTo-Json -InputObject $payload -Compress -Depth 6",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)",
    "$size = [System.BitConverter]::GetBytes([int]$bytes.Length)",
    "$pipe.Write($size, 0, 4)",
    "$pipe.Write($bytes, 0, $bytes.Length)",
    "$pipe.Flush()",
    "$pipe.Dispose()",
  ].join("\n");
}

/** Windows PowerShell takes a script as UTF-16LE base64, which needs no quoting. */
export function encodeCommand(text) {
  return Buffer.from(String(text), "utf16le").toString("base64");
}

/** Prefix a UTF-8 message with its length, little-endian, the way the bootstrap reads it. */
export function frame(text) {
  const body = Buffer.from(String(text), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** The framed message in `buffer`, or undefined while it is still incomplete. */
function unframe(buffer) {
  if (buffer.length < 4) return undefined;
  const length = buffer.readUInt32LE(0);
  if (length <= 0 || length > MAX_FRAME) throw new Error("impossible channel frame");
  if (buffer.length < 4 + length) return undefined;
  try {
    return JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
  } catch {
    return null; // complete, but not JSON: discard it
  }
}

/**
 * Whether a payload may be trusted as the answer to this call. A result from any other call,
 * or a shape that is not an object, is discarded rather than read as success.
 */
export function acceptsResult(payload, nonce) {
  return Boolean(payload && payload.nonce === nonce && payload.result && typeof payload.result === "object");
}

/**
 * Open a one-shot channel for `script`.
 *
 * Returns the pipe path, the bootstrap to hand to the elevated process, and `result()` which
 * resolves to `{ nonce, result }` from the elevated side, or null when nothing arrived (the
 * prompt was dismissed, or the channel was squatted). Call `close()` when done, always.
 */
export async function openChannel(script, { connectGraceMs = CONNECT_GRACE_MS } = {}) {
  const name = `pinglab-${randomBytes(16).toString("hex")}`;
  const pipePath = "\\\\.\\pipe\\" + name;
  const nonce = randomBytes(16).toString("hex");

  let resolvePayload;
  const payload = new Promise((resolve) => {
    resolvePayload = resolve;
  });
  let settled = false;
  const settle = (value) => {
    if (settled) return;
    settled = true;
    resolvePayload(value);
  };

  let connected = false;
  let closed = false;
  let received = Buffer.alloc(0);
  const sockets = new Set();

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (connected) {
      socket.destroy(); // a second client is never ours
      return;
    }
    connected = true;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      try {
        const message = unframe(received);
        if (message !== undefined) settle(message);
      } catch {
        settle(null);
      }
    });
    socket.on("close", () => {
      if (!settled) {
        try {
          settle(unframe(received) ?? null);
        } catch {
          settle(null);
        }
      }
    });
    // The script goes out only after the elevated side has connected. The pipe stays open
    // for the answer; it is the elevated side that writes and then closes.
    socket.write(frame(script));
  });

  await new Promise((resolve, reject) => {
    const fail = (err) => reject(err);
    server.once("error", fail);
    server.listen(pipePath, () => {
      server.removeListener("error", fail);
      server.on("error", () => {});
      resolve();
    });
  });

  return {
    pipePath,
    nonce,
    bootstrap: bootstrapText(name, nonce),
    /**
     * The result, if the elevated side connected. `waitMs` bounds how long a connected
     * channel may take to finish; without a connection there is nothing to wait for beyond
     * the accept grace period.
     */
    async result(waitMs = 2000) {
      if (!connected && !closed) {
        await new Promise((resolve) => setTimeout(resolve, connectGraceMs));
      }
      if (!connected) return null;
      return Promise.race([
        payload,
        new Promise((resolve) => setTimeout(() => resolve(null), waitMs)),
      ]);
    },
    close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      try {
        server.close();
      } catch {}
    },
  };
}
