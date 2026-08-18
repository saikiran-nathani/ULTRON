"""Code extraction — where points quietly vanish.

An extractor that takes the *first* fenced block costs real points: a model that
explains a naive approach, shows it, then gives the good one gets scored on the naive
one. The field guide records 4 points lost to exactly this.

Extraction failures are counted separately and on purpose. If 8% of generations fail to
extract, that is an 8-point ceiling on your score that has nothing to do with the model,
and it will otherwise look like a capability problem forever.

Stdlib only. Imported by the harness on both machines.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass

# Opening fence, optional language tag, then body, then closing fence. Non-greedy so
# consecutive blocks do not get merged into one.
_FENCED = re.compile(r"```[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*\r?\n(.*?)```", re.DOTALL)
_OPEN_FENCE = re.compile(r"```[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*\r?\n")

# For raw-completion eval: stop before the model starts writing the next thing.
DEFAULT_STOPS = ("\ndef ", "\nclass ", "\nif __name__", "\nprint(", "\n@")

OK = "ok"
OK_UNFENCED = "ok_unfenced"
OK_UNTERMINATED = "ok_unterminated_fence"
EXTRACT_FAIL = "extract_fail"


@dataclass
class Extraction:
    code: str
    status: str
    n_blocks: int = 0

    @property
    def ok(self) -> bool:
        return self.status != EXTRACT_FAIL


def _parses(src: str) -> bool:
    if not src.strip():
        return False
    try:
        ast.parse(src)
        return True
    except (SyntaxError, ValueError):
        return False


def extract_code(text: str, *, prefer: str = "last") -> Extraction:
    """Pull the solution out of a model response.

    prefer:
      'last'  -- the LAST complete fenced block. The documented default, and what the
                 field guide prescribes: models routinely show a wrong approach first.
      'last_parsing' -- the last complete block that is valid Python. Slightly more
                 robust to trailing prose blocks, but it can pick a usage example over
                 the real solution. Treat a change of strategy as its own experiment
                 with its own baseline, not a cleanup commit.

    Handles: no fences, unlabeled fences, multiple blocks, and unterminated fences.
    """
    if prefer not in ("last", "last_parsing"):
        raise ValueError(f"unknown prefer={prefer!r}")
    if not text or not text.strip():
        return Extraction("", EXTRACT_FAIL, 0)

    blocks = [(tag.lower(), body) for tag, body in _FENCED.findall(text)]
    if blocks:
        # Prose-only fences (output samples, tracebacks) are not candidates.
        code_blocks = [b for tag, b in blocks if tag in ("", "python", "py", "python3")]
        candidates = code_blocks or [b for _, b in blocks]
        if prefer == "last_parsing":
            chosen = next((b for b in reversed(candidates) if _parses(b)), candidates[-1])
        else:
            chosen = candidates[-1]
        chosen = chosen.strip("\n")
        return Extraction(
            chosen, OK if _parses(chosen) else EXTRACT_FAIL, len(blocks)
        )

    # An opening fence with no close: the generation was truncated mid-block. Everything
    # after the last opening fence is the best available guess.
    opens = list(_OPEN_FENCE.finditer(text))
    if opens:
        tail = text[opens[-1].end():].strip("\n")
        # Drop a trailing partial fence if one is being emitted.
        tail = re.sub(r"\n?`{1,3}\s*$", "", tail)
        return Extraction(
            tail, OK_UNTERMINATED if _parses(tail) else EXTRACT_FAIL, len(opens)
        )

    # No fences at all. Common for base models and raw-completion eval.
    body = text.strip("\n")
    if _parses(body):
        return Extraction(body, OK_UNFENCED, 0)
    return Extraction(body, EXTRACT_FAIL, 0)


def truncate_at_stops(text: str, stops: tuple[str, ...] = DEFAULT_STOPS) -> str:
    """Cut a raw completion at the first stop sequence.

    Wrong stops truncate valid solutions, so this is only for raw-completion eval --
    never apply it to a chat-template response, where fences already delimit the code.
    """
    cut = len(text)
    for stop in stops:
        idx = text.find(stop)
        if idx != -1:
            cut = min(cut, idx)
    return text[:cut]


def strip_prompt_echo(completion: str, prompt_signature: str) -> str:
    """Remove a re-emitted function signature.

    If the model repeats the signature and you also prepend the prompt, you get a
    duplicate `def` and a syntax error on otherwise correct code.
    """
    sig = prompt_signature.strip()
    if not sig:
        return completion
    stripped = completion.lstrip()
    if stripped.startswith(sig):
        return stripped[len(sig):].lstrip("\n")
    return completion


if __name__ == "__main__":
    # The trap this file exists for: explain, show a wrong approach, then the right one.
    two_blocks = (
        "Here is a naive approach:\n\n"
        "```python\ndef add(a, b):\n    return a - b\n```\n\n"
        "That is wrong. Here is the correct one:\n\n"
        "```python\ndef add(a, b):\n    return a + b\n```\n"
    )
    got = extract_code(two_blocks)
    assert got.status == OK and got.n_blocks == 2, got
    assert "a + b" in got.code and "a - b" not in got.code, "took the FIRST block"

    # Unlabeled fence.
    assert extract_code("```\ndef f():\n    return 1\n```").status == OK
    # No fences.
    assert extract_code("def f():\n    return 1\n").status == OK_UNFENCED
    # Unterminated fence (truncated generation).
    r = extract_code("Sure:\n```python\ndef f():\n    return 1\n")
    assert r.status == OK_UNTERMINATED and "return 1" in r.code, r
    # Prose inside the fence is an extraction failure, counted separately.
    assert extract_code("```python\nthis is not code at all!!\n```").status == EXTRACT_FAIL
    # Empty response.
    assert extract_code("").status == EXTRACT_FAIL
    assert extract_code("   \n ").status == EXTRACT_FAIL
    # A non-python fence should not be preferred over the python one.
    mixed = "```text\nnonsense here\n```\n```python\nx = 1\n```\n"
    assert extract_code(mixed).code == "x = 1", extract_code(mixed)
    # last_parsing skips a trailing unparseable block; 'last' does not.
    trailing = "```python\nx = 1\n```\n```python\n>>> x\n1\n```\n"
    assert extract_code(trailing, prefer="last").status == EXTRACT_FAIL
    assert extract_code(trailing, prefer="last_parsing").code == "x = 1"
    # Stops and echo.
    assert truncate_at_stops("    return a + b\ndef other():\n    pass") == "    return a + b"
    # Indentation of the body must survive -- it is the function body, and lstrip()ing
    # it would turn correct code into an IndentationError.
    assert strip_prompt_echo("def f(x):\n    return x", "def f(x):") == "    return x"
    assert strip_prompt_echo("    return x", "def f(x):") == "    return x"
    print("extract: all checks passed")
