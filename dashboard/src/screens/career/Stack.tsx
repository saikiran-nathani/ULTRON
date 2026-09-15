/**
 * The roadmap's stack half — layers, proficiency, and how they compose.
 *
 * Ported from nexus's `roadmap/Stack.tsx`, `roadmap/PipelineStrip.tsx` and
 * `roadmap/ProficiencyRadar.tsx`, folded into the Career screen with the
 * plan half.
 *
 * Touch fixes:
 *
 * - The radar's vertices were the 3.5px dots themselves, wrapped in a `<g>`
 *   with `cursor-pointer` and an `onClick`. That is unhittable with a thumb
 *   and invisible to a keyboard and to VoiceOver. Each vertex now carries a
 *   transparent 22-unit hit circle (~44px as rendered) and is a real
 *   `role="button"` with a tab stop and Enter/Space.
 * - Every `Section`'s edit control was `tap-44` + `group-hover/sec:opacity-100`.
 *   `tap-44` does not exist in this app's base layer, so it expanded to
 *   nothing and left an 11px glyph at 50% opacity as the only edit affordance.
 *   They are `IconButton`s now.
 * - The through-line's edit control: same.
 * - A resource link was a bare text button; it now takes a 44px floor.
 * - The pipeline strip's nodes had no minimum height.
 */
import { Fragment, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, ExternalLink, GitBranch, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  FormModal,
  IconButton,
  SegmentedControl,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { uid } from "@/lib/nexus/format";
import type {
  LayerResource,
  LayerToolGroup,
  Proficiency,
  Roadmap,
  RoadmapLayer,
} from "@/lib/nexus/types";
import { roadmap } from "@/store/roadmap";
import { byId } from "./order";
import { LEVELS, LEVEL_LABEL, LEVEL_TOKEN, radarModel } from "./radar";

const scrollToCard = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });

const tagColor = (tag: string) => {
  const t = tag.toLowerCase();
  if (t.includes("differentiator")) return "var(--color-accent-lt)";
  if (t.includes("flex")) return "var(--color-warn)";
  if (t.includes("gate")) return "var(--color-bad)";
  if (t.includes("foundation")) return "var(--color-neutral-100)";
  return "var(--color-info)";
};

const LAYER_FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "tag", label: "Tag (Differentiator / Flex / Gate / Foundation / Working knowledge)" },
  { key: "target", label: "Target", full: true },
  { key: "what", label: "What it is", type: "textarea" as const, full: true },
  { key: "role", label: "Role", type: "textarea" as const, full: true },
];

/* ── text ⇄ structure, so deep content stays editable through a textarea ──
   `uid()` rather than nexus's inline `Math.random().toString(36).slice(2)`.
   These records go through per-record sync, where the id is the identity and
   also the sort key — a bare random id carries no creation time, so a
   re-saved tool group would shuffle into hash order among its siblings. */
const toolsToText = (t: readonly LayerToolGroup[]) =>
  byId(t)
    .map((g) => `${g.group}: ${g.items.join("; ")}`)
    .join("\n");

const textToTools = (s: string): LayerToolGroup[] =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      const group = i >= 0 ? l.slice(0, i).trim() : l;
      const items = i >= 0 ? l.slice(i + 1).split(";").map((x) => x.trim()).filter(Boolean) : [];
      return { id: uid(), group, items };
    });

const resToText = (r: readonly LayerResource[]) =>
  byId(r)
    .map((x) => (x.url ? `${x.label} | ${x.url}` : x.label))
    .join("\n");

const textToRes = (s: string): LayerResource[] =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split("|").map((x) => x.trim());
      return { id: uid(), label: parts[0] ?? l, url: parts[1] ?? "" };
    });

const linesToArr = (s: string) =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

/* ── the radar ──────────────────────────────────────────────────────────── */

function ProficiencyRadar({
  layers,
  onSelect,
}: {
  layers: readonly RoadmapLayer[];
  onSelect: (id: string) => void;
}) {
  const m = radarModel(layers);
  if (!m) return null;

  return (
    <svg
      viewBox={`0 0 ${m.size} ${m.size}`}
      /* `overflow-visible` lets the axis labels paint outside the viewBox. In
         the desktop card they land in a 280px column with the rest of the
         panel to their right; once the grid collapses to one column the radar
         fills the width and the right-hand labels ran off a 375px viewport, so
         the box is capped below `md`. */
      className="h-auto w-full max-w-[230px] overflow-visible md:max-w-[300px]"
      role="group"
      aria-label="Layer proficiency"
    >
      {m.rings.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--color-line)" strokeWidth={0.5} />
      ))}
      {m.axes.map((a, i) => (
        <line
          key={i}
          x1={m.centre}
          y1={m.centre}
          x2={a.x}
          y2={a.y}
          stroke="var(--color-hairline)"
          strokeWidth={0.5}
        />
      ))}

      <motion.path
        d={m.polygon}
        fill="color-mix(in srgb, var(--color-accent) 18%, transparent)"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        style={{
          transformOrigin: "center",
          filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--color-accent) 45%, transparent))",
        }}
      />

      {m.vertices.map((v) => (
        <g
          key={v.id}
          role="button"
          tabIndex={0}
          aria-label={`${v.name} — ${LEVEL_LABEL[v.level]}. Jump to this layer.`}
          className="cursor-pointer"
          onClick={() => onSelect(v.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(v.id);
            }
          }}
        >
          {/* The actual target. `fill="transparent"` rather than
              `fill-opacity=0`: a zero-opacity fill still hit-tests in every
              browser, but `fill="none"` does not, and getting that backwards
              is what made the source's dots the only hittable area. */}
          <circle cx={v.vx} cy={v.vy} r={m.hit} fill="transparent" />
          <circle
            cx={v.vx}
            cy={v.vy}
            r={3.5}
            fill={LEVEL_TOKEN[v.level]}
            stroke="var(--color-bg)"
            strokeWidth={1}
          />
          <text
            x={v.lx}
            y={v.ly}
            textAnchor={v.anchor}
            dominantBaseline="middle"
            className="text-[8px] uppercase tracking-wider"
            style={{ fontFamily: "var(--font-body)", fill: "var(--color-fg-dim)" }}
          >
            {v.name.length > 16 ? v.name.slice(0, 15) + "…" : v.name}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ── the navigator ──────────────────────────────────────────────────────── */

function PipelineStrip({
  layers,
  onSelect,
}: {
  layers: readonly RoadmapLayer[];
  onSelect: (id: string) => void;
}) {
  const ordered = byId(layers);
  if (ordered.length === 0) return null;

  return (
    <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
      {ordered.map((l, i) => (
        <Fragment key={l.id}>
          {i > 0 && (
            <div aria-hidden className="flex shrink-0 items-center text-fg-muted">
              <ChevronRight size={13} />
            </div>
          )}
          <motion.button
            onClick={() => onSelect(l.id)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.04 * i, ease: [0.16, 1, 0.3, 1] }}
            className="group flex min-w-[92px] shrink-0 flex-col justify-between rounded-sm border-[0.5px] border-line bg-card-hover/60 px-2.5 py-2 text-left transition-colors hover:border-line-active pointer-coarse:min-h-[44px]"
            title={`${l.name} · ${LEVEL_LABEL[l.proficiency]}`}
          >
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: LEVEL_TOKEN[l.proficiency],
                  boxShadow: `0 0 6px ${LEVEL_TOKEN[l.proficiency]}`,
                }}
              />
              <span className="label text-accent-dim">L{i + 1}</span>
            </div>
            <div className="mt-1.5 truncate text-[11px] leading-tight text-fg-dim group-hover:text-fg">
              {l.name}
            </div>
            <div className="label mt-1" style={{ color: LEVEL_TOKEN[l.proficiency] }}>
              {LEVEL_LABEL[l.proficiency]}
            </div>
          </motion.button>
        </Fragment>
      ))}
    </div>
  );
}

/* ── one layer ──────────────────────────────────────────────────────────── */

function Section({
  label,
  onEdit,
  children,
}: {
  label: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="label">{label}</span>
        <IconButton icon={<Pencil size={11} />} label={`Edit ${label}`} onClick={onEdit} />
      </div>
      {children}
    </div>
  );
}

type LayerEditor = "text" | "tools" | "resources" | "demo" | null;

function LayerCard({ layer }: { layer: RoadmapLayer }) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<LayerEditor>(null);
  const [deleting, setDeleting] = useState(false);

  const tools = byId(layer.tools);
  const resources = byId(layer.resources);

  return (
    <Card id={`layer-${layer.id}`} className="p-5" active={layer.proficiency === "solid"}>
      {/* Wraps below `md`: the name, the four-state proficiency control and
          the delete button need ~500px to sit on one line. `md:flex-nowrap`
          pins the desktop row, which is the source's layout unchanged. */}
      <div className="flex flex-wrap items-start gap-3 md:flex-nowrap">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left pointer-coarse:min-h-[44px]"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="display text-[16px] text-fg">{layer.name}</span>
            {layer.tag && <Chip color={tagColor(layer.tag)}>{layer.tag}</Chip>}
            <ChevronDown
              size={14}
              aria-hidden
              className={cn("text-fg-muted transition-transform", open && "rotate-180")}
            />
          </div>
          <div className="mt-1 text-[11px] text-fg-muted">Target: {layer.target || "—"}</div>
        </button>

        <SegmentedControl
          className="shrink-0"
          options={LEVELS.map((id) => ({ id, label: LEVEL_LABEL[id], color: LEVEL_TOKEN[id] }))}
          value={layer.proficiency}
          onChange={(id) => roadmap.setProficiency(layer.id, id as Proficiency)}
        />
        <IconButton
          icon={<Trash2 size={13} />}
          label="Delete layer"
          danger
          onClick={() => setDeleting(true)}
        />
      </div>

      {open && (
        <div className="mt-4 flex flex-col gap-4 border-t-[0.5px] border-line pt-4 text-[12.5px] leading-relaxed">
          <Section label="What it is" onEdit={() => setEditor("text")}>
            <p className="text-fg-dim">{layer.what || "—"}</p>
            {layer.role && (
              <p className="mt-1.5 text-fg-muted">
                <span className="label">Role · </span>
                {layer.role}
              </p>
            )}
          </Section>

          <Section label="Tools & methods" onEdit={() => setEditor("tools")}>
            <div className="flex flex-col gap-2.5">
              {tools.map((g) => (
                <div key={g.id}>
                  <div className="label mb-1.5">{g.group}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.items.map((it) => (
                      <Chip key={it} color="var(--color-neutral-100)">
                        {it}
                      </Chip>
                    ))}
                  </div>
                </div>
              ))}
              {layer.methods.length > 0 && (
                <div>
                  <div className="label mb-1.5">Core methods</div>
                  <p className="text-fg-dim">{layer.methods.join(" · ")}</p>
                </div>
              )}
              {tools.length === 0 && layer.methods.length === 0 && (
                <p className="text-fg-muted">Nothing listed yet.</p>
              )}
            </div>
          </Section>

          {resources.length > 0 && (
            <Section label="Resources" onEdit={() => setEditor("resources")}>
              <div className="flex flex-col gap-1">
                {resources.map((r) =>
                  r.url ? (
                    <button
                      key={r.id}
                      onClick={() => window.open(r.url, "_blank", "noopener,noreferrer")}
                      className="flex items-center gap-1.5 text-left text-accent-lt hover:underline pointer-coarse:min-h-[44px]"
                    >
                      <ExternalLink size={11} aria-hidden /> {r.label}
                    </button>
                  ) : (
                    <span key={r.id} className="text-fg-dim">
                      {r.label}
                    </span>
                  ),
                )}
              </div>
            </Section>
          )}

          <Section label="Demo walkthrough" onEdit={() => setEditor("demo")}>
            <div className="mb-1.5 flex items-center gap-1.5 text-fg">
              <GitBranch size={12} aria-hidden className="text-accent-dim" />
              {layer.demo.name || "—"}
            </div>
            {layer.demo.tree && (
              <pre className="nums mb-2 overflow-x-auto rounded-xs border-[0.5px] border-line bg-bg p-3 text-[11px] leading-relaxed text-fg-dim">
                {layer.demo.tree}
              </pre>
            )}
            <ol className="flex flex-col gap-1">
              {layer.demo.flow.map((s, i) => (
                <li key={`${i}-${s.slice(0, 24)}`} className="flex gap-2 text-fg-dim">
                  <span className="nums shrink-0 text-accent-dim">{i + 1}.</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      )}

      {editor === "text" && (
        <FormModal
          title="Edit layer"
          initial={{
            name: layer.name,
            tag: layer.tag,
            target: layer.target,
            what: layer.what,
            role: layer.role,
          }}
          fields={LAYER_FIELDS}
          onSubmit={(v) =>
            roadmap.editLayer(layer.id, {
              name: String(v.name),
              tag: String(v.tag),
              target: String(v.target),
              what: String(v.what),
              role: String(v.role),
            })
          }
          onClose={() => setEditor(null)}
        />
      )}
      {editor === "tools" && (
        <FormModal
          title="Edit tools & methods"
          initial={{ tools: toolsToText(layer.tools), methods: layer.methods.join("\n") }}
          fields={[
            {
              key: "tools",
              label: 'Tools — one group per line: "Group: item; item"',
              type: "textarea",
              full: true,
            },
            { key: "methods", label: "Core methods — one per line", type: "textarea", full: true },
          ]}
          onSubmit={(v) => {
            roadmap.setTools(layer.id, textToTools(String(v.tools)));
            roadmap.setMethods(layer.id, linesToArr(String(v.methods)));
          }}
          onClose={() => setEditor(null)}
        />
      )}
      {editor === "resources" && (
        <FormModal
          title="Edit resources"
          initial={{ resources: resToText(layer.resources) }}
          fields={[
            {
              key: "resources",
              label: 'One per line: "Label | https://url" (url optional)',
              type: "textarea",
              full: true,
            },
          ]}
          onSubmit={(v) => roadmap.setResources(layer.id, textToRes(String(v.resources)))}
          onClose={() => setEditor(null)}
        />
      )}
      {editor === "demo" && (
        <FormModal
          title="Edit demo walkthrough"
          initial={{ name: layer.demo.name, tree: layer.demo.tree, flow: layer.demo.flow.join("\n") }}
          fields={[
            { key: "name", label: "Demo name", full: true },
            { key: "tree", label: "File tree", type: "textarea", full: true },
            { key: "flow", label: "Flow — one step per line", type: "textarea", full: true },
          ]}
          onSubmit={(v) =>
            roadmap.setDemo(layer.id, {
              name: String(v.name),
              tree: String(v.tree),
              flow: linesToArr(String(v.flow)),
            })
          }
          onClose={() => setEditor(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete layer"
          message={`Delete "${layer.name}" from the stack?`}
          onConfirm={() => roadmap.delLayer(layer.id)}
          onClose={() => setDeleting(false)}
        />
      )}
    </Card>
  );
}

export function Stack({ data }: { data: Roadmap }) {
  const [adding, setAdding] = useState(false);
  const [editingThroughLine, setEditingThroughLine] = useState(false);

  // Ascending id. Layers have no date and no sort key, so this is the only
  // order they have — and the seed's zero-padded ordinal makes it the authored
  // one. See `order.tsx`.
  const layers = byId(data.layers);

  return (
    <div className="flex flex-col gap-4 pt-5">
      <Card className="p-5" active>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-[280px_1fr]">
          <div className="flex flex-col">
            <div className="label mb-2">Proficiency map</div>
            <div className="grid flex-1 place-items-center">
              {layers.length >= 3 ? (
                <ProficiencyRadar layers={layers} onSelect={(id) => scrollToCard(`layer-${id}`)} />
              ) : (
                // Not a two-axis radar: that is a line, and a line reads as a
                // broken chart rather than as "not enough layers yet".
                <p className="max-w-[24ch] text-center text-[11px] text-fg-muted">
                  The radar needs three layers before it is a shape.
                </p>
              )}
            </div>
          </div>
          <div className="min-w-0">
            <div className="label mb-2 flex items-center gap-1.5">
              How the layers compose — your through-line
              <span className="ml-auto">
                <IconButton
                  icon={<Pencil size={11} />}
                  label="Edit the through-line"
                  onClick={() => setEditingThroughLine(true)}
                />
              </span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-fg-dim">
              {data.throughLine || (
                <span className="text-fg-muted">
                  One paragraph on how these layers add up to one engineer rather than six hobbies.
                </span>
              )}
            </p>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 border-t-[0.5px] border-line pt-3">
              {LEVELS.map((l) => (
                <div key={l} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: LEVEL_TOKEN[l] }}
                  />
                  <span className="label" style={{ color: LEVEL_TOKEN[l] }}>
                    {LEVEL_LABEL[l]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {layers.length > 0 && (
        <div>
          <div className="label mb-2">The stack — jump to a layer</div>
          <PipelineStrip layers={layers} onSelect={(id) => scrollToCard(`layer-${id}`)} />
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="label">
          {layers.length} {layers.length === 1 ? "layer" : "layers"}
        </span>
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
          Add layer
        </Button>
      </div>

      {layers.length === 0 ? (
        <EmptyState
          title="No layers"
          hint="A layer is one band of the stack — what it is, the tools, and the demo that proves you can do it."
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              Add layer
            </Button>
          }
        />
      ) : (
        <Stagger className="flex flex-col gap-4">
          {layers.map((l) => (
            <Reveal key={l.id}>
              <LayerCard layer={l} />
            </Reveal>
          ))}
        </Stagger>
      )}

      {adding && (
        <FormModal
          title="New layer"
          fields={LAYER_FIELDS}
          onSubmit={(v) =>
            roadmap.addLayer({
              name: String(v.name),
              tag: String(v.tag),
              target: String(v.target),
              what: String(v.what),
              role: String(v.role),
            })
          }
          onClose={() => setAdding(false)}
        />
      )}
      {editingThroughLine && (
        <FormModal
          title="Through-line"
          initial={{ throughLine: data.throughLine }}
          fields={[
            { key: "throughLine", label: "How the layers compose", type: "textarea", full: true },
          ]}
          onSubmit={(v) => roadmap.setThroughLine(String(v.throughLine))}
          onClose={() => setEditingThroughLine(false)}
        />
      )}
    </div>
  );
}
