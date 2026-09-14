/**
 * The client's hybrid logical clock. Mirrors `src/trainwatch/hlc.py`.
 *
 * Two implementations of one wire format is a drift risk, and the mitigation
 * is that the format is fixed-width and boring: zero-padded millis, a
 * zero-padded counter, a node id. `test_auth_client_contract.py` already
 * proves this pattern works — read the literals on both sides and compare —
 * and `clock.test.ts` does the same for these.
 *
 * Restated here because it is the thing that goes wrong:
 *
 * > **The HLC decides who wins. It must never decide what you still need.**
 *
 * The pull cursor is the server's `seq`, never this. See `hlc.py` for what
 * happens otherwise — a record from a slow-clocked device lands below another
 * device's cursor and is never delivered to it again.
 */

const MS_WIDTH = 16;
const COUNT_WIDTH = 5;
const NODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Must match `MAX_DRIFT_MS` in hlc.py. */
export const MAX_DRIFT_MS = 10 * 60 * 1000;

export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClockError";
  }
}

export function formatHlc(millis: number, counter: number, node: string): string {
  if (!Number.isInteger(millis) || millis < 0) {
    throw new ClockError(`millis must be a non-negative integer, got ${millis}`);
  }
  if (counter >= 10 ** COUNT_WIDTH) {
    throw new ClockError(`counter overflow (${counter}): >10^${COUNT_WIDTH} writes in 1ms`);
  }
  if (!NODE_RE.test(node)) throw new ClockError(`invalid node id: ${node}`);
  return `${String(millis).padStart(MS_WIDTH, "0")}-${String(counter).padStart(COUNT_WIDTH, "0")}-${node}`;
}

export function parseHlc(value: string): { millis: number; counter: number; node: string } {
  const m = new RegExp(`^(\\d{${MS_WIDTH}})-(\\d{${COUNT_WIDTH}})-(${NODE_RE.source.slice(1, -1)})$`).exec(
    value,
  );
  if (!m) throw new ClockError(`not a valid HLC: ${value}`);
  return { millis: Number(m[1]), counter: Number(m[2]), node: m[3]! };
}

/**
 * A node's clock. One per device, persisted with the cursor.
 *
 * Persistence matters more than it looks: a clock that resets to zero on
 * reload emits readings below ones it has already published, so a write made
 * after a reload loses to one made before it. `millis`/`counter` are therefore
 * part of the saved state, not just in-memory.
 */
export class Clock {
  constructor(
    readonly node: string,
    private millis = 0,
    private counter = 0,
  ) {
    if (!NODE_RE.test(node)) throw new ClockError(`invalid node id: ${node}`);
  }

  /** Stamp a local write. */
  tick(wallMs: number = Date.now()): string {
    if (wallMs > this.millis) {
      this.millis = wallMs;
      this.counter = 0;
    } else {
      // Same millisecond, or the wall clock went BACKWARDS — a device waking
      // from sleep, an NTP correction, a timezone change. The counter carries
      // us forward either way, because emitting a reading lower than one we
      // have already emitted lets a later write lose to an earlier one.
      this.counter += 1;
    }
    return formatHlc(this.millis, this.counter, this.node);
  }

  /**
   * Advance past a reading we just received, and return ours.
   *
   * Called with the highest HLC in a pull. Skipping it breaks causality: edit
   * a record the server told us about, and our edit can sort *before* the
   * thing it was based on.
   */
  observe(remote: string, wallMs: number = Date.now()): string {
    const { millis: rMs, counter: rCount } = parseHlc(remote);
    if (rMs > wallMs + MAX_DRIFT_MS) {
      throw new ClockError(
        `remote clock is ${Math.round((rMs - wallMs) / 1000)}s ahead of ours, past the ` +
          `${MAX_DRIFT_MS / 1000}s ceiling. Refusing: accepting it would let that writer ` +
          `win every future conflict permanently.`,
      );
    }
    const high = Math.max(wallMs, this.millis, rMs);
    if (high === this.millis && high === rMs) this.counter = Math.max(this.counter, rCount) + 1;
    else if (high === this.millis) this.counter += 1;
    else if (high === rMs) this.counter = rCount + 1;
    else this.counter = 0;
    this.millis = high;
    return formatHlc(this.millis, this.counter, this.node);
  }

  current(): string {
    return formatHlc(this.millis, this.counter, this.node);
  }

  /** For persistence. Restore with `new Clock(node, millis, counter)`. */
  toJSON(): { node: string; millis: number; counter: number } {
    return { node: this.node, millis: this.millis, counter: this.counter };
  }
}

/**
 * A stable per-device id, used as the HLC node and the sync device id.
 *
 * Generated once and persisted. A device that mints a new id on every load
 * would look like a new device to the server every time — and since the
 * tombstone GC watermark is `min(last_pull_seq)` across non-retired devices,
 * each phantom would pin that watermark at 0 forever. The tombstone table
 * would grow without bound because of a device that does not exist.
 */
export function deviceId(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): string {
  const KEY = "tw.sync.device";
  const existing = storage.getItem(KEY);
  if (existing && NODE_RE.test(existing)) return existing;
  // crypto.randomUUID is unavailable on http:// over a tailnet IP — not a
  // secure context — which is exactly how the phone and iPad reach this box.
  const raw =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const id = raw.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
  storage.setItem(KEY, id);
  return id;
}
