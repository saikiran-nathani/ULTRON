/**
 * `FormModal`'s two pure halves — how a draft is seeded, and how it is coerced
 * back on save. Both are load-bearing and both fail silently:
 *
 * - Seeding in the wrong order makes an edit form show a field's default in
 *   place of the record's own value, and saving then overwrites real data with
 *   the placeholder that was on screen.
 * - Coercing "" to 0 for a number field is right for a create form and wrong
 *   for a nullable one, which is what `keepEmpty` exists to say. Getting it
 *   backwards writes a plausible 0 where the user meant "unset".
 *
 * The rendering is not covered here — there is no jsdom in this repo — so
 * these tests deliberately hold the parts that do not need one.
 */
import { describe, expect, it } from "vitest";
import { coerceFormValues, formInitialValues, type FormField } from "./FormModal";

const f = (over: Partial<FormField> & { key: string }): FormField => ({
  label: over.key,
  ...over,
});

describe("formInitialValues", () => {
  it("prefers the record over the field default", () => {
    const fields = [f({ key: "name", defaultValue: "untitled" })];
    expect(formInitialValues(fields, { name: "real" })).toEqual({ name: "real" });
  });

  it("falls back to the field default, then to empty", () => {
    const fields = [f({ key: "a", defaultValue: "d" }), f({ key: "b" })];
    expect(formInitialValues(fields)).toEqual({ a: "d", b: "" });
  });

  it("keeps a falsy-but-real value from the record", () => {
    // 0 and "" are values a user chose. `?? `-style fallbacks are fine; a
    // truthiness test here would replace a legitimate 0 with the default.
    const fields = [f({ key: "n", type: "number", defaultValue: 5 })];
    expect(formInitialValues(fields, { n: 0 })).toEqual({ n: "0" });
    expect(formInitialValues([f({ key: "s", defaultValue: "d" })], { s: "" })).toEqual({ s: "" });
  });

  it("treats a null record field as absent", () => {
    // The API returns null for an unset column; that is "no value", not the
    // string "null" in the input.
    const fields = [f({ key: "note", defaultValue: "d" })];
    expect(formInitialValues(fields, { note: null })).toEqual({ note: "d" });
  });

  it("stringifies non-strings, since every input is a string input", () => {
    expect(formInitialValues([f({ key: "n", type: "number" })], { n: 42 })).toEqual({ n: "42" });
  });

  it("gives a checkbox a boolean at every step", () => {
    const box = f({ key: "on", type: "checkbox" });
    expect(formInitialValues([box])).toEqual({ on: false });
    expect(formInitialValues([box], { on: 1 })).toEqual({ on: true });
    expect(formInitialValues([f({ key: "on", type: "checkbox", defaultValue: true })])).toEqual({
      on: true,
    });
  });

  it("ignores keys in the record that no field claims", () => {
    expect(formInitialValues([f({ key: "a" })], { a: "1", stray: "x" })).toEqual({ a: "1" });
  });
});

describe("coerceFormValues", () => {
  it("numbers a number field", () => {
    const fields = [f({ key: "n", type: "number" })];
    expect(coerceFormValues(fields, { n: "12.5" })).toEqual({ n: 12.5 });
  });

  it("empties to 0 by default and to \"\" under keepEmpty", () => {
    expect(coerceFormValues([f({ key: "n", type: "number" })], { n: "" })).toEqual({ n: 0 });
    expect(
      coerceFormValues([f({ key: "n", type: "number", keepEmpty: true })], { n: "" }),
    ).toEqual({ n: "" });
  });

  it("keeps a real 0 distinct from empty", () => {
    const fields = [f({ key: "n", type: "number", keepEmpty: true })];
    expect(coerceFormValues(fields, { n: "0" })).toEqual({ n: 0 });
  });

  it("booleans a checkbox", () => {
    const fields = [f({ key: "on", type: "checkbox" })];
    expect(coerceFormValues(fields, { on: true })).toEqual({ on: true });
    expect(coerceFormValues(fields, { on: false })).toEqual({ on: false });
  });

  it("strings everything else, including an untouched field", () => {
    const fields = [f({ key: "a" }), f({ key: "b", type: "textarea" })];
    expect(coerceFormValues(fields, { a: "x" })).toEqual({ a: "x", b: "" });
  });

  it("emits exactly the declared keys, in the declared order", () => {
    const fields = [f({ key: "b" }), f({ key: "a" })];
    const out = coerceFormValues(fields, { a: "1", b: "2", stray: "x" });
    expect(Object.keys(out)).toEqual(["b", "a"]);
  });

  it("round-trips a seeded draft back to the record's values", () => {
    const fields = [
      f({ key: "name" }),
      f({ key: "epochs", type: "number" }),
      f({ key: "live", type: "checkbox" }),
    ];
    const record = { name: "run-7", epochs: 3, live: true };
    expect(coerceFormValues(fields, formInitialValues(fields, record))).toEqual(record);
  });
});
