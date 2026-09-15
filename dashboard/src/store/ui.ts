import type { ReactNode } from "react";
import { create } from "zustand";
/**
 * The screen ids, declared here rather than imported from `config/nav`.
 *
 * nexus kept this union next to the sidebar's icon list, which is the right
 * home for it — but `config/nav.ts` is a component-layer file and outside this
 * change. Declared and exported here so the union has exactly one definition
 * either way: whoever ports the nav imports it from the store rather than
 * writing a second copy that drifts one screen at a time.
 */
export type ScreenId =
  | "dashboard"
  | "study"
  | "projects"
  | "academics"
  | "career"
  | "roadmap"
  | "journal"
  | "brain";

interface UIState {
  screen: ScreenId;
  setScreen: (s: ScreenId) => void;
  /**
   * Single global modal slot (matches the legacy setModal ergonomics).
   *
   * Ported, and currently unused — a note rather than a recommendation. The
   * UI kit in `src/components/ui` deliberately does not read this: its modals
   * take an `onClose` prop, so a screen owns its own dismissal. Anyone porting
   * a screen that did `setModal(<Thing/>)` in nexus should follow the kit's
   * convention instead of reviving this slot, and then delete it.
   */
  modal: ReactNode | null;
  setModal: (node: ReactNode | null) => void;
}

/** Active screen + global UI chrome state. One slice, UI only. */
export const useUI = create<UIState>((set) => ({
  screen: "dashboard",
  setScreen: (screen) => set({ screen }),
  modal: null,
  setModal: (modal) => set({ modal }),
}));
