# ADR-0002 — Production depth profile

- **Status:** Accepted — *security section superseded by [ADR-0003](0003-writable-hub-and-browser-threat-model.md)*
- **Date:** 2026-08-17

## Triage

| Question | Answer |
|---|---|
| External/public users? | No — single user |
| Handles PII or money? | No |
| Authenticated? | No app-level auth; **the tailnet is the auth boundary** |
| Regulated (GDPR/HIPAA/PCI/SOC2)? | No |
| Does uptime carry revenue/reputation? | No — but a missed alert costs a night of GPU time |
| Scales beyond one machine? | No, by design (see ADR-0001) |

## Decision

**Profile: Standard — target L2 across the board.** Two deliberate deviations:

- **Reliability of the notify path is bumped toward L3.** It is the only part of
  this system whose failure is *silent*. Everything else fails loudly or is
  visibly blank. So: the notifier never raises, retries with backoff, dedupes,
  and the liveness check runs **out of process** (cron) so it can fire when the
  trainer itself is dead. Tests cover the failure-isolation path specifically.
- **Security is held at L1-plus, on purpose.** The API binds `0.0.0.0` with no
  auth. That is only acceptable because Tailscale — not the app — is the network
  boundary, and the API is read-only. This is an **accepted risk**, recorded
  below, not an oversight.

## Accepted risks

| Risk | Why accepted | Trip-wire that forces a revisit |
|---|---|---|
| ~~No app-level authn/authz on the dashboard API~~ | ~~Read-only data on a private WAN-less tailnet~~ | **FIRED (2026-08-21)** — the device hub added write endpoints. Re-derived in [ADR-0003](0003-writable-hub-and-browser-threat-model.md): the posture is now unauthenticated but Host- and Origin-bound, with an optional token. |
| ntfy.sh is a third party that can read topic contents | Alert bodies are step numbers and loss values, not secrets; topic name is high-entropy | Alerts start carrying anything sensitive → self-host ntfy on the tailnet |
| Built dashboard committed to git | Keeps Node off the training box | Build output starts causing merge pain |
| No backups of `var/trainwatch.db` | It is derived telemetry, reproducible by re-running; checkpoints are the real artifact | The store ever becomes the system of record for anything |

## What L2 means concretely here

- Tests: pytest on the risky paths (rules, notifier isolation, store concurrency,
  liveness math), coverage floor 70%, gated in CI.
- Static analysis: ruff + mypy `strict` on the package, gated in CI.
- Observability: structured logging; the dashboard *is* the metrics surface.
- Ops: a runbook (`docs/runbook.md`) covering the six failure modes the source
  guide names.
