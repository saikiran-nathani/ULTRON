import { useMemo, useState } from "react";
import { Card, Chip, ProgressBar, inputCls } from "@/components/ui";
import { fmtDuration } from "@/lib/nexus/format";
import { PROJECT_STATUSES } from "@/lib/nexus/constants";
import type { Project } from "@/lib/nexus/types";
import {
  filterSortProjects,
  priorityTone,
  statusTone,
  taskProgress,
  totalMinutes,
  type ProjectSort,
} from "./ordering";

/** The master column: filter, sort, and one compact card per project. */
export function ProjectsList({
  list,
  selectedId,
  onSelect,
}: {
  list: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("All");
  const [sort, setSort] = useState<ProjectSort>("recent");

  const filtered = useMemo(() => filterSortProjects(list, { q, status, sort }), [list, q, status, sort]);

  return (
    <div className="flex flex-col gap-2">
      <input
        className={inputCls}
        placeholder="Filter projects…"
        aria-label="Filter projects by name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="flex gap-2">
        <select
          className={inputCls + " py-1 text-[11px]"}
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="All">All statuses</option>
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className={inputCls + " py-1 text-[11px]"}
          aria-label="Sort projects"
          value={sort}
          onChange={(e) => setSort(e.target.value as ProjectSort)}
        >
          <option value="recent">Recent activity</option>
          <option value="name">Name</option>
          <option value="priority">Priority</option>
        </select>
      </div>

      {/* A filter that matches nothing is not an empty screen: the data is
          there, the query is wrong, and saying so is the difference between
          "try another word" and "add a project". */}
      {filtered.length === 0 ? (
        <p className="rounded-sm border-[0.5px] border-dashed border-line px-3 py-4 text-[12px] text-fg-muted">
          No project matches{q.trim() ? ` “${q.trim()}”` : ""}
          {status === "All" ? "" : ` in ${status}`}.
        </p>
      ) : (
        filtered.map((p) => {
          const tasks = taskProgress(p);
          const mins = totalMinutes(p);
          const selected = p.id === selectedId;
          return (
            <Card
              key={p.id}
              interactive
              active={selected}
              onClick={() => onSelect(p.id)}
              /* `Card` is a div. nexus stopped at `onClick`, which makes this
                 a control a mouse and a finger can use and a keyboard cannot
                 — and one VoiceOver reads out as static text. The kit's own
                 `StatBand` carries the fix; this is the same three lines. */
              role="button"
              tabIndex={0}
              aria-current={selected}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(p.id);
                }
              }}
              className="p-3 pointer-coarse:min-h-[44px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] text-fg">{p.name}</span>
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: statusTone(p.status) }}
                  title={p.status}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Chip color={priorityTone(p.priority)}>{p.priority}</Chip>
                {mins > 0 && <span className="nums text-[10px] text-fg-muted">{fmtDuration(mins)}</span>}
              </div>
              {tasks.total > 0 && (
                <div className="mt-2 flex items-center gap-2">
                  <ProgressBar value={tasks.pct} />
                  <span className="nums shrink-0 text-[10px] text-fg-muted">
                    {tasks.done}/{tasks.total}
                  </span>
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
