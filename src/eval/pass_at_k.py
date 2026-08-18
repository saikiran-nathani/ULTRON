"""pass@k — the unbiased estimator, and the aggregation around it.

pass@k is the probability that at least one of k sampled solutions passes all tests. It
is NOT a percentage of problems solved: it is an estimate of a probability, and the way
you estimate it matters enormously.

Reference: Chen et al., "Evaluating Large Language Models Trained on Code" (Codex).

Stdlib only, deliberately -- this is imported by the harness on both machines and must
not drag numpy into a fresh environment.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence


def pass_at_k(n: int, c: int, k: int) -> float:
    """Unbiased estimate of pass@k for one problem.

    n = samples generated for the problem (n >> k)
    c = how many of those n passed

    The naive alternative -- sample k and check -- is a Bernoulli draw per problem with
    enormous variance. This uses all n samples to estimate the same quantity with far
    less noise.
    """
    if k <= 0:
        raise ValueError("k must be >= 1")
    if n <= 0:
        raise ValueError("n must be >= 1")
    if not 0 <= c <= n:
        raise ValueError(f"c must satisfy 0 <= c <= n, got c={c}, n={n}")
    if k > n:
        raise ValueError(
            f"pass@{k} needs n >= {k} samples per problem, got n={n}. "
            "Generate more samples; do not silently report a smaller k."
        )
    if n - c < k:
        return 1.0
    # 1 - C(n-c, k)/C(n, k), computed as a running product to stay numerically stable.
    prod = 1.0
    for i in range(n - c + 1, n + 1):
        prod *= 1.0 - k / i
    return 1.0 - prod


def pass_at_k_over_problems(counts: Iterable[tuple[int, int]], k: int) -> float:
    """Mean of per-problem pass@k. `counts` is an iterable of (n, c) pairs.

    Averaging the per-problem estimates is the correct aggregation. Pooling all samples
    across problems first is a different (and wrong) quantity.
    """
    values = [pass_at_k(n, c, k) for n, c in counts]
    if not values:
        raise ValueError("no problems to score")
    return sum(values) / len(values)


def mean_std(values: Sequence[float]) -> tuple[float, float]:
    """Mean and sample standard deviation across seeds.

    Three seeds is the minimum honest experiment. On 164 problems the across-seed std is
    typically 1.5-2.5 points, so a number without a std is an anecdote: a +1.5 point
    delta is indistinguishable from noise no matter how good it looks.
    """
    n = len(values)
    if n == 0:
        raise ValueError("no values")
    mean = sum(values) / n
    if n == 1:
        # Not 0.0 -- a single seed has unknown spread, and reporting 0.0 invites exactly
        # the false confidence this function exists to prevent.
        return mean, float("nan")
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    return mean, math.sqrt(var)


def format_score(values: Sequence[float], places: int = 1) -> str:
    """Render as `mean ± std` for results/NN-phase.md."""
    mean, std = mean_std(values)
    if math.isnan(std):
        return f"{mean:.{places}f} (1 seed — no std, not yet a result)"
    return f"{mean:.{places}f} ± {std:.{places}f}"


if __name__ == "__main__":
    # Sanity checks, from the estimator's definition.
    assert pass_at_k(1, 1, 1) == 1.0
    assert pass_at_k(1, 0, 1) == 0.0
    assert pass_at_k(20, 0, 1) == 0.0
    assert pass_at_k(20, 20, 1) == 1.0
    assert abs(pass_at_k(20, 10, 1) - 0.5) < 1e-12, "pass@1 with c/n=0.5 must be 0.5"
    # pass@k is monotonically non-decreasing in k.
    ks = [pass_at_k(20, 5, k) for k in (1, 2, 5, 10)]
    assert ks == sorted(ks), ks
    # 5 of 20 passing: pass@1 = 0.25, and pass@10 must be far higher.
    assert abs(pass_at_k(20, 5, 1) - 0.25) < 1e-12
    assert pass_at_k(20, 5, 10) > 0.9
    # Asking for pass@10 from n=1 is an error, not a silently smaller k.
    try:
        pass_at_k(1, 1, 10)
    except ValueError:
        pass
    else:
        raise AssertionError("k > n must raise")
    m, s = mean_std([26.2, 24.9, 27.1])
    assert abs(m - 26.066666) < 1e-4 and 1.0 < s < 1.2, (m, s)
    assert "±" in format_score([26.2, 24.9, 27.1])
    assert "1 seed" in format_score([26.2])
    print("pass_at_k: all checks passed")
