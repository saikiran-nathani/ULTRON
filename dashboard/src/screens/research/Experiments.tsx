/**
 * Experiments, and the run each one produced.
 *
 * `Experiment.runId` is why this screen exists rather than a notebook, so the
 * run link is not a field in a list of fields — it is a block of its own on
 * every card, and it renders five visibly different things:
 *
 * | state         | what it means                                    | tone   |
 * | ------------- | ------------------------------------------------ | ------ |
 * | `none`        | no run linked. Normal. Not a warning.            | muted  |
 * | `linked`      | the hub knows the run; its numbers are shown.    | good   |
 * | `checking`    | the question is open — asking, or still connecting | info |
 * | `missing`     | the hub answered 404. The id names nothing.      | bad    |
 * | `unreachable` | we could not ask. Not the same as `missing`.     | warn   |
 *
 * The middle three are the ones a lazy implementation collapses, and the
 * collapse is the failure this project exists to remove: "the fetch failed"
 * and "the run was deleted" arrive at the same `catch`, and only one of them
 * is a fact about your data. See `runlink.tsx` for the resolution and
 * `useRunLinks.tsx` for why the live run list alone cannot answer it.
 *
 * The same rule governs the banner at the top of this tab, and it is the rule
 * one size smaller. "The hub is unreachable" is a verdict, so it may only be
 * shown once the stream has actually reported `offline` — never during the
 * `connecting` window, where the honest render is a spinner. A spinner is
 * acceptable there and only there because `api.ts` guarantees `connection`
 * leaves `connecting` in one direction or the other.
 *
 * `projectId` is the opposite case. It *is* a real reference into `projects`
 * and it *is* in the reconciler's table, so a dangling one is already reported
 * as a `dangling-reference` `Finding` with a sentence written for a person.
 * This screen shows that finding rather than computing a second opinion — a
 * needs-attention list that disagrees with the app's own reconciler is worse
 * than no list.
 */
import { useState } from "react";
import {
  CircleDashed,
  FlaskConical,
  Link2,
  Link2Off,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ServerCrash,
  Trash2,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import {
  Button,
  Callout,
  Card,
  Chip,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  FormModal,
  IconButton,
  SegmentedControl,
  StatBand,
  type FormField,
  type FormValues,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import { dayClock, duration } from "@/lib/format";
import { todayStr } from "@/lib/nexus/format";
import type { Experiment, ExperimentStatus, NexusData, Project } from "@/lib/nexus/types";
import type { Finding } from "@/lib/sync/reconcile";
import type { Run } from "@/lib/api";
import { research } from "./edits";
import {
  byId,
  isUnwritten,
  linkTally,
  resolveRunLink,
  type HubReach,
  type RunLink,
  type RunLinkContext,
} from "./runlink";

const STATUS_META: Record<ExperimentStatus, { label: string; tone: string }> = {
  planned: { label: "Planned", tone: "var(--color-neutral-100)" },
  running: { label: "Running", tone: "var(--color-info)" },
  done: { label: "Done", tone: "var(--color-good)" },
  abandoned: { label: "Abandoned", tone: "var(--color-fg-muted)" },
};

const RUN_DOT: Record<Run["status"], string> = {
  running: "var(--color-good)",
  finished: "var(--color-accent)",
  failed: "var(--color-bad)",
  dead: "var(--color-bad)",
  stopped: "var(--color-fg-muted)",
};

type Filter = "all" | ExperimentStatus | "unlinked" | "broken";

/**
 * The two filters that are not statuses are the point of the list: "no run"
 * and "broken link" are the two facts you come here to act on, and neither is
 * derivable from `status`.
 */
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
  { id: "unlinked", label: "No run" },
  { id: "broken", label: "Broken link" },
];

/* ── the run link, rendered as five different things ───────────────────── */

function RunLinkBlock({
  link,
  onRetry,
  onUnlink,
  onEdit,
}: {
  link: RunLink;
  onRetry: () => void;
  onUnlink: () => void;
  onEdit: () => void;
}) {
  if (link.state === "none") {
    // Deliberately the quietest thing on the card. `types.ts` documents `""`
    // as the normal value for an experiment that was not a training run, so a
    // warning here would mark correct data as broken forever.
    return (
      <div className="flex items-center gap-2 rounded-sm border-[0.5px] border-dashed border-line px-3 py-2 text-[11.5px] text-fg-muted">
        <Unlink size={12} aria-hidden />
        <span>No run linked — this was not a training run.</span>
        <button
          onClick={onEdit}
          className="ml-auto shrink-0 text-accent-dim underline decoration-dotted pointer-coarse:min-h-[44px]"
        >
          Link one
        </button>
      </div>
    );
  }

  if (link.state === "linked") {
    const r = link.run;
    const ran = duration((r.ended_at ?? Date.now() / 1000) - r.started_at);
    return (
      <div className="rounded-sm border-[0.5px] border-line-active bg-card-hover/50 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link2 size={12} aria-hidden style={{ color: "var(--color-good)" }} />
          <span className="label" style={{ color: "var(--color-good)" }}>
            Linked to a run
          </span>
          <Chip color={RUN_DOT[r.status]} dot>
            {r.status}
          </Chip>
          <span className="ml-auto shrink-0">
            <CopyButton text={r.id} label="Run id" size="sm" />
          </span>
        </div>
        <div className="mt-2 truncate text-[12.5px] text-fg">{r.name}</div>
        <div className="nums mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-fg-muted">
          <span>{r.last_step.toLocaleString()} steps</span>
          <span>{ran}</span>
          <span>started {dayClock(r.started_at)}</span>
        </div>
        {/* No deep link: this screen cannot navigate — `App.tsx` renders
            `<ResearchScreen />` with no props and owns the nav state. Saying
            where the charts are beats a button that cannot work. */}
        <div className="mt-1.5 text-[10.5px] text-fg-muted">
          Its loss curve, GPU trace and events are in brain → Train.
        </div>
      </div>
    );
  }

  if (link.state === "checking") {
    return (
      <div
        className="flex items-center gap-2 rounded-sm border-[0.5px] px-3 py-2 text-[11.5px]"
        style={{
          borderColor: "color-mix(in srgb, var(--color-info) 35%, transparent)",
          color: "var(--color-info)",
        }}
      >
        <Search size={12} aria-hidden className="animate-pulse" />
        <span>
          Asking the hub about <span className="nums">{link.runId}</span>…
        </span>
      </div>
    );
  }

  if (link.state === "missing") {
    return (
      <div
        className="rounded-sm border-[0.5px] px-3 py-2.5"
        style={{
          borderColor: "color-mix(in srgb, var(--color-bad) 40%, transparent)",
          background: "color-mix(in srgb, var(--color-bad) 8%, transparent)",
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Link2Off size={12} aria-hidden style={{ color: "var(--color-bad)" }} />
          <span className="label" style={{ color: "var(--color-bad)" }}>
            Linked to a run that no longer exists
          </span>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-dim">
          The hub was asked for <span className="nums">{link.runId}</span> and answered that it has
          no such run — deleted, or the database was rebuilt. The evidence this experiment points at
          is gone; the experiment is not.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<Pencil size={12} aria-hidden />} onClick={onEdit}>
            Correct the id
          </Button>
          <Button size="sm" variant="ghost" icon={<Unlink size={12} aria-hidden />} onClick={onUnlink}>
            Clear the link
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-sm border-[0.5px] px-3 py-2.5"
      style={{
        borderColor: "color-mix(in srgb, var(--color-warn) 40%, transparent)",
        background: "color-mix(in srgb, var(--color-warn) 8%, transparent)",
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ServerCrash size={12} aria-hidden style={{ color: "var(--color-warn)" }} />
        <span className="label" style={{ color: "var(--color-warn)" }}>
          Can&apos;t check this link
        </span>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-dim">
        <span className="nums">{link.runId}</span> is set, but {link.detail}. This is{" "}
        <em>not</em> the same as the run being gone — the link may be perfectly good and the box
        simply unreachable. Nothing here has been changed.
      </p>
      <div className="mt-2">
        <Button size="sm" variant="ghost" icon={<RefreshCw size={12} aria-hidden />} onClick={onRetry}>
          Ask again
        </Button>
      </div>
    </div>
  );
}

/* ── the form ──────────────────────────────────────────────────────────── */

function experimentFields(projects: readonly Project[]): FormField[] {
  return [
    { key: "name", label: "Name", required: true, full: true },
    {
      key: "hypothesis",
      label: "Hypothesis — what you expect to happen, written before",
      type: "textarea",
      full: true,
    },
    {
      key: "status",
      label: "Status",
      type: "select",
      required: true,
      defaultValue: "planned",
      options: (["planned", "running", "done", "abandoned"] as const).map((s) => ({
        value: s,
        label: STATUS_META[s].label,
      })),
    },
    {
      key: "runId",
      label: "trainwatch run id — empty if this was not a training run",
      placeholder: "e.g. 2026-09-14-gpt-sweep-3",
    },
    { key: "started", label: "Started", type: "date" },
    { key: "ended", label: "Ended", type: "date" },
    {
      key: "result",
      label: "Result — what actually happened",
      type: "textarea",
      full: true,
    },
    {
      key: "projectId",
      label: "Banked into a project",
      type: "select",
      // Not `required`, so `FormModal` renders its own "—" option for "none".
      options: byId(projects).map((p) => ({ value: p.id, label: p.name })),
      full: true,
    },
  ];
}

const toExperiment = (v: FormValues): Omit<Experiment, "id"> => ({
  name: String(v.name),
  hypothesis: String(v.hypothesis),
  status: String(v.status) as ExperimentStatus,
  // `""` is the empty date input; the model says `ISODate | null`, and storing
  // `""` where `null` is meant makes "no date" two different values that every
  // reader has to handle.
  started: String(v.started) || null,
  ended: String(v.ended) || null,
  runId: String(v.runId).trim(),
  result: String(v.result),
  projectId: String(v.projectId) || null,
});

/* ── one experiment ───────────────────────────────────────────────────── */

function ExperimentCard({
  exp,
  link,
  projects,
  finding,
  onRetry,
}: {
  exp: Experiment;
  link: RunLink;
  projects: readonly Project[];
  finding: Finding | undefined;
  onRetry: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const meta = STATUS_META[exp.status];
  const project = exp.projectId ? projects.find((p) => p.id === exp.projectId) : undefined;
  const unwritten = isUnwritten(exp);

  return (
    <Card className="p-5" active accent={meta.tone}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="display text-[16px] leading-tight text-fg">{exp.name || "Untitled"}</div>
          <div className="nums mt-1 flex flex-wrap gap-x-2.5 text-[10.5px] text-fg-muted">
            {exp.started && <span>{exp.started}</span>}
            {exp.ended && <span>→ {exp.ended}</span>}
            {!exp.started && !exp.ended && <span>no dates</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Chip color={meta.tone}>{meta.label}</Chip>
          <IconButton icon={<Pencil size={12} />} label="Edit experiment" onClick={() => setEditing(true)} />
          <IconButton
            icon={<Trash2 size={12} />}
            label="Delete experiment"
            danger
            onClick={() => setDeleting(true)}
          />
        </div>
      </div>

      {exp.hypothesis && (
        <div className="mt-3">
          <div className="label mb-1">Hypothesis</div>
          <p className="text-[12.5px] leading-relaxed text-fg-dim">{exp.hypothesis}</p>
        </div>
      )}

      <div className="mt-3">
        <div className="label mb-1">Result</div>
        {exp.result ? (
          <p className="text-[12.5px] leading-relaxed text-fg-dim">{exp.result}</p>
        ) : unwritten ? (
          // `result` is documented as "the point of the record". Done with
          // nothing written is the notebook failure this domain replaces, so
          // it says so instead of rendering a blank line.
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-warn)" }}>
            Marked done with nothing written down. The run happened; what you learned did not
            survive it.
          </p>
        ) : (
          <p className="text-[12px] text-fg-muted">Not yet — it has not finished.</p>
        )}
      </div>

      <div className="mt-4">
        <RunLinkBlock
          link={link}
          onRetry={onRetry}
          onUnlink={() => research.unlinkRun(exp.id)}
          onEdit={() => setEditing(true)}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t-[0.5px] border-line pt-3 text-[11px]">
        <span className="label">Banked into</span>
        {project ? (
          <span className="text-fg-dim">{project.name}</span>
        ) : finding ? (
          // The reconciler's own sentence, verbatim. Recomputing "is this
          // project still there?" locally would be a second implementation of
          // a check `lib/sync/reconcile.ts` already owns, free to disagree
          // with it.
          <span className="flex items-start gap-1.5" style={{ color: "var(--color-bad)" }}>
            <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0" />
            <span className="leading-relaxed">{finding.message}</span>
          </span>
        ) : (
          <span className="text-fg-muted">no project</span>
        )}
      </div>

      {editing && (
        <FormModal
          title="Edit experiment"
          initial={{
            name: exp.name,
            hypothesis: exp.hypothesis,
            status: exp.status,
            runId: exp.runId,
            started: exp.started ?? "",
            ended: exp.ended ?? "",
            result: exp.result,
            projectId: exp.projectId ?? "",
          }}
          fields={experimentFields(projects)}
          onSubmit={(v) => research.edit(exp.id, toExperiment(v))}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete experiment"
          message={`Delete "${exp.name}"? The run it names lives on the hub and is not touched, but the hypothesis and the result are only here.`}
          onConfirm={() => research.del(exp.id)}
          onClose={() => setDeleting(false)}
        />
      )}
    </Card>
  );
}

/* ── the tab ───────────────────────────────────────────────────────────── */

export function Experiments({
  data,
  ctx,
  findings,
  pending,
  hub,
  onRetry,
}: {
  data: NexusData;
  ctx: RunLinkContext;
  /** Keyed by experiment id. From `reconcile`, never recomputed here. */
  findings: ReadonlyMap<string, Finding>;
  pending: number;
  hub: HubReach;
  onRetry: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState(false);

  // Ascending id — the only total order these records have. `started` is
  // nullable, so it cannot be the sort key; see `runlink.tsx`.
  const experiments = byId(data.research.experiments);
  const links = experiments.map((e) => resolveRunLink(e.runId, ctx));
  const t = linkTally(links);

  const rows = experiments
    .map((exp, i) => ({ exp, link: links[i]! }))
    .filter(({ exp, link }) => {
      if (filter === "all") return true;
      if (filter === "unlinked") return link.state === "none";
      if (filter === "broken") return link.state === "missing";
      return exp.status === filter;
    });

  return (
    <div className="flex flex-col gap-4 pt-5">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          New experiment
        </Button>
      </div>

      <StatBand
        items={[
          { label: "Experiments", value: t.total },
          {
            label: "Joined to a run",
            value: t.linked,
            sub: "evidence you can open",
            color: "var(--color-good)",
          },
          {
            label: "No run linked",
            value: t.none,
            sub: "not training runs",
            color: "var(--color-fg-muted)",
          },
          {
            label: "Broken links",
            value: t.missing,
            sub: t.unreachable > 0 ? `${t.unreachable} unverifiable` : "hub says no such run",
            color: t.missing > 0 ? "var(--color-bad)" : "var(--color-fg-muted)",
          },
        ]}
      />

      {/* The hub being unreachable is its own state, said once at the top
          rather than implied by every card. Critically it is NOT rendered as
          "no runs": that would turn a network outage into a data problem.

          `hub === "unreachable"`, never `!== "reachable"`. This banner is a
          verdict, and during the `connecting` window there is no verdict to
          state — the earlier version tested a boolean that folded
          `connecting` in with `offline`, so it announced an unreachable hub on
          every first mount, including against a hub answering 200. The
          `asking` state gets the spinner below instead. */}
      {hub === "unreachable" && (
        <Callout
          icon={<ServerCrash size={12} aria-hidden />}
          label="The hub is unreachable — run links cannot be checked"
          tone="var(--color-warn)"
          actions={
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} aria-hidden />} onClick={onRetry}>
              Retry
            </Button>
          }
        >
          Runs live in the hub&apos;s own tables, not in the synced vault, so nothing local can
          resolve a run id. Every experiment below still shows its own id and its own notes — what
          is missing is the verdict on whether the run is still there, and that absence is not
          evidence that it is gone.
        </Callout>
      )}

      {/* The `connecting` window, and the only place on this screen where a
          spinner is honest: `api.ts` guarantees `connection` leaves
          `connecting` for `live` or `offline` and does not sit here, so this
          state resolves on its own. It says what it is waiting for rather
          than spinning anonymously. */}
      {hub === "asking" && (
        <div className="flex items-center gap-2 text-[11px] text-fg-muted">
          <CircleDashed size={12} aria-hidden className="animate-pulse" />
          Connecting to the hub — run links are not checked yet. Nothing below has been judged.
        </div>
      )}

      {hub === "reachable" && pending > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-fg-muted">
          <CircleDashed size={12} aria-hidden className="animate-pulse" />
          Checking {pending} run {pending === 1 ? "id" : "ids"} against the hub — the live snapshot
          only carries the 25 most recent runs.
        </div>
      )}

      {/* Five segments overflow a 375px phone, and `SegmentedControl` is an
          `inline-flex` with no scroll of its own. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <SegmentedControl
          className="min-w-max"
          options={FILTERS}
          value={filter}
          onChange={(id) => setFilter(id as Filter)}
        />
      </div>

      {experiments.length === 0 ? (
        <EmptyState
          icon={<FlaskConical size={22} strokeWidth={1.6} aria-hidden />}
          title="No experiments"
          hint="An experiment is a hypothesis written before the run, a run id, and what actually happened. The run id is what makes this a record rather than a notebook."
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              New experiment
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <Card className="px-4 py-6 text-center text-[12px] text-fg-muted">
          No experiments match this filter.
        </Card>
      ) : (
        <Stagger className="flex flex-col gap-3">
          {rows.map(({ exp, link }) => (
            <Reveal key={exp.id}>
              <ExperimentCard
                exp={exp}
                link={link}
                projects={data.projects}
                finding={findings.get(exp.id)}
                onRetry={onRetry}
              />
            </Reveal>
          ))}
        </Stagger>
      )}

      {adding && (
        <FormModal
          title="New experiment"
          fields={experimentFields(data.projects).map((f) =>
            f.key === "started" ? { ...f, defaultValue: todayStr() } : f,
          )}
          onSubmit={(v) => research.add(toExperiment(v))}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
