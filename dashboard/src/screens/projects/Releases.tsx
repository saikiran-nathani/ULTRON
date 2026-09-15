import { useState } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button, FormModal, IconButton } from "@/components/ui";
import { useProjects } from "@/store/projects";
import { todayStr } from "@/lib/nexus/format";
import type { Project } from "@/lib/nexus/types";
import { orderReleases } from "./ordering";

/**
 * What shipped, newest first.
 *
 * Ordered by `date` descending with `id` descending as the tiebreak —
 * `releases` is a per-record synced collection, so nexus's `[...].reverse()`
 * was reversing whatever order a rehydrate had produced, not the order they
 * were added in. An undated release sorts to the bottom rather than the top;
 * see `byDateDesc` in `ordering`.
 */
export function Releases({ project: p }: { project: Project }) {
  const { addRelease, delRelease } = useProjects();
  const [adding, setAdding] = useState(false);
  const releases = p.releases ?? [];

  return (
    <div>
      <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
        Add release
      </Button>

      {releases.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
          Nothing shipped yet. A release is a version, a date and where it went.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {orderReleases(releases).map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="nums shrink-0 text-accent-lt">{r.version}</span>
              <span className="nums shrink-0 text-[10.5px] text-fg-muted">{r.date || "undated"}</span>
              <span className="min-w-0 flex-1 truncate text-fg-dim">{r.notes}</span>
              {r.url && (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  title={`Open ${r.version}`}
                  aria-label={`Open ${r.version}`}
                  className="grid h-9 w-9 place-items-center rounded-xs text-fg-muted transition-colors hover:bg-card-hover hover:text-fg md:h-7 md:w-7 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] pointer-coarse:border pointer-coarse:border-line pointer-coarse:bg-card/60 pointer-coarse:text-fg-dim"
                >
                  <ExternalLink size={11} aria-hidden />
                </a>
              )}
              <IconButton
                icon={<Trash2 size={11} />}
                label={`Delete release ${r.version}`}
                danger
                onClick={() => delRelease(p.id, r.id)}
              />
            </div>
          ))}
        </div>
      )}

      {adding && (
        <FormModal
          title="New release"
          fields={[
            { key: "version", label: "Version", required: true, placeholder: "v1.2.0" },
            { key: "date", label: "Date", type: "date", defaultValue: todayStr() },
            { key: "url", label: "Live / release URL", full: true },
            { key: "notes", label: "Notes", type: "textarea", full: true },
          ]}
          onSubmit={(v) =>
            addRelease(p.id, {
              version: String(v.version),
              date: String(v.date),
              url: String(v.url),
              notes: String(v.notes),
            })
          }
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
