/**
 * Every list order on this screen, in one place — and none of them is "the
 * order the array happened to be in".
 *
 * Per-record sync keys records by id and **rebuilds each array in ascending id
 * order**, because array position is not something that syncs: records arrive
 * one at a time, on their own `seq`, and a device that has pulled three of
 * five phases holds them in whatever order the server sent. So any screen that
 * renders `array.map` and calls the result "the order I authored" is reading a
 * fact that sync does not carry.
 *
 * The roadmap is the sharpest case, and it looks like an accident unless you
 * know why. Its seeded ids are `seed:0001:phase:…` — a zero-padded ordinal
 * minted in authored order (see `lib/nexus/roadmapSeed.ts`, which explains the
 * measurement that put it there: with content-only ids, rebuilding from sync
 * reordered all five phases and all 34 tasks into hash order, and
 * `RoadmapTask` has no `sort`, no date and nothing else to order by, so the
 * authored curriculum order was simply gone). **Ascending id therefore IS
 * authored order** for anything the seed minted, which is why `byId` below is
 * the default for roadmap tasks, layers, tool groups and resources.
 *
 * `orderPhases` is the one deliberate exception, and it is a narrowing rather
 * than a disagreement:
 *
 * - A phase has a real ordering key — `start`, an ISO date the user picked —
 *   and `store/roadmap.ts` already keeps `phases` sorted by it on every add
 *   and edit. Rendering a different order than the store maintains would make
 *   "add phase" appear to insert in the wrong place.
 * - `currentPhaseIndex` (also `store/roadmap.ts`) is
 *   `findIndex(p => p.end >= today)`, which is only correct on a
 *   chronologically ordered list. Handing it an id-ordered list silently
 *   returns the wrong "Now" phase.
 * - `uid()` ids start with a base36 `Date.now()`, currently `"m…"`, which
 *   sorts *before* `"seed:…"` — so pure id order would file every phase the
 *   user adds ahead of the whole seeded roadmap.
 *
 * `id` is still the tiebreak, because two phases may legitimately share a
 * `start` and a comparator without a total order lets two converged devices
 * render the same data in different orders forever.
 */
import type { RoadmapPhase } from "@/lib/nexus/types";

/**
 * Ascending id — a total order, and for seeded records the authored one.
 *
 * Compared with `<`/`>` rather than `localeCompare`, deliberately: this must
 * agree with the sync layer's own rebuild, which sorts code-unit-wise. A
 * locale collation treats `:` and `-` as ignorable punctuation in some
 * locales, so `seed:0010:task:x` and `seed:1:task:x` could order differently
 * on two devices with the same data.
 */
export function byId<T extends { id: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Chronological, `id` as the tiebreak. See the module note for why not `byId`. */
export function orderPhases<T extends Pick<RoadmapPhase, "id" | "start">>(
  phases: readonly T[],
): T[] {
  return [...phases].sort(
    (a, b) =>
      (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
