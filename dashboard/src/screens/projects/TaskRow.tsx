import { useState } from "react";
import { Check, ChevronDown, ChevronUp, Paperclip, Pencil, StickyNote, Trash2 } from "lucide-react";
import { FormModal, IconButton, inputCls, type FormField } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useProjects } from "@/store/projects";
import { PRIORITIES } from "@/lib/nexus/constants";
import type { Attachment, ProjectTask } from "@/lib/nexus/types";
import { fmtBytes, priorityTone } from "./ordering";

const TASK_FIELDS: FormField[] = [
  { key: "name", label: "Name", required: true, full: true },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    required: true,
    options: PRIORITIES.map((p) => ({ value: p, label: p })),
  },
];

/**
 * One task: a checkbox, a name, and five controls.
 *
 * `index`/`total` come from `taskPositions`, which builds them from the
 * store's own `orderTasks`. They are not the position of the task in
 * `p.tasks` and must never be — see the note on `taskPositions`.
 */
export function TaskRow({
  pid,
  task,
  index,
  total,
  canUp,
  canDown,
}: {
  pid: string;
  task: ProjectTask;
  index: number;
  total: number;
  canUp: boolean;
  canDown: boolean;
}) {
  const { toggleTask, editTask, delTask, moveTask, updateTaskNotes } = useProjects();
  const [editing, setEditing] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  return (
    <div className="rounded-sm px-1 py-1 transition-colors hover:bg-card-hover">
      <div className="group flex flex-wrap items-center gap-2">
        <button
          onClick={() => toggleTask(pid, task.id)}
          aria-pressed={task.done}
          className="flex flex-1 items-center gap-2 text-left pointer-coarse:min-h-[44px]"
        >
          <span
            className={cn(
              "grid h-4 w-4 shrink-0 place-items-center rounded-xs border transition-all",
              task.done ? "border-accent bg-accent text-bg" : "border-line-active",
            )}
          >
            {task.done && <Check size={11} strokeWidth={3} aria-hidden />}
          </span>
          <span className={cn("text-[12.5px]", task.done ? "text-fg-muted line-through" : "text-fg-dim")}>
            {task.name}
          </span>
          {/* Where this row sits, for anyone who cannot see the list. The
              reorder buttons below are meaningless without it — "move up"
              from where? `sr-only` is hidden at every width, so no layout
              anywhere changes. */}
          <span className="sr-only">
            , task {index + 1} of {total}
          </span>
        </button>
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: priorityTone(task.priority) }}
          title={`${task.priority} priority`}
        />
        {/*
          Reorder / notes / edit / delete are this row's only controls. Dimmed
          at rest on a pointer, never hidden — and at full strength on a coarse
          pointer, where there is no hover to brighten them and where
          `IconButton` has already drawn each one a resting surface.

          `basis-full` drops the group onto its own line on a narrow screen:
          five 44px buttons need 220px, which a 375px row cannot spare without
          squeezing the task name to nothing. `md:basis-auto` restores the
          single desktop row, unchanged.
        */}
        <div className="flex shrink-0 basis-full items-center justify-end opacity-50 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 md:basis-auto">
          {/*
            The whole of reordering, and deliberately so: two buttons, no
            drag. A long-press drag on a touch screen competes with the
            scroll that gets you to the task in the first place, and a
            mouse-only drag handle is a reorder the phone and the iPad cannot
            perform at all. These are 44px on a coarse pointer (IconButton's
            floor), they work from the keyboard, and each press is one
            `sort` write rather than a rewritten array.

            `disabled` rather than nexus's `pointer-events-none opacity-30`:
            the same dimmed look, but the end-of-list button also leaves the
            tab order and announces itself as unavailable.
          */}
          <IconButton
            icon={<ChevronUp size={12} />}
            label="Move up"
            disabled={!canUp}
            onClick={() => moveTask(pid, index, index - 1)}
            className={canUp ? "" : "opacity-30"}
          />
          <IconButton
            icon={<ChevronDown size={12} />}
            label="Move down"
            disabled={!canDown}
            onClick={() => moveTask(pid, index, index + 1)}
            className={canDown ? "" : "opacity-30"}
          />
          <IconButton
            icon={<StickyNote size={12} />}
            label={showNotes ? "Hide notes" : task.notes ? "Notes" : "Add notes"}
            onClick={() => setShowNotes((v) => !v)}
            className={task.notes ? "text-accent-lt" : ""}
          />
          <IconButton icon={<Pencil size={12} />} label="Edit task" onClick={() => setEditing(true)} />
          <IconButton
            icon={<Trash2 size={12} />}
            label="Delete task"
            danger
            onClick={() => delTask(pid, task.id)}
          />
        </div>
      </div>

      {(task.attachments.length > 0 || showNotes) && (
        <div className="ml-6 mt-1.5 flex flex-col gap-2">
          {task.attachments.length > 0 && (
            <div className="flex flex-col gap-1">
              {task.attachments.map((a) => (
                <AttachmentRow key={a.stored_name} pid={pid} taskId={task.id} att={a} />
              ))}
            </div>
          )}
          {showNotes && (
            <textarea
              className={inputCls + " min-h-[60px] resize-y"}
              placeholder="Task notes…"
              aria-label="Task notes"
              defaultValue={task.notes}
              onBlur={(e) => updateTaskNotes(pid, task.id, e.target.value)}
            />
          )}
        </div>
      )}

      {editing && (
        <FormModal
          title="Edit task"
          initial={{ name: task.name, priority: task.priority }}
          fields={TASK_FIELDS}
          onSubmit={(v) => editTask(pid, task.id, { name: String(v.name), priority: String(v.priority) })}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/**
 * An attachment, as the record that survived the port.
 *
 * nexus rendered these as openable thumbnails: `readAttachmentBase64` for the
 * image previews, `openFileExternal` to hand the file to the OS, and
 * `pickAndAttachFiles` to add more — three Tauri commands over a directory of
 * copied bytes on the Mac. None of that crossed. The *metadata* did, and it
 * syncs, so a row that quietly rendered a filename as if it were a file would
 * be the most convincing lie on this screen.
 *
 * So it says what it is: a record of a file that lives elsewhere. There is no
 * add control, because adding one would mint a metadata row pointing at
 * nothing. Removing is real — the record is the only thing that was ever
 * here to remove.
 */
function AttachmentRow({ pid, taskId, att }: { pid: string; taskId: string; att: Attachment }) {
  const { removeTaskAttachment } = useProjects();
  const name = att.name || att.original_name || att.stored_name;
  return (
    <div className="flex items-center gap-2 rounded-xs border-[0.5px] border-line bg-bg px-2 py-1">
      <Paperclip size={11} aria-hidden className="shrink-0 text-accent-dim" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-fg-dim" title={name}>
        {name}
      </span>
      <span className="nums shrink-0 text-[10.5px] text-fg-muted">{fmtBytes(att.size)}</span>
      <span className="shrink-0 text-[10px] text-fg-muted" title="Only the record of this file is in this app — the bytes stayed on the Mac.">
        record only
      </span>
      <IconButton
        icon={<Trash2 size={11} />}
        label={`Remove the record of ${name}`}
        danger
        onClick={() => removeTaskAttachment(pid, taskId, att.stored_name)}
      />
    </div>
  );
}
