/**
 * The inbox, and triage as three verbs rather than a wizard.
 *
 * Capture and triage are deliberately different moments — that is the whole
 * shape of the plan's "lands in an inbox, triaged later" — so nothing here
 * runs at capture time and nothing here asks more than one question:
 *
 *   keep  → it stays a thought; pick the journal category it belongs to.
 *   file  → it becomes a thing in another domain; pick which existing one.
 *   drop  → it was noise; confirmed, because a mis-tap here is a loss.
 *
 * Both pickers are lists of tap targets inside a `Modal`, not `FormModal`
 * forms. A form needs a default, a default is a wrong answer waiting for a
 * mis-tap, and a form needs a second tap on Save for a decision that is one
 * choice wide. A list of rows is one tap and has no default to be wrong about.
 *
 * Filing can fail — the project you aimed at may have been deleted on another
 * device since the sheet opened — so every verb reports back, and a refusal
 * gets a visible banner with the capture still in the list. Silence there
 * would be the text disappearing with nothing to show for it.
 */
import { useState } from "react";
import { Archive, FolderInput, Inbox as InboxIcon, Trash2, XCircle } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  Modal,
  inputCls,
} from "@/components/ui";
import { FRAGMENT_TYPES, JOURNAL_CATEGORIES } from "@/lib/nexus/constants";
import type { Fragment, FragmentType, NexusData } from "@/lib/nexus/types";
import { cn } from "@/lib/cn";
import { ageLabel, capture, fileTargets, inboxOf, parseFileTarget } from "@/store/capture";

/**
 * A fragment type's colour.
 *
 * `FRAGMENT_TYPES` already carries one, and it is not usable here: two of the
 * four name `--color-copper` and `--color-amber`, which belonged to the
 * previous theme and do not exist in `theme.css` — so `color-mix` receives an
 * empty custom property and the chip renders as nothing. The labels and hints
 * come from the model as they should; only the tone is restated, against
 * tokens this theme actually defines. (Worth fixing in `constants.ts`, which
 * is outside this brief's files.)
 */
const TYPE_TONE: Record<FragmentType, string> = {
  seed: "var(--color-good)",
  thread: "var(--color-info)",
  principle: "var(--color-warn)",
  action: "var(--color-bad)",
};

interface PickOption {
  value: string;
  label: string;
  hint?: string;
}

/** A one-tap chooser. No default, no Save — the tap is the decision. */
function PickSheet({
  title,
  intro,
  options,
  onPick,
  onClose,
}: {
  title: string;
  intro: string;
  options: PickOption[];
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <p className="mb-3 text-[12px] leading-relaxed text-fg-muted">{intro}</p>
      <div className="flex flex-col gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              onPick(o.value);
              onClose();
            }}
            className={cn(
              "flex min-h-[40px] flex-col items-start justify-center gap-0.5 rounded-sm border-[0.5px] border-line",
              "bg-card px-3 py-2 text-left transition-colors hover:border-line-active hover:bg-card-hover",
              "active:scale-[0.99] pointer-coarse:min-h-[52px]",
            )}
          >
            <span className="text-[12.5px] font-medium text-fg">{o.label}</span>
            {o.hint && <span className="text-[11px] text-fg-muted">{o.hint}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

type Sheet =
  | { kind: "keep"; fragment: Fragment }
  | { kind: "file"; fragment: Fragment }
  | { kind: "drop"; fragment: Fragment }
  | null;

export function Inbox({ data }: { data: NexusData }) {
  const items = inboxOf(data.journal.fragments);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [refused, setRefused] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<InboxIcon size={22} strokeWidth={1.6} />}
        title="Inbox is clear"
        hint="Everything captured has been kept, filed or dropped. This is the state the inbox is supposed to be in — capture above and it lands right here."
      />
    );
  }

  const close = () => setSheet(null);

  return (
    <div className="flex flex-col gap-2.5">
      {refused && (
        <Card
          className="flex items-start gap-2.5 p-3.5"
          accent="var(--color-bad)"
          active
          role="alert"
        >
          <XCircle
            size={14}
            strokeWidth={1.8}
            className="mt-px shrink-0 text-[var(--color-bad)]"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] leading-relaxed text-fg-dim">{refused}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setRefused(null)}>
            Dismiss
          </Button>
        </Card>
      )}

      {items.map((f) => (
        <Row key={f.id} fragment={f} onSheet={setSheet} />
      ))}

      {sheet?.kind === "keep" && (
        <PickSheet
          title="Keep as a thought"
          intro="It stays exactly as you typed it and moves out of the inbox into this part of the journal. Nothing is copied or re-created."
          options={JOURNAL_CATEGORIES.map((c) => ({
            value: c.id,
            label: c.label,
            hint: c.blurb,
          }))}
          onPick={(value) => {
            if (!capture.keep(sheet.fragment.id, value)) {
              setRefused("That capture could not be kept — it may have been triaged on another device. Pull to refresh and look again.");
            }
          }}
          onClose={close}
        />
      )}

      {sheet?.kind === "file" && (
        <PickSheet
          title="File it somewhere"
          intro="The text moves into a record that already exists in the model, and the capture leaves the inbox. Both happen in one write, so it is never in neither place."
          options={fileTargets(data).map((t) => ({ value: t.value, label: t.label }))}
          onPick={(value) => {
            const target = parseFileTarget(value);
            if (!target || !capture.file(sheet.fragment.id, target)) {
              setRefused(
                "Nothing was filed, and the capture is still in the list. The project you picked was most likely deleted on another device.",
              );
            }
          }}
          onClose={close}
        />
      )}

      {sheet?.kind === "drop" && (
        <ConfirmDialog
          title="Drop this capture?"
          message={`“${sheet.fragment.fragment}” is deleted everywhere, on every device. There is no undo — if there is any chance it matters, keep it instead and sort it later.`}
          confirmLabel="Drop"
          onConfirm={() => {
            if (!capture.drop(sheet.fragment.id)) {
              setRefused("That capture was already gone — nothing was deleted.");
            }
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

function Row({
  fragment: f,
  onSheet,
}: {
  fragment: Fragment;
  onSheet: (s: Sheet) => void;
}) {
  const meta = FRAGMENT_TYPES.find((t) => t.id === f.type);
  const tone = TYPE_TONE[f.type];

  return (
    <Card className="p-3.5" accent={tone} active>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-fg">{f.fragment}</p>
        <span className="nums shrink-0 text-[10.5px] text-fg-muted">{ageLabel(f.date)}</span>
      </div>

      {f.body && (
        <p className="mt-1.5 whitespace-pre-line text-[11.5px] leading-relaxed text-fg-muted">
          {f.body}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* A native select rather than a segmented control: four segments at a
            44px floor is most of a phone's width, and retyping is a scan-time
            correction, not the point of the row. `inputCls` carries the coarse
            pointer floor and the 16px iOS rule. */}
        <label className="shrink-0">
          <span className="sr-only">Type</span>
          <select
            value={f.type}
            onChange={(e) => capture.setType(f.id, e.target.value as FragmentType)}
            className={cn(inputCls, "w-auto py-1 text-[11px]")}
            style={{ color: tone }}
            aria-label={`Type of “${f.fragment}”`}
          >
            {FRAGMENT_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {meta && !f.body && (
          <Chip color={tone} className="hidden sm:inline-flex">
            {meta.hint}
          </Chip>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="subtle"
            icon={<Archive size={12} strokeWidth={1.8} aria-hidden />}
            onClick={() => onSheet({ kind: "keep", fragment: f })}
          >
            Keep
          </Button>
          <Button
            size="sm"
            variant="subtle"
            icon={<FolderInput size={12} strokeWidth={1.8} aria-hidden />}
            onClick={() => onSheet({ kind: "file", fragment: f })}
          >
            File
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={12} strokeWidth={1.8} aria-hidden />}
            onClick={() => onSheet({ kind: "drop", fragment: f })}
          >
            Drop
          </Button>
        </div>
      </div>
    </Card>
  );
}
