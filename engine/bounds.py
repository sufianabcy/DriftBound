"""The proven limits, as plain functions.

Every number the dashboard draws as a "bound" comes from here, and every
function matches a statement in docs/theory.md. Nothing here touches engine
state, so the tests can check the formulas directly.
"""

from __future__ import annotations

import math


def ceil_log2(m: int) -> int:
    """Smallest d with 2**d >= m, for m >= 1 (exact integer arithmetic)."""
    if m < 1:
        raise ValueError("m must be at least 1")
    return (m - 1).bit_length()


def recovery_labels(n: int) -> int:
    """Labels to identify one of the n + 1 threshold rules: ceil(log2(n + 1)).

    Upper bound: binary search (Theorem 3). Lower bound: the halving adversary
    (Theorem 4). With n = 1023 both sides are 10.
    """
    return ceil_log2(n + 1)


def recall_labels(k: int) -> int:
    """Labels to recover a rule that is one of k stored rules: ceil(log2 k) + 2."""
    if k < 1:
        raise ValueError("recall needs at least one stored rule")
    return ceil_log2(k) + 2


def recall_fallback_labels(k: int, n: int) -> int:
    """Worst case when recall is tried and the rule turns out to be new."""
    return recall_labels(k) + recovery_labels(n)


def recall_is_worthwhile(k: int, n: int) -> bool:
    """Use memory only when its worst case beats a plain binary search."""
    return k >= 1 and recall_labels(k) < recovery_labels(n)


def expected_mistakes_before_detection(p: float) -> float | None:
    """Labeling a fraction p lets 1/p mistakes pass on average (Theorem 7).

    Returns None when p == 0: the drift is never detected (Impossibility 1a).
    """
    if p <= 0:
        return None
    return 1.0 / p


def mistakes_per_drift(n: int) -> int:
    """With p = 1: one detecting mistake plus at most one per recovery step."""
    return 1 + recovery_labels(n)


def halving_mistakes(num_rules: int) -> int:
    """Mistake bound of the Halving algorithm: floor(log2 |H|) (Littlestone 1988)."""
    if num_rules < 1:
        raise ValueError("need at least one rule")
    return num_rules.bit_length() - 1


def threshold_littlestone_dimension(n: int) -> int:
    """Ldim of thresholds on n points (n + 1 rules) is floor(log2(n + 1))."""
    return halving_mistakes(n + 1)


def kraft_sum(depths: list[int]) -> float:
    """Sum of 2**-d over the label counts of an exact identification strategy.

    Any strategy is a binary decision tree, so this is at most 1 (Theorem 6).
    """
    return sum(2.0**-d for d in depths)


def noise_floor(noise: float) -> float:
    """Even the true rule disagrees with a fraction `noise` of observed labels."""
    return noise


def noisy_detection_labels(eps: float, noise: float, delta: float) -> float:
    """Labels any detector needs so that false alarm + miss <= 2 * delta.

    Bretagnolle-Huber bound for a drift that changes a fraction eps of inputs
    under label noise `noise` (0 < noise < 1/2). It grows like 1/eps, so no
    fixed budget covers every eps (Impossibility 1b).
    """
    if not (0 < eps <= 1 and 0 < noise < 0.5 and 0 < delta < 0.25):
        raise ValueError("need 0 < eps <= 1, 0 < noise < 0.5, 0 < delta < 0.25")
    kl_per_label = eps * (1 - 2 * noise) * math.log((1 - noise) / noise)
    return math.log(1 / (4 * delta)) / kl_per_label
