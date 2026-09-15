import { useState } from "react";
import { ExternalLink, KeyRound, Link2, Plug, Plus, Terminal, Trash2, X } from "lucide-react";
import { CopyButton, IconButton, inputCls } from "@/components/ui";
import { useProjects } from "@/store/projects";
import type { Project } from "@/lib/nexus/types";
import { orderEnvVars, orderLinks, orderPorts, orderRunCommands } from "./ordering";

/**
 * How to run the project: commands, env vars, ports, resources.
 *
 * `project.runbook` is optional, and an absent one is the normal state of
 * every project created before the dev add-ons existed. It is read through
 * one `??` at the top rather than guarded at each use — the store's writers
 * (`addRunCommand`, `setPorts`, …) mint it on first write, so nothing here
 * has to.
 *
 * Unlike the rest of this domain the runbook is *not* a per-record synced
 * collection: it rides inside the project record, so two devices editing two
 * different commands in the same runbook within one offline window resolve
 * last-writer-wins on the whole thing. Nothing a screen can do about that —
 * but the sub-lists are still ordered by `id` rather than by array position,
 * so at least the render is stable either way.
 */
export function Runbook({ project: p }: { project: Project }) {
  const { addRunCommand, delRunCommand, addEnvVar, delEnvVar, setPorts, addLink, delLink } =
    useProjects();
  const rb = p.runbook ?? { commands: [], env: [], ports: [], links: [] };

  const [cmdLabel, setCmdLabel] = useState("");
  const [cmd, setCmd] = useState("");
  const [envKey, setEnvKey] = useState("");
  const [envVal, setEnvVal] = useState("");
  const [port, setPort] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  const addPort = () => {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && n < 65536) setPorts(p.id, orderPorts([...rb.ports, n]));
    setPort("");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Commands */}
      <div>
        <div className="label mb-1.5 flex items-center gap-1.5">
          <Terminal size={11} aria-hidden /> Commands
        </div>
        {rb.commands.length === 0 ? (
          <Hint>Nothing recorded — the command you always forget goes here.</Hint>
        ) : (
          <div className="flex flex-col gap-1">
            {orderRunCommands(rb.commands).map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="w-16 shrink-0 truncate text-fg-muted">{c.label}</span>
                <code className="nums min-w-0 flex-1 truncate rounded-xs bg-bg px-1.5 py-0.5 text-[11.5px] text-fg-dim">
                  {c.cmd}
                </code>
                <CopyButton text={c.cmd} size="sm" label="Copy" />
                <IconButton
                  icon={<Trash2 size={11} />}
                  label={`Delete the ${c.label} command`}
                  danger
                  onClick={() => delRunCommand(p.id, c.id)}
                />
              </div>
            ))}
          </div>
        )}
        {/* One column below `md`: a 375px row cannot hold a label, a command
            and a 44px button without the command becoming unreadable. The
            desktop grid is the original three-column one. */}
        <div className="mt-1.5 grid grid-cols-1 gap-1.5 md:grid-cols-[80px_1fr_auto]">
          <input
            className={inputCls}
            placeholder="label"
            aria-label="Command label"
            value={cmdLabel}
            onChange={(e) => setCmdLabel(e.target.value)}
          />
          <input
            className={inputCls}
            placeholder="npm run dev"
            aria-label="Command"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
          />
          <IconButton
            icon={<Plus size={14} />}
            label="Add command"
            className="justify-self-end"
            onClick={() => {
              if (cmd.trim()) {
                addRunCommand(p.id, { label: cmdLabel.trim() || "run", cmd: cmd.trim() });
                setCmdLabel("");
                setCmd("");
              }
            }}
          />
        </div>
      </div>

      {/* Env */}
      <div>
        <div className="label mb-1.5 flex items-center gap-1.5">
          <KeyRound size={11} aria-hidden /> Env vars
        </div>
        {rb.env.length === 0 ? (
          <Hint>No env recorded. Values sync in clear text — keep secrets out.</Hint>
        ) : (
          <div className="flex flex-col gap-1">
            {orderEnvVars(rb.env).map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                <code className="nums min-w-0 flex-1 truncate rounded-xs bg-bg px-1.5 py-0.5 text-[11.5px] text-fg-dim">
                  {e.key}={e.value}
                </code>
                <CopyButton text={`${e.key}=${e.value}`} size="sm" label="Copy" />
                <IconButton
                  icon={<Trash2 size={11} />}
                  label={`Delete ${e.key}`}
                  danger
                  onClick={() => delEnvVar(p.id, e.id)}
                />
              </div>
            ))}
          </div>
        )}
        <div className="mt-1.5 grid grid-cols-1 gap-1.5 md:grid-cols-[1fr_1fr_auto]">
          <input
            className={inputCls}
            placeholder="KEY"
            aria-label="Env var name"
            value={envKey}
            onChange={(e) => setEnvKey(e.target.value)}
          />
          <input
            className={inputCls}
            placeholder="value"
            aria-label="Env var value"
            value={envVal}
            onChange={(e) => setEnvVal(e.target.value)}
          />
          <IconButton
            icon={<Plus size={14} />}
            label="Add env var"
            className="justify-self-end"
            onClick={() => {
              if (envKey.trim()) {
                addEnvVar(p.id, { key: envKey.trim(), value: envVal });
                setEnvKey("");
                setEnvVal("");
              }
            }}
          />
        </div>
      </div>

      {/* Ports */}
      <div>
        <div className="label mb-1.5 flex items-center gap-1.5">
          <Plug size={11} aria-hidden /> Ports
        </div>
        {rb.ports.length === 0 && <Hint>No ports recorded.</Hint>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {orderPorts(rb.ports).map((pt) => (
            <span
              key={pt}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-card pl-2.5 text-[11px]"
            >
              <a
                href={`http://localhost:${pt}`}
                target="_blank"
                rel="noreferrer"
                className="nums text-accent-lt underline-offset-2 hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center"
              >
                :{pt}
              </a>
              {/* nexus drew this as a bare 10px "×" that only turned red on
                  hover. A finger has no hover and cannot hit 10px, so the one
                  destructive control on the chip was the least reachable
                  thing on the screen. It is a real target now — and it is the
                  chip's trailing element rather than an overlay, so it cannot
                  swallow taps meant for the link. */}
              <button
                onClick={() => setPorts(p.id, rb.ports.filter((x) => x !== pt))}
                title={`Remove port ${pt}`}
                aria-label={`Remove port ${pt}`}
                className="grid h-7 w-7 place-items-center rounded-full text-fg-muted transition-colors hover:text-[var(--color-bad)] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
              >
                <X size={11} aria-hidden />
              </button>
            </span>
          ))}
          <input
            className={inputCls + " w-24"}
            placeholder="port"
            aria-label="Add a port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addPort();
            }}
            onBlur={() => port.trim() && addPort()}
          />
        </div>
      </div>

      {/* Links */}
      <div>
        <div className="label mb-1.5 flex items-center gap-1.5">
          <Link2 size={11} aria-hidden /> Resources
        </div>
        {rb.links.length === 0 ? (
          <Hint>No links recorded.</Hint>
        ) : (
          <div className="flex flex-col gap-1">
            {orderLinks(rb.links).map((l) => (
              <div key={l.id} className="flex items-center gap-2 text-[12px]">
                {/* An anchor, not a `window.open` button: a real link can be
                    long-pressed, shared and opened in a new tab, which is how
                    a link is used on a phone. */}
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-accent-lt underline-offset-2 hover:underline pointer-coarse:min-h-[44px]"
                >
                  <ExternalLink size={11} aria-hidden className="shrink-0" />
                  <span className="truncate">{l.label || l.url}</span>
                </a>
                <IconButton
                  icon={<Trash2 size={11} />}
                  label={`Delete ${l.label || l.url}`}
                  danger
                  onClick={() => delLink(p.id, l.id)}
                />
              </div>
            ))}
          </div>
        )}
        <div className="mt-1.5 grid grid-cols-1 gap-1.5 md:grid-cols-[80px_1fr_auto]">
          <input
            className={inputCls}
            placeholder="label"
            aria-label="Link label"
            value={linkLabel}
            onChange={(e) => setLinkLabel(e.target.value)}
          />
          <input
            className={inputCls}
            placeholder="https://…"
            aria-label="Link URL"
            inputMode="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
          />
          <IconButton
            icon={<Plus size={14} />}
            label="Add link"
            className="justify-self-end"
            onClick={() => {
              if (linkUrl.trim()) {
                addLink(p.id, { label: linkLabel.trim(), url: linkUrl.trim() });
                setLinkLabel("");
                setLinkUrl("");
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** An empty sub-list is a normal state, and says so in its own voice —
 *  dimmer than data, and never styled like the error banner. */
const Hint = ({ children }: { children: string }) => (
  <p className="text-[11px] leading-relaxed text-fg-muted">{children}</p>
);
