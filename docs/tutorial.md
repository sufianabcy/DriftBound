# DriftBound: a guided tour

This tutorial walks through the whole service: the idea, the engine, the API, the database and the dashboard, then how
it is tested and how it will be deployed. Every example comes from a real run of this code, with its seed given, so
you can reproduce it. Code links point at the lines as of 7 October 2026.

**Before you start:** set up the repo as in the [README](../README.md) quick start. The engine lessons need only some
Python. The later lessons assume you know roughly what a REST API and React are.

**How to read it:** lesson 0 is the map. Lessons 1 to 5 are the ideas, inside `engine/`. Lessons 6 to 9 are the
service around them: API, live updates, database and dashboard. Lesson 10 covers testing and shipping. The exercises,
cheat sheet and glossary at the end are for coming back to.

- [Lesson 0: The big picture](#lesson-0-the-big-picture)
- [Lesson 1: The core idea, in one example](#lesson-1-the-core-idea-in-one-example)
- [Lesson 2: Concept memory](#lesson-2-concept-memory)
- [Lesson 3: Inside the engine package](#lesson-3-inside-the-engine-package)
- [Lesson 4: Robust mode](#lesson-4-robust-mode)
- [Lesson 5: The adversary, the four conditions and the impossibility lab](#lesson-5-the-adversary-the-four-conditions-and-the-impossibility-lab)
- [Lesson 6: The API server](#lesson-6-the-api-server)
- [Lesson 7: One click, end to end](#lesson-7-one-click-end-to-end)
- [Lesson 8: The database](#lesson-8-the-database)
- [Lesson 9: The dashboard](#lesson-9-the-dashboard)
- [Lesson 10: Tests, experiments, CI and deployment](#lesson-10-tests-experiments-ci-and-deployment)
- [Hands-on exercises](#hands-on-exercises)
- [Where to change things](#where-to-change-things)
- [Questions people will ask you](#questions-people-will-ask-you)
- [Glossary](#glossary)

---

## Lesson 0: The big picture

**In one paragraph.** A stream of numbers arrives, one per step. Each number has a hidden label, 0 or 1, given by a
rule, and the rule can change at any moment without warning. That change is called *concept drift*. DriftBound
predicts every label, notices when the rule has changed, and relearns it. For one family of rules, thresholds, it goes
further. It proves how few labels relearning can take, and it reaches that limit. It also shows on screen when zero
error is achievable and when no system could achieve it.

**An everyday picture.** Think of an exam whose pass mark θ is secret, and the examiner can move it at any time. Each
step a score x between 1 and 1023 arrives, and you must say "pass" (1) or "fail" (0). You may ask a grader for the
true verdict on any score, but every answer costs one label. DriftBound is a strategy for this game. It asks very few
questions, and under four stated conditions it never raises a false alarm.

**The cast.**

| Piece | Role | Code |
|---|---|---|
| Stream | the world: makes inputs, knows the true rule, answers label questions | [engine/streams.py](../engine/streams.py) |
| Drift injector | changes the true rule | [engine/streams.py](../engine/streams.py#L115) |
| Exact engine | the learner that comes with proofs | [engine/exact.py](../engine/exact.py) |
| Concept memory | the learner's notebook of past rules | [engine/memory.py](../engine/memory.py) |
| Robust engine | the learner for messy data (noisy labels, arbitrary rules) | [engine/robust.py](../engine/robust.py) |
| Adversary | an opponent that picks the worst drifts | [engine/adversary.py](../engine/adversary.py) |
| Bounds | every proven number, as plain functions | [engine/bounds.py](../engine/bounds.py) |
| Runner | the referee: runs one step and keeps score | [engine/runner.py](../engine/runner.py) |
| API | puts runs on the network, streams them live, stores history | [api/](../api/) |
| Dashboard | shows a run live and lets you poke it | [web/](../web/) |
| Database | keeps history: runs, metrics, drift events, learned rules | [api/db.py](../api/db.py), [db/schema.sql](../db/schema.sql) |

**How the pieces connect.**

```text
Browser: the dashboard (web/)
  │  REST commands, for example POST /api/runs/{id}/drift
  ▼
api/routes.py ──► api/manager.py: one loop per running run
                     │
                     │  Runner.step()   (engine/: stream, engines, memory, adversary, bounds)
                     ▼
                   tick ──► api/live.py (the hub) ──► WebSocket ──► Browser
                     │                                (a snapshot, then about 10 messages a second)
                     ▼
                   every 50 steps: write queue ──► writer task ──► api/db.py ──► SQLite or PostgreSQL
                                                               └─► api/storage.py ──► ./models or S3
```

`engine/` is plain Python with no web code. You can use it from a shell, a test or a notebook without starting
anything.

**Run it.** In two terminals, from the repo root:

```bash
source .venv/bin/activate && uvicorn api.main:app --reload   # API on http://localhost:8000 (try /docs)
cd web && npm run dev                                         # dashboard on http://localhost:5173
```

Open http://localhost:5173. A run starts by itself.

**What lives where while it runs.** A live run is a Python object inside the API process. Its history (the run,
metric points, drift events and learned rules) goes to a database. Locally that is the SQLite file `driftbound.db`;
on AWS it will be PostgreSQL. So a server restart ends live runs, but their history stays.

---

## Lesson 1: The core idea, in one example

### The rules

Inputs are the whole numbers 1 to N, with N = 1023. A rule is a threshold θ ([Threshold](../engine/streams.py#L14)):

```text
h_θ(x) = 1 if x ≥ θ, else 0
```

θ can be any of 1, 2, …, 1024. θ = 1 says 1 to everything and θ = 1024 says 0 to everything. So there are 1,024
possible rules, and the engine's job never changes: work out which one is in force *now*.

### The version space: everything still possible

The exact engine keeps the set of rules that agree with every label it has bought since its last reset. For
thresholds that set is always an interval, written [lo, hi]:

- a label "x is 1" means θ ≤ x, so hi drops to x if x is smaller;
- a label "x is 0" means θ > x, so lo rises to x + 1 if that is larger.

That is the whole update ([exact.py:102](../engine/exact.py#L102)):

```python
def update(self, x: int, y: int) -> bool:
    if y == 1:
        self.hi = min(self.hi, x)  # threshold is at or below x
    else:
        self.lo = max(self.lo, x + 1)  # threshold is above x
    if self.lo == self.hi:
        self.rule = self.lo
    return self.lo > self.hi
```

The return value is the drift alarm: `lo > hi` means that no threshold explains the labels.

### What the engine does with the interval

| When | What it does | Code |
|---|---|---|
| Every step | Predicts 1 if x ≥ (lo + hi) // 2: the majority vote of the rules still possible (the Halving rule). Once lo = hi, that is the rule itself. | [predict](../engine/exact.py#L79) |
| More than one rule left (**learning**) | Asks for the label of the middle point, q = (lo + hi − 1) // 2. Either answer removes half the rules. | [next_query](../engine/exact.py#L83) |
| One rule left (**monitoring**) | With probability p, buys the label of the arriving point. A label that agrees changes nothing. A label that disagrees empties the interval: drift. | [_exact_step](../engine/runner.py#L230) |

Halving 1,024 rules down to one takes exactly 10 answers, since 2¹⁰ = 1024. So learning, and relearning after every
drift, costs 10 labels. Lesson 5 shows an opponent that forces every learner to pay at least 10.

### Why an alarm is a proof, not a guess

Suppose the rule has not changed and the labels are correct. Then the true θ agrees with every label, so it never
leaves [lo, hi], and the interval can never become empty. **An empty interval is impossible without a drift**, so
there are no false alarms (Theorem 1 in [theory.md](theory.md#3-guarantees-under-the-four-conditions)).

While monitoring, the interval is a single rule. The first bought label that disagrees with it empties it, so **a
harmful drift is caught at its first labeled mistake** (Theorem 2). A drift that never causes a mistake is never
flagged and costs nothing, and that is fine, because it was harmless (Corollary 2.2).

There are no statistics and no thresholds to tune. That only holds under conditions, and Lesson 5 is about what
happens when they break.

### Watch it happen: N = 15

With N = 15 there are 16 rules, so learning takes ⌈log₂ 16⌉ = 4 labels. This is
`Runner(RunConfig(n=15, seed=3, theta=11))`, so the secret rule is θ = 11. Each row of the band shows the interval
after a step:

```text
θ:       1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16
start  ████████████████████████████████████████████████   16 rules possible
step 1  ·  ·  ·  ·  ·  ·  ·  · ████████████████████████   asked x = 8, answer 0  ->  9..16
step 2  ·  ·  ·  ·  ·  ·  ·  · ████████████ ·  ·  ·  ·    asked x = 12, answer 1  ->  9..12
step 3  ·  ·  ·  ·  ·  ·  ·  ·  ·  · ██████ ·  ·  ·  ·    asked x = 10, answer 0  ->  11..12
step 4  ·  ·  ·  ·  ·  ·  ·  ·  ·  · ███ ·  ·  ·  ·  ·    asked x = 11, answer 1  ->  11..11
```

The same run continued, with two drifts injected along the way. ✗ marks a mistake.

| Step | Input x | Predicted | True | The one label bought this step | Interval after | State after | Event |
|---|---|---|---|---|---|---|---|
| 1 | 10 | 1 | 0 ✗ | asked about 8: 0 | 9–16 | learning | |
| 2 | 15 | 1 | 1 | asked about 12: 1 | 9–12 | learning | |
| 3 | 1 | 0 | 0 | asked about 10: 0 | 11–12 | learning | |
| 4 | 7 | 0 | 0 | asked about 11: 1 | 11 | monitoring | **recovered** in 4 labels (bound 4) |
| 5 | 10 | 0 | 0 | label of 10: 0, agrees | 11 | monitoring | |
| 6 | 5 | 0 | 0 | label of 5: 0, agrees | 11 | monitoring | |
| | | | | *drift injected: θ 11 → 4* | | | |
| 7 | 4 | 0 | 1 ✗ | label of 4: 1, contradicts θ = 11 | empty, so reset to 1–16 | learning | **detected** 0 steps after the drift, 1 mistake |
| 8 | 9 | 1 | 1 | asked about 8: 1 | 1–8 | learning | |
| 9 | 6 | 1 | 1 | asked about 4: 1 | 1–4 | learning | |
| 10 | 12 | 1 | 1 | asked about 2: 0 | 3–4 | learning | |
| 11 | 13 | 1 | 1 | asked about 3: 0 | 4 | monitoring | **recovered** in 4 labels (bound 4) |
| 12–16 | | | | five labels, all agree | 4 | monitoring | |
| | | | | *drift injected: θ 4 → 11, a recurring rule; memory holds 4 and 11* | | | |
| 17 | 12 | 1 | 1 | label of 12: agrees | 4 | monitoring | |
| 18 | 3 | 0 | 0 | label of 3: agrees | 4 | monitoring | |
| 19 | 5 | 1 | 0 ✗ | label of 5: 0, contradicts θ = 4 | empty, so reset | recalling | **detected** 2 steps after the drift, 1 mistake |
| 20 | 14 | 1 | 1 | asked about 10: 0 | 11–16 | recalling | |
| 21 | 7 | 0 | 0 | asked about 11: 1 | 11 | monitoring | **recovered** from memory in 2 labels (bound 2) |

What to notice:

- **Step 1 is a mistake.** With all 16 rules possible, the engine guesses with the middle one. Mistakes while
  learning are allowed. The guarantees are about what happens once the rule is pinned down.
- **While learning, the arriving point is not labeled.** The step's one label goes to the question the engine chose,
  a *membership query* (design.md, D-06). So "10 labels" also means "10 steps".
- **Step 7, the first labeled mistake after the drift, is the detection.** After the second drift, steps 17 and 18
  brought inputs 12 and 3. The old rule (4) and the new rule (11) agree there; they disagree only on 4 to 10. No
  mistake, so there was nothing to detect yet. Step 19 brought 5, inside that zone, and was caught at once.
- **With p = 1, every step buys exactly one label**: 24 steps, 24 labels. A lower p saves monitoring labels and makes
  detection slower (Lesson 3).
- After 24 steps the counters read: 3 mistakes (steps 1, 7 and 19), 0 false alarms, 2 detections for 2 drifts,
  memory [4, 11].

Steps 19 to 21 recovered in 2 labels instead of 4. That is concept memory, the subject of Lesson 2.

---

## Lesson 2: Concept memory

**The idea.** Real systems often go back to a rule they have seen before, such as weekday and weekend behaviour. The
engine keeps the rules it has learned in a small notebook, and after a drift it first checks whether the new rule is
one of those.

**The notebook** ([ConceptMemory](../engine/memory.py#L21)) holds up to 8 thresholds. When it is full, the least
recently used one is dropped. [remember](../engine/memory.py#L51) adds a rule, or bumps its reuse count if it is
already there.

**Recall** ([next_query](../engine/exact.py#L83)). After a reset with K usable stored rules, the engine works in two
stages:

1. It asks about points that split the stored rules in half: either answer rules out half of them. After ⌈log₂ K⌉
   questions one stored rule t is left.
2. It confirms t with at most 2 more questions: is t − 1 a 0, and is t a 1? If both answers are yes, the interval is
   exactly [t, t].

That is at most ⌈log₂ K⌉ + 2 labels (Theorem 5). For K = 1, 2, 4 and 8 that means 2, 3, 4 and 5 labels instead of
10. Steps 20 and 21 in Lesson 1 are exactly this with K = 1: "is 10 a 0?" yes, "is 11 a 1?" yes, done.

**Three details matter.**

- **Skip the rule that just failed.** The rule the engine was monitoring with has just been contradicted, so it
  cannot be the new one ([reset_after_drift](../engine/exact.py#L37)). The first version forgot this, and every run
  wasted 2 labels on its first drift (12 instead of 10). A smoke test caught it (design.md, D-09).
- **Recall only when it can win.** Recall is tried only when ⌈log₂ K⌉ + 2 < 10
  ([recall_is_worthwhile](../engine/bounds.py#L41)). With N = 15 and 4 stored rules, recall would cost 4 labels,
  no better than a plain search, so the engine skips it.
- **A miss costs extra, and that is unavoidable.** If the new rule is not in memory, the confirmation fails and
  binary search continues on what is left of the interval, keeping every label already bought. The worst case is
  ⌈log₂ K⌉ + 2 + 10 labels.

**The price of memory (Theorem 6).** Any exact strategy is a yes/no decision tree. For a decision tree, the sum of
2^−(labels for θ) over all rules is at most 1 (Kraft's inequality). Binary search spends exactly 10 on every one of
the 1,024 rules, so the sum is exactly 1, with no slack. Making some rules faster (the stored ones) therefore *forces*
some other rule to be slower. That is why the dashboard checks each recovery against the bound for its own path:

| Recovery path | Bar color | Bound at N = 1023 |
|---|---|---|
| `full`: plain binary search | blue | 10 |
| `memory`: the rule was stored | orange | ⌈log₂ K⌉ + 2, so 2 to 5 |
| `memory_fallback`: recall missed, then search | green | ⌈log₂ K⌉ + 12, so 12 to 15 |

No bar ever passes its own black tick. Bars above the dashed 10-label line show the price of memory, live.

**Turning memory off** (the Memory recall switch in the control panel's Settings tab) sets the engine's memory to `None`: no recall, but the stored
rules are kept ([set_memory](../engine/runner.py#L514)).

---

## Lesson 3: Inside the engine package

### streams.py: the world

The [Stream](../engine/streams.py#L49) is the only object that knows the truth. Engines see inputs and the labels
they pay for, never θ itself.

- `next_x()` draws an input uniformly from 1 to N.
- `clean_label(x, step)` is the true label. Inside a gradual drift it is drawn from the old or the new rule.
- `observe(clean)` flips the label with probability `noise`. `query(x, step)` is the label oracle: the clean label,
  then the noise.
- Inputs, labels (with noise) and drift choices each have their own random generator
  ([Stream.\_\_init\_\_](../engine/streams.py#L52)). The same seed always gives the same run, and turning noise on
  never changes which inputs arrive (design.md, D-12).
- `version` goes up on every change of the rule. `history` lists every threshold used, and recurring drifts pick from
  it.

The [DriftInjector](../engine/streams.py#L115) changes the rule. Every method returns an event such as
`{"type": "injected", "drift": "abrupt", "step": 206, "from": 300, "to": 800}`.

| Kind | What happens | Method |
|---|---|---|
| abrupt | jumps to a new θ. A random jump moves at least (N + 1)/8 = 128 thresholds, so it is visible on screen (D-15) | `abrupt` |
| gradual | for 200 steps each label comes from the old or the new rule, with the new one ever more likely | `gradual`, `GradualWindow` |
| recurring | goes back to a θ used earlier in the run | `recurring` |
| out_of_family | random labels (a `LookupTable`): no threshold fits | `arbitrary` |
| any exact θ | used by the adversary and the lab scenarios | `set_threshold` |

### exact.py and memory.py

Covered in Lessons 1 and 2. Two more members: `state` is `learning`, `recalling` or `monitoring`, and
[bound()](../engine/exact.py#L71) gives the proven label limit for the recovery in progress, according to its path.

### bounds.py: every number on the screen

Every bound the dashboard draws comes from a function in [bounds.py](../engine/bounds.py), and each one matches a
statement in theory.md. The values at N = 1023:

| Function | Value | Meaning |
|---|---|---|
| `recovery_labels(1023)` | 10 | labels to identify a rule from scratch; also the lower bound |
| `recall_labels(K)` | 2, 3, 4, 4, 5, 5, 5, 5 for K = 1 to 8 | recall of a stored rule |
| `recall_fallback_labels(K, 1023)` | 12 to 15 | recall that missed, then search |
| `mistakes_per_drift(1023)` | 11 | with p = 1: the detecting mistake plus at most one per learning step |
| `expected_mistakes_before_detection(p)` | 1/p | for example 4 at p = 0.25 (Theorem 7) |
| `noise_floor(η)` | η | error against noisy labels cannot go below the noise |
| `noisy_detection_labels(ε, η, δ)` | 18.3 at ε = 0.1, 183.1 at ε = 0.01 (η = 0.1, δ = 0.01) | labels any detector needs under noise; grows like 1/ε |

### runner.py: one step, and all the bookkeeping

The [Runner](../engine/runner.py#L64) owns the stream, the injector, the memory, both engines, the adversary and every
counter. It does no input or output: the API calls `step()` in a loop and collects records from it.
[RunConfig](../engine/runner.py#L28) holds the settings: N, mode, p, noise, seed, starting θ, memory on or off, and a
few sizes.

[Runner.step()](../engine/runner.py#L138) in eight moves:

1. Advance the step counter, and pick up events queued by commands since the last step (an injected drift, a mode
   switch).
2. Close a finished gradual window. Fire a scheduled drift: the "Monitoring off" scenario waits until the engine
   settles.
3. Draw x and predict.
4. Let the adversary act. It sees x and the prediction, so it can be adaptive.
5. Draw the clean label and the noisy one. A mistake is counted against the clean label, and a second counter uses
   the noisy one (D-17).
6. In exact mode ([_exact_step](../engine/runner.py#L230)), ask the engine's question while learning. While
   monitoring, flip the p-coin and maybe buy x's label. In robust mode
   ([_robust_step](../engine/runner.py#L258)), flip the p-coin and learn from x's label.
7. Detect and recover. An empty interval calls [_detected](../engine/runner.py#L299); a question that pins down one
   rule calls [_recovered](../engine/runner.py#L374).
8. Build the **tick**, a dictionary describing the step. Add it to the short history, and every 5 steps queue a
   metric point for the database.

The tick is what the dashboard draws from:

| Field | Meaning |
|---|---|
| `step`, `x` | step number, arriving input |
| `y_true`, `y_obs`, `y_pred` | true label, label as observed after noise, prediction |
| `labeled` | the arriving point's label was bought (monitoring) |
| `query`, `query_label` | the point the engine asked about and the answer (learning) |
| `state`, `mode` | `learning`, `recalling` or `monitoring`; `exact` or `robust` |
| `lo`, `hi`, `candidates_left` | the interval and its size (exact mode only) |
| `theta`, `theta_hat` | the true rule (known only to the simulator) and the engine's rule |
| `error_rate`, `observed_error_rate` | rolling error over the last 100 steps, against the truth and against the observed labels |
| `mistakes_total`, `labels_total`, `false_alarms` | running counters |
| `events` | what happened this step: `injected`, `detected`, `recovered`, `recovery_ended`, `mode`, `adversary`, `scenario`, `gradual_end` |

**Drift accounting.** The engine is blind, but the simulator knows the truth, so it labels each detection
([_cause](../engine/runner.py#L289), D-16):

| Cause | Meaning | False alarm? |
|---|---|---|
| `drift` | the rule changed since the last reset | no |
| `gradual` | a gradual window is open | no |
| `out_of_family` | the rule is random labels | no |
| `noise` | nothing changed: flipped labels caused it | **yes** |

It also measures each detection's delay (steps since the first undetected change) and how many mistakes got through
first. The truth is used only for these labels and for the conditions panel, never inside an engine.

**Recoveries.** Each recovery is recorded with the labels it spent, its bound, its path, whether it found the true
rule, and whether a drift landed during it. Some recoveries never finish: another detection interrupts them, the
mode switches, or the server shuts down. Those become a `recovery_ended` event with path `interrupted`, `abandoned` or
`open_at_close` ([_close_recovery](../engine/runner.py#L350)).

**Commands** change a run between steps: `inject`, `set_mode`, `set_p`, `set_noise`, `set_memory`, `set_adversary`
and `apply_scenario`. Each queues an event that shows up on the next tick.

**Outputs** that the API reads:

- [conditions()](../engine/runner.py#L587): the four conditions as true or false (Lesson 5).
- [summary()](../engine/runner.py#L599): everything the panels need, including the bounds and the guarantee verdict.
- [snapshot()](../engine/runner.py#L670): the summary plus the last 1,500 history points, 300 events, 200
  recoveries and 50 full ticks, for a viewer who has just joined.
- [drain()](../engine/runner.py#L680): the metric points, drift-event records and concept updates produced since
  the last call. Each record is handed over exactly once.

---

## Lesson 4: Robust mode

### Why exact mode needs clean labels

Under label noise, a flipped label can contradict the true rule. The interval empties, the engine declares a drift
that never happened, and it relearns. Here is one run: seed 21, θ = 300, 10% noise, 3,000 steps, and no drift at
all.

| Mode | False alarms | Error against the true rule | Error against the observed labels |
|---|---|---|---|
| exact | 224 | 4.4% | 14.1% |
| robust | 0 | 2.4% | 12.5% |

This is not a bug in the exact engine. Under noise, *no* detector can promise both zero false alarms and zero missed
drifts (Impossibility 1c). Robust mode gives up exactness and gains tolerance.

The last column cannot go below the noise, because even a perfect predictor disagrees with 10% of the noisy labels.
In general it is about η + (1 − 2η) × (true error); for robust mode that is 0.1 + 0.8 × 0.024 ≈ 0.12. The error
chart draws both lines, plus the noise floor.

### How it works

[engine/robust.py](../engine/robust.py) has three parts:

1. **A model.** A Hoeffding tree from the River library: an online decision tree that learns one labeled point at a
   time and splits once it has enough evidence. Its only feature is x / N. Its exhaustive splitter can split exactly
   at the threshold, and it won a comparison of six models ([make_model](../engine/robust.py#L17), design.md D-19).
2. **A detector.** ADWIN (δ = 0.002) watches the stream of right (0) and wrong (1) predictions on labeled points.
   It keeps a window of recent values and drops the older part once the two parts' averages differ by more than
   chance allows. There are two guards ([learn](../engine/robust.py#L102)). Only a *rising* error counts, because
   ADWIN also fires when a new model improves. And alarms are ignored for 30 labels after a model swap.
3. **A model memory.** On an alarm ([_alarm](../engine/robust.py#L120)) the failing model is stored, because it
   describes the concept that just ended. Every stored model is scored on the last 32 labels. The best one is reused
   if its accuracy is at least 0.75 and at least 0.10 better than the failing model's. Otherwise a fresh tree
   starts, warmed up on those 32 labels. Up to 8 models are kept, least recently used dropped first.

Robust mode labels only arriving points, each with probability p; it never chooses its questions. Its dot on the
number line is the model's boundary: the point where its predictions switch from 0 to 1, found by binary search over
predictions ([boundary](../engine/robust.py#L85)).

### Watch it: a rule that leaves and comes back

`Runner(RunConfig(seed=23, mode="robust", theta=300))`, with clean labels and p = 1:

| When | What happened |
|---|---|
| steps 1 to 3,000 | the tree learns θ = 300; its boundary is 301 |
| step 3,001 | drift from 300 to 800 |
| step 3,040 | ADWIN alarm, 39 steps and 22 mistakes after the drift. Memory is empty, so a fresh tree starts. The failing tree scored 0.469 on the last 32 labels. Afterwards the boundary is 799, and the stored models are [301]. |
| step 6,001 | drift back from 800 to 300 |
| step 6,016 | alarm after 15 steps and 14 mistakes. The stored 301-model scores 0.844 against the failing model's 0.562, so it is **reused**. Afterwards the boundary is 301, and the stored models are [301, 799]. |

Compare this with exact mode, which catches a drift at its first labeled mistake. Robust mode needs evidence: 22
mistakes here. That is the cost of tolerating noise. Its guarantees are probabilistic. ADWIN's false-alarm
probability per check is at most δ (Bifet and Gavaldà 2007). Measured: no false alarms in 20,000 drift-free steps at
10% noise (`test_robust_mode_stays_quiet_without_drift`).

**Switching modes** happens live, on the same stream. Robust mode keeps its model across switches, and switching to
exact mode relearns from scratch (D-31).

**Model snapshots.** When a robust model is stored, the runner hands the model object to the API. The API pickles it
to S3 in the cloud, or to `./models` locally, and the database keeps only its address (Lesson 8).

---

## Lesson 5: The adversary, the four conditions and the impossibility lab

Lower bounds and impossibility results are claims about the worst case. To show them live, DriftBound includes an
opponent that produces the worst case on demand ([adversary.py](../engine/adversary.py)). It acts after the engine
predicts and before any label is drawn ([act](../engine/adversary.py#L75)), so it can react to the input and the
prediction.

### Worst-case answers: no learner beats 10 labels

The textbook argument is Theorem 4. Whatever point the learner asks about, answer so that the *larger* half of the
remaining rules survives. After 9 answers at least 2 rules are left, so 10 labels are necessary.

The dashboard needs a definite true rule at every step, so the code plays this out in advance
([worst_case_threshold](../engine/adversary.py#L20)). It copies the engine and plays the whole recovery on the copy,
answering "keep the larger half" each time. Then it commits to the one rule left. The engine is deterministic and
its recovery does not depend on the random inputs (D-08), so the real engine asks exactly those questions and gets
exactly those answers. The adversary avoids the current rule and everything in memory, so recall cannot shortcut the
attack. It strikes after a stretch of monitoring, 100 steps by default.

Here it runs with seed 4, memory off, striking after every 20 monitoring steps:

| Attack | New rule | Detected | Recovered | Labels |
|---|---|---|---|---|
| step 30 | 52 → 595 | step 30 | step 40 | 10 |
| step 60 | 595 → 421 | step 65 | step 75 | 10 |
| step 95 | 421 → 688 | step 102 | step 112 | 10 |

Every recovery takes exactly 10 labels. The upper bound (binary search) meets the lower bound (the adversary). With
memory on, the attack does more damage, 12 to 13 labels, because recall is tried and misses. That is the price of
memory from Lesson 2, forced by an opponent.

### Rapid fire, stealth and noise

- **Rapid fire** (every k steps) picks a rule that labels the current input against the prediction: θ above x if
  the engine said 1, at or below x if it said 0. At k = 1 every prediction is wrong. In general the error stays at
  or above 1/k (Impossibility 3). These changes count as drift but are not logged one by one, because they would
  flood the database (D-14).
- **Stealth** moves θ by one every 50 steps. A one-step move changes the label of a single input out of 1,023, so it
  is rarely seen. With p = 0 it is never caught. With p = 1, noticing one such move takes about 1,000 steps on
  average (Impossibility 1b).
- **Noise** turns on 10% label flips.

### The four conditions

Zero error is achievable under four conditions, and each one is necessary. Drop any one, and a theorem says that no
engine can promise zero error. The runner computes the four live ([conditions](../engine/runner.py#L587)), and the
banner and the boundary table show them.

| Condition | Holds when (in code) | Break it button that breaks it | What you see | Why it cannot be fixed |
|---|---|---|---|---|
| A1. Rule family | the rule is a threshold (`stream.in_family`) | No rule to find | random labels; detections never stop, and none are false alarms; error near 50% | Impossibility 2: with arbitrary rules, labels say nothing about unlabeled points (no free lunch) |
| A2. Labels | noise is 0 | Wrong labels (10%) | false alarms climb with no drift at all | Impossibility 1c: under noise every alarm rule risks a false alarm or a miss |
| A3. Label access | p > 0 | No labels after a change | p = 0, then a drift once the engine settles: the error jumps and nothing is ever detected | Impossibility 1a: without labels, a drift changes nothing you can observe |
| A4. Drift timing | no rapid fire, no stealth, no open gradual window, no drift during a recovery | Rule changes every step | the rule flips against every prediction: error 100% | Impossibility 3: if the rule can change every step, an adversary can make every prediction wrong |

**Restore everything** (the `all_clear` scenario) restores clean labels, p = 1, no adversary and a threshold rule. In
exact mode it also relearns: the interval starts from all rules again, though with memory recall on the engine tries
remembered rules first ([apply_scenario](../engine/runner.py#L555)). The four scenarios switch to exact mode, because
they demonstrate its limits. In the dashboard they sit in the control panel's **Break it** tab, with **Slow creep**
(stealth) beside them.

The guarantee banner is green exactly when the mode is exact and all four conditions hold
([summary](../engine/runner.py#L666)).

### What "zero error" honestly means

No learner can avoid the first mistake of a drift (Theorem 8). At the drift step, an opponent can pick the new rule
against whatever the learner predicts. So the achievable promise, and the one the exact engine keeps, has three
parts:

1. zero false alarms;
2. at most 1 + 10 = 11 mistakes per drift with p = 1, of which the first is unavoidable;
3. zero errors after recovery, until the next drift.

The proofs are in [theory.md](theory.md#5-impossibility-results).

---

## Lesson 6: The API server

The API puts runs on the network. It is one process: uvicorn running the FastAPI app in `api/`. That process serves
the REST commands, the WebSocket stream and, once built, the dashboard files, so the browser talks to one address.

### Startup

`uvicorn api.main:app` imports [api/main.py](../api/main.py), whose last line builds the app with
[create_app](../api/main.py#L57). In order, it:

1. reads the settings ([config.py](../api/config.py)) from the environment and `.env`;
2. creates the database, the model store (S3 or `./models`), and the run manager with its hub;
3. on startup (the `lifespan` function), creates any missing tables and marks runs left `running` by a dead process
   as `interrupted`, then starts the writer task. If the database is down, the app logs it and carries on without
   history, and `/api/health` reports the problem;
4. mounts the routes under `/api`, and serves the built dashboard at `/` if `web/dist` exists. Otherwise `/` shows a
   short help page.

| Setting (environment variable) | Default | Effect |
|---|---|---|
| `DATABASE_URL` | empty: `sqlite+aiosqlite:///./driftbound.db` | where history goes; a `postgresql+asyncpg://…` URL for RDS |
| `MODELS_BUCKET` | empty: use `MODELS_DIR` | S3 bucket for robust-model snapshots |
| `MODELS_DIR` | `models` | local folder for snapshots |
| `AWS_REGION` | `ap-south-1` | the region of the S3 bucket |
| `WEB_DIST` | `web/dist` | the built dashboard |
| `MAX_LIVE_RUNS` | 24 | runs kept in memory; unwatched runs are evicted first, then paused ones, oldest first. Every test-page visitor holds one |
| `IDLE_STOP_SECONDS` | 600 | stop a run nobody has watched for 10 minutes |
| `FLUSH_EVERY` | 50 | steps between database writes |
| `MAX_SPEED`, `DEFAULT_SPEED` | 500, 20 | steps per second |

### The run manager: one loop per run

In [api/manager.py](../api/manager.py), each live run is a `LiveRun`. It holds an id (12 hex characters), a
`Runner`, a speed, a status (`created`, `running`, `stopped` or `error`) and the asyncio task that drives it.

The loop ([_loop](../api/manager.py#L215)) wakes every 50 ms and does five things:

1. works out how many steps it owes (speed × time elapsed, carrying the fractions). It takes at most 250 per wake-up,
   so a stalled loop drops time instead of racing to catch up;
2. calls `runner.step()` that many times and pushes each tick to the hub;
3. every 50 steps, drains the runner's records into the write queue;
4. every 100 ms, tells the hub to send one message to the viewers;
5. stops the run if nobody has watched it for 10 minutes. A tab left open counts as watching and keeps its run going.

At the default 20 steps a second that is one step per wake-up and about two ticks per message. At 500 a second it
is 25 steps per wake-up and about 50 ticks per message.

Commands (drift, adversary, settings, scenario) call the runner directly and save the new config. Then they
*announce*: a fresh `state` message goes to the viewers at once, even while the run is paused
([_announce](../api/manager.py#L277)).

**Why every endpoint is `async`** (D-30). FastAPI runs plain `def` endpoints on a thread pool, where a command could
change a runner in the middle of its `step()`. Async endpoints run on the same event loop as the run loops. A burst
of steps never pauses for another task in the middle, so commands and steps cannot interleave and no locks are
needed.

**The database never slows the demo** (D-23). Nothing in the loop or in the commands waits for the database. Writes
go into one queue, which a single writer task drains in order ([_write_loop](../api/manager.py#L307)). If a write
fails, the error is counted and logged, `/api/health` shows it, and the demo keeps running.

### The hub: batching for the browser

A run can produce 500 ticks a second, but the browser receives about 10 messages a second
([api/live.py](../api/live.py)).

- `push` buffers a tick, and only if someone is watching that run.
- `flush` sends one `ticks` message: the buffered ticks plus the latest run info and summary. A message carries at
  most 60 ticks: every tick with an event, the last tick, and an even sample of the rest ([thin](../api/live.py#L16)).
- Each viewer has a queue of 32 messages. A slow viewer loses its oldest messages instead of slowing the run down.

### The WebSocket

The endpoint is `/api/runs/{id}/live` ([live_ticks](../api/routes.py#L180)). On connect, the server sends a
**snapshot**: run info, summary, the last 1,500 history points, 300 events, 200 recoveries and 50 full ticks. A phone that joins
late therefore draws full charts at once. After that, the server forwards whatever the hub queues. If 15 seconds pass
with nothing to send, it sends a `ping`, so that proxies such as CloudFront keep the idle socket open.

The dashboard never sends anything; the server reads only to notice a disconnect. Sending and receiving run as two
tasks in one anyio task group, so whichever ends first stops the other cleanly (D-34).

Message types: `snapshot`, `ticks`, `state`, `ping`, `closed` (the run was evicted) and `error` (the run is not live).

### The endpoints

| Method and path | Calls | Returns |
|---|---|---|
| `GET /api/health` | `Database.ping` | database, storage and live-run status |
| `GET /api/runs` | `Database.list_runs`, plus the live runs | stored runs merged with live state |
| `POST /api/runs` | `RunManager.create` | 201 and `{run, summary}`; `kind: "fraud"` marks a fraud-test run |
| `GET /api/runs/{id}` | the live summary, or the stored row | `{run, summary}`, or `{run, stored}` for a past run |
| `PATCH /api/runs/{id}` | `RunManager.update` | changes mode, p, noise, speed, memory |
| `POST /api/runs/{id}/start`, `/stop` | `start_run`, `stop_run` | `{run, summary}` |
| `POST /api/runs/{id}/step` | `RunManager.step_run`, then `Runner.step(x)` | `{ticks, run, summary}`: runs `count` steps now, playing or paused; with `x`, one step that processes that input |
| `POST /api/runs/{id}/drift` | `RunManager.inject`, then `Runner.inject` | `{event}` |
| `POST /api/runs/{id}/adversary` | `Runner.set_adversary` | `{adversary}` |
| `POST /api/runs/{id}/scenario` | `Runner.apply_scenario` | `{event}` |
| `GET /api/runs/{id}/events`, `/metrics`, `/concepts` | database reads | stored history |
| `WS /api/runs/{id}/live` | the hub | a snapshot, then messages |

Request bodies are pydantic models ([schemas.py](../api/schemas.py)), so a malformed field gets a 422 before any of
our code runs. A command the engine rejects, such as a θ out of range, becomes a 400. A run that is not in memory
gives a 404. The interactive page at http://localhost:8000/docs lists every endpoint and lets you send requests.

### A real session

This session was captured by running the app in-process against a scratch SQLite file, with seed 11, θ = 300 and
100 steps a second. Step numbers depend on timing, so yours will differ.

```text
GET /api/health
→ {"status": "ok", "version": "0.1.0",
   "database": {"dialect": "sqlite", "reachable": true, "write_errors": 0, "last_error": null},
   "models": "local", "live_runs": 0}

POST /api/runs  {"name": "Tutorial run", "seed": 11, "theta": 300, "speed": 100, "start": true}
→ 201 {"run": {"id": "2871c1609898", "name": "Tutorial run", "status": "running", "speed": 100.0,
               "viewers": 0, "live": true, ...},
       "summary": {"step": 0, "state": "learning", "lo": 1, "hi": 1024, "candidates_left": 1024,
                   "guarantee": true, "bounds": {"recovery_labels": 10, ...}, ...}}
```

The first WebSocket message is the snapshot, with keys `type`, `run`, `summary`, `history`, `events` and
`recoveries`. After that, at 100 steps a second, 2 seconds brought 20 messages. Each was a `ticks` message carrying
10 or 11 ticks, about 5 KB. One tick while monitoring:

```json
{"step": 205, "x": 614, "y_pred": 1, "y_true": 1, "y_obs": 1, "labeled": true, "query": null,
 "state": "monitoring", "lo": 300, "hi": 300, "theta": 300, "theta_hat": 300, "error_rate": 0.0,
 "mistakes_total": 1, "labels_total": 205, "candidates_left": 1, "false_alarms": 0, "events": []}
```

Inject a drift:

```text
POST /api/runs/2871c1609898/drift  {"type": "abrupt", "theta": 800}
→ 200 {"event": {"type": "injected", "drift": "abrupt", "step": 206, "from": 300, "to": 800}}
```

The next WebSocket messages were a `state` message (the announcement), then `ticks`. The events in those ticks:

```text
step 206  injected   abrupt, 300 → 800
step 206  detected   cause drift, delay 0, 1 mistake before detection
step 216  recovered  10 labels, bound 10, path full, θ̂ = 800, correct
```

The tick that carried the detection is worth reading. Input 626 arrived. The engine predicted 1, since 626 ≥ 300, but
under the new rule it is 0, since 626 < 800. The label was bought and the interval emptied. The same tick already
shows the reset: `"state": "learning", "lo": 1, "hi": 1024, "candidates_left": 1024`.

Then a recurring drift back to 300, which memory recovers in 2 labels:

```text
step 227  injected   recurring, 800 → 300
step 231  detected   delay 4, 1 mistake
step 233  recovered  2 labels, bound 2, path memory, recall_k 1
```

And two errors:

```text
POST /api/runs/nope/start                                    → 404 {"detail": "run nope is not live"}
POST /api/runs/{id}/drift {"type": "abrupt", "theta": 5000}  → 400 {"detail": "theta must be between 1 and 1024"}
```

### Try it with curl

With the API running:

```bash
curl -s localhost:8000/api/health
RUN=$(curl -s -X POST localhost:8000/api/runs -H 'content-type: application/json' \
  -d '{"seed": 11, "theta": 300, "start": true}' | python3 -c 'import sys, json; print(json.load(sys.stdin)["run"]["id"])')
curl -s -X POST localhost:8000/api/runs/$RUN/drift -H 'content-type: application/json' -d '{"type": "abrupt", "theta": 800}'
curl -s localhost:8000/api/runs/$RUN/events
echo "watch it at http://localhost:5173/#run=$RUN"
```

---

## Lesson 7: One click, end to end

You click **Change it**, next to "Change the rule" in the control panel's **Try it** tab. This is everything that
happens, in order.

**In the browser:**

1. The button calls `onDrift('abrupt')` ([ControlPanel.tsx:161](../web/src/components/ControlPanel.tsx#L161)).
2. The app's `drift()` wraps the call in `act()`, which disables the buttons while it runs and turns any error into
   a toast ([App.tsx:145](../web/src/App.tsx#L145)).
3. `api.drift()` sends `POST /api/runs/{id}/drift` with `{"type": "abrupt"}` ([api.ts:73](../web/src/lib/api.ts#L73)).
   In development, Vite forwards `/api` to port 8000 ([vite.config.ts](../web/vite.config.ts#L23)). In production it
   is the same server.

**On the server, during the request:**

4. FastAPI checks the body against `DriftRequest`. Then `inject_drift` checks that the run is live and calls the
   manager ([routes.py:140](../api/routes.py#L140)).
5. `RunManager.inject` calls `Runner.inject`, then announces a fresh `state` message to every viewer
   ([manager.py:154](../api/manager.py#L154)).
6. `Runner.inject` asks the drift injector for a new θ at least 128 away, and the stream's rule switches. The runner
   counts the injection and notes the change as undetected. It also writes an `injected` record for the database and
   queues the event for the next tick ([runner.py:471](../engine/runner.py#L471)).
7. The response `{"event": {...}}` goes back to the browser.

**On the server, over the next steps of the run loop:**

8. The next tick carries the `injected` event, and predictions are now checked against the new rule.
9. The first labeled point where the two rules disagree is a mistake, and `update()` empties the interval.
   `_detected` classifies it as a drift, because the stream's version changed since the last reset. It records the
   delay and the mistakes, resets the engine and opens a recovery. The tick carries a `detected` event.
10. Ten steps of questions later (2 to 5 with recall), one rule is left. `_recovered` stores it in memory and fills
   in the detection's database record: labels spent, bound, outcome. The tick carries a `recovered` event.
11. Each tick goes to the hub, and every 100 ms the hub sends a `ticks` message.

**In the browser, as messages arrive:**

12. The reducer in `useLiveRun` appends the new ticks, error points, events and recoveries to bounded buffers and
    remembers the last question asked ([fold](../web/src/lib/useLiveRun.ts#L67)).
13. React redraws everything that changed:
    - the number line's band snaps wide open, then halves at every step;
    - the error chart gets a hollow triangle (injected) and a dot (detected);
    - the labels chart gets a new bar reaching its tick at 10;
    - "What just happened" gets three lines, and the Detections tile counts one more.

**In the database, in the background:**

14. Every 50 steps the manager drains the runner and queues a batch. The writer task writes it in one transaction:
    metric points, drift events and concept updates ([write_batch](../api/db.py#L146)). The `detected` row is
    written only once its recovery has ended, so it already carries its label count and bound.

The same flow as a picture:

```text
Browser                       API process                                               Database
───────                       ───────────                                               ────────
click Abrupt
POST /drift ────────────────► routes.inject_drift
                                └► RunManager.inject
                                     ├► Runner.inject: the stream's rule changes
                                     └► announce: the hub queues a 'state' message
'state' message ◄────────────────────┘
{"event"} reply ◄───────────────┘

                              run loop, every 50 ms
                                Runner.step() × speed: predict, label, detect, recover
                                  └► tick ──► hub
'ticks' message ◄─────────────────────────────┘ every 100 ms
reducer, redraw

                              every 50 steps
                                Runner.drain() ──► write queue ──► writer task ───────► write_batch
```

---

## Lesson 8: The database

There are four tables, defined in [api/db.py](../api/db.py#L45) and written out for psql in
[db/schema.sql](../db/schema.sql). This is what the session from Lesson 6 left in them.

**runs**: one row per run.

```text
id            name          mode   status   config (JSON)
2871c1609898  Tutorial run  exact  stopped  {"n": 1023, "p": 1.0, "noise": 0.0, "seed": 11, "theta": 300,
                                             "memory": true, "speed": 100.0, "adversary": {...}, ...}
```

`mode` and `config` are updated whenever settings change. `status` moves through `created`, `running` and `stopped`,
or `interrupted` and `error`.

**metric_points**: one row every 5 steps, keyed by run and step. Around the drift at step 206:

| step | error_rate | mistakes_total | labels_total | candidates_left | false_alarms |
|---|---|---|---|---|---|
| 200 | 0.00 | 1 | 200 | 1 | 0 |
| 205 | 0.00 | 1 | 205 | 1 | 0 |
| 210 | 0.02 | 3 | 210 | 64 | 0 |
| 215 | 0.02 | 3 | 215 | 2 | 0 |
| 220 | 0.02 | 3 | 220 | 1 | 0 |

`candidates_left` tells the recovery story. One rule before the drift, all 1,024 at the detection, 64 after four
questions (step 210), 2 after nine, and 1 again at step 216.

**drift_events**: an `injected` row at injection time, and a `detected` row once its recovery ends.

| id | step | source | drift_type | labels_to_recover | bound | details (excerpt) |
|---|---|---|---|---|---|---|
| 1 | 206 | injected | abrupt | | | from 300, to 800 |
| 2 | 206 | detected | abrupt | 10 | 10 | delay 0, 1 mistake; recovered at 216, path full, correct |
| 3 | 227 | injected | recurring | | | from 800, to 300 |
| 4 | 231 | detected | recurring | 2 | 2 | delay 4, 1 mistake; recovered at 233, path memory, correct |

**concepts**: every rule the run has learned, one row per key. A repeat updates the existing row instead of adding
another (an *upsert*).

| key | learned_at_step | rule | reuse_count |
|---|---|---|---|
| theta:300 | 10 | {"theta": 300} | 1 |
| theta:800 | 216 | {"theta": 800} | 0 |

Robust runs use keys like `model:1`, and their `rule` holds the snapshot's address, for example
`"local://runs/<run id>/model-1-step3040.pkl"`, or an `s3://` address in the cloud.

**When rows are written.** Nothing is written per step. The runner buffers records. The manager flushes them every
50 steps and when a run stops, and the single writer task writes each batch in one transaction.

**SQLite or PostgreSQL.** The tables are defined once, in SQLAlchemy Core. With `DATABASE_URL` empty, the app uses a
SQLite file, `driftbound.db` in the repo root (gitignored), so a laptop needs no database server. On AWS the same
code points at PostgreSQL (RDS), where JSON columns become JSONB. `db/schema.sql` is the same schema for psql, and a
test checks that the two agree on a real PostgreSQL. CI runs that test on every push.

**Look for yourself:**

```bash
sqlite3 driftbound.db
sqlite> .tables
sqlite> SELECT id, name, mode, status FROM runs ORDER BY created_at DESC LIMIT 5;
sqlite> SELECT step, source, drift_type, labels_to_recover, bound FROM drift_events ORDER BY id DESC LIMIT 10;
sqlite> SELECT key, learned_at_step, reuse_count FROM concepts ORDER BY id DESC LIMIT 10;
```

**Replay.** `GET /api/runs` lists the runs in the database merged with the ones in memory. `live: true` means the
server still holds the run in memory, so you can watch or resume it. Whether it is streaming is a separate field,
`status`; a stopped run can still be live. A run that is no longer live is replayed from `GET /metrics` (thinned on
the server to about 1,500 points) and `GET /events`. [fromStored](../web/src/lib/describe.ts#L67) turns those rows
back into live-style events, so the same charts can draw them.

---

## Lesson 9: The dashboard

The web app is React 19 and TypeScript, built with Vite, with charts by Recharts and the number line drawn in plain
SVG. It has three pages: the dashboard at `/`, the fraud detection test at `/test/` and the spam filter test at
`/spam/`. All of them only ever call relative
`/api` paths, so the same build works behind the Vite proxy and on the server.

### Files

| File | Job |
|---|---|
| [main.tsx](../web/src/main.tsx) | mounts the dashboard |
| [App.tsx](../web/src/App.tsx) | the dashboard: picks the run, wires the commands, lays out the page |
| [test/FraudTest.tsx](../web/src/test/FraudTest.tsx) | the fraud detection test page, mounted by [test/main.tsx](../web/src/test/main.tsx) from [web/test/index.html](../web/test/index.html) |
| [lib/useLiveRun.ts](../web/src/lib/useLiveRun.ts) | the WebSocket, and the state it builds |
| [lib/api.ts](../web/src/lib/api.ts) | the REST calls, and `DEFAULT_RUN` |
| [lib/types.ts](../web/src/lib/types.ts) | the shapes the API sends, mirroring runner.py |
| [lib/describe.ts](../web/src/lib/describe.ts) | one sentence per event, the four conditions' rows, stored rows turned back into events |
| [lib/fraud.ts](../web/src/lib/fraud.ts) | the fraud story: rupee amounts, outcomes, one sentence per event, and "what is happening now" |
| [lib/format.ts](../web/src/lib/format.ts) | number formats and labels |
| [components/](../web/src/components/) | one file per panel (listed below) |
| [styles.css](../web/src/styles.css) | one beige theme: the color tokens, and the layout of both pages |

### How data flows

```text
WebSocket messages: snapshot, ticks, state
   │
   ▼
useLiveRun's reducer ──► { connection, run, summary, points, events, recoveries, ticks, lastQuery }
   │
   ▼  props
number line, charts, tiles, banner, tables, panels
   │
   ▼  a click
act(() => api.something()) ──► REST call ──► API
   │
   └► a reply that carries a summary is applied at once; the rest arrives over the WebSocket
```

- **Which run?** ([App.tsx:58](../web/src/App.tsx#L58)) The run id lives in the URL hash, as `#run=…`. With no
  hash, the dashboard joins the newest live dashboard run (never a fraud-test run), or creates one with
  `DEFAULT_RUN`: exact mode, N = 1023, p = 1, 20 steps a second. Everyone who opens the page, presenter and jury phones alike, therefore watches the same run, and a
  link pins one (D-41).
- **useLiveRun** opens one WebSocket per run. Its reducer replaces everything on a `snapshot`, appends on `ticks`
  (keeping at most 6,000 points, 400 events, 80 recoveries and the last 50 full ticks), and replaces the run and
  summary on `state`. A step taken by hand arrives twice, in the REST reply and on the WebSocket, in either order, so
  ticks at or below the last step already seen are skipped. If the
  socket drops, it reconnects after 1, 2, 4 and 8 seconds, then every 10. The snapshot that greets each reconnect
  redraws everything.
- **Commands** go through `act()`. It marks the page busy and sends the REST call. A reply that carries a summary is
  applied at once, so a setting changes on screen before the next tick. Errors show as a toast for 6 seconds.

### The dashboard, top to bottom

| Part | What it shows | Reads | File |
|---|---|---|---|
| Top bar | the connection pill (Live, Paused, Reconnecting or Not live, with the number watching), and the **Test spam filtering** and **Test fraud detection** buttons, top right, which open `/spam/` and `/test/` | connection, run | App.tsx |
| How to read this page | three numbered sentences for a first-time viewer, and a link to the fraud test. **Hide** is remembered by the browser | | Explainer.tsx |
| Guarantee banner | green when all four conditions hold in exact mode; red, naming what is broken and why; gray in robust mode | `summary.guarantee`, `conditions` | Overview.tsx |
| Tiles | false alarms (the hero number), wrong answers, labels used, and detections for the number of rule changes | `summary.counters` | Overview.tsx |
| The hidden rule | the band of rules still possible, the engine's rule (dot), the hidden rule (triangle, known only to the simulator), remembered rules (ticks), the last label asked (diamond), and a red zone of wrong answers while a change is still undetected. A chip says Learning, Checking memory or Monitoring. Click the line to move the hidden rule there. | summary, last query | NumberLine.tsx |
| Wrong answers over time | the share of wrong answers (blue) and of disagreements with noisy labels (gray, only when they differ), the noise floor (dashed), and marks for a rule change (hollow triangle), a detection (dot) and a false alarm (short red tick). Its header holds the 500 / 2,000 / 6,000-step window for both charts. | points, events | ErrorChart.tsx |
| Labels needed to relearn | one bar per recovery, colored by path, with its own proven limit as a black tick and 10 as a dashed line | recoveries | LabelsChart.tsx |
| When is zero error possible? | the four conditions as cards: Holds or Broken, what is true now, and when zero error is possible or impossible | summary | Panels.tsx, `Conditions` |
| Control panel | Play or Pause and the speed, then three tabs. **Try it**: change the rule, bring back an old rule, change it gradually, worst-case attacker. **Break it**: the four scenarios, slow creep, and Restore everything. **Settings**: the engine (Exact or Robust), labels while monitoring (p), wrong labels (noise), memory recall, and New run | summary, run | ControlPanel.tsx |
| What just happened | newest first, one sentence per event | events | Panels.tsx, `EventLog` |
| Run history | collapsed at the bottom: stored and live runs, fraud-test runs tagged, each with Watch, Open or Replay | `GET /api/runs`, every 15 seconds | Panels.tsx, `RunHistory` |
| New run dialog | name, mode, N, p, noise, seed, memory | | NewRunDialog.tsx |
| Replay | a stored run, drawn by the same charts | `GET /metrics`, `/events` | Replay.tsx |

On a phone the two columns become one, and the control panel moves up to sit right under the number line.

Three details:

- The error chart's y-axis always starts at 0 and stops at the smallest of 10%, 25%, 50% or 100% that fits, so small
  spikes stay visible.
- The p and noise sliders keep their own value while you drag, and send it 180 ms after you stop
  ([useDebouncedSetting](../web/src/components/ControlPanel.tsx#L17)).
- Every chart has a **Table view** button that shows the same facts as rows.

### The fraud detection test page

`/test/` tells the same engine's story as fraud detection, for reviewers who would rather test than read. Input x is
a transaction of ₹(10 × x), label 1 means fraud, and the hidden threshold θ is the amount where fraud starts, ₹6,000
at first. An analyst check is a label, and fraudsters changing tactics is a drift. The vocabulary lives in
[lib/fraud.ts](../web/src/lib/fraud.ts).

- **Each visitor gets a fresh run**, created with `kind: "fraud"` and left paused, so the dashboard never joins it and
  reviewers do not disturb each other ([FRAUD_RUN](../web/src/test/FraudTest.tsx#L16)). The run id goes into the
  address bar, so a reload keeps it.
- **Test a transaction** sends `POST /step` with `x`: exactly one step that processes that amount. The reply shows
  the decision (blocked or approved), what it really was, and whether an analyst checked it.
- **Next transaction**, **Next 10** and **Play** step it with random amounts.
- **Fraudsters change tactics** injects drifts: smaller or larger amounts, an old pattern back, a gradual switch, or a
  cutoff you type. **Make it harder** turns on wrong analyst answers (noise 10%), stops spot checks (p = 0), makes
  fraud random, or switches to the noise-tolerant engine.
- **What is happening now** ([narrate](../web/src/lib/fraud.ts#L86)) explains the current state in one paragraph,
  including the exact range of amounts judged wrongly after an undetected change.
- The scoreboard reads `summary.counters.confusion`: fraud stopped, fraud missed and genuine customers blocked are the
  true positives, false negatives and false positives against the true rule.

### The spam filter test page

`/spam/` tells the same story as spam filtering, and adds the one thing a judge most needs to see: a filter that never
adapts, beside the engine, on the same emails. The vocabulary lives in [lib/spam.ts](../web/src/lib/spam.ts).

- **The story.** A separate filter gives every email a spam score from 1 to 1,023: that is input x. DriftBound does
  not score emails; it keeps the cutoff right. At or above the cutoff an email goes to the spam folder, below it to
  the inbox. Real spam starts at score 600 at first. While learning, the engine's question appears as "Reviewer
  checked an email scoring 512: not spam". While monitoring, labels are users' verdicts, and p, 20% by default, is
  the share of emails users report on ([SPAM_RUN](../web/src/spam/SpamTest.tsx#L27)).
- **Reports.** A real report disagrees with where the email went ("Report spam" in the inbox, "Not spam" in the spam
  folder). A verdict that agrees is shown as "A user opened it and left it where it was".
- **The comparison** ([useComparison](../web/src/spam/SpamTest.tsx#L64)) files every email the page
  receives twice: by the engine, and by a filter frozen at cutoff 600. It counts spam caught, spam delivered to the
  inbox, and real mail sent to spam for each. It runs in the browser, over every email since the page opened.
- **Spammers change their wording**: spam slips in with lower scores, moves to higher scores, rewords gradually, a
  typed cutoff, or "An old campaign returns" (memory finds it in 2 to 5 reviews). **Make it harder**: the report
  share (100%, 20% or 5%), users mis-report, nobody reports, spam with no score pattern, the noise-tolerant engine.
- Subject lines are invented to suit the score, and marked as simulated. Three sentences under "About this
  simulation" state the page's simplifications.
- The two test pages share their run handling ([lib/testRun.ts](../web/src/lib/testRun.ts)) and page parts
  ([components/TestParts.tsx](../web/src/components/TestParts.tsx)); each keeps its own story file.

### Design rules

Colors are named roles in [styles.css](../web/src/styles.css), in one warm beige theme: cream cards on a beige page,
serif headings and a walnut accent. `--series-1` (blue), `--series-2` (orange) and `--series-3` (green) mark the
recovery paths; they were checked again for color-blind separation against the cream card color. `--good`,
`--warning` and `--critical` are for status. A status color never appears alone: it always comes with an icon and a
word, such as Holds or Broken. Shapes carry meaning too, like the triangle, dot and tick on the error chart. See
design.md, D-39 and D-52.

### Development and production

- `npm run dev`: Vite serves the page on port 5173 with instant reload, and forwards `/api`, WebSocket included, to
  port 8000.
- `npm run build`: type-checks, then writes `web/dist`, which FastAPI serves at `/`. `index.html` is sent with
  `no-cache` and the hashed asset files are cached for a year, so a redeploy shows up at once (D-37).
- `npm run lint`: runs oxlint.

---

## Lesson 10: Tests, experiments, CI and deployment

### Tests: one per theorem

`pytest` runs 65 tests in under 15 seconds. The PostgreSQL test is skipped unless `TEST_DATABASE_URL` is set.

| File | Tests | What they prove |
|---|---|---|
| [test_exact.py](../tests/test_exact.py) | 16 | every rule takes exactly 10 labels; the interval is exactly the consistent rules; 0 false alarms and 0 errors over 100,000 drift-free steps; detection at the first labeled mistake; harmless drifts are ignored; zero error after every recovery |
| [test_memory.py](../tests/test_memory.py) | 6 | recall within ⌈log₂ K⌉ + 2; the fallback within its bound; the contradicted rule is skipped; recall skipped when it cannot win; least-recently-used eviction; a recurring drift end to end |
| [test_bounds.py](../tests/test_bounds.py) | 5 | the formulas; a Kraft sum of exactly 1 for binary search; memory has a price; mistakes before detection average 1/p; the noisy detection cost grows like 1/ε |
| [test_adversary.py](../tests/test_adversary.py) | 7 | worst-case answers force exactly 10 labels without memory and at least 10 with it; five query strategies all lose to the halving adversary; rapid-fire error; stealth hides without labels and is caught with them |
| [test_robust.py](../tests/test_robust.py) | 4 | recovery under 10% noise; exact mode's false alarms under the same noise; robust mode stays quiet without drift; model reuse |
| [test_runner.py](../tests/test_runner.py) | 12 | same seed, same run; the gradual, out-of-family, monitoring-off and noise scenarios; All clear; a mode round trip; `drain` hands each record over once; bad commands rejected; the guarantee flag; a chosen input; outcome counts |
| [test_api.py](../tests/test_api.py) | 12 | a run over HTTP and WebSocket detects, recovers and writes history; metric thinning; robust snapshots; settings, scenarios and adversary; errors; eviction, which spares watched runs; idle stop; stepping by hand with a chosen input |
| [test_db.py](../tests/test_db.py) | 3 | a SQLite round trip; orphaned runs become `interrupted`; `schema.sql` matches the app's tables on a real PostgreSQL |

```bash
pytest                                  # everything
pytest tests/test_exact.py -k harmful   # one test, by name
pytest -x                               # stop at the first failure
TEST_DATABASE_URL=postgresql+asyncpg://USER:PASSWORD@localhost:5432/driftbound_test pytest tests/test_db.py
```

In VS Code, the Testing panel finds every test, and the "Tests (current file)" launch configuration runs one file
under the debugger.

### Experiments: the measured numbers

[notebooks/experiments.py](../notebooks/experiments.py) measures each claim by simulation, seeded so the numbers
repeat. Run it whole with `python notebooks/experiments.py` (a few seconds), or cell by cell in VS Code. Its seven
tables are the ones quoted in theory.md:

1. all 1,024 rules take 10 labels;
2. recall against new rules, for K = 1, 2, 4 and 8;
3. mistakes before detection against 1/p;
4. detection delay against N / |drift|;
5. false alarms under noise, for both modes;
6. the worst-case adversary, with and without memory;
7. rapid-fire error against 1/k.

### CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on every push and pull request, with two jobs. One
installs Python 3.11, starts a PostgreSQL 16 service and runs ruff and pytest, so the schema test runs as well. The
other runs `npm ci`, the linter and the build for the dashboard. It will start working once the repo is committed and
pushed to GitHub; nothing has been committed yet.

### Deployment: prepared, not run

The target, from the build plan:

```text
browser ──HTTPS──► CloudFront ──► EC2 t3.micro (ap-south-1): uvicorn on port 80, run by systemd, one worker
                                  ├──► RDS PostgreSQL db.t4g.micro: history
                                  └──► S3 bucket: robust-model snapshots, reached through the instance's IAM role
```

The pieces are in [deploy/](../deploy/):

- `driftbound.service` is the systemd unit. It runs one worker, because live runs exist only in that process's
  memory.
- `bootstrap_ec2.sh` is the one-time setup on the instance: Python 3.11, the virtual environment, and
  `/etc/driftbound.env` created from the template, readable by root only.
- `driftbound.env.example` is that template: `DATABASE_URL`, `MODELS_BUCKET`, `AWS_REGION`. Real values live only on
  the server.
- `deploy.sh` runs on your Mac. It builds the dashboard, copies the repo up with rsync, installs packages, restarts
  the service and calls `/api/health`.

The order:

1. Create the EC2 instance, the RDS database (initial name `driftbound`), the S3 bucket and the IAM role.
2. Run `deploy.sh` once to copy the code up.
3. On the instance, run `bootstrap_ec2.sh`, fill in `/etc/driftbound.env`, and load `db/schema.sql`.
4. From then on, `deploy.sh` does everything.

Check first whether CloudFront is available on the account; the fallback is plain HTTP on the instance's Elastic IP.
Nothing has been run against AWS yet: it needs the team's account, and it spends credits.

---

## Hands-on exercises

Each exercise takes a few minutes. Start the two servers first (Lesson 0) unless an exercise says otherwise.

**1. Replay Lesson 1 in a Python shell.** No servers needed. From the repo root, run
`source .venv/bin/activate && python`, then:

```python
from engine.runner import RunConfig, Runner

r = Runner(RunConfig(n=15, seed=3, theta=11))
for _ in range(6):
    t = r.step()
    print(t["step"], t["query"], t["query_label"], (t["lo"], t["hi"]), t["state"])
r.inject("abrupt", theta=4)
t = r.step()
print(t["step"], t["events"][-1]["type"], (t["lo"], t["hi"]))
```

You should see the questions 8, 12, 10 and 11, the interval shrinking to `(11, 11)`, then `7 detected (1, 16)`. Try
another `theta`, and predict the questions before you run it.

**2. Watch the band collapse.** In the control panel's Settings tab, click New run… and create a run with N = 15. It
learns in a fraction of a second, so set the speed to 1 step/s right after. Now click the number line to move the true rule. Watch the detection, then
the four questions that halve the band.

**3. Memory on and off.** In the Try it tab, click Change it twice, then Bring back. The new bar in "Labels needed to
relearn" is orange and short (2 or 3 labels), and it reaches its own tick. Untick Memory recall in Settings, click
Change it, then Bring back again: this time the bar is blue and costs 10.

**4. Fewer labels, slower detection.** In Settings, set "Labels while monitoring" to 25%. Click Change it several
times and read "Change detected after … steps and … wrong answers" in What just happened. The wrong answers average
about 4, which is 1/p, and the Labels used tile grows four times slower while monitoring.

**5. Break a condition, then compare modes.** In the Break it tab, run "Wrong labels (10%)". False alarms climb, the
banner turns red and names labels, and the gray line sits above the dashed 10% floor. In Settings, switch the engine
to Robust and the false alarms stop. To get back to the start, click Restore everything, then switch back to Exact.

**6. Drive it from the terminal.** Run the curl commands from Lesson 6, using the run id from the page's URL (the
part after `#run=`). Each command shows up on the dashboard within a tenth of a second, because the server announces
it to every viewer.

**7. Break the engine on purpose, then undo it.** In [engine/exact.py](../engine/exact.py#L81), change `x >=` to
`x >` in `predict()`, so that predicting and updating disagree about what a threshold means. Run
`pytest tests/test_exact.py`. Two tests fail: `test_zero_false_alarms_and_zero_error_over_100k_drift_free_steps` and
`test_zero_error_after_every_adaptation`. The engine still raises no false alarms, but it now makes silent mistakes
exactly at x = θ, and the tests that count errors after recovery catch them. Undo the change with Cmd+Z (there is no
commit to restore from yet) and run the tests again.

**8. Replay from the database.** Restart the API: Ctrl+C, then start it again. The old run is no longer in memory,
so Run history offers Replay instead of Watch. Its charts are now rebuilt from the database alone. Then open
`driftbound.db` with sqlite3 (Lesson 8) and find the same drift events.

**9. Feel the price of memory.** Turn on the Worst-case attacker (Try it tab) with memory on. The bars land at about 12 to 13, above
the dashed 10-label line but never above their own ticks. Turn memory off, and every bar is exactly 10.

**10. Test fraud detection.** Click Test fraud detection, top right. Press Next 10: in ten analyst checks the engine
learns that fraud starts at ₹6,000. Send ₹5,000 (approved, genuine). Under "Or choose where fraud starts", set
₹3,000, then send ₹4,500. The engine still approves it, but it was fraud: the analyst's check contradicts the
engine's rule, the row turns red, and the engine starts relearning. Press Next 10 again and it settles on ₹3,000.

**11. Beat a filter that never adapts.** Click Test spam filtering, top right. Press Next 10: ten reviews set the
cutoff at score 600, and the comparison is level. Under "Or choose where spam starts", set 350, then press Next 10
several times. Spam scoring 350 to 599 lands in the inbox for both filters until a user reports one (at 20% reports
this can take dozens of emails). Then DriftBound relearns, and its "Spam delivered to the inbox" stops growing while
the fixed filter's keeps climbing. Now press "An old campaign returns" and count the reviews: 2 to 5.

---

## Where to change things

| I want to… | Edit | Also update |
|---|---|---|
| change the default N | `RunConfig.n` in engine/runner.py | `CreateRun.n` in api/schemas.py, `DEFAULT_RUN` in web/src/lib/api.ts, the New run form |
| change the memory size | `RunConfig.memory_capacity` | it also caps robust mode's model store |
| tune robust mode (δ, grace, reuse rule) | the `RobustEngine` defaults in engine/robust.py | the runner passes only the capacity |
| change how far random drifts jump | `DriftInjector.min_jump` in engine/streams.py | |
| change the gradual window | `RunConfig.gradual_width` | the Try it text in ControlPanel.tsx says 200 |
| change how often the worst-case adversary strikes | `Adversary.worst_case_gap`, or send `gap` to `POST /adversary` | |
| store metrics more or less often | `RunConfig.metric_every`, `Settings.flush_every` | |
| change the speeds | `default_speed` and `max_speed` in api/config.py | the speed limit in api/schemas.py, `SPEEDS` in ControlPanel.tsx and test/FraudTest.tsx |
| add a field to the tick | the tick dictionary in `Runner.step()` | `Tick` in types.ts, and the component that shows it |
| add a drift type | `DriftInjector`, plus `Runner._inject` and `DRIFTS` | `DriftRequest`, `DriftKind`, the Try it tab in ControlPanel.tsx, `DRIFT_LABEL`, `describe()`, `fraudEvent()` |
| add a lab scenario | `SCENARIOS` and `apply_scenario` in runner.py | `ScenarioRequest`, `ScenarioName`, the Break it tab in ControlPanel.tsx, `SCENARIO_LABEL` |
| add an endpoint | `build_router` in api/routes.py (keep it `async`) | a `RunManager` method, api.ts, the README's API table |
| add a database column | the table in api/db.py, and db/schema.sql | the column lists in db.py. An existing PostgreSQL also needs `ALTER TABLE`, because the app creates only missing tables. |
| change a color | the tokens at the top of styles.css (one theme) | check contrast and color-blind separation again |
| change the fraud story | `RUPEES_PER_STEP` in web/src/lib/fraud.ts, `FRAUD_RUN` (the starting cutoff) in web/src/test/FraudTest.tsx | the wording in `narrate()` and `fraudEvent()` |
| change the spam story | `START_CUTOFF` and the subject lines in web/src/lib/spam.ts, `SPAM_RUN` (report share) in web/src/spam/SpamTest.tsx | the wording in `narrateSpam()` and `spamEvent()` |

Whatever you change, record the decision in [design.md](../design.md).

---

## Questions people will ask you

**"You promise zero error, but I saw mistakes."** The promise has three parts: zero false alarms, at most 11
mistakes per drift with p = 1, and zero errors once recovered. No learner can avoid the first mistake after a drift
(Theorem 8), so literal zero error is impossible whenever drift is possible at all. The problem statement accepts a
matching impossibility result, and the dashboard shows both halves: what is achieved, and what cannot be.

**"Isn't asking for labels cheating?"** Labels are the cost being measured, and the tiles count every one. While
learning, the engine picks the point it asks about. That assumes a labeler who can answer for any x (design.md,
known limitations). With p below 1 it buys fewer monitoring labels and detects later, after about 1/p mistakes.

**"Why thresholds? Real models are more complex."** Thresholds are the simplest family where every bound can be
proved exactly and then matched, so the dashboard shows proven numbers rather than estimates. The same reasoning
extends to any finite family through the Littlestone dimension (theory.md, section 4.2). For messier data there is
robust mode.

**"What if the labels are noisy?"** Then no detector can promise zero false alarms and zero misses at once
(Impossibility 1c). Exact mode raises false alarms. Robust mode tolerates the noise, with probabilistic guarantees.
The "10% label noise" scenario shows both.

**"What happens if the server restarts?"** Live runs end, because their state lives in the process's memory. Their
history stays in the database, and runs that were streaming are marked `interrupted`. The page offers to start a new
run.

**"How do I know the numbers on screen are right?"** Each bound comes from bounds.py, each theorem has a test, and
notebooks/experiments.py measures every bound by simulation. The labels chart draws each recovery's own proven bound
right beside it.

---

## Glossary

- **Abrupt drift**: the rule jumps to a new θ at once.
- **ADWIN**: an adaptive-window change detector (Bifet and Gavaldà 2007). It watches a stream of numbers, here 1 for a
  wrong prediction and 0 for a right one, and signals when the recent average differs from the older one by more
  than chance allows.
- **Bound**: a proven limit, from bounds.py, such as 10 labels per recovery.
- **Concept, rule**: what turns an input into its true label. Here, usually a threshold θ.
- **Concept drift**: the rule changes over time. Only the labeling changes, never how inputs are drawn.
- **Concept memory**: up to 8 learned rules, checked first after a drift (recall).
- **Conditions A1 to A4**: rule family, clean labels, label access and drift timing. Zero error is achievable only
  when all four hold.
- **Detection delay**: steps from a drift to its detection.
- **False alarm**: a detection when the rule has not changed since the last reset (cause `noise`).
- **Gradual drift**: for a window of steps, labels come from the old or the new rule, with the new one ever more
  likely.
- **Halving rule**: predict with the majority vote of the rules still possible. For an interval, that is its
  midpoint.
- **Hoeffding tree**: an online decision tree that splits once it has statistically enough evidence. It is robust
  mode's model, from River.
- **Kraft inequality**: in any yes/no decision tree, the sum of 2^−depth over the leaves is at most 1. It is why
  memory has a price.
- **Label**: the true 0 or 1 for an input, from the label oracle. Every label costs 1.
- **Label noise (η)**: the probability that a label is flipped.
- **Learning, recalling, monitoring**: the exact engine's states. It is searching, checking stored rules first, or
  holding one rule and watching.
- **Littlestone dimension**: the most mistakes an adversary can force on the best possible learner of a rule family.
  It is 10 for thresholds on 1,023 points.
- **LRU (least recently used)**: how memory picks what to drop when it is full.
- **Membership query**: the engine picks a point and asks for its label.
- **Mistake**: a prediction that disagrees with the true rule (not with the noisy label).
- **Monitoring rate (p)**: while monitoring, the probability of buying the arriving point's label.
- **N**: the number of inputs, 1,023. There are N + 1 thresholds.
- **Out of family**: a rule that is not a threshold (random labels).
- **Recovery**: relearning after a detection. It is reported with its labels, its bound and its path: `full`,
  `memory` or `memory_fallback`.
- **Recurring drift**: the rule returns to one used earlier.
- **River**: the Python library for online machine learning that provides the Hoeffding tree and ADWIN.
- **Snapshot**: the first WebSocket message, with everything needed to draw a run you have just joined. The word also
  means a saved robust model, pickled to S3 or `./models`.
- **θ (theta), θ̂ (theta hat)**: the true threshold, and the engine's current one.
- **Tick**: the record of one step, sent to the dashboard.
- **Upsert**: insert a row, or update it if its key already exists. Used for concepts.
- **Version space**: the set of rules consistent with every label since the last reset. For thresholds, the interval
  [lo, hi].
- **WebSocket**: a connection that stays open, so the server can push messages to the browser.
