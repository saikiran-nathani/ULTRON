/**
 * The kit's barrel, so a screen can write
 * `import { Card, Button } from "@/components/ui"`.
 *
 * `.tsx` and not `.ts` only because this directory's brief allowed `*.tsx`
 * and nothing else; the extension carries no meaning here.
 */
export { Card, CardHead } from "./Card";
export { Button } from "./Button";
export { IconButton } from "./IconButton";
export { Chip } from "./Chip";
export { Stat } from "./Stat";
export { CountUp } from "./CountUp";
export { ProgressBar, clampPct } from "./ProgressBar";
export { ProgressRing } from "./ProgressRing";
export { Sparkline, sparklineGeometry, type SparklineGeometry } from "./Sparkline";
export { InlineEdit } from "./InlineEdit";
export { EmptyState } from "./EmptyState";
export { ScrollList } from "./ScrollList";
export { StatBand, type StatItem } from "./StatBand";
export { Callout } from "./Callout";
export { ExpandableCard } from "./ExpandableCard";
export { SegmentedControl, type SegOption } from "./SegmentedControl";
export { Tabs, type TabDef } from "./Tabs";
export { Modal } from "./Modal";
export { Field, inputCls, labelCls } from "./Field";
export {
  FormModal,
  coerceFormValues,
  formInitialValues,
  type FieldType,
  type FormDraft,
  type FormField,
  type FormValues,
} from "./FormModal";
export { ConfirmDialog } from "./ConfirmDialog";
export { LineChart, TimeSeriesSparkline, type Point } from "./Chart";
export { CopyButton } from "./CopyButton";
