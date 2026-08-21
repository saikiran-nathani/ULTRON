# `data/` — row shapes

Append-only, per slide 12: `raw/` is never edited, every transformation writes a
new directory. Contents are gitignored; only this file and the `.gitkeep` markers
are tracked.

```
raw/        downloaded, never modified
interim/    filtered, deduped, decontaminated  <- untemplated
processed/  templated, versioned v1..vN
```

## `interim/` — one JSON object per line

What `src/data/measure_lengths.py` reads. Untemplated: the script applies the
chat template itself, because templated length is what has to fit `seq_len`.

```json
{"id": "oci-000123", "source": "opencodeinstruct", "prompt": "Write a function that...", "response": "def solve(n):\n    return n * 2\n"}
```

| Field | Required | Notes |
|---|---|---|
| `id` | recommended | stable across rebuilds — the hash partition keys on it |
| `source` | recommended | provenance; lets you filter or weight by origin later |
| `prompt` | **yes** | the user turn, no template markup |
| `response` | **yes** | the assistant turn, no template markup |
| `meta` | optional | anything else; ignored by these scripts |

Rules the scripts enforce:

- `prompt` and `response` must be non-empty strings.
- No template markup in either field. Write plain text — the template is applied
  downstream. A literal `<|im_start|>` or `<|im_end|>` in content is encoded as
  the real special token and truncates the turn (slide 27).

## Verifiable sets — a superset

Sets used by the verifier (RFT, GRPO) add two fields to the same shape:

| Field | Notes |
|---|---|
| `test_kind` | `"assert"` \| `"call"` \| `"stdio"` — picks the executor |
| `tests` | assert: `list[str]` · call: `[{"args": [...], "want": ...}]` · stdio: `[{"stdin": "...", "stdout": "..."}]` |

`response` stays the reference solution. A row with no tests is SFT-only.

## `processed/`

Written by the templating step, versioned (`v1`, `v2`, ...). The version string
goes in the run config as `data_version`, per slide 13 — a run that does not
record it is not reproducible.
