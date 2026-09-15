import { Construction } from "lucide-react";
import { EmptyState } from "@/components/ui";

/**
 * A screen that has not been built yet, and says so.
 *
 * Not a blank div: an empty screen is indistinguishable from a screen whose
 * data failed to load, and on a phone there is no console to check. Stage 4
 * lands these one at a time, and until one lands this is the honest render.
 */
export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl items-center px-5">
      <EmptyState
        icon={<Construction size={22} strokeWidth={1.6} />}
        title={`${title} is not built yet`}
        hint={note}
        className="w-full"
      />
    </div>
  );
}
