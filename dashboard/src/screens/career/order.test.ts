/**
 * The two orderings the Career screen renders, both of which fail silently.
 *
 * A wrong order is not an exception and not a log line — it is a roadmap whose
 * phases read in the wrong sequence, or a curriculum whose 34 tasks come back
 * shuffled after a sync. The screen looks fine while being wrong, which is
 * precisely why these are unit-tested rather than eyeballed.
 */
import { describe, expect, it } from "vitest";
import { byId, orderPhases } from "./order";

const ids = <T extends { id: string }>(xs: T[]) => xs.map((x) => x.id);

describe("byId", () => {
  it("puts seeded roadmap ids back into authored order", () => {
    // The shape the seed actually mints. The zero-padded ordinal is the whole
    // reason ascending id is authored order; without the padding, 10 would
    // sort before 9.
    const shuffled = [
      { id: "seed:0010:task:tenth" },
      { id: "seed:0002:task:second" },
      { id: "seed:0009:task:ninth" },
      { id: "seed:0001:task:first" },
    ];
    expect(ids(byId(shuffled))).toEqual([
      "seed:0001:task:first",
      "seed:0002:task:second",
      "seed:0009:task:ninth",
      "seed:0010:task:tenth",
    ]);
  });

  it("does not mutate its input", () => {
    const xs = [{ id: "b" }, { id: "a" }];
    byId(xs);
    expect(ids(xs)).toEqual(["b", "a"]);
  });

  it("is a total order, so two devices with the same data agree", () => {
    const a = byId([{ id: "x" }, { id: "y" }, { id: "z" }]);
    const b = byId([{ id: "z" }, { id: "x" }, { id: "y" }]);
    expect(ids(a)).toEqual(ids(b));
  });

  it("orders code-unit-wise, not by locale collation", () => {
    // `localeCompare` can treat `:` as ignorable, which would make these two
    // compare equal and let two devices disagree about a converged list.
    expect(ids(byId([{ id: "seed:0002:a" }, { id: "seed:00019:a" }]))).toEqual([
      "seed:00019:a",
      "seed:0002:a",
    ]);
  });

  it("handles empty and single-element lists", () => {
    expect(byId([])).toEqual([]);
    expect(ids(byId([{ id: "only" }]))).toEqual(["only"]);
  });
});

describe("orderPhases", () => {
  it("orders chronologically, not by id", () => {
    // A user-added phase carries a `uid()` id, which starts with a base36
    // `Date.now()` — currently "m…", which sorts BEFORE "seed:…". Pure id
    // order would file every new phase ahead of the entire seeded roadmap.
    const phases = [
      { id: "seed:0001:phase:one", start: "2026-01-01" },
      { id: "mfz9qab12", start: "2026-06-01" },
      { id: "seed:0007:phase:two", start: "2026-03-01" },
    ];
    expect(ids(orderPhases(phases))).toEqual([
      "seed:0001:phase:one",
      "seed:0007:phase:two",
      "mfz9qab12",
    ]);
  });

  it("agrees with id order on seeded data, where both are authored order", () => {
    const phases = [
      { id: "seed:0003:phase:c", start: "2026-07-01" },
      { id: "seed:0001:phase:a", start: "2026-01-01" },
      { id: "seed:0002:phase:b", start: "2026-04-01" },
    ];
    expect(ids(orderPhases(phases))).toEqual(ids(byId(phases)));
  });

  it("breaks a shared start date by id rather than leaving it arbitrary", () => {
    const phases = [
      { id: "b", start: "2026-01-01" },
      { id: "a", start: "2026-01-01" },
    ];
    expect(ids(orderPhases(phases))).toEqual(["a", "b"]);
    // Reversed input, same output — the property that stops two converged
    // devices rendering the same roadmap in two orders.
    expect(ids(orderPhases([...phases].reverse()))).toEqual(["a", "b"]);
  });

  it("sorts an empty start last rather than crashing on it", () => {
    // `""` is reachable: the phase form's date input can be cleared.
    const phases = [{ id: "a", start: "" }, { id: "b", start: "2026-01-01" }];
    expect(ids(orderPhases(phases))).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const phases = [{ id: "b", start: "2026-06-01" }, { id: "a", start: "2026-01-01" }];
    orderPhases(phases);
    expect(ids(phases)).toEqual(["b", "a"]);
  });
});
