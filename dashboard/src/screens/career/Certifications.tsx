/**
 * Certifications, ported from nexus's `Career.tsx`.
 *
 * Same three forced changes as `Pipeline.tsx` (theme tokens, per-card
 * `onClose`, id ordering), plus one fix the source had wrong rather than
 * merely different: deleting a certification went straight through on the
 * click, with no confirmation, while deleting a *job* got a dialog. On a phone
 * that delete button is 11px from the edit button. It gets the same
 * confirmation the rest of the app uses.
 */
import { useState } from "react";
import { AlertTriangle, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  FormModal,
  IconButton,
  type FormField,
  type FormValues,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import { daysFromToday } from "@/lib/nexus/format";
import { CERT_STATUSES, type CertStatus } from "@/lib/nexus/constants";
import type { Career, Certification } from "@/lib/nexus/types";
import { career } from "@/store/career";
import { byId } from "./order";

const FIELDS: FormField[] = [
  { key: "name", label: "Name", required: true, full: true },
  { key: "provider", label: "Provider" },
  {
    key: "status",
    label: "Status",
    type: "select",
    defaultValue: "Studying",
    options: CERT_STATUSES.map((s) => ({ value: s, label: s })),
  },
  { key: "expiryDate", label: "Expiry date", type: "date" },
  { key: "cost", label: "Cost" },
  { key: "link", label: "Link", full: true },
  {
    key: "notes",
    label: "Notes — which of your work this certifies",
    type: "textarea",
    full: true,
  },
];

const toCert = (v: FormValues): Omit<Certification, "id"> => ({
  name: String(v.name),
  provider: String(v.provider),
  status: String(v.status) as CertStatus,
  expiryDate: String(v.expiryDate),
  cost: String(v.cost),
  link: String(v.link),
  notes: String(v.notes),
});

/** Passed and inside 90 days of expiry — the one state worth interrupting for. */
const expiringSoon = (c: Certification) =>
  c.status === "Passed" && c.expiryDate !== "" && daysFromToday(c.expiryDate) < 90;

function CertCard({ cert }: { cert: Certification }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const expiring = expiringSoon(cert);
  const days = cert.expiryDate ? daysFromToday(cert.expiryDate) : 0;

  return (
    <Card className="p-4" active={cert.status === "Passed"} accent="var(--color-good)">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-fg">{cert.name}</div>
          <div className="truncate text-[11px] text-fg-muted">
            {cert.provider}
            {cert.cost && ` · ${cert.cost}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Chip color={cert.status === "Passed" ? "var(--color-good)" : "var(--color-accent)"}>
            {cert.status}
          </Chip>
          {cert.link && (
            <IconButton
              icon={<ExternalLink size={12} />}
              label="Open certification page"
              onClick={() => window.open(cert.link, "_blank", "noopener,noreferrer")}
            />
          )}
          <IconButton icon={<Pencil size={12} />} label="Edit certification" onClick={() => setEditing(true)} />
          <IconButton
            icon={<Trash2 size={12} />}
            label="Delete certification"
            danger
            onClick={() => setDeleting(true)}
          />
        </div>
      </div>

      {cert.notes && (
        <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">{cert.notes}</p>
      )}

      {expiring && (
        <div
          className="mt-2 flex items-center gap-1.5 text-[11px]"
          style={{ color: days < 0 ? "var(--color-bad)" : "var(--color-warn)" }}
        >
          <AlertTriangle size={12} aria-hidden />
          {days < 0 ? `Expired ${cert.expiryDate}` : `Expires ${cert.expiryDate} — ${days}d`}
        </div>
      )}

      {editing && (
        <FormModal
          title="Edit certification"
          initial={{ ...cert }}
          fields={FIELDS}
          onSubmit={(v) => career.editCert(cert.id, toCert(v))}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete certification"
          message={`Delete "${cert.name}"? It is one of the two places this app treats as evidence, so anything banked only here goes back to unbanked.`}
          onConfirm={() => career.delCert(cert.id)}
          onClose={() => setDeleting(false)}
        />
      )}
    </Card>
  );
}

export function Certifications({ data }: { data: Career }) {
  const [adding, setAdding] = useState(false);
  const certs = byId(data.certifications);

  return (
    <div className="flex flex-col gap-4 pt-5">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          New certification
        </Button>
      </div>

      {certs.length === 0 ? (
        <EmptyState
          title="No certifications"
          hint="A certification is the other thing this app counts as evidence — its name and notes are searched by the Evidence ledger."
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              New certification
            </Button>
          }
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {certs.map((c) => (
            <Reveal key={c.id}>
              <CertCard cert={c} />
            </Reveal>
          ))}
        </Stagger>
      )}

      {adding && (
        <FormModal
          title="New certification"
          fields={FIELDS}
          onSubmit={(v) => career.addCert(toCert(v))}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
