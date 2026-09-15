/**
 * The application pipeline, ported from nexus's `Career.tsx`.
 *
 * Three things changed on the way over, all of them forced:
 *
 * 1. **Colour.** The source named `copper`, `warm`, `muted`, `steel-100` and
 *    `amber` — tokens of a theme this app does not have. Everything here
 *    resolves through AZIMUTH's contract instead (`accent`, `fg`, `fg-muted`,
 *    `neutral-100`, `warn`), so a re-palette stays a one-file change.
 * 2. **Modals.** nexus pushed JSX into a global `setModal` slot. This kit's
 *    modals take a required `onClose`, so each card owns its own dismissal —
 *    see the note on `store/ui.ts`, which keeps that slot only as a warning.
 * 3. **Order.** `jobs.filter(...)` rendered whatever order the array was in.
 *    Per-record sync rebuilds arrays in ascending id order, so column
 *    contents are explicitly `byId` now. `uid()` is a base36 `Date.now()`
 *    prefix, so that reads as "oldest application first" — a real order, not
 *    an accident of the last pull.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  CountUp,
  EmptyState,
  FormModal,
  IconButton,
  StatBand,
  inputCls,
  type FormField,
  type FormValues,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import { daysFromToday, todayStr } from "@/lib/nexus/format";
import { JOB_STATUSES, type JobStatus } from "@/lib/nexus/constants";
import type { Career, Job } from "@/lib/nexus/types";
import { career } from "@/store/career";
import { byId } from "./order";

/** The funnel's stages, in order. `Rejected`/`Withdrawn` are exits, not stages. */
const COLUMNS: readonly JobStatus[] = ["Applied", "Phone Screen", "Technical", "Onsite", "Offer"];
const CLOSED: readonly JobStatus[] = ["Rejected", "Withdrawn"];

const isClosed = (j: Pick<Job, "status">) => CLOSED.includes(j.status);

/** Age of an application, as a health signal rather than a decoration. */
const ageColor = (days: number) =>
  days > 30 ? "var(--color-bad)" : days > 14 ? "var(--color-warn)" : "var(--color-good)";

const JOB_FIELDS: FormField[] = [
  { key: "company", label: "Company", required: true },
  { key: "role", label: "Role", required: true },
  {
    key: "status",
    label: "Status",
    type: "select",
    defaultValue: "Applied",
    options: JOB_STATUSES.map((s) => ({ value: s, label: s })),
  },
  { key: "dateApplied", label: "Date applied", type: "date" },
  { key: "salary", label: "Salary" },
  { key: "url", label: "Posting URL", full: true },
  { key: "contact", label: "Contact" },
  { key: "resumeVersion", label: "Résumé version" },
  { key: "nextAction", label: "Next action", full: true },
  { key: "notes", label: "Notes", type: "textarea", full: true },
  {
    key: "prepNotes",
    label: "Prep notes — the work you point at in an interview",
    type: "textarea",
    full: true,
  },
];

const toJob = (v: FormValues): Omit<Job, "id"> => ({
  company: String(v.company),
  role: String(v.role),
  status: String(v.status) as JobStatus,
  dateApplied: String(v.dateApplied),
  salary: String(v.salary),
  url: String(v.url),
  contact: String(v.contact),
  nextAction: String(v.nextAction),
  notes: String(v.notes),
  prepNotes: String(v.prepNotes),
  resumeVersion: String(v.resumeVersion),
});

function JobCard({ job }: { job: Job }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const age = job.dateApplied ? -daysFromToday(job.dateApplied) : 0;

  return (
    <Card interactive className="group p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-fg">{job.company}</div>
          <div className="truncate text-[11px] text-fg-muted">{job.role}</div>
        </div>
        {/* Half strength at rest and full on hover was already the source's
            fix for `opacity-0`; the coarse-pointer clause is the part it was
            missing. A finger never fires hover, so on a phone these two sat at
            50% forever — legible, but reading as disabled. */}
        <div className="flex shrink-0 opacity-50 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
          <IconButton icon={<Pencil size={12} />} label="Edit application" onClick={() => setEditing(true)} />
          <IconButton
            icon={<Trash2 size={12} />}
            label="Delete application"
            danger
            onClick={() => setDeleting(true)}
          />
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        {job.dateApplied && (
          <span className="nums text-[10px]" style={{ color: ageColor(age) }}>
            {age}d
          </span>
        )}
        {job.salary && <span className="nums text-[10px] text-fg-muted">{job.salary}</span>}
        {job.url && (
          <IconButton
            className="ml-auto"
            icon={<ExternalLink size={12} />}
            label="Open posting"
            onClick={() => window.open(job.url, "_blank", "noopener,noreferrer")}
          />
        )}
      </div>

      {job.nextAction && (
        <div className="mt-1 truncate text-[10.5px] text-accent-lt">→ {job.nextAction}</div>
      )}

      {/* A real `<select>` rather than a menu: it is the one control on this
          card used every week, and the platform picker is the best touch
          target on the phone by a wide margin. */}
      <label className="mt-2 block">
        <span className="sr-only">Status for {job.company}</span>
        <select
          className={inputCls + " py-1 text-[11px]"}
          value={job.status}
          onChange={(e) => career.setJobStatus(job.id, e.target.value)}
        >
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {editing && (
        <FormModal
          title="Edit application"
          initial={{ ...job }}
          fields={JOB_FIELDS}
          onSubmit={(v) => career.editJob(job.id, toJob(v))}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete application"
          message={`Delete the ${job.role} application at ${job.company}? Its prep notes go with it, and those are what banked your work.`}
          onConfirm={() => career.delJob(job.id)}
          onClose={() => setDeleting(false)}
        />
      )}
    </Card>
  );
}

/** Stage-by-stage survival, with the conversion between stages. */
function Funnel({ jobs }: { jobs: readonly Job[] }) {
  const active = jobs.filter((j) => !isClosed(j));
  if (active.length === 0) return null;

  const reached = COLUMNS.map((_, k) => active.filter((j) => COLUMNS.indexOf(j.status) >= k).length);
  const top = Math.max(1, reached[0] ?? 0);

  return (
    <Card className="p-5" active>
      <div className="label mb-3">Pipeline funnel</div>
      <div className="flex flex-col gap-2">
        {COLUMNS.map((col, k) => {
          const n = reached[k] ?? 0;
          const prev = reached[k - 1] ?? 0;
          const conv = k > 0 && prev > 0 ? Math.round((n / prev) * 100) : null;
          return (
            <div key={col} className="flex items-center gap-3">
              <span className="label w-24 shrink-0 text-fg-dim">{col}</span>
              <div className="relative h-6 flex-1 overflow-hidden rounded-xs bg-subtle/40">
                <motion.div
                  className="absolute inset-y-0 left-0 rounded-xs"
                  initial={{ width: 0 }}
                  animate={{ width: `${(n / top) * 100}%` }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: 0.05 * k }}
                  style={{
                    background: `color-mix(in srgb, var(--color-accent) ${40 + k * 12}%, transparent)`,
                  }}
                />
                <span className="nums absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-fg">
                  {n}
                </span>
              </div>
              <span className="nums w-12 text-right text-[10.5px] text-fg-muted">
                {conv != null ? `${conv}%` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function Pipeline({ data }: { data: Career }) {
  const [adding, setAdding] = useState(false);
  const jobs = byId(data.jobs);

  const total = jobs.length;
  const responded = jobs.filter((j) => j.status !== "Applied").length;
  const offers = jobs.filter((j) => j.status === "Offer").length;
  const active = jobs.filter((j) => !isClosed(j)).length;
  const closed = jobs.filter(isClosed);

  return (
    <div className="flex flex-col gap-4 pt-5">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          New application
        </Button>
      </div>

      <StatBand
        items={[
          { label: "Applications", value: <CountUp value={total} /> },
          { label: "Response rate", value: total ? `${Math.round((responded / total) * 100)}%` : "—" },
          { label: "Offers", value: <CountUp value={offers} />, color: "var(--color-good)" },
          { label: "Active", value: <CountUp value={active} />, color: "var(--color-accent-lt)" },
        ]}
      />

      {total === 0 ? (
        <EmptyState
          title="No applications yet"
          hint="Every application is a place to bank finished work. The Evidence tab lists what is waiting for one."
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              New application
            </Button>
          }
        />
      ) : (
        <>
          <Funnel jobs={jobs} />
          {/* Horizontal on every size, including the phone: five stages of a
              kanban do not fit a 375px column, and stacking them vertically
              loses the one thing the layout is for. */}
          <Stagger className="flex gap-3 overflow-x-auto pb-2">
            {COLUMNS.map((col) => {
              const items = jobs.filter((j) => j.status === col);
              return (
                <Reveal key={col} className="w-[200px] shrink-0">
                  <div className="label mb-2 flex items-center justify-between">
                    <span>{col}</span>
                    <span className="nums">{items.length}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {items.map((j) => (
                      <JobCard key={j.id} job={j} />
                    ))}
                  </div>
                </Reveal>
              );
            })}
          </Stagger>
        </>
      )}

      {closed.length > 0 && (
        <div>
          <div className="label mb-2">Closed ({closed.length})</div>
          <div className="flex flex-wrap gap-2">
            {closed.map((j) => (
              <Chip key={j.id} color="var(--color-neutral-100)">
                {j.company} · {j.status}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {adding && (
        <FormModal
          title="New application"
          fields={JOB_FIELDS.map((f) =>
            f.key === "dateApplied" ? { ...f, defaultValue: todayStr() } : f,
          )}
          onSubmit={(v) => career.addJob(toJob(v))}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
