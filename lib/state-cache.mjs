/**
 * The cache in front of the settings state.
 *
 * A state read has to pay for several PowerShell processes (adapter list, route, DNS,
 * power plan, WLAN order, registry values and two throughput samples). Together they cost
 * tens of seconds on a loaded machine, while almost nothing in the result changes from one
 * second to the next.
 *
 * The rules here:
 *   fresh      - within ttlMs the cached value is returned and no read starts.
 *   stale      - after ttlMs the cached value is still returned immediately, and one
 *                background read refreshes it (single flight, never one per caller).
 *   too stale  - after maxStaleMs the read is awaited, because showing a value older than
 *                that would be guessing at the machine's current state.
 *   invalidate - a completed apply, revert or restore drops the value and bumps a generation,
 *                so a read that started before the change can never install its old answer.
 *
 * `now` is injectable so the lifetime behaviour is tested without waiting. `onError` is how a
 * failed background refresh is reported; a caller awaiting a cold read still gets the error.
 */
export function createStateCache({
  load,
  ttlMs = 5000,
  maxStaleMs = 120000,
  now = () => Date.now(),
  onError = () => {},
} = {}) {
  if (typeof load !== "function") throw new Error("createStateCache needs a load function");
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("ttlMs must be a non-negative number");
  if (!Number.isFinite(maxStaleMs) || maxStaleMs < ttlMs) {
    throw new Error("maxStaleMs must be a number and at least ttlMs");
  }

  let value = null;
  let loadedAt = 0;
  let inflight = null;
  let generation = 0;

  const ageMs = () => (value === null ? Infinity : now() - loadedAt);

  /** Start one read. Only the newest generation may install its result. */
  function start() {
    const gen = ++generation;
    const read = Promise.resolve()
      .then(load)
      .then(
        (next) => {
          if (gen === generation) {
            value = next;
            loadedAt = now();
          }
          return next;
        },
        (err) => {
          // A failed background refresh keeps the last good value: dropping it would turn a
          // transient PowerShell failure into a state read that fails too.
          if (gen === generation) onError(err);
          throw err;
        },
      );
    inflight = read;
    // Clear the slot from the read itself, not from a wrapper promise: comparing a wrapper
    // against `read` never matches, which would leave the slot occupied forever and stop the
    // stale window from ever starting a refresh.
    read.then(
      () => {
        if (inflight === read) inflight = null;
      },
      () => {
        if (inflight === read) inflight = null;
      },
    );
    return read;
  }

  async function get() {
    const age = ageMs();
    if (value !== null && age <= ttlMs) return value;

    if (value !== null && age <= maxStaleMs) {
      if (!inflight) start().catch(() => {});
      return value;
    }

    if (inflight) return inflight;
    return start();
  }

  /** Forget what is cached, including any read that was already running. */
  function invalidate() {
    generation += 1;
    value = null;
    loadedAt = 0;
    inflight = null;
  }

  return {
    get,
    invalidate,
    /** For tests and diagnostics: what is held and how old it is. */
    peek: () => ({ hasValue: value !== null, ageMs: value === null ? null : ageMs() }),
  };
}
