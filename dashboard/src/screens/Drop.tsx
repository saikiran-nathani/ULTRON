/**
 * Files and links — the leg AirDrop cannot do.
 *
 * AirDrop already moves a screenshot from the iPhone to the Mac. It has no
 * answer for iPhone -> WSL2, which is precisely the case that comes up
 * (a paper figure, a plot, a config) and precisely why this screen exists.
 */
import { useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  FileUp,
  Image as ImageIcon,
  Link2,
  Pin,
  PinOff,
  Send,
  Trash2,
} from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { Reveal, Stagger } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { bytes, dayClock } from "@/lib/format";
import { type HubFile, type HubLink, type HubState, hubApi } from "@/lib/hub";
import { Button, Card, Chip, EmptyState, IconButton, Tabs } from "@/components/ui";

export function DropScreen({ hub, refresh }: { hub: HubState | null; refresh: () => void }) {
  const [tab, setTab] = useState("files");
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ScreenShell eyebrow="send to any device" title="Drop">
      <Stagger className="flex flex-col gap-4">
        <Reveal>
          <Tabs
            tabs={[
              { id: "files", label: "Files", count: hub?.files.length },
              { id: "links", label: "Links", count: hub?.links.filter((l) => !l.opened_at).length },
            ]}
            active={tab}
            onChange={setTab}
            layoutId="drop-tabs"
          />
        </Reveal>

        {error && (
          <Reveal>
            <Card active accent="var(--color-bad)" className="px-4 py-3">
              <p className="text-[12px] text-[var(--color-bad)]">{error}</p>
            </Card>
          </Reveal>
        )}

        {tab === "files" ? (
          <>
            <Reveal>
              <Dropzone
                maxBytes={hub?.limits.max_upload ?? 0}
                onFiles={(files) => act(async () => {
                  for (const f of files) await hubApi.upload(f);
                })}
              />
            </Reveal>
            <Reveal>
              {(hub?.files.length ?? 0) === 0 ? (
                <EmptyState
                  title="No files yet"
                  icon={<FileUp size={22} strokeWidth={1.6} />}
                  hint="Drop one above, or from a terminal: trainwatch send plot.png"
                />
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {hub!.files.map((f) => (
                    <FileCard
                      key={f.id}
                      file={f}
                      onPin={() => act(() => hubApi.pinFile(f.id, !f.pinned))}
                      onDelete={() => act(() => hubApi.deleteFile(f.id))}
                    />
                  ))}
                </div>
              )}
            </Reveal>
          </>
        ) : (
          <>
            <Reveal>
              <LinkComposer
                devices={(hub?.devices ?? []).map((d) => d.name)}
                onPush={(url, title, target) => act(() => hubApi.pushLink(url, title, target))}
              />
            </Reveal>
            <Reveal>
              {(hub?.links.length ?? 0) === 0 ? (
                <EmptyState
                  title="No links pushed"
                  icon={<Link2 size={22} strokeWidth={1.6} />}
                  hint="Send a URL to one device or all of them. Useful for reading a paper on the iPad that you found on the Mac."
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {hub!.links.map((l) => (
                    <LinkRow
                      key={l.id}
                      link={l}
                      onOpen={() => act(() => hubApi.openLink(l.id))}
                      onDelete={() => act(() => hubApi.deleteLink(l.id))}
                    />
                  ))}
                </div>
              )}
            </Reveal>
          </>
        )}
      </Stagger>
    </ScreenShell>
  );
}

function Dropzone({
  onFiles,
  maxBytes,
}: {
  onFiles: (files: File[]) => void;
  maxBytes: number;
}) {
  const [over, setOver] = useState(false);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Reject oversize files before uploading them. The limit was displayed but
  // never enforced, so dropping a 500 MB checkpoint from an iPad pushed the
  // whole body over cellular and only then got a 413.
  const accept = (files: File[]) => {
    const oversize = files.find((f) => f.size > maxBytes);
    if (oversize) {
      setTooBig(`${oversize.name} is ${bytes(oversize.size)} — the limit is ${bytes(maxBytes)}`);
      return;
    }
    setTooBig(null);
    if (files.length) onFiles(files);
  };

  const open = () => input.current?.click();

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose files to upload"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          accept(Array.from(e.dataTransfer.files));
        }}
        onClick={open}
        // The only real control is the file input, and it is display:none —
        // which removes it from the tab order. Without this the entire upload
        // feature was unreachable by keyboard or switch control.
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 py-9 text-center",
          "transition-all duration-200 ease-[var(--ease-signature)] active:scale-[0.99]",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]",
          over
            ? "border-line-strong bg-accent/5"
            : "border-line/70 hover:border-line-active hover:bg-card-hover/40",
        )}
      >
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          tabIndex={-1}
          onChange={(e) => {
            accept(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <FileUp size={20} strokeWidth={1.6} className="text-fg-muted" />
        <div className="display text-[14px] text-fg-dim">Drop files, or tap to choose</div>
        <p className="text-[11px] text-fg-muted">
          On iPad this opens Photos, Files or the camera · up to {bytes(maxBytes)}
        </p>
      </div>
      {tooBig && (
        <p role="alert" className="mt-2 text-[11px]" style={{ color: "var(--color-bad)" }}>
          {tooBig}
        </p>
      )}
    </div>
  );
}

function FileCard({
  file,
  onPin,
  onDelete,
}: {
  file: HubFile;
  onPin: () => void;
  onDelete: () => void;
}) {
  return (
    <Card active={file.pinned} className="flex flex-col overflow-hidden">
      {file.is_image ? (
        // Only allowlisted raster types are served inline by the API; SVG is
        // forced to download, so this <img> can never execute anything.
        <a href={`/api/files/${file.id}/raw`} target="_blank" rel="noreferrer" className="block">
          <img
            src={`/api/files/${file.id}/raw`}
            alt={file.name}
            loading="lazy"
            className="h-36 w-full bg-bg object-cover"
          />
        </a>
      ) : (
        <div className="grid h-36 w-full place-items-center bg-bg text-fg-muted">
          <ImageIcon size={22} strokeWidth={1.5} className="opacity-40" />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 px-3.5 py-3">
        <div className="truncate text-[12.5px] font-medium text-fg-dim" title={file.name}>
          {file.name}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="nums text-[10.5px] text-fg-muted">{bytes(file.size)}</span>
          <span className="label">{file.device || "unknown"}</span>
          <span className="nums text-[10.5px] text-fg-muted">{dayClock(file.ts)}</span>
        </div>
        <div className="mt-auto flex items-center gap-1.5 pt-1">
          <a
            href={`/api/files/${file.id}/raw?download=true`}
            download={file.name}
            className="inline-flex min-h-[34px] flex-1 items-center justify-center gap-1.5 rounded-sm border border-line bg-card/60 text-[11px] font-medium text-fg-dim transition-all hover:border-line-active hover:text-fg active:scale-[0.96]"
          >
            <Download size={12} /> Save
          </a>
          <IconButton
            icon={file.pinned ? <PinOff size={12} /> : <Pin size={12} />}
            label={file.pinned ? "Unpin" : "Pin"}
            onClick={onPin}
            className="h-9 w-9"
          />
          <IconButton
            icon={<Trash2 size={12} />}
            label="Delete"
            danger
            onClick={onDelete}
            className="h-9 w-9"
          />
        </div>
      </div>
    </Card>
  );
}

function LinkComposer({
  devices,
  onPush,
}: {
  devices: string[];
  onPush: (url: string, title: string, target: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("");

  return (
    <Card className="p-4">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Link URL to push"
        placeholder="https://arxiv.org/abs/..."
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="min-h-[44px] w-full rounded-sm border-[0.5px] border-line bg-bg px-3 text-[12.5px] text-fg outline-none transition-colors placeholder:text-fg-muted/60 focus:border-line-strong"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<Send size={13} />}
          disabled={!/^https?:\/\/\S+$/i.test(url.trim())}
          onClick={() => {
            onPush(url.trim(), "", target);
            setUrl("");
          }}
        >
          Push
        </Button>
        <select
          aria-label="Send the link to which device"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="min-h-[44px] rounded-sm border-[0.5px] border-line bg-bg px-2.5 text-[12px] text-fg-dim outline-none focus:border-line-strong"
        >
          <option value="">All devices</option>
          {devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-2 text-[11px] text-fg-muted">
        Only http(s) is accepted — javascript: and file: URLs are refused server-side.
      </p>
    </Card>
  );
}

function LinkRow({
  link,
  onOpen,
  onDelete,
}: {
  link: HubLink;
  onOpen: () => void;
  onDelete: () => void;
}) {
  let host = link.url;
  try {
    host = new URL(link.url).host;
  } catch {
    /* keep the raw string */
  }
  return (
    <Card active={!link.opened_at} className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={onOpen}
            className="block truncate text-[13px] font-medium text-accent-lt hover:underline"
          >
            {link.title || link.url}
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="nums text-[10.5px] text-fg-muted">{host}</span>
            {!link.opened_at && <Chip color="var(--color-accent)">unread</Chip>}
            {link.target && <Chip color="var(--color-info)">→ {link.target}</Chip>}
            <span className="label">{link.device || "unknown"}</span>
            <span className="nums text-[10.5px] text-fg-muted">{dayClock(link.ts)}</span>
          </div>
        </div>
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={onOpen}
          aria-label="Open"
          className="inline-grid h-11 w-11 shrink-0 place-items-center rounded-sm border-[0.5px] border-line bg-card/60 text-fg-muted transition-all hover:border-line-active hover:text-fg active:scale-[0.94]"
        >
          <ExternalLink size={13} />
        </a>
        <IconButton icon={<Trash2 size={13} />} label="Delete" danger onClick={onDelete} />
      </div>
    </Card>
  );
}
