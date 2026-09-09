# ADR-0004 — The store becomes the system of record

- **Status:** Accepted — 2026-09-09
- **Supersedes:** the durability row of [ADR-0002](../trainwatch/adr/0002-production-profile.md)'s
  accepted-risk table, and extends [ADR-0003](../trainwatch/adr/0003-writable-hub-and-browser-threat-model.md)
  with controls C7–C13.

## Context

ADR-0002 accepted "no backups of `var/trainwatch.db`" on the grounds that the store held
*derived telemetry, reproducible by re-running*. It recorded one trip-wire:

> **The store ever becomes the system of record for anything.**

That trip-wire has fired. Curriculum progress, experiment lineage and eval results are to
live in the database, replacing hand-maintained Markdown. The immediate cause is concrete:
`TUF/STATUS.md` was partially updated on 2026-08-23 and by 2026-09-08 it was actively
misleading — claiming Python 3.14 as a settled decision after it had been reversed to 3.12,
and claiming "nothing measured on a model yet" when two full benchmark sweeps were committed.
A document that looks current where it is not is worse than one that is plainly stale.

## Decision

| | |
|---|---|
| **System of record** | Curriculum progress · training telemetry · experiment lineage · artifacts and eval results |
| **Auth boundary** | Tailscale remains the *network* boundary. Real app auth is added *inside* it. |
| **Host** | The Mac — 48 GB, always on, no CUDA contention |
| **Database** | SQLite + WAL + `user_version` migrations + `VACUUM INTO` backups |
| **Consequence** | The TUF requires a networked sink; `emit.py` has none today |

### Why the tailnet is no longer sufficient on its own

It still is, as a network boundary. What changes is that the data behind it is now
irreplaceable, and that most writes do not come from a human.

The actors are: one person, agent sessions (local and cloud), the TUF trainer, the liveness
cron, and an iPad. Five of the six are machines. So this is not a login page — it is **one
human identity with a revocable session, plus service accounts holding scoped tokens, plus an
audit log that attributes every write.** Identity exists here to answer "what changed my
infrastructure, and when", not to keep strangers out. Tailscale already does that.

## Threat model delta from ADR-0003

ADR-0003's threat was the browser — DNS rebinding for cross-origin reads, CSRF for
cross-origin writes. Those controls (C1–C6) are unchanged. Three new assets extend the model:

| New asset | Threat | Control |
|---|---|---|
| Credentials — password hash, session tokens, machine tokens | theft, fixation, replay | C7–C10 |
| Irreplaceable history | loss, silent corruption | C13 |
| Write attribution | an agent or device writing false history unnoticed | C11 |

Out of scope, unchanged: internet-facing threats. No public ingress, and `tailscale funnel`
remains forbidden. That is what keeps rate limiting a local concern rather than a bot-defence
problem.

## Three inherited defects this ADR is obliged to fix

Found while planning, all in code that predates this decision.

### 1. `PRAGMA foreign_keys` is never set

SQLite defaults foreign-key enforcement **off**. Neither `Store.__init__` nor `Hub.__init__`
sets it, so every foreign key in the new relational schema would be silently unenforced —
orphaned rows accumulate and nothing raises.

The pragma is per-connection. `StorePool.get()` constructs one `Store` per thread and each
`Store.__init__` opens its own connection, so `__init__` is the correct place: it is the
per-connection factory. Two sites — `store.py` and `hub.py`.

### 2. `synchronous=NORMAL`

Correct for disposable telemetry and documented as a deliberate trade. Wrong for a system of
record: with WAL, `NORMAL` can lose the last committed transactions on power loss. It will not
corrupt the file, but "committed" stops meaning committed.

Moving to `FULL` costs an fsync per commit. Metric writes are already batched
(`_BATCH_ROWS = 512`, `_FLUSH_INTERVAL = 2.0`), so the fsync amortises over hundreds of rows.
**To be measured, not assumed** — if throughput regresses materially, the fallback is a split:
telemetry at `NORMAL`, record tables at `FULL`.

### 3. No UNIQUE on `metrics(run_id, key, step)`

The TUF sink must survive a network drop by spooling locally and replaying. Replay is only
safe if it is idempotent, and idempotence needs the unique constraint plus an upsert. Without
it a reconnect duplicates rows and every chart silently double-counts.

**Migration hazard:** an existing database may already hold duplicates, in which case
`CREATE UNIQUE INDEX` fails. The migration must dedupe first, keeping the highest `rowid` per
`(run_id, key, step)`. `flush()` must move from `INSERT` to
`INSERT … ON CONFLICT(run_id, key, step) DO UPDATE`.

## Database design

Timestamps stay `REAL` unix epoch, matching the existing tables. No second convention.

### Auth

```sql
users          (id, username UNIQUE, pw_hash, role, created_at, pw_changed_at, disabled_at)
sessions       (id PK, user_id FK, created_at, last_seen, expires_at, ip, ua, revoked_at)
api_tokens     (id PK, name, secret_hash, scopes, created_at, last_used, expires_at, revoked_at)
login_attempts (id, username, ip, ts, ok)
audit_log      (seq PK, ts, actor_kind, actor_id, action, target, detail,
                request_id, prev_hash, hash)
```

`sessions.id` holds the SHA-256 of the cookie value; `api_tokens.secret_hash` the SHA-256 of
the token secret. **Neither plaintext is ever stored.** A database leak yields nothing
replayable.

### Curriculum — replaces the Markdown that went stale

```sql
phases         (id, slug UNIQUE, name, ord UNIQUE, status)
gates          (id, phase_id FK, slug, description, verify_cmd, UNIQUE(phase_id, slug))
gate_results   (id, gate_id FK, ts, passed, evidence, commit_sha, machine)
decisions      (id, slug, title, body, decided_at, superseded_by FK)
open_questions (id, slug UNIQUE, question, status, opened_at, closed_at, resolution)
```

`phases.ord UNIQUE` makes `CLAUDE.md` §5's *"do not reorder"* a database constraint rather
than a comment in a file.

`gates.verify_cmd` carries the command that proves the gate, so a gate result is evidence
rather than an assertion.

### Lineage

```sql
datasets    (id PK, name, n_examples, sha256, built_at, recipe, parent_id FK)
configs     (id PK = sha256(canonical yaml), phase_id FK, body, created_at)
checkpoints (id PK, run_id FK, step, path, sha256, size_bytes, kind)
evals       (id, subject_kind, subject_id, harness_sha, task_set, k, seed,
             score, n_problems, ran_at, machine,
             UNIQUE(subject_kind, subject_id, harness_sha, task_set, k, seed))
```

The UNIQUE on `evals` makes "three seeds" enforceable, and stops one seed being reported twice
as though it were two.

`runs` gains `config_id`, `dataset_id`, `phase_id`, `machine`, `commit_sha`. Those five
columns are what turn telemetry into lineage — the difference between "loss went down" and
"loss went down, on this data, with this config, at this commit, on this machine."

### Migrations — `PRAGMA user_version`, not Alembic

**Revised during implementation.** This ADR originally specified Alembic. It also rules out an
ORM, and those two decisions turn out to conflict: Alembic earns its keep through
`--autogenerate`, which diffs SQLAlchemy models against the live schema. With no models there
is nothing to diff, so Alembic reduces to ordered hand-written SQL plus a dependency, an
`alembic/` tree, an `env.py`, and `render_as_batch=True` to work around SQLite's `ALTER TABLE`.

SQLite answers the same question natively. `PRAGMA user_version` is a 32-bit integer in the
file header; a module-level tuple of `(version, name, apply)` and a loop is the whole
migration runner, in about 50 lines with no new dependency and in the same hand-written-SQL
style as the rest of `store.py`.

Two rules this imposes, both enforced by tests in `test_migrations.py`:

- **Append only.** Never renumber or edit a shipped entry. A database records the version it
  reached; renumbering entry 2 to 3 makes every database already at 2 skip the new 2 forever.
- **Each step must be safe to re-run.** DDL in Python's `sqlite3` does not reliably participate
  in a transaction, so a step that raises may leave the schema half-applied with
  `user_version` unbumped — and it will be retried on the next open. Idempotence is the only
  guarantee available, so it is the one relied on.

The trip-wire that would bring Alembic back: adopting an ORM, or needing real downgrade paths.

### Backups

- `VACUUM INTO 'snap-<ts>.db'` hourly — atomic and internally consistent, unlike `cp` against
  a live WAL database
- Retain 24 hourly, 30 daily
- Off-machine copy by rsync to `/data` on the TUF: separate disk, separate machine, no cloud
  (`CLAUDE.md` §8)
- `PRAGMA integrity_check` weekly
- **A quarterly restore drill.** A backup that has never been restored is a file, not a backup.

## Authentication and authorisation

| Element | Choice | Rejected alternative |
|---|---|---|
| Password hashing | Argon2id (`argon2-cffi`), m=64 MiB, t=3, p=4 | bcrypt — 72-byte truncation; passlib — heavy and stagnant |
| Session | Server-side, rows in SQLite | JWT: logout cannot revoke without a denylist, which is sessions with extra steps |
| Cookie | `__Host-tw_session`; `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` | |
| Token entropy | `secrets.token_urlsafe(32)` — 256 bits | |
| Lifetime | 12 h idle · 30 d absolute · id rotated on login | rotation defeats fixation |
| Machine auth | `Authorization: Bearer twk_<id>_<secret>`; scopes `telemetry:write`, `progress:write`, `read` | |
| Token storage | SHA-256 of the secret | Argon2 is unnecessary: 256-bit random has no dictionary to attack, so a KDF adds latency for nothing |
| Brute force | 5 failures → exponential backoff per `(username, ip)`; generic error text | |
| Comparison | `hmac.compare_digest` everywhere | `==` leaks timing |
| RBAC | `owner` (all) · `viewer` (read) · machine scopes | small, but the enforcement point exists from day one |

**Cookie trap.** The `__Host-` prefix requires the `Secure` attribute. Browsers treat
`http://localhost` as a secure context and permit `Secure` there, but behaviour differs from
the Tailscale HTTPS origin. Verify on **both** origins — `https://…ts.net` and
`http://127.0.0.1:8730` — before trusting either.

### The audit log is hash-chained

Every row stores `prev_hash`, and `hash = sha256(prev_hash ‖ canonical(row))`. Deleting or
editing history breaks the chain, and a verifier detects it. Roughly 60 lines of code.

This is the difference between having a log and having evidence, and it is the specific
control that answers *"work will be done by the agents without me knowing what's happening in
the infrastructure."*

## Controls — C7 to C13

C1–C6 from ADR-0003 are unchanged and still enforced by `SecurityGuard`.

| | Control | Defeats |
|---|---|---|
| C7 | `__Host-` prefixed `HttpOnly` `Secure` `SameSite=Lax` cookie | XSS token theft, cross-origin send, subdomain injection |
| C8 | Server-side revocable sessions | logout that does not revoke; stolen-token persistence |
| C9 | Argon2id + per-account backoff + generic errors | offline cracking, brute force, user enumeration |
| C10 | Scoped machine tokens, hashed at rest, revocable, last-used tracked | blast radius of a leaked device token |
| C11 | Hash-chained append-only audit log | unattributed and unnoticed writes |
| C12 | Synchroniser CSRF token on human write routes | residual CSRF beyond C2/C3 |
| C13 | `foreign_keys=ON` · `synchronous=FULL` · hourly `VACUUM INTO` · restore drill | silent corruption, orphaned rows, data loss |

## The TUF sink

`emit.py` has exactly three sinks — `StoreSink`, `TensorBoardSink`, `WandbSink` — and none of
them touch the network. Only `client.py` and `notify.py` do. Hosting on the Mac therefore
requires a fourth sink. Requirements in priority order:

1. **Never block the training loop.** Bounded queue, background thread, drop-newest with a
   counter on overflow. A monitoring stall must not stall a three-hour SFT run.
2. **Store and forward.** Network down → spool to local SQLite → replay on reconnect. Without
   this a Wi-Fi hiccup punches a silent hole in the history, which defeats the premise.
3. **Idempotent replay.** Upsert on `(run_id, key, step)`. Safe to run twice.
4. **Authenticated** with a `telemetry:write` token, not an open endpoint.

**Gate:** pull the cable mid-run, reconnect, and assert zero gaps *and* zero duplicates. Until
that test exists, the sink is not done.

## Build order

| | Slice | Gate — binary, before moving on |
|---|---|---|
| **A** | Durable core: pragmas, dedupe migration, Alembic, backups | `kill -9` mid-write → restore → `integrity_check` clean |
| **C** | Curriculum and gates | `STATUS.md` is *generated from* the DB, never hand-edited again |
| **B** | Auth and the audit chain | revocation works · rate limit fires · chain verifies · tamper detected |
| **D** | TUF sink | cable pulled mid-run → no gaps, no duplicates |
| **E** | Lineage and UI | `results/00-baseline.md` becomes a query |

A and C run first, deliberately out of letter order. They are about two days and they fix the
concrete failure that prompted this ADR. B and D must land **before the first real training
sweep**, so telemetry has somewhere trustworthy to arrive. E is least load-bearing.

### Cost against the curriculum — stated plainly

Roughly 2,950 lines including tests at ADR-0002's L2 bar, about 7.5 days. Meanwhile the
pipeline is blocked at Phase 1, the eval harness: pure Python, no compiler, no GPU, nothing
standing in its way. This ADR is infrastructure for a project whose next real step is
unblocked and unbuilt. Slicing A+C first is what keeps that honest.

## Non-goals

Public exposure · multi-tenancy · OAuth/SSO · Postgres · a secret manager (`.env` at `0600`) ·
high availability · `tailscale funnel` (forbidden).

## Accepted risks

| Risk | Why acceptable | Trip-wire that forces a revisit |
|---|---|---|
| Single-writer SQLite | One human, a few machines, small batched writes | Sustained `SQLITE_BUSY` under normal load |
| No off-site backup | `/data` on the TUF is a separate disk on a separate machine; cloud is ruled out | Both machines in one location becomes a loss event worth insuring against |
| Tailnet is still the outer boundary | App auth is defence in depth, not the only wall | Anything needs to be reachable off-tailnet |
| `.env` secrets on disk at `0600` | Single-user machine | A second human gets an account |
| `synchronous=FULL` throughput unmeasured | Writes are batched 512-deep | Measured regression → split telemetry/record durability |
