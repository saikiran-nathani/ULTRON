# ADR-0001 — Stack and architecture

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

`remote-training-monitoring.md` specifies a four-layer system (Reach → Persist →
Emit → Notify) for watching a training run on a headless Windows/CUDA box from an
iPad. The guide gives snippets, not a system. We need a real implementation whose
constraints are:

1. The **training process** is the most expensive thing in the system. A monitoring
   library that fails to import, blocks on a network call, or raises inside the
   training loop is worse than no monitoring at all.
2. The **training box is Windows**, so per the guide's own warning the runtime is
   WSL2 with CUDA passthrough. It should not need a Node toolchain.
3. The **client is an iPad** over Tailscale — intermittent connectivity, touch input,
   and a browser as the only viable app surface.
4. This is a **single-user tool on a private tailnet**, not a multi-tenant service.

## Decision

**Two processes, one file, zero coupling.**

```
 training proc                        server proc                iPad
┌──────────────┐   sqlite (WAL)    ┌──────────────┐   HTTP/SSE  ┌────────┐
│ TrainMonitor │ ─── writes ─────▶ │ FastAPI      │ ──────────▶ │ Safari │
│  emit/rules  │                   │  read-only   │  tailnet    └────────┘
│  heartbeat   │ ─── ntfy ──────▶  │  gpu sampler │
└──────────────┘   (fire+forget)   └──────────────┘
```

- **Zero-dependency core.** `trainwatch` (store, notify, emit, rules, heartbeat,
  monitor) imports only the stdlib — `sqlite3`, `urllib.request`, `threading`.
  FastAPI, TensorBoard and W&B are optional extras. The training env installs
  nothing it doesn't already have.
- **SQLite in WAL mode as the bus.** One writer (the run), many readers (the
  server), no daemon to keep alive, survives a server restart, and the whole
  history is one file you can `scp`. A message queue or a metrics DB would be
  more machinery than a single-box single-user tool can justify.
- **Fan-out emit.** One `log()` call goes to the store *and* TensorBoard *and*
  W&B, chosen by config. Sinks are independent: a broken sink is disabled, not
  fatal.
- **The dashboard ships pre-built.** Vite builds to
  `src/trainwatch/server/static/`, which is committed. The Windows/WSL2 box only
  ever needs Python.
- **The API is read-only.** No kill/restart/checkpoint endpoints. A read-only
  surface on the tailnet has a dramatically smaller blast radius, and the guide's
  goal is *being interrupted*, not remote control. Revisit if that changes.

## Consequences

**Good.** Nothing new can break the training run. The server can crash, be
upgraded, or be absent entirely and the run keeps logging and alerting. No
external service is required (TensorBoard + self-hostable ntfy = fully local).

**Costs.** SQLite means a single box — this does not federate across machines
without changing the transport. Committing `static/` puts build output in git.
Read-only means an iPad-initiated kill still requires SSH.

**Rejected alternatives.** Prometheus + Grafana (three services to babysit for
one GPU); W&B-only (cloud dependency, and the guide explicitly wants a local-first
option); writing JSONL and tailing it (no indexed queries for the series endpoint,
and concurrent-read semantics are worse than SQLite's).
