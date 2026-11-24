/**
 * The start-up update check.
 *
 * PingLab is a local app with no account and no server of its own, so "is there a newer
 * version" can only mean the public releases page. Each start asks GitHub's releases API once,
 * in the background, and compares the newest release tag with the version in package.json.
 *
 * What it must never do: block a view, throw into a start-up path, or claim this copy is up to
 * date when the question could not be answered. A failed check returns `checked: false` with no
 * sentence, and every surface then says nothing rather than something it does not know.
 *
 * The comparison is pure, so it is testable with fixed tags; the check takes a fetch, so a test
 * never reaches github.com (see update.test.mjs).
 */
import { readFileSync } from "node:fs";

export const RELEASES_URL = "https://github.com/Mr-neiN/pinglab/releases";
export const RELEASE_API = "https://api.github.com/repos/Mr-neiN/pinglab/releases/latest";
/** A start-up check gets a short leash: nothing waits for it, and a hung request is a failure. */
export const CHECK_TIMEOUT_MS = 4000;

/**
 * `v1.2.3` or `1.2.3` → [1, 2, 3]; anything else → null. Only that shape is a release: the
 * workflow publishes no suffix, so comparing one would need rules this app does not have.
 */
export function parseVersion(text) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(text ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Is `candidate` a later release than `current`? An unreadable version is never newer. */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The version this copy runs as, from the package.json beside it, or null when unreadable. */
export function currentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return parseVersion(pkg.version) ? String(pkg.version).trim().replace(/^v/i, "") : null;
  } catch {
    return null;
  }
}

/**
 * Ask the releases API once. Resolves to a comparison (`checked: true`) or a reason it could
 * not be made; never rejects, because this runs on a start-up path.
 */
export async function checkForUpdate({
  current = currentVersion(),
  url = RELEASE_API,
  fetchImpl = globalThis.fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
} = {}) {
  const version = parseVersion(current) ? String(current).trim().replace(/^v/i, "") : null;
  if (!version) {
    return { checked: false, current: null, sentence: null, reason: "This copy does not know its own version." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      // GitHub refuses a request without a User-Agent, and this one says which copy asked.
      headers: { "user-agent": `PingLab/${version}`, accept: "application/vnd.github+json" },
      signal: controller.signal,
      redirect: "error",
    });
    // 404 is a repository with no published release yet: there is nothing to be newer than.
    if (!res.ok) {
      return { checked: false, current: version, sentence: null, reason: `the releases API answered ${res.status}` };
    }
    const body = await res.json();
    const tag = String(body?.tag_name ?? "").trim();
    if (!parseVersion(tag)) {
      return { checked: false, current: version, sentence: null, reason: "the newest release has no usable version" };
    }
    const latest = tag.replace(/^v/i, "");
    const newer = isNewer(latest, version);
    return {
      checked: true,
      current: version,
      latest,
      newer,
      url: RELEASES_URL,
      // Only a newer release is worth a line. A copy that is current has nothing to do, and
      // saying so on every start is noise; a failed check has nothing to say at all.
      sentence: newer
        ? `PingLab ${latest} is available; this copy is ${version}. Get it from ${RELEASES_URL}.`
        : null,
    };
  } catch (err) {
    return { checked: false, current: version, sentence: null, reason: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
