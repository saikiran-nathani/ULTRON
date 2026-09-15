/**
 * The reading list, which is the paper list.
 *
 * `READING_TYPES` gained `"Paper"` for this screen, and `constants.ts` is
 * explicit about why it is one list and not two:
 *
 * > Widening the union rather than creating a second list, because a paper
 * > queued to read is a reading-list item in every respect that matters — and
 * > two lists would mean deciding, every time, which of them a thing belongs
 * > in.
 *
 * So the whole list lives here, with papers ordered first, rather than being
 * filtered down to `type === "Paper"`. That also gives the non-paper items
 * somewhere to be: `config/nav.ts` removed Journal as a screen, and the
 * reading list is one of the two pieces of it that had to land somewhere.
 *
 * Writes go through the existing `journal` slice — `addReading`,
 * `editReading`, `delReading` — because the reading list is journal data that
 * this screen happens to render, not research data that needs a new slice.
 */
import { useState } from "react";
import { BookOpen, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  FormModal,
  IconButton,
  SegmentedControl,
  StatBand,
  inputCls,
  type FormField,
  type FormValues,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import {
  READING_STATUSES,
  READING_TYPES,
  type ReadingStatus,
  type ReadingType,
} from "@/lib/nexus/constants";
import type { Journal, ReadingItem } from "@/lib/nexus/types";
import { journal } from "@/store/journal";
import { orderReading } from "./runlink";

const STATUS_TONE: Record<ReadingStatus, string> = {
  Queue: "var(--color-neutral-100)",
  Reading: "var(--color-info)",
  Done: "var(--color-good)",
  Paused: "var(--color-warn)",
};

/** A paper is the point of this tab, so it is the one type with an accent. */
const typeTone = (t: ReadingType) =>
  t === "Paper" ? "var(--color-accent-lt)" : "var(--color-neutral-100)";

const FIELDS: FormField[] = [
  { key: "title", label: "Title", required: true, full: true },
  { key: "author", label: "Author" },
  {
    key: "type",
    label: "Type",
    type: "select",
    required: true,
    defaultValue: "Paper",
    options: READING_TYPES.map((t) => ({ value: t, label: t })),
  },
  {
    key: "status",
    label: "Status",
    type: "select",
    required: true,
    defaultValue: "Queue",
    options: READING_STATUSES.map((s) => ({ value: s, label: s })),
  },
  { key: "url", label: "Link — arXiv, DOI, anywhere", full: true },
  {
    key: "notes",
    label: "Notes — what it changed about what you were going to do",
    type: "textarea",
    full: true,
  },
];

const toItem = (v: FormValues): Omit<ReadingItem, "id"> => ({
  title: String(v.title),
  author: String(v.author),
  type: String(v.type) as ReadingType,
  status: String(v.status) as ReadingStatus,
  url: String(v.url),
  notes: String(v.notes),
});

function ReadingCard({ item }: { item: ReadingItem }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <Card className="p-4" active={item.status === "Done"} accent={STATUS_TONE[item.status]}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] leading-snug text-fg">{item.title || "Untitled"}</div>
          <div className="mt-0.5 truncate text-[11px] text-fg-muted">{item.author || "—"}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Chip color={typeTone(item.type)}>{item.type}</Chip>
          {item.url && (
            <IconButton
              icon={<ExternalLink size={12} />}
              label={`Open ${item.title}`}
              onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}
            />
          )}
          <IconButton icon={<Pencil size={12} />} label="Edit item" onClick={() => setEditing(true)} />
          <IconButton
            icon={<Trash2 size={12} />}
            label="Delete item"
            danger
            onClick={() => setDeleting(true)}
          />
        </div>
      </div>

      {item.notes && (
        <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">{item.notes}</p>
      )}

      {/* The one control used weekly, so it is the platform picker rather than
          a menu — the best touch target available, and `inputCls` already
          carries the 44px floor and the 16px iOS anti-zoom size. */}
      <label className="mt-2.5 block">
        <span className="sr-only">Reading status for {item.title}</span>
        <select
          className={inputCls + " py-1 text-[11px]"}
          value={item.status}
          onChange={(e) => journal.editReading(item.id, { status: e.target.value as ReadingStatus })}
        >
          {READING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {editing && (
        <FormModal
          title="Edit reading item"
          initial={{ ...item }}
          fields={FIELDS}
          onSubmit={(v) => journal.editReading(item.id, toItem(v))}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete reading item"
          message={`Delete "${item.title}"? Its notes go with it.`}
          onConfirm={() => journal.delReading(item.id)}
          onClose={() => setDeleting(false)}
        />
      )}
    </Card>
  );
}

type Filter = "all" | ReadingStatus;

export function Papers({ data }: { data: Journal }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState(false);

  // Papers first, then everything else, each block by id — never array order,
  // which per-record sync rebuilds on every pull.
  const items = orderReading(data.readingList);
  const papers = items.filter((i) => i.type === "Paper").length;
  const count = (s: ReadingStatus) => items.filter((i) => i.status === s).length;

  const shown = filter === "all" ? items : items.filter((i) => i.status === filter);

  return (
    <div className="flex flex-col gap-4 pt-5">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          Add to the list
        </Button>
      </div>

      <StatBand
        items={[
          { label: "Papers", value: papers, sub: `of ${items.length} items`, color: "var(--color-accent-lt)" },
          { label: "Reading", value: count("Reading"), color: "var(--color-info)" },
          { label: "Queued", value: count("Queue") },
          { label: "Done", value: count("Done"), color: "var(--color-good)" },
        ]}
      />

      {/* Five segments overflow a 375px phone, and `SegmentedControl` is an
          `inline-flex` with no scroll of its own. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <SegmentedControl
          className="min-w-max"
          options={[
            { id: "all", label: "All" },
            ...READING_STATUSES.map((s) => ({ id: s, label: s })),
          ]}
          value={filter}
          onChange={(id) => setFilter(id as Filter)}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={22} strokeWidth={1.6} aria-hidden />}
          title="Nothing to read yet"
          hint="Papers belong to the research track, so the reading list lives here. Queue one and the notes you take on it stay next to the experiments it changed."
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              Add to the list
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <Card className="px-4 py-6 text-center text-[12px] text-fg-muted">
          Nothing is {filter === "all" ? "listed" : filter.toLowerCase()}.
        </Card>
      ) : (
        <Stagger className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {shown.map((i) => (
            <Reveal key={i.id}>
              <ReadingCard item={i} />
            </Reveal>
          ))}
        </Stagger>
      )}

      {adding && (
        <FormModal
          title="Add to the reading list"
          fields={FIELDS}
          onSubmit={(v) => journal.addReading(toItem(v))}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
