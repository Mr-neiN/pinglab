/**
 * What the API accepts, and what it refuses before anything else happens.
 *
 * Every value here arrives in a request body. Some of them end up in a PowerShell script,
 * a DNS lookup, a file in the data folder or a measured duration, so each one is checked for
 * type, length and shape here rather than trusted downstream. A refusal is an `HttpError`
 * with the status the route should answer and a sentence that names the field; nothing from
 * the request is echoed back beyond a bounded, sanitized value.
 *
 * These functions are pure: server.mjs owns the sockets and the data, this owns the rules,
 * so the rules can be exercised without a network or a Windows machine.
 */
import net from "node:net";

/** A refusal the route should send as-is. Anything else is a 500 with no detail. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const refuse = (message, status = 400) => new HttpError(status, message);

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A JSON body has to be an object: `null`, an array or a bare number is not a request. */
export function bodyObject(value) {
  if (!isPlainObject(value)) throw refuse("The request body must be a JSON object.");
  return value;
}

/** A short, single-line string. Control characters never survive into a script or a log. */
export function textField(value, { name, max = 80, pattern = null, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw refuse(`${name} is required.`);
  }
  if (typeof value !== "string") throw refuse(`${name} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) throw refuse(`${name} is required.`);
  if (trimmed.length > max) throw refuse(`${name} is too long (the limit is ${max} characters).`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw refuse(`${name} contains a control character.`);
  if (pattern && !pattern.test(trimmed)) throw refuse(`${name} has an unexpected format.`);
  return trimmed;
}

/**
 * A host or IP that will be resolved and connected to. Letters, digits, dots, dashes,
 * underscores and IPv6 colons; it must start and end with a letter or digit, so a value such
 * as "-f" can never be read as an option by anything downstream.
 */
const HOST_RE = /^[^\s/\\?#@]+$/u;

export function hostField(value, { name = "host", fallback = null } = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== null) return fallback;
    throw refuse(`${name} is required.`);
  }
  if (typeof value !== "string") throw refuse(`${name} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) throw refuse(`${name} is required.`);
  if (trimmed.length > 253) throw refuse(`${name} is too long (the limit is 253 characters).`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw refuse(`${name} contains a control character.`);
  if (trimmed.startsWith("-")) throw refuse(`${name} may not start with a dash.`);
  if (/[\s/\\?#@]/.test(trimmed)) throw refuse(`${name} is not a host name or IP address.`);
  return trimmed;
}

/** A DNS server list: real IP addresses only, and only a handful of them. */
export function serverList(value, { name = "servers", max = 4 } = {}) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw refuse(`${name} must be a list of IP addresses.`);
  if (!value.length) throw refuse(`${name} must contain at least one address.`);
  if (value.length > max) throw refuse(`Too many ${name} (the limit is ${max}).`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !net.isIP(entry.trim())) {
      throw refuse(`${name} must contain IP addresses only.`);
    }
    return entry.trim();
  });
}

/** One endpoint the probe may contact: a host, a real port and a known kind. */
function endpointOne(entry, index) {
  if (!isPlainObject(entry)) throw refuse(`Endpoint ${index + 1} must be an object.`);
  const host = hostField(entry.host, { name: `Endpoint ${index + 1} host` });
  const port = entry.port === undefined ? 443 : Number(entry.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw refuse(`Endpoint ${index + 1} port must be a whole number from 1 to 65535.`);
  }
  // Label and id are display text: clamp them rather than refusing a save over a long name.
  const label = String(entry.label ?? host).trim().slice(0, 60) || host;
  const id =
    String(entry.id ?? `ep${index}`)
      .replace(/[^a-z0-9_-]/gi, "")
      .slice(0, 40) || `ep${index}`;
  return { id, label, host, port, kind: entry.kind === "dns" ? "dns" : "game" };
}

/** The endpoint list a save may store. The count is bounded: it drives every later probe. */
export function endpointList(value, { max = 25 } = {}) {
  if (!Array.isArray(value)) throw refuse("endpoints must be a list.");
  if (!value.length) throw refuse("At least one endpoint is required.");
  if (value.length > max) throw refuse(`Too many endpoints: ${value.length}, the limit is ${max}.`);
  return value.map((entry, index) => endpointOne(entry, index));
}

/** A duration in whole seconds, bounded so one request cannot hold the server for hours. */
export function secondsField(value, { name = "seconds", min, max, fallback }) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw refuse(`${name} is required.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw refuse(`${name} must be a number.`);
  if (number < min || number > max) throw refuse(`${name} must be between ${min} and ${max}.`);
  return number;
}

/** The latency target and the length of a bufferbloat run. */
export function bufferbloatRequest(body) {
  return {
    host: hostField(body.host, { name: "host", fallback: "1.1.1.1" }),
    seconds: secondsField(body.seconds, { name: "seconds", min: 1, max: 30, fallback: 6 }),
  };
}

/**
 * A soak request. The page sends minutes; the other spellings stay for the CLI's benefit.
 * The bounds match what lib/soak.mjs would clamp to anyway, but an out-of-range value is
 * refused instead of silently becoming something the caller did not ask for.
 */
export function soakRequest(body) {
  const hasMinutes = body.minutes !== undefined && body.minutes !== null && body.minutes !== "";
  const seconds = hasMinutes
    ? Math.round(secondsField(body.minutes, { name: "minutes", min: 1, max: 60 }) * 60)
    : secondsField(body.seconds, { name: "seconds", min: 10, max: 3600, fallback: 600 });
  const intervalMs = secondsField(body.intervalMs, {
    name: "intervalMs",
    min: 200,
    max: 5000,
    fallback: 500,
  });
  if (!Number.isInteger(intervalMs)) throw refuse("intervalMs must be a whole number of milliseconds.");
  return { seconds, intervalMs };
}

/** A tweak request's shape. Which actions exist is the caller's catalog question. */
export function tweakRequest(body) {
  return {
    action: textField(body.action, { name: "action", max: 64, pattern: /^[a-z][a-z0-9-]*$/ }),
    alias: textField(body.alias, { name: "alias", max: 128 }),
    preset: textField(body.preset, { name: "preset", max: 40, required: false }),
    servers: serverList(body.servers),
  };
}

/** A numeric id from a path, as `/api/soak/run/<id>` allows exactly one of. */
export function pathId(path, prefix) {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!/^\d{1,12}$/.test(rest)) return null;
  return Number(rest);
}
