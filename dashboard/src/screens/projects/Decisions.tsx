import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Chip, FormModal, IconButton, type FormField } from "@/components/ui";
import { useProjects } from "@/store/projects";
import { todayStr } from "@/lib/nexus/format";
import type { Decision, Project } from "@/lib/nexus/types";
import { decisionTone, orderDecisions } from "./ordering";

const STATUSES = ["Proposed", "Accepted", "Superseded"] as const;

const FIELDS: FormField[] = [
  { key: "title", label: "Title", required: true, full: true, placeholder: "Use Zustand for state" },
  {
    key: "status",
    label: "Status",
    type: "select",
    required: true,
    options: STATUSES.map((s) => ({ value: s, label: s })),
  },
  { key: "date", label: "Date", type: "date" },
  { key: "context", label: "Context", type: "textarea", full: true },
  { key: "decision", label: "Decision", type: "textarea", full: true },
  { key: "consequences", label: "Consequences", type: "textarea", full: true },
];

/**
 * Architecture Decision Records, newest first — `date` descending, `id`
 * descending to break a tie, for the same reason as releases.
 *
 * The edit control is new. nexus rendered an ADR as immutable and yet the
 * store has always had `editDecision`: a decision's whole life is
 * Proposed → Accepted → Superseded, and without an edit the only way to
 * advance one was to delete it and lose its context. The write it needs
 * already existed; nothing was wired to it.
 */
export function Decisions({ project: p }: { project: Project }) {
  const { addDecision, editDecision, delDecision } = useProjects();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const decisions = p.decisions ?? [];
  const editing = decisions.find((d) => d.id === editingId) ?? null;

  const patch = (v: Record<string, string | number | boolean>) => ({
    title: String(v.title),
    status: String(v.status),
    date: String(v.date),
    context: String(v.context),
    decision: String(v.decision),
    consequences: String(v.consequences),
  });

  return (
    <div>
      <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
        Add decision
      </Button>

      {decisions.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
          No decisions recorded. The ones worth writing down are the ones you will be asked to
          justify later.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {orderDecisions(decisions).map((dec) => (
            <article key={dec.id} className="rounded-sm border-[0.5px] border-line p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Chip color={decisionTone(dec.status)}>{dec.status}</Chip>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{dec.title}</span>
                <span className="nums shrink-0 text-[10.5px] text-fg-muted">
                  {dec.date || "undated"}
                </span>
                <IconButton
                  icon={<Pencil size={11} />}
                  label={`Edit ${dec.title}`}
                  onClick={() => setEditingId(dec.id)}
                />
                <IconButton
                  icon={<Trash2 size={11} />}
                  label={`Delete ${dec.title}`}
                  danger
                  onClick={() => delDecision(p.id, dec.id)}
                />
              </div>
              <Body dec={dec} />
            </article>
          ))}
        </div>
      )}

      {adding && (
        <FormModal
          title="New decision (ADR)"
          fields={FIELDS.map((f) =>
            f.key === "status"
              ? { ...f, defaultValue: "Accepted" }
              : f.key === "date"
                ? { ...f, defaultValue: todayStr() }
                : f,
          )}
          onSubmit={(v) => addDecision(p.id, patch(v))}
          onClose={() => setAdding(false)}
        />
      )}

      {editing && (
        <FormModal
          title="Edit decision"
          /* Spelled out rather than passing the record: `initial` takes a
             `Record<string, unknown>`, and an interface has no implicit index
             signature — `id` has no field to seed anyway. */
          initial={{
            title: editing.title,
            status: editing.status,
            date: editing.date,
            context: editing.context,
            decision: editing.decision,
            consequences: editing.consequences,
          }}
          fields={FIELDS}
          onSubmit={(v) => editDecision(p.id, editing.id, patch(v))}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

/** The three prose fields. Each is optional in practice — an ADR written in a
 *  hurry is a title and a status, and a blank paragraph is not an error. */
function Body({ dec }: { dec: Decision }) {
  const rows: Array<[string, string]> = [
    ["Context", dec.context],
    ["Decision", dec.decision],
    ["Consequences", dec.consequences],
  ];
  return (
    <>
      {rows.map(([label, text]) =>
        text ? (
          <p key={label} className="mt-1.5 text-[11.5px] leading-relaxed text-fg-dim">
            <span className="label">{label} · </span>
            {text}
          </p>
        ) : null,
      )}
    </>
  );
}
