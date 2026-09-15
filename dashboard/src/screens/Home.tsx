import { Placeholder } from "./Placeholder";
import type { ScreenId } from "@/config/nav";

export function HomeScreen({ onOpen }: { onOpen: (id: ScreenId) => void }) {
  void onOpen;
  return (
    <Placeholder
      title="Home"
      note="A launcher, not a report: quick capture, today's todos, the timer, and live run status. Anything still true next week belongs in the vault."
    />
  );
}
