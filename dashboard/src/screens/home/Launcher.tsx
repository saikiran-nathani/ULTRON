/**
 * The launcher: four tracks, then Career.
 *
 * Every tile is a label, an icon and one line saying what is behind the door.
 * No counts, and that is the rule rather than a shortage of data — "3 active
 * projects" would still be true next week, so by the plan's own test it is
 * vault content, and putting it here is how a launcher quietly becomes the
 * report it exists to replace.
 *
 * `Card` is a `div`, so a clickable tile gets `role="button"`, a tab stop and
 * Enter/Space — without those it is a control only a mouse or a finger can
 * reach, and VoiceOver reads it as static text. The coarse-pointer floor is on
 * the pointer, not a breakpoint: a landscape iPad is 1024px wide and driven by
 * a thumb.
 */
import { ArrowUpRight } from "lucide-react";
import { Card } from "@/components/ui";
import type { ScreenId } from "@/config/nav";
import { launcherTiles } from "./selectors";

export function Launcher({ onOpen }: { onOpen: (id: ScreenId) => void }) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
    >
      {launcherTiles().map((t) => {
        const Icon = t.icon;
        return (
          <Card
            key={t.id}
            interactive
            onClick={() => onOpen(t.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(t.id);
              }
            }}
            className="group/tile flex flex-col gap-2.5 p-4 pointer-coarse:min-h-[96px]"
          >
            <div className="flex items-center justify-between gap-2">
              <Icon size={17} strokeWidth={1.7} className="text-accent" aria-hidden />
              <ArrowUpRight
                size={13}
                strokeWidth={1.8}
                className="text-fg-muted transition-transform duration-200 group-hover/tile:-translate-y-0.5 group-hover/tile:translate-x-0.5"
                aria-hidden
              />
            </div>
            <div className="min-w-0">
              <div className="display truncate text-[14.5px] text-fg">{t.label}</div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">{t.blurb}</p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
