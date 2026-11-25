/**
 * The HTTP plumbing every route shares: response headers, JSON and text answers, the page
 * token check, and a JSON body reader.
 *
 * Pure request/response handling on purpose. The routes in server.mjs own what a request
 * means; this module owns how an answer is written, so a header or a refusal sentence is
 * changed once instead of in every route. `redact` needs the run's token, so it is passed in
 * rather than imported from the server that generated it.
 */
import { timingSafeEqual } from "node:crypto";

import { HttpError, bodyObject } from "./api-input.mjs";

const TOKEN_HEADER = "x-pinglab-token";

/** Never let the run's token reach a log line, even inside an error message. */
export function redact(value, token) {
  return String(value).split(token).join("[token]");
}

/** Headers every response carries, static files and JSON alike. */
export function securityHeaders(contentType) {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Cache-Control": "no-store",
    // The page needs no inline script and loads nothing from another origin. Inline style
    // attributes are how the bar widths are drawn, so styles alone allow them.
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res, status, text) {
  res.writeHead(status, securityHeaders("text/plain; charset=utf-8"));
  res.end(text);
}

export function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

/** Constant-time comparison, so the token cannot be guessed a character at a time. */
export function tokenMatches(req, token, header = TOKEN_HEADER) {
  const given = req.headers[header];
  if (typeof given !== "string" || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/** A state-changing request has to be JSON, which is what a form post cannot send. */
export function isJson(req) {
  return String(req.headers["content-type"] || "").toLowerCase().split(";")[0].trim() === "application/json";
}

/**
 * Read a JSON object, or refuse it. Every failure here is the caller's, so it carries a
 * status and a fixed sentence: a parser message quotes the input it could not read, and an
 * error body is the last place a request's contents should appear.
 */
export async function readJson(req, { limit = 2 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "The request body is larger than 2 MB.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  return bodyObject(parsed);
}
