import type { ReactNode } from "react";

/**
 * Shared input styling, so every form in the app matches.
 *
 * The two `pointer-coarse:` clauses are both phone fixes, and the second is
 * the non-obvious one: iOS Safari zooms the whole page when a field smaller
 * than 16px takes focus, and it does not zoom back out. The form then sits
 * off-centre behind the keyboard for the rest of the session. 16px on touch
 * is the documented way to refuse that; a fine pointer keeps the 13px the
 * desktop layout was measured against.
 */
export const inputCls =
  "w-full rounded-sm border-[0.5px] border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-muted/60 focus:border-line-strong pointer-coarse:min-h-[44px] pointer-coarse:text-[16px]";

export const labelCls = "label mb-1 block";

interface FieldProps {
  label: string;
  children: ReactNode;
  full?: boolean;
}

export function Field({ label, children, full }: FieldProps) {
  return (
    <label className={full ? "col-span-2 block" : "block"}>
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}
