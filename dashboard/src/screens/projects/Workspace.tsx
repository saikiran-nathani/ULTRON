import { useState } from "react";
import { ClipboardList, ExternalLink, ListTodo, Plug } from "lucide-react";
import { Button, Card, CopyButton, EmptyState } from "@/components/ui";
import { fmtDuration, toDayStr } from "@/lib/nexus/format";
import type { Project } from "@/lib/nexus/types";
import {
  buildStandup,
  declaredPorts,
  filterSortProjects,
  orderTasks,
  priorityTone,
  rollup,
} from "./ordering";

/**
 * The cross-project view — what nexus called the developer workspace.
 *
 * Three of its four panels were Tauri and did not cross:
 *
 * - **Ship log** read `git log` out of each project's directory through a Rust
 *   command. A browser cannot read a directory it was not handed, and this
 *   app is served from a training box that has none of these repos.
 * - **Running dev servers** probed localhost with a raw socket. `fetch` to a
 *   closed port and `fetch` to a port that refuses CORS are the same failure,
 *   so a liveness dot here would be a coin flip drawn as a fact.
 * - **Standup** drew half its body from those commits.
 *
 * What is left is the half that was always the store's: what you finished,
 * what is next, and the ports and links you wrote down. The standup is
 * generated from `timeLog`, `doneAt` and the open tasks — no commits, and it
 * says so rather than rendering an empty "Commits" heading forever.
 */
export function Workspace({ list, onOpen }: { list: Project[]; onOpen: (id: string) => void }) {
  const [standup, setStandup] = useState<string | null>(null);
  const totals = rollup(list);
  const ports = declaredPorts(list);

  if (list.length === 0) {
    return (
      <div className="pt-4">
        <EmptyState
          icon={<ClipboardList size={22} strokeWidth={1.6} />}
          title="Nothing to roll up yet"
          hint="The workspace summarises across projects — a standup draft, what is next, and the ports and links your runbooks declare. Add a project first."
        />
      </div>
    );
  }

  const generate = () => {
    const since = new Date(Date.now() - 86400000);
    setStandup(
      buildStandup(list, { sinceISO: since.toISOString(), sinceDate: toDayStr(since) }),
    );
  };

  return (
    <div className="grid grid-cols-1 gap-4 pt-4 md:grid-cols-2">
      {/* Standup */}
      <Card className="p-5" active>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="label flex items-center gap-1.5">
            <ClipboardList size={12} aria-hidden /> Standup · last 24h
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={generate}>
              {standup === null ? "Generate" : "Regenerate"}
            </Button>
            {standup !== null && <CopyButton text={standup} size="sm" label="Copy" />}
          </div>
        </div>
        {standup === null ? (
          <p className="text-[12px] leading-relaxed text-fg-muted">
            A draft from the last 24 hours: tasks and milestones you closed, time you logged, and
            the next open task on each project. No commits — there is no git on this side of the
            port.
          </p>
        ) : (
          <pre className="whitespace-pre-wrap rounded-sm border-[0.5px] border-line bg-bg p-3 text-[12px] leading-relaxed text-fg-dim">
            {standup}
          </pre>
        )}
      </Card>

      {/* What's next */}
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="label flex items-center gap-1.5">
            <ListTodo size={12} aria-hidden /> Next up
          </div>
          <span className="nums text-[10.5px] text-fg-muted">
            {totals.openTasks} open · {fmtDuration(totals.minutes)} logged
          </span>
        </div>
        {totals.openTasks === 0 ? (
          <p className="text-[12px] leading-relaxed text-fg-muted">
            Every task on every project is done. Either you are finished or the list is out of
            date.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {filterSortProjects(list, { sort: "priority" }).map((p) => {
              const next = orderTasks([...p.tasks]).find((t) => !t.done);
              if (!next) return null;
              const open = p.tasks.filter((t) => !t.done).length;
              return (
                <button
                  key={p.id}
                  onClick={() => onOpen(p.id)}
                  className="flex items-center gap-2 rounded-sm px-1 text-left transition-colors hover:bg-card-hover pointer-coarse:min-h-[44px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: priorityTone(next.priority) }}
                    title={`${next.priority} priority`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg-dim">
                    <span className="text-fg-muted">{p.name} · </span>
                    {next.name}
                  </span>
                  <span className="nums shrink-0 text-[10.5px] text-fg-muted">{open}</span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {/* Declared ports */}
      <Card className="p-5 md:col-span-2">
        <div className="label mb-3 flex items-center gap-1.5">
          <Plug size={12} aria-hidden /> Declared ports
        </div>
        {ports.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-fg-muted">
            No runbook declares a port yet. These are the ones you wrote down, not the ones that
            are listening — nothing here has checked.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ports.map((pt) => (
              <a
                key={`${pt.projectId}:${pt.port}`}
                href={`http://localhost:${pt.port}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-sm border-[0.5px] border-line bg-card px-3 py-1.5 text-[12px] text-accent-lt transition-colors hover:border-line-active hover:bg-card-hover pointer-coarse:min-h-[44px]"
              >
                <span className="nums">localhost:{pt.port}</span>
                <span className="text-fg-muted">{pt.projectName}</span>
                <ExternalLink size={11} aria-hidden />
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
