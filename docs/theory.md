# DriftBound: the theory

The problem statement asks for zero-error detection and adaptation under any drift. That is provably impossible,
and the statement itself accepts "a matching impossibility result". This document gives both halves: the
conditions under which zero error is achievable, an engine that achieves it with matching label bounds, and the
impossibility results that show every condition is necessary.

Each result names the test that checks it (`tests/`) and, where it is a statistical claim, the measurement in
`notebooks/experiments.py`.

## At a glance

| Condition | Zero error is achievable when | It is provably impossible when | Result |
|---|---|---|---|
| A1. Rule family | the true rule always comes from a known finite set | any rule at all is allowed | Impossibility 2 |
| A2. Labels | labels are correct | labels are noisy | Impossibility 1c, noise floor |
| A3. Label access | the engine can request labels after a drift | no labels arrive after a drift | Impossibility 1a |
| A4. Drift timing | drifts are at least one adaptation period apart | the rule may change at every step | Impossibility 3 |

Under A1 to A4 the exact engine guarantees, for thresholds on $N$ points:

1. **Zero false alarms** (Theorem 1).
2. **Harmful drift is caught at its first labeled mistake** (Theorem 2).
3. **Harmless drift is ignored and costs nothing** (Corollary 2.2).
4. **Zero error after adaptation**, in exactly $\lceil \log_2 (N+1) \rceil$ labels (Theorem 3).

The label bounds match: binary search uses $\lceil \log_2 (N+1) \rceil$ labels, and no learner can use fewer
(Theorem 4). With $N = 1023$ both sides are **10**. Memory brings a returning rule back in
$\lceil \log_2 K \rceil + 2$ labels (Theorem 5), and that speed has a provable price on new rules (Theorem 6).

One more fact frames all of this: **no learner avoids the first mistake of a drift** (Theorem 8). So "zero error"
can only ever mean zero false alarms, a bounded number of mistakes per drift, and zero error once adapted. That is
exactly what the exact engine delivers.

---

## 1. Setting

**Inputs.** At each step $t = 1, 2, \dots$ an input $x_t \in X = \{1, \dots, N\}$ arrives, independently and uniformly
at random. Most results hold for any input sequence; the ones that need uniform inputs say so.

**Rules.** The family is the thresholds $H_N = \{h_\theta : \theta \in \{1, \dots, N+1\}\}$ with
$h_\theta(x) = 1$ if $x \ge \theta$ and $0$ otherwise. There are $|H_N| = N + 1$ rules; $\theta = 1$ labels
everything 1 and $\theta = N + 1$ labels everything 0. Distinct thresholds are distinct functions on $X$.

**Concepts and drift.** The true rule at step $t$ is $c_t$. A *drift* at step $t$ means $c_t \ne c_{t-1}$. Drift is
pure concept drift: the input distribution never changes, only the labeling.

**Protocol per step.**

1. $x_t$ arrives and the learner predicts $\hat y_t$.
2. The learner may buy labels:
   - a **membership query** $q \in X$, answered by the label oracle with $c_t(q)$ [Angluin 1988];
   - the **label of the arriving point**, $c_t(x_t)$. The exact engine requests it with probability $p$ while
     monitoring.
3. Under label noise $\eta$, every label the learner receives is flipped independently with probability $\eta$.

**Costs.** A *mistake* is $\hat y_t \ne c_t(x_t)$, measured against the true rule. *Labels* counts every label
bought. A *false alarm* is a drift declaration when the rule has not changed since the learner last reset. The
*detection delay* is the number of steps from a drift to its declaration.

## 2. The exact engine

`engine/exact.py`. The engine keeps the **version space**, the set of rules consistent with every label received
since its last reset.

**Lemma 1 (the version space is an interval).** Given labels $(x_i, y_i)$, the consistent thresholds are exactly
$[lo, hi]$ with $lo = 1 + \max\{x_i : y_i = 0\}$ and $hi = \min\{x_i : y_i = 1\}$, taking $\max \emptyset = 0$ and
$\min \emptyset = N + 1$. So a label $(x, 1)$ sets $hi \leftarrow \min(hi, x)$, a label $(x, 0)$ sets
$lo \leftarrow \max(lo, x + 1)$, and the set is empty exactly when $lo > hi$.

*Proof.* $h_\theta(x) = 1 \iff \theta \le x$. A label $(x, 1)$ is consistent exactly with $\theta \le x$, and a label
$(x, 0)$ exactly with $\theta \ge x + 1$. Intersecting these half-lines gives the interval. $\square$

*Test:* `test_version_space_is_exactly_the_set_of_consistent_rules` brute-forces 300 random label sets.

**The algorithm.**

- **Predict** with the majority vote of the version space: $\hat y = 1$ iff $x \ge \lfloor (lo + hi)/2 \rfloor$.
  This is the Halving rule [Littlestone 1988], with ties going to 1.
- **Learning** (more than one rule left): one membership query per step, at $q = \lfloor (lo + hi - 1)/2 \rfloor$.
  The answer keeps $[lo, q]$ or $[q + 1, hi]$, of sizes $\lfloor s/2 \rfloor$ and $\lceil s/2 \rceil$ where
  $s = hi - lo + 1$. The query always satisfies $1 \le q \le N$.
- **Monitoring** (one rule left): with probability $p$, request the label of the arriving point.
- **Detection**: the version space is empty. Declare drift, reset to all $N + 1$ rules, and learn again.
- **Recall** (optional): after a reset, if memory holds rules, the queries first split the stored rules instead of
  the whole range (Section 4.3).

## 3. Guarantees under the four conditions

The conditions, stated precisely:

- **A1 (realizable):** $c_t \in H_N$ for every $t$.
- **A2 (clean labels):** every label received equals $c_t$ at the queried point ($\eta = 0$).
- **A3 (label access):** membership queries are answered during learning, and $p > 0$ while monitoring.
- **A4 (drift separation):** no drift lands between a reset and the convergence that follows it. In words: each
  drift arrives after the previous one has been detected and recovered from.

**Theorem 1 (zero false alarms).** Under A1 and A2, if the rule has not changed since the last reset, the engine
never declares drift.

*Proof.* Let $c = h_{\theta^\*}$ be the unchanged rule. Every label since the reset is $c$'s label (A2), so
$\theta^\*$ is consistent with all of them and stays in $[lo, hi]$. The version space is never empty, and an empty
version space is the only trigger. $\square$

*Test:* `test_zero_false_alarms_and_zero_error_over_100k_drift_free_steps` (100,000 steps, 0 detections).

**Theorem 2 (caught at the first labeled mistake).** Under A2, suppose the engine is monitoring with rule
$\hat\theta$ (so $lo = hi = \hat\theta$). It declares drift at step $t$ if and only if it labels $x_t$ and
$h_{\hat\theta}(x_t) \ne c_t(x_t)$.

*Proof.* A label that agrees with $h_{\hat\theta}$ leaves $[\hat\theta, \hat\theta]$ unchanged (Lemma 1). A label
that disagrees removes $\hat\theta$, the only candidate, so the set becomes empty. $\square$

*Corollary 2.1.* With $p = 1$ every point is labeled, so a harmful drift is declared at its very first mistake.

*Corollary 2.2 (harmless drift).* A drift such that no arriving point falls where the old and new rules disagree
causes no mistake and is never declared. Both events require a point in the disagreement region.

*Tests:* `test_harmful_drift_is_caught_at_its_first_labeled_mistake` (25 seeds),
`test_with_sparse_labels_only_a_labeled_mistake_triggers_detection`,
`test_harmless_drift_is_ignored_and_costs_nothing`.

**Theorem 3 (exact recovery, then zero error).** Under A1, A2 and A4, after a reset the engine identifies the new
rule $\theta^\*$ with at most $\lceil \log_2 (N+1) \rceil$ queries, exactly that many when $N + 1$ is a power of two.
From then on every prediction is correct until the next drift.

*Proof.* By A4 every query answer comes from $h_{\theta^\*}$, so $\theta^\*$ stays in the interval (Lemma 1). Each
query leaves at most $\lceil s/2 \rceil$ of $s$ rules. Starting from $N + 1$, that reaches one rule after
$\lceil \log_2 (N+1) \rceil$ queries. When $N + 1 = 2^m$, every split is exactly even, so it takes exactly $m$
queries. The last rule left is $\theta^\*$, so the prediction $h_{\theta^\*}(x)$ is right for every $x$ while
$c_t = h_{\theta^\*}$. $\square$

*Corollary 3.1 (mistakes per drift).* With $p = 1$ a drift costs at most $1 + \lceil \log_2 (N+1) \rceil$ mistakes:
the detecting one, plus at most one per learning step. With $N = 1023$ that is 11.

*Tests:* `test_every_rule_is_identified_in_exactly_ten_labels` (all 1,024 rules),
`test_binary_search_meets_the_upper_bound_for_any_n`, `test_zero_error_after_every_adaptation`,
`test_recovery_after_abrupt_drift_takes_exactly_ten_labels` (also checks Corollary 3.1).

> **Why the engine forgets the detecting label.** The label that triggered detection carries information about the
> new rule, and keeping it could save at most one query: it leaves at least half the rules alive in the worst case.
> The engine discards it on purpose. Recovery then becomes exactly the from-scratch identification problem, so its
> cost is exactly $\lceil \log_2 (N+1) \rceil$ and meets the lower bound below. The recovery path also stops
> depending on the random input, which lets the worst-case adversary compute its attack in advance (Section 6). The
> detecting label is counted as monitoring cost.

## 4. Label complexity

### 4.1 Upper and lower bound

$$\text{labels to recover from one drift} = \lceil \log_2 (N+1) \rceil$$

The upper bound is Theorem 3. The lower bound:

**Theorem 4 (no learner recovers faster).** Let a learner start a recovery with all $N + 1$ rules possible. For every
deterministic learner and every $k < \lceil \log_2 (N+1) \rceil$, there is a rule for which at least two rules are
still consistent after $k$ labels. Such a learner cannot guarantee zero error.

*Proof.* An adversary keeps the set $S$ of rules consistent with its answers so far. For any labeled point $x$
(query or arriving point), answer 1 keeps $S_1 = \{\theta \in S : \theta \le x\}$ and answer 0 keeps
$S_0 = \{\theta \in S : \theta > x\}$. These are disjoint with $|S_0| + |S_1| = |S|$, so the adversary keeps the
larger one, of size at least $|S|/2$. After $k$ answers, $|S| \ge (N+1)/2^k > 1$. The adversary commits to a rule only
at the end, and every answer it gave is consistent with that rule.

With two consistent thresholds $\theta_1 < \theta_2$ left, every input in $[\theta_1, \theta_2 - 1]$ is labeled
differently by them. Under uniform inputs such an input arrives with probability at least $1/N$ per step. Whatever the
learner predicts on it, one of the two rules makes that prediction wrong, and the adversary can commit to that one.
$\square$

*Randomized learners.* If the new rule is uniform over the $N + 1$ rules, any strategy is a binary decision tree
whose leaves identify rules. The expected depth is at least the entropy $\log_2 (N+1)$ (Kraft inequality plus Gibbs'
inequality [Cover and Thomas 2006, Thm 5.3.1]). By Yao's principle [Yao 1977], randomization cannot beat this on
average.

*Tests:* `test_halving_adversary_beats_every_query_strategy` runs five strategies against the adversary;
`test_worst_case_answers_force_exactly_ten_labels_without_memory` runs it live. *Measured:* 30 adversarial
recoveries without memory, all exactly 10 labels.

### 4.2 Other rule families

With a label on every point, the Halving algorithm makes at most $\lfloor \log_2 |H| \rfloor$ mistakes per drift, and
no algorithm can guarantee fewer mistakes than the Littlestone dimension of the family [Littlestone 1988]. For
thresholds on $N$ points the Littlestone dimension is $\lfloor \log_2 (N+1) \rfloor = 10$, so the threshold family
sits right at its own limit.

### 4.3 Concept memory

`engine/memory.py`, `ExactEngine.next_query`. After a reset with $K$ usable stored rules (stored rules other than the
one just contradicted), the engine first splits the stored rules. A query at the $\lceil K/2 \rceil$-th stored
threshold keeps half of them, whatever the answer. Once one stored rule $t$ is left, two queries confirm it: label 0
at $t - 1$ and label 1 at $t$, skipping any query the interval already answers. If no stored rule survives, binary
search continues on what is left of the interval, keeping every label already bought. Recall is used only when
$\lceil \log_2 K \rceil + 2 < \lceil \log_2 (N+1) \rceil$.

**Theorem 5 (recall).** If the new rule is one of the $K$ usable stored rules, recovery takes at most
$\lceil \log_2 K \rceil + 2$ labels. Otherwise it takes at most $\lceil \log_2 K \rceil + 2 + \lceil \log_2 (N+1) \rceil$,
and the rule found is still exact.

*Proof.* Each splitting query halves the stored candidates (rounding up), so one is left after
$\lceil \log_2 K \rceil$ queries. Confirmation takes at most 2 more. If the rule is stored, the confirmation succeeds
and the interval is the single rule. If not, at most $\lceil \log_2 K \rceil + 2$ labels were spent before the
fallback. The fallback is binary search on a subset of the full range, so it needs at most $\lceil \log_2 (N+1) \rceil$
more. Correctness is Lemma 1 throughout: the interval always holds exactly the consistent rules. $\square$

*Tests:* `test_returning_rule_is_recovered_within_log2k_plus_2_labels`,
`test_new_rule_falls_back_and_stays_within_its_bound`, `test_recurring_drift_end_to_end`.

*Measured, 200 trials per $K$:*

| $K$ | returning rule: max (bound) | new rule: max (bound) |
|---|---|---|
| 1 | 2 (2) | 12 (12) |
| 2 | 3 (3) | 13 (13) |
| 4 | 4 (4) | 14 (14) |
| 8 | 5 (5) | 15 (15) |

Both bounds are reached, so they are tight.

**Theorem 6 (memory has a price).** Let $d(\theta)$ be the number of labels an exact identification strategy uses
when the rule is $\theta$. Then $\sum_\theta 2^{-d(\theta)} \le 1$. If $N + 1 = 2^m$ and some rule is identified in
fewer than $m$ labels, some other rule needs more than $m$.

*Proof.* A deterministic strategy is a binary decision tree whose leaves name single rules, and a rule's depth is its
label count. Kraft's inequality for binary trees gives $\sum 2^{-d} \le 1$ [Kraft 1949; Cover and Thomas 2006, Thm
5.2.1]. If every $d(\theta) \le m$, the sum is at least $2^m \cdot 2^{-m} = 1$, so equality holds and every
$d(\theta) = m$. So any rule with $d < m$ forces another with $d > m$. $\square$

So a learner fast on returning rules must be slow on some new rule. That is why the dashboard draws each recovery's
own bound tick, and why bars that recalled and missed sit above the dashed 10-label line. The worst-case adversary
exploits exactly this: with memory on it forces 12 to 13 labels (measured mean 12.6), never fewer than 10.

*Test:* `test_memory_has_a_price` computes all 1,024 depths with three stored rules.

### 4.4 Monitoring cost

**Theorem 7 (labels buy speed).** Under A2, suppose a drift creates a disagreement region $D$ of $\varepsilon N$
inputs and the rule then holds still. The number of mistakes up to and including detection is geometric with
parameter $p$, with mean $1/p$. Under uniform inputs the expected detection delay is $1/(p\varepsilon)$ steps.

*Proof.* Mistakes happen exactly at steps with $x_t \in D$. Each is labeled independently with probability $p$, and
by Theorem 2 detection happens at the first labeled one. Labeled points outside $D$ change nothing. So the count is
geometric in $p$. Each step independently has $x_t \in D$ and a label with probability $p\varepsilon$, which gives
the delay. $\square$

*Measured, 300 seeds each:*

| $p$ | mistakes before detection (mean) | $1/p$ |
|---|---|---|
| 1 | 1.00 | 1 |
| 0.5 | 2.08 | 2 |
| 0.25 | 4.03 | 4 |
| 0.1 | 10.11 | 10 |

*Measured delay at* $p = 1$: 3, 15, 62, 253 and 1,006 steps for drifts of 256, 64, 16, 4 and 1 thresholds, against
$N/|D|$ = 4, 16, 64, 256 and 1,023.

*Test:* `test_mistakes_before_detection_average_one_over_p`.

## 5. Impossibility results

Each result shows that one of the four conditions cannot be dropped.

**Impossibility 1a (no labels after a drift, so A3 is necessary).** If the learner receives no labels after step
$T$, nothing it observes after $T$ depends on whether the rule changed at $T$. Inputs come from the same distribution
either way; that is what pure concept drift means. So for every detector, the probability of an alarm is the same
with or without a drift. Zero missed drifts would require alarming with probability 1, which makes the false-alarm
probability 1. $\square$

*Dashboard:* "No labels after a change" in the control panel's Break it tab. *Test:* `test_monitoring_off_scenario_hides_the_drift`.

**Impossibility 1b (tiny drifts beat any fixed budget).** A drift that changes a fraction $\varepsilon$ of inputs is
visible only through a labeled point in that fraction. With $m$ labels on random points, the miss probability is at
least $(1 - \varepsilon)^m$, which tends to 1 as $\varepsilon \to 0$. With label noise $\eta \in (0, 1/2)$, telling
"no drift" from "drift" with false alarm plus miss probability at most $2\delta$ needs

$$m \;\ge\; \frac{\ln \frac{1}{4\delta}}{\varepsilon\,(1 - 2\eta)\,\ln\frac{1-\eta}{\eta}}$$

labels, which grows like $1/\varepsilon$. *Proof:* the KL divergence between the two label distributions is
$\varepsilon (1-2\eta)\ln\frac{1-\eta}{\eta}$ per label. The Bretagnolle–Huber inequality gives
$P_{\text{false alarm}} + P_{\text{miss}} \ge \tfrac12 e^{-m \cdot \mathrm{KL}}$ [Bretagnolle and Huber 1979; Tsybakov
2009, Lemma 2.6]. $\square$

No finite label budget covers every $\varepsilon$. *Code:* `bounds.noisy_detection_labels`. *Measured:* a drift of a
single threshold goes unnoticed for about 1,000 steps on average even with $p = 1$. The stealth adversary repeats such
one-step moves and, with $p = 0$, is never caught (`test_stealth_drift_hides_while_monitoring_is_off`).

**Impossibility 1c (noisy labels, so A2 is necessary).** With noise $\eta \in (0, 1/2)$ and any finite number of
labels, every label sequence has positive probability whether or not a drift happened, since each label takes each
value with probability at least $\eta$. A detector that ever alarms therefore has a positive false-alarm probability,
and one that ever stays quiet has a positive miss probability. Zero false positives and zero false negatives cannot
both hold. $\square$

**The noise floor.** For any predictor, the expected disagreement with noisy labels is
$\eta + (1 - 2\eta)\,P(\hat y \ne c(x)) \ge \eta$. Measured error cannot reach zero even for the true rule.
*Measured:* at $\eta = 0.1$ the robust engine's error against the true rule is 0.006, while against the observed
labels it is 0.108.

*Dashboard:* "Wrong labels (10%)". The exact engine raises 712 false alarms in 10,000 steps; the robust engine raises
none. *Tests:* `test_exact_mode_raises_false_alarms_under_the_same_noise`,
`test_noisy_labels_scenario_causes_false_alarms`.

**Impossibility 2 (arbitrary rules, so A1 is necessary).** If every labeling of $X$ is allowed, labels on a set $L$
say nothing about points outside $L$. For each unlabeled $x$, rules with either label are still consistent. An
adversary can set every unlabeled point opposite to the learner's prediction, so the learner errs on every unseen
point. With a uniformly random labeling, every learner's expected error on unseen points is exactly 1/2. This is the
no-free-lunch argument [Wolpert 1996]. Zero error requires labeling all $N$ points after every drift, which is
impossible for an infinite input space. Equivalently, the Littlestone dimension of all labelings of $N$ points is
$N$. $\square$

*Dashboard:* "No rule to find". The version space empties again and again, the error sits near 50%, and none
of these detections are false alarms. *Test:* `test_out_of_family_rule_defeats_exact_mode`.

**Impossibility 3 (unlimited drift speed, so A4 is necessary).** If the rule may change at every step, an adversary
that sees $x_t$ and the prediction $\hat y_t$ picks $c_t$ with $c_t(x_t) = 1 - \hat y_t$. Thresholds always allow
this: $\theta > x_t$ gives 0 and $\theta \le x_t$ gives 1. A deterministic learner is then wrong at every step. Against
a randomized learner, choosing between the two sides at random makes it wrong half the time. With a change every $k$
steps, the same argument forces at least one mistake per change, so an error rate of at least $1/k$. $\square$

*Measured error rates:* $k$ = 1, 2, 5, 10, 50 gives 1.000, 0.701, 0.494, 0.326 and 0.037, against $1/k$ = 1, 0.5,
0.2, 0.1 and 0.02. *Dashboard:* "Rule changes every step". *Tests:* `test_rapid_fire_at_k1_makes_every_prediction_wrong`,
`test_rapid_fire_keeps_the_error_above_zero`.

**Theorem 8 (no learner avoids the first mistake).** Even one drift is enough to force a mistake. At the drift step,
the same adversary as in Impossibility 3 picks the new rule against the learner's prediction. That forces a mistake
with certainty for a deterministic learner, and with probability 1/2 for a randomized one. So literal zero error is
impossible whenever drift is possible at all. The achievable target is the one the exact engine meets: zero false
alarms, at most $1 + \lceil\log_2(N+1)\rceil$ mistakes per drift with $p = 1$ (at least 1 is unavoidable), and zero
error after adaptation. $\square$

## 6. The adversary, precisely

`engine/adversary.py`. The worst-case answering adversary of Theorem 4 is adaptive: it answers each query as it comes.
The dashboard needs a fully defined true rule at every step, to count mistakes and draw the true rule.

Because the exact engine is deterministic and its recovery does not depend on the random input (Section 3), the
adversary plays the whole recovery in advance on a copy of the engine, answering every query to keep the larger half
of the surviving rules alive, and then commits to the one rule left. Every answer the real engine receives is the
answer the adaptive adversary would have given, so the two are equivalent for deterministic learners. The adversary
counts only rules outside memory and different from the current rule, so the attack always uses a new rule and
recall cannot shortcut it.

## 7. Robust mode

`engine/robust.py`. Robust mode handles what the exact engine cannot, namely noisy labels and rules outside the
family, and it promises less. It learns with a Hoeffding tree [via River, Montiel et al. 2021]. ADWIN [Bifet and
Gavaldà 2007] watches the stream of right and wrong predictions on labeled points.

Bifet and Gavaldà prove two bounds for ADWIN with confidence parameter $\delta$:

- **False positives:** if the error rate stays constant, the probability that ADWIN shrinks its window at a given
  step is at most $\delta$.
- **False negatives:** if some split of the window has means differing by more than $2\varepsilon_{\text{cut}}$, a
  threshold set by $\delta$ and the two window lengths, ADWIN detects it with probability at least $1 - \delta$.

DriftBound uses $\delta = 0.002$ and reacts only to a rising error. After a model swap it ignores alarms for 30
labels while the new model warms up.

These guarantees are probabilistic, so robust mode makes no zero-error claim. *Measured:* no false alarms in 20,000
drift-free steps at 10% noise, and no false alarms across 10,000-step runs at 0%, 2%, 5%, 10% and 20% noise. After an
abrupt drift, error against the true rule returns below 5%. A returning rule is matched to a stored model and reused.
Whether the alarm fires at all depends on how long the model has seen one rule. After an abrupt drift at 10% noise,
an alarm came in 20 of 20 runs after 3,000 steps on one rule (median delay 87 steps), 12 of 20 after 1,000 and 5 of 20
after 300. A young tree often relearns the new rule on its own before ADWIN has enough evidence; the error recovers
either way. *Tests:* `tests/test_robust.py`.

## References

Citations marked † were checked online against the publication record on 7 October 2026. The others are textbook
results.

- † D. Angluin. Queries and concept learning. *Machine Learning* 2:319–342, 1988.
- † A. Bifet and R. Gavaldà. Learning from time-changing data with adaptive windowing. *Proc. SIAM International
  Conference on Data Mining (SDM)*, pp. 443–448, 2007.
- J. Bretagnolle and C. Huber. Estimation des densités : risque minimax. *Z. Wahrscheinlichkeitstheorie verw.
  Gebiete* 47:119–137, 1979.
- T. M. Cover and J. A. Thomas. *Elements of Information Theory*, 2nd ed. Wiley, 2006.
- † J. Gama, I. Žliobaitė, A. Bifet, M. Pechenizkiy and A. Bouchachia. A survey on concept drift adaptation. *ACM
  Computing Surveys* 46(4), article 44, 2014. doi:10.1145/2523813.
- L. G. Kraft. *A device for quantizing, grouping, and coding amplitude-modulated pulses*. MS thesis, MIT, 1949.
- † N. Littlestone. Learning quickly when irrelevant attributes abound: a new linear-threshold algorithm. *Machine
  Learning* 2:285–318, 1988.
- † J. Montiel, M. Halford, S. M. Mastelini, G. Bolmier, R. Sourty, R. Vaysse, A. Zouitine, H. M. Gomes, J. Read,
  T. Abdessalem and A. Bifet. River: machine learning for streaming data in Python. *JMLR* 22(110):1–8, 2021.
- A. B. Tsybakov. *Introduction to Nonparametric Estimation*. Springer, 2009.
- † D. H. Wolpert. The lack of a priori distinctions between learning algorithms. *Neural Computation*
  8(7):1341–1390, 1996.
- A. C. Yao. Probabilistic computations: toward a unified measure of complexity. *Proc. 18th FOCS*, pp. 222–227,
  1977.
