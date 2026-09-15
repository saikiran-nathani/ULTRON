import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { inputCls, labelCls } from "./Field";

export type FieldType = "text" | "number" | "date" | "time" | "select" | "textarea" | "checkbox";

export interface FormField {
  key: string;
  label: string;
  type?: FieldType;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
  step?: number;
  min?: number;
  /** Span both columns. */
  full?: boolean;
  defaultValue?: string | number | boolean;
  /**
   * For number fields: keep "" when empty instead of coercing to 0, so a real
   * 0 stays distinguishable from "no value".
   */
  keepEmpty?: boolean;
}

export type FormValues = Record<string, string | number | boolean>;

/** The editor's working state: every field is a string, or a checkbox's boolean. */
export type FormDraft = Record<string, string | boolean>;

function initialValue(f: FormField, initial?: Record<string, unknown>): string | boolean {
  const fromInitial = initial?.[f.key];
  if (fromInitial !== undefined && fromInitial !== null) {
    return f.type === "checkbox" ? Boolean(fromInitial) : String(fromInitial);
  }
  if (f.defaultValue !== undefined) {
    return f.type === "checkbox" ? Boolean(f.defaultValue) : String(f.defaultValue);
  }
  return f.type === "checkbox" ? false : "";
}

/**
 * Seed the draft from `initial`, then `defaultValue`, then empty.
 *
 * Exported for its own test rather than inlined, because the precedence is the
 * whole contract: an edit form that quietly preferred a field's
 * `defaultValue` over the record being edited would overwrite real data on
 * save, and nothing in the UI would look wrong while it happened.
 */
export function formInitialValues(fields: FormField[], initial?: Record<string, unknown>): FormDraft {
  const v: FormDraft = {};
  for (const f of fields) v[f.key] = initialValue(f, initial);
  return v;
}

/** Turn the string-shaped draft back into typed values for the caller. */
export function coerceFormValues(fields: FormField[], draft: FormDraft): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const raw = draft[f.key];
    if (f.type === "number") out[f.key] = raw === "" ? (f.keepEmpty ? "" : 0) : Number(raw);
    else if (f.type === "checkbox") out[f.key] = Boolean(raw);
    else out[f.key] = String(raw ?? "");
  }
  return out;
}

interface FormModalProps {
  title: string;
  fields: FormField[];
  initial?: Record<string, unknown>;
  submitLabel?: string;
  onSubmit: (values: FormValues) => void;
  /** Dismiss. Required here — see the note on `Modal`. */
  onClose: () => void;
}

/** Config-driven create/edit form, used across every CRUD screen. */
export function FormModal({
  title,
  fields,
  initial,
  submitLabel = "Save",
  onSubmit,
  onClose,
}: FormModalProps) {
  const [values, setValues] = useState<FormDraft>(() => formInitialValues(fields, initial));

  const set = (k: string, val: string | boolean) => setValues((prev) => ({ ...prev, [k]: val }));

  const submit = () => {
    onSubmit(coerceFormValues(fields, values));
    onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        {fields.map((f) => {
          const val = values[f.key];
          if (f.type === "checkbox") {
            return (
              // The whole row is the label, so the tap target is the row and
              // not the 16px box — the floor just brings it up to 44px.
              <label
                key={f.key}
                className="flex cursor-pointer items-center gap-2 pointer-coarse:min-h-[44px] md:col-span-2"
              >
                <input
                  type="checkbox"
                  checked={Boolean(val)}
                  onChange={(e) => set(f.key, e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)] pointer-coarse:h-5 pointer-coarse:w-5"
                />
                <span className="text-[12.5px] text-fg-dim">{f.label}</span>
              </label>
            );
          }
          return (
            <label key={f.key} className={f.full ? "md:col-span-2" : "md:col-span-1"}>
              <span className={labelCls}>{f.label}</span>
              {f.type === "select" ? (
                <select
                  className={inputCls}
                  value={String(val)}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  {!f.required && <option value="">—</option>}
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea
                  className={inputCls + " min-h-[72px] resize-y"}
                  placeholder={f.placeholder}
                  value={String(val)}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : (
                <input
                  className={inputCls}
                  type={f.type ?? "text"}
                  placeholder={f.placeholder}
                  step={f.step}
                  min={f.min}
                  value={String(val)}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </label>
          );
        })}
      </div>
    </Modal>
  );
}
