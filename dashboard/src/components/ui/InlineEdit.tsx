import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/cn";
import { inputCls } from "./Field";

interface InlineEditProps {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  /** Styling for both the display element and the editor. */
  className?: string;
}

/**
 * Direct-manipulation text editing: tap the text to edit it in place. Enter
 * (or blur) commits, Esc cancels. Replaces a modal form for simple fields.
 *
 * The source marked this as editable with a hover background and a
 * `title="Click to edit"` tooltip — two affordances a touch screen has
 * neither of, leaving the text indistinguishable from a static label. The
 * action was always reachable by tap; nothing said it was there. So on a
 * coarse pointer the pencil is rendered permanently and the row takes a 44px
 * floor. A fine pointer still gets the original hover-only treatment, so the
 * desktop rendering is unchanged.
 */
export function InlineEdit({ value, onCommit, placeholder, multiline, className }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t !== value) onCommit(t);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  if (editing) {
    if (multiline) {
      return (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className={cn(inputCls, "min-h-[72px] resize-y", className)}
        />
      );
    }
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className={cn(inputCls, className)}
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      title="Edit"
      aria-label={value ? `Edit: ${value}` : "Edit"}
      className={cn(
        "-mx-1 cursor-text rounded-sm px-1 text-left transition-colors hover:bg-card-hover/70",
        "pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center pointer-coarse:gap-1.5",
        className,
      )}
    >
      {value || <span className="text-fg-muted">{placeholder ?? "—"}</span>}
      <Pencil
        size={11}
        aria-hidden
        className="hidden shrink-0 text-fg-muted pointer-coarse:block"
      />
    </button>
  );
}
