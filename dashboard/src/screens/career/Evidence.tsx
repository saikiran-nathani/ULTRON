/**
 * Where the four tracks terminate — and, more usefully, where they did not.
 *
 * This tab is the one thing a straight port of nexus's `Career.tsx` and
 * `Roadmap.tsx` side by side cannot give you. Those two screens render the
 * career side; the four tracks render the work; nothing renders the join. The
 * plan is explicit that the join is the point:
 *
 * > a course that never surfaces on the career side is a course whose value
 * > was never banked.
 *
 * So: every *finished* thing from courses, projects, research and
 * self-learning, and whether anything on the career side names it. Three
 * states, because the roadmap is a plan and a résumé is evidence and
 * collapsing them would make writing a to-do look like having done it. See
 * `banking.tsx` for the matcher and the argument.
 *
 * The two remedies both do real work rather than marking something read:
 *
 * - **Add to roadmap** writes a task into a phase, moving the row from
 *   `unbanked` to `planned`. The task text comes from `bankTaskText` so the
 *   matcher is guaranteed to find it afterwards — otherwise the user taps the
 *   button, a task appears, and the row stays red.
 * - **Bank on an application** appends a line to a job's prep notes, moving
 *   the row to `record`. Prep notes are what you actually say out loud in an
 *   interview, which is what banking means.
 *
 * Both are ordinary edits through the existing `career`/`roadmap` slices. No
 * new store, and nothing here calls `adopt`.
 */
import { useState } from "react";
import {
  Award,
  BookMarked,
  CheckCircle2,
  FlaskConical,
  FolderKanban,
  GraduationCap,
  Landmark,
  Map as MapIcon,
  Sprout,
} from "lucide-react";
import {
  Button,
  Callout,
  Card,
  Chip,
  EmptyState,
  FormModal,
  SegmentedControl,
  StatBand,
  type FormField,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import type { NexusData } from "@/lib/nexus/types";
import { career } from "@/store/career";
import { roadmap } from "@/store/roadmap";
import { byId } from "./order";
import {
  TRACK_LABEL,
  TRACK_ORDER,
  bankNoteText,
  bankTaskText,
  type BankState,
  type LedgerRow,
  type LedgerTally,
  type Track,
} from "./banking";

const TRACK_ICON: Record<Track, typeof BookMarked> = {
  courses: BookMarked,
  projects: FolderKanban,
  research: FlaskConical,
  learn: GraduationCap,
};

const STATE_META: Record<BankState, { label: string; tone: string; empty: string }> = {
  record: {
    label: "On the record",
    tone: "var(--color-good)",
    empty: "Nothing is on the record yet — no application or certification names any of it.",
  },
  planned: {
    label: "Planned",
    tone: "var(--color-warn)",
    empty: "Nothing is waiting in the roadmap.",
  },
  unbanked: {
    label: "Not banked",
    tone: "var(--color-bad)",
    empty: "Nothing is unbanked. Every finished thing is named somewhere on the career side.",
  },
};

type Filter = "all" | BankState;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "unbanked", label: "Not banked" },
  { id: "planned", label: "Planned" },
  { id: "record", label: "On record" },
  { id: "all", label: "All" },
];

/* ── the two remedies ───────────────────────────────────────────────────── */

type Remedy = { kind: "roadmap" | "application"; row: LedgerRow };

function RemedyModal({
  remedy,
  data,
  onClose,
}: {
  remedy: Remedy;
  data: NexusData;
  onClose: () => void;
}) {
  if (remedy.kind === "roadmap") {
    const phases = byId(data.roadmap.phases);
    const fields: FormField[] = [
      {
        key: "phase",
        label: "Phase",
        type: "select",
        required: true,
        defaultValue: phases[0]?.id ?? "",
        options: phases.map((p) => ({ value: p.id, label: p.title || "Untitled phase" })),
        full: true,
      },
      {
        key: "text",
        label: "Task",
        type: "textarea",
        required: true,
        full: true,
        defaultValue: bankTaskText(remedy.row.title),
      },
    ];
    return (
      <FormModal
        title="Plan to bank it"
        submitLabel="Add task"
        fields={fields}
        onSubmit={(v) => {
          const phaseId = String(v.phase);
          const text = String(v.text).trim();
          if (phaseId && text) roadmap.addTask(phaseId, text);
        }}
        onClose={onClose}
      />
    );
  }

  const jobs = byId(data.career.jobs);
  const fields: FormField[] = [
    {
      key: "job",
      label: "Application",
      type: "select",
      required: true,
      defaultValue: jobs[0]?.id ?? "",
      options: jobs.map((j) => ({ value: j.id, label: `${j.company} — ${j.role}` })),
      full: true,
    },
    {
      key: "line",
      label: "Prep note — what this work shows",
      type: "textarea",
      required: true,
      full: true,
      defaultValue: bankNoteText(remedy.row.title, remedy.row.why),
    },
  ];
  return (
    <FormModal
      title="Bank it on an application"
      submitLabel="Append"
      fields={fields}
      onSubmit={(v) => {
        const job = data.career.jobs.find((j) => j.id === String(v.job));
        const line = String(v.line).trim();
        if (!job || !line) return;
        // Appended, never replaced: prep notes accumulate across a whole
        // search and overwriting them would lose every earlier bank.
        career.editJob(job.id, {
          prepNotes: job.prepNotes ? `${job.prepNotes}\n${line}` : line,
        });
      }}
      onClose={onClose}
    />
  );
}

/* ── one row ────────────────────────────────────────────────────────────── */

function LedgerRowCard({
  row,
  canPlan,
  canBank,
  onRemedy,
}: {
  row: LedgerRow;
  canPlan: boolean;
  canBank: boolean;
  onRemedy: (r: Remedy) => void;
}) {
  const meta = STATE_META[row.state];
  return (
    <Card className="p-4" active accent={meta.tone}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] text-fg">{row.title || "Untitled"}</div>
          <div className="mt-0.5 text-[11px] text-fg-muted">
            {row.why}
            {row.where && <> · {row.state === "record" ? "on" : "in"} {row.where}</>}
          </div>
        </div>
        <Chip color={meta.tone}>{meta.label}</Chip>
      </div>

      {/* A title too short to search for is a fact about the title, not a
          judgement about the user. Saying so is the difference between a
          fixable row and a permanently red one. */}
      {!row.matchable && (
        <p className="mt-2 text-[11px] text-fg-muted">
          Its name is too short to search for, so this row can never turn green. Rename it to
          something an interviewer would recognise.
        </p>
      )}

      {row.state !== "record" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            icon={<Landmark size={13} aria-hidden />}
            disabled={!canBank}
            title={canBank ? undefined : "No applications yet — add one on the Pipeline tab."}
            onClick={() => onRemedy({ kind: "application", row })}
          >
            Bank on an application
          </Button>
          {row.state === "unbanked" && (
            <Button
              size="sm"
              variant="ghost"
              icon={<MapIcon size={13} aria-hidden />}
              disabled={!canPlan}
              title={canPlan ? undefined : "No phases yet — add one on the Plan tab."}
              onClick={() => onRemedy({ kind: "roadmap", row })}
            >
              Add to roadmap
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/* ── the tab ────────────────────────────────────────────────────────────── */

/**
 * `rows` and `counts` are computed by `Career.tsx` and passed in rather than
 * folded here, so the tab's badge and the tab's contents cannot disagree about
 * how much is unbanked — the one number on this screen somebody acts on.
 */
export function Evidence({
  data,
  rows,
  counts: t,
}: {
  data: NexusData;
  rows: readonly LedgerRow[];
  counts: LedgerTally;
}) {
  // Opens on the problem when there is one, and on the whole ledger when
  // there is not — rather than opening on an empty "not banked" list and
  // making the good state look like a bug. Initial value only, so switching
  // filters afterwards is never overridden.
  const [filter, setFilter] = useState<Filter>(() => (t.unbanked > 0 ? "unbanked" : "all"));
  const [remedy, setRemedy] = useState<Remedy | null>(null);

  const canPlan = data.roadmap.phases.length > 0;
  const canBank = data.career.jobs.length > 0;

  // Nothing has finished yet. Visually a dashed empty state, which is
  // deliberately nothing like the "everything is banked" callout below — one
  // means "come back later", the other means "you are done".
  if (t.total === 0) {
    return (
      <div className="pt-5">
        <EmptyState
          icon={<Sprout size={22} strokeWidth={1.6} aria-hidden />}
          title="Nothing has terminated yet"
          hint="This ledger fills up as work finishes: a graded course, a completed project, a done experiment, a study plan with every topic ticked. Work still in flight is not listed, so an empty ledger is not a warning."
        />
      </div>
    );
  }

  const shown = filter === "all" ? rows : rows.filter((r) => r.state === filter);

  return (
    <div className="flex flex-col gap-4 pt-5">
      <StatBand
        items={[
          {
            label: "On the record",
            value: t.record,
            sub: "in an application or a cert",
            color: "var(--color-good)",
            onClick: () => setFilter("record"),
            active: filter === "record",
          },
          {
            label: "Planned only",
            value: t.planned,
            sub: "in the roadmap, not on a résumé",
            color: "var(--color-warn)",
            onClick: () => setFilter("planned"),
            active: filter === "planned",
          },
          {
            label: "Not banked",
            value: t.unbanked,
            sub: "named nowhere",
            color: t.unbanked > 0 ? "var(--color-bad)" : "var(--color-fg-muted)",
            onClick: () => setFilter("unbanked"),
            active: filter === "unbanked",
          },
          {
            label: "Finished work",
            value: t.total,
            sub: "across the four tracks",
            onClick: () => setFilter("all"),
            active: filter === "all",
          },
        ]}
      />

      {t.unbanked > 0 ? (
        <Callout
          icon={<Award size={12} aria-hidden />}
          label={`${t.unbanked} finished ${t.unbanked === 1 ? "thing has" : "things have"} not been banked`}
          tone="var(--color-bad)"
        >
          These are done, and nothing on the career side names them — not an application, not a
          certification, not even a roadmap task. That is the whole failure this screen exists to
          make visible: the work happened and the evidence did not.
        </Callout>
      ) : t.planned > 0 ? (
        <Callout
          icon={<MapIcon size={12} aria-hidden />}
          label="Everything finished is at least planned"
          tone="var(--color-warn)"
        >
          {t.planned} {t.planned === 1 ? "item is" : "items are"} named in the roadmap and nowhere
          an interviewer will read. A plan to bank something is not the same as having banked it.
        </Callout>
      ) : (
        <Callout
          icon={<CheckCircle2 size={12} aria-hidden />}
          label="Every finished thing is on the record"
          tone="var(--color-good)"
        >
          All {t.total} of them are named in an application or a certification. This is what the
          four tracks terminating looks like.
        </Callout>
      )}

      {/* Four segments do not fit a 375px phone, and `SegmentedControl` is an
          `inline-flex` with no overflow handling of its own — without the
          scroller the last segment is unreachable. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <SegmentedControl
          className="min-w-max"
          options={FILTERS}
          value={filter}
          onChange={(id) => setFilter(id as Filter)}
        />
      </div>

      {shown.length === 0 && filter !== "all" ? (
        // A filter with no matches, which is not the same fact as an empty
        // ledger — hence a plain line rather than the dashed panel above.
        <Card className="px-4 py-6 text-center text-[12px] text-fg-muted">
          {STATE_META[filter].empty}
        </Card>
      ) : (
        <Stagger className="flex flex-col gap-5">
          {TRACK_ORDER.map((track) => {
            const group = shown.filter((r) => r.track === track);
            if (group.length === 0) return null;
            const Icon = TRACK_ICON[track];
            const shortfall = t.byTrack[track];
            return (
              <Reveal key={track}>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Icon size={13} aria-hidden className="text-accent-dim" />
                    <span className="label">{TRACK_LABEL[track]}</span>
                    <span className="nums text-[10.5px] text-fg-muted">
                      {group.length} of {shortfall.total}
                    </span>
                    {shortfall.unbanked > 0 && (
                      <Chip color="var(--color-bad)">{shortfall.unbanked} unbanked</Chip>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {group.map((r) => (
                      <LedgerRowCard
                        key={`${r.track}:${r.id}`}
                        row={r}
                        canPlan={canPlan}
                        canBank={canBank}
                        onRemedy={setRemedy}
                      />
                    ))}
                  </div>
                </div>
              </Reveal>
            );
          })}
        </Stagger>
      )}

      <p className="max-w-[72ch] text-[11px] leading-relaxed text-fg-muted">
        Banked means the words appear where somebody outside this app reads them: a job
        application&apos;s notes, prep notes, résumé version or next action, or a
        certification&apos;s name or notes. The roadmap counts as planned, never as banked.
        Matching is on whole words, so a two-letter title cannot be found.
      </p>

      {remedy && <RemedyModal remedy={remedy} data={data} onClose={() => setRemedy(null)} />}
    </div>
  );
}
