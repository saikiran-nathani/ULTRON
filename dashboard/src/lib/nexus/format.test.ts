/**
 * `uid()` carries a property the sync layer silently depends on.
 *
 * `rehydrate` rebuilds every array in ascending key order, because array
 * *position* is not a synced property — records arrive one at a time, in
 * whatever order the server's `seq` hands them over. That is only acceptable
 * because ascending id order *is* creation order for everything this app
 * mints: `uid()` is `Date.now().toString(36)` plus five random characters, and
 * that time prefix is a fixed width.
 *
 * Which makes the width load-bearing rather than incidental. Lose it — a
 * shorter prefix, a different radix, a counter instead of a clock — and
 * lexicographic order stops agreeing with chronological order, so every list
 * in the app silently reorders itself after its first sync. Nothing fails; the
 * journal just starts rendering in a jumble that differs per device.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { toDayStr, todayStr, uid } from "./format";

/** The window in which `Date.now().toString(36)` is exactly 8 characters. */
const EIGHT_CHAR_START = new Date("1973-01-01T00:00:00Z").getTime();
const EIGHT_CHAR_END = new Date("2059-01-01T00:00:00Z").getTime();

afterEach(() => void vi.useRealTimers());

describe("uid", () => {
  it("sorts later ids after earlier ones", () => {
    // The property `rehydrate`'s canonical ordering rests on. A plain string
    // compare, because that is what `rehydrate` does.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
    const early = uid();
    vi.setSystemTime(new Date("2026-09-15T10:00:01Z"));
    const later = uid();
    expect(early < later).toBe(true);
  });

  it("keeps sorting correctly across a decade, not just across a second", () => {
    // A one-second gap would also pass with a prefix that overflowed into a
    // ninth character — the failure needs a wide gap to show up, because it is
    // a *width* change, not an ordering change.
    vi.useFakeTimers();
    const at = (iso: string) => {
      vi.setSystemTime(new Date(iso));
      return uid();
    };
    const ids = [
      at("2026-01-01T00:00:00Z"),
      at("2031-06-30T00:00:00Z"),
      at("2040-12-31T23:59:59Z"),
      at("2058-12-31T00:00:00Z"),
    ];
    expect([...ids].sort()).toEqual(ids);
  });

  it("has a fixed-width time prefix for the whole window the app will run in", () => {
    // States the horizon rather than assuming it. 36^8 ms after the epoch is
    // mid-2059; past that the prefix gains a character and every previously
    // minted id sorts *after* every new one, inverting every list in the app.
    // If this ever needs changing, zero-pad the prefix — do not widen it.
    vi.useFakeTimers();
    for (const t of [EIGHT_CHAR_START, Date.now(), EIGHT_CHAR_END - 1]) {
      vi.setSystemTime(t);
      expect(uid()).toHaveLength(8 + 5);
    }
  });

  it("does not collide within a single millisecond", () => {
    // Two records created by one action — a project and its milestones — share
    // a timestamp, so the suffix is the only thing separating them. A
    // collision would make one record silently overwrite the other in the
    // snapshot, because `(collection, id)` is the primary key.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
    const ids = new Set(Array.from({ length: 2000 }, uid));
    expect(ids.size).toBe(2000);
  });
});

describe("toDayStr", () => {
  it("uses the local calendar, not UTC", () => {
    // The after-8pm bug: `toISOString().slice(0,10)` on an evening in a
    // negative-offset zone reports *tomorrow*, so a habit ticked at 21:00 is
    // filed against the wrong day — and a habit completion's id is
    // `${habitId}:${date}`, so the wrong day is a different record that the
    // streak will never count.
    const evening = new Date(2026, 8, 15, 21, 30);
    expect(toDayStr(evening)).toBe("2026-09-15");
  });

  it("zero-pads, so string comparison is date comparison", () => {
    // `roadmap.phases` is ordered by `start.localeCompare`, pending days are
    // found with `cursor <= today`, and `isRoutineDue` compares dates as
    // strings. An unpadded month would sort "2026-9-01" after "2026-10-01".
    expect(toDayStr(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
