# DriftBound: design record

This file records every design decision taken while building DriftBound, every change from the original plan ("Drift
Adaptation Engine: Design and Build Plan", @Sufian, 6 October 2026), and what was verified. It is the place to look
when you want to know *why* something is the way it is.

- **Decisions** are numbered `D-nn`. Each says what was decided, why, what else was considered, and where it lives in
  the code.
- **Changes from the plan** are numbered `C-nn` and point to the decision behind them.
- The **change log** at the end lists the work in the order it was done.

When you change something, add or update the matching entry here in the same commit.

---

## 1. Status

Built on 7 October 2026, up to the end of the development phase. Deployment to AWS is the next step and was not
run.

| # | Milestone | Status | Evidence |
|---|---|---|---|
| 0 | Setup | Done | Repo, venv (Python 3.11), folder skeleton, `db/schema.sql`, theory outline; `pytest` and both dev servers start |
| 1 | Stream and exact engine | Done | Every rule recovered in exactly 10 labels; 0 false alarms over 100,000 drift-free steps |
| 2 | Adversary and bounds | Done | Worst-case answers force exactly 10 labels (without memory); rapid fire at k = 1 keeps the error at 100% |
| 3 | Concept memory | Done | Returning rule recovered within ⌈log₂K⌉ + 2 labels; the bound is reached, so it is tight |
| 4 | Robust engine | Done | At 10% noise robust mode recovers (error < 5%) while exact mode raises false alarms |
| 5 | API and database | Done | A run started over the API streams ticks; rows land in SQLite and in a real PostgreSQL 18 |
| 6 | Dashboard | Done | Abrupt drift shows the spike, the detection mark and the recovery live. Redesigned for reviewers in one beige theme, plus a fraud detection test page at `/test/`; both checked on desktop and a 390 px phone (D-52 to D-56) |
| 7 | Deployment | **Not started** | `deploy/` holds the service unit, deploy script, EC2 bootstrap and env template, all unrun |
| 8 | Theory and rehearsal | Theory done | `docs/theory.md` has the full proofs; slides, the timed rehearsal and the backup recording are still to do |

Test suite: 66 tests, all passing (the PostgreSQL test runs when `TEST_DATABASE_URL` is set; CI sets it). Full run
about 11 seconds.

## 2. Architecture as built

```
browser (React + Recharts): the dashboard at /, fraud test at /test/, spam test at /spam/
   │  REST commands: /api/runs/...            ▲ WebSocket /api/runs/{id}/live: snapshot, then
   ▼                                          │ batches of ticks about 10 times a second
FastAPI, one uvicorn process (api/main.py) ───┘
   ├─ routes.py    REST + WebSocket (all async, so they never race the engine)
   ├─ manager.py   one asyncio loop per running run; one writer task for all storage
   ├─ live.py      hub: buffers ticks per run, thins and fans them out
   ├─ db.py        SQLAlchemy Core tables: PostgreSQL (RDS), or SQLite when DATABASE_URL is empty
   └─ storage.py   robust-model snapshots: S3, or a local folder
engine/ (pure Python, no web imports)
   streams.py  inputs, true rule, noise, drift injector     exact.py   candidate elimination + recall
   memory.py   stored rules (LRU, capacity 8)               robust.py  Hoeffding tree + ADWIN + model memory
   adversary.py  worst case, rapid fire, stealth            bounds.py  every proven number
   runner.py   one step: predict → adversary → label → update → account
```

A step, in `Runner.step()`:

1. close a finished gradual window;
2. draw the input;
3. predict;
4. let the adversary act, after seeing the input and the prediction;
5. draw the clean label and the noisy label, and count mistakes;
6. either query the oracle (learning), or pay for the arriving point's label with probability *p* (monitoring);
7. update, detect, recover, and record events;
8. emit a tick, and a metric point every 5 steps.

The input is random unless the caller chooses it (`Runner.step(x)`, D-54).

---

## 3. Decision log

### Project and tooling

**D-01. The repository root is the workspace folder itself.** The plan's tree is rooted at `driftbound/`. Putting the
repo at the root of the opened VS Code folder means `.vscode/` (launch, settings, extensions) works without
re-opening a subfolder. On the server the path stays `/home/ec2-user/driftbound` as planned. *Considered:* a
`driftbound/` subfolder, which leaves `.vscode/` unused unless the subfolder is opened. Recorded as C-01.

**D-02. Python 3.11.** The plan says 3.11 or 3.12. This Mac has 3.11, 3.13 and 3.14. River 0.26.1 installs and
passes every test on 3.11, and Amazon Linux 2023 ships a `python3.11` package, so local and server versions match.

**D-03. One frozen `requirements.txt`** (`pip freeze`, as the plan does), dev tools included. It is simpler than a
runtime/dev split, and installing pytest and ruff on the server is harmless. Two packages were added to the plan's
list: `aiosqlite` (D-24) and `httpx2` (D-05). Recorded as C-03.

**D-04. `pyproject.toml` holds the pytest and ruff config.** pytest gets `pythonpath = ["."]` and `testpaths`. ruff
uses line length 110, rule sets E, F, W, I, B, UP and SIM, and ignores SIM102 and SIM108, two style rules that made
the adversary code harder to read.

**D-05. A test for every guarantee, plus integration tests.** `tests/` has one test per theorem (the docstrings say
which), API tests through FastAPI's TestClient on a temporary SQLite file, and a schema test against real PostgreSQL
(D-24).

### The exact engine

**D-06. Learning uses membership queries, one per step.** The plan's engine "asks the label oracle for the label of
the middle point". That is Angluin's membership-query model: the engine chooses the point. One query per step makes
the band on the number line visibly halve once per step, and makes "10 labels" also mean "10 steps".
*Considered:* waiting for random stream points to fall inside the band, as stream-based active learning does, which
is slower and has no exact bound. `engine/exact.py`, `Runner._exact_step`.

**D-07. Prediction is the version-space majority, i.e. the plan's rule.** `x >= (lo + hi) // 2` is exactly the Halving
algorithm's majority vote, ties going to 1. This was kept unchanged, and the theory relies on it (docs/theory.md §2).

**D-08. After a detection the version space resets to all rules; the detecting label is not reused for the search.**
Recovery is then the from-scratch identification problem. It costs exactly ⌈log₂(N+1)⌉ labels, meeting the lower
bound with nothing left over. The recovery path also stops depending on the random input, which lets the worst-case
adversary compute its attack in advance (D-13). The cost of discarding the label is at most one query, because it
leaves at least half the rules alive in the worst case. The detecting label counts as monitoring cost.
*Considered:* re-applying it, which saves up to one label but makes recovery counts input-dependent and the bound
"at most" rather than "exactly". Explained in docs/theory.md §3.

**D-09. Recall skips the rule that was just contradicted.** This was found by testing. The first version tried
memory first, and right after the first drift memory holds only the old rule, which the detecting label has just
disproved. Every run wasted 2 labels on its first drift: 12 instead of 10. The engine now remembers the rule it
converged on (`ExactEngine.rule`) and excludes it on `reset_after_drift()`. The adversary's simulation calls the same
method (D-13).

**D-10. Recall only when it can win, then fall back without waste.** Memory is consulted only if
⌈log₂K⌉ + 2 < ⌈log₂(N+1)⌉ (`bounds.recall_is_worthwhile`). Recall splits the stored rules, then confirms the survivor
with at most 2 labels, skipping any query the interval already answers. On a miss it binary-searches what is left of
the interval, keeping every label bought. Memory capacity is 8, with least-recently-used eviction; 8 rules cost at
most 5 labels to recall, against 10 for a full search. Each recovery records its path: `full`, `memory` or
`memory_fallback`.

**D-11. Every recovery is reported against the bound for its own path.** The bound is 10 for a full search,
⌈log₂K⌉ + 2 for a recall that hits, and ⌈log₂K⌉ + 2 + 10 for a recall that misses. Theorem 6 in the theory proves
that a learner fast on returning rules *must* be slow on some new rule (Kraft inequality). So the plan's "bars touch
the line and never cross it" cannot hold with memory on. It became "no bar crosses its own bound tick", and bars above
the dashed 10-line show the price of memory. Measured: the per-path bounds are reached exactly, so they are tight.
Recorded as C-07.

### Stream, drift and adversary

**D-12. Separate random generators for inputs, labels and noise, drift choices, the monitoring coin, and the
adversary.** The same seed gives the same run (`test_same_seed_gives_the_same_run`), and changing *p* or the noise
never changes the input sequence. `Stream.__init__`, `Runner.__init__`.

**D-13. The worst-case adversary is realized by simulating the engine.** The textbook adversary answers each query
adaptively, keeping the larger half alive. The dashboard, however, needs a definite true rule at every step, to count
mistakes and draw the truth. Since the engine is deterministic and its recovery path does not depend on the input
(D-08), the adversary plays the recovery on a copy (`copy.copy` plus `reset_after_drift`) and commits to the one rule
left. That is equivalent for deterministic learners. It counts only rules outside memory and different from the
current rule, so the attack always uses a new rule and recall cannot shortcut it. It attacks after 100 steps of
monitoring. `worst_case_threshold()`.

**D-14. Rapid fire picks the rule that makes the current prediction wrong; its changes are not logged one by one.**
At k = 1 every prediction fails, the theorem's construction exactly. The changes still count as drift for detection
delay and cause, but are not written as individual events: at 500 steps per second they would flood the charts and
the database. Stealth moves the rule by one every 50 steps and bounces at the ends.

**D-15. Random abrupt drifts move at least (N+1)/8 thresholds.** That keeps a demo drift visible on screen and
detected within a few steps. Small drifts are the stealth adversary's job, and an exact `theta` can always be given,
which is what clicking the number line does.

**D-16. The simulator classifies each detection, and only the engine is kept blind.** The causes are `out_of_family`
(no threshold fits), `gradual` (two rules mixing), `drift` (the rule changed since the last reset) and `noise` (nothing
changed). Only `noise` counts as a false alarm. The truth is used only to label events and fill the conditions panel,
never inside an engine. `Runner._cause`.

**D-17. Mistakes are counted against the clean label; a second rate uses the noisy one.** The guarantee is about the
true rule. The observed rate makes the noise floor (η + (1−2η)·error) visible on the error chart.

**D-18. "Drift timing" is tracked as a live condition.** It is broken while rapid fire or stealth is on, while a
gradual window is open, or when a drift lands mid-recovery (`_overlap`). The overlap flag clears once a recovery ends
on the true rule, or at the next detection. Without that, a lucky contaminated recovery would show the guarantee as
void forever; the test suite caught this (D-46).

### Robust engine

**D-19. A Hoeffding tree with an exhaustive splitter, chosen by experiment.** Setup: 10% label noise, every point
labeled, drift from θ = 300 to 800 at step 3,000, ADWIN resets. Error is measured against the true rule.

| River model | error before drift | after (steps 3,500–4,000) | settled (5,000–6,000) | alarm after drift | µs per step |
|---|---|---|---|---|---|
| LogisticRegression, SGD | 0.047 | 0.110 | 0.065 | never | 3 |
| LogisticRegression, Adam | 0.052 | 0.198 | 0.059 | 167 steps | 4 |
| HoeffdingTree, Gaussian splitter | 0.012 | 0.014 | 0.011 | 71 steps | 14 |
| HoeffdingTree, exhaustive splitter, grace 50 | 0.004 | 0.026 | 0.004 | 71 steps | 21 |
| **HoeffdingTree, exhaustive splitter, grace 20, δ = 1e-5** | 0.013 | **0.010** | **0.003** | 71 steps | 23 |
| kNN, k = 15 | 0.067 | 0.066 | 0.063 | 71 steps | 498 |

The exhaustive splitter can split exactly at the threshold; the Gaussian splitter tries only about ten candidate
points. Grace 20 adapts faster after a swap, at a small steady-state cost. Logistic regression never fired ADWIN
under SGD. kNN is 25 times slower. `engine/robust.py:make_model`.

**D-20. ADWIN with δ = 0.002, reacting to rising error only, with a 30-label grace after a model swap.** ADWIN also
fires when the error *falls*, for example as a fresh model improves, so the engine compares the estimate before and
after each update. Prototype result: no false alarms in 30,000 drift-free steps at 0%, 10% and 20% noise.

**D-21. Model memory and reuse.** On an alarm, the failing model is stored, because it describes the concept that
just ended. Stored models are scored on the last 32 labels. One is reused if its accuracy is at least 0.75 and at
least 0.10 better than the failing model. Otherwise a fresh model starts, warmed on those 32 labels. *Changed during
the prototype:* the first version scored on 64 labels, which straddled the drift at *p* = 0.3 and rejected the right
model (0.78 accuracy). Capacity is 8, least recently used. A reused model that is retired again replaces its own
entry, so there are no duplicates.

**D-22. Robust mode labels only arriving points, with probability *p*.** It is a passive online learner; queries are
exact mode's tool. Its number-line marker is the model's estimated boundary: the point where predictions switch to 1,
found by binary search over predictions.

### Data model and persistence

**D-23. The live demo never waits for the database.** Run IDs are 12-hex strings made by the API, not database
serials, so creating a run needs no round trip. All writes go through one queue, drained in order by one writer task.
If the database is down, the demo keeps running, the failures are logged, and `/api/health` shows them. A run row
whose insert failed is retried before anything that references it. `api/manager.py`.

**D-24. SQLite when `DATABASE_URL` is empty.** The laptop fallback demo and the tests need no database server. The
tables are defined once in SQLAlchemy Core, with JSON stored as JSONB on PostgreSQL. The API calls `create_all` on
startup, which is harmless when the tables exist. `db/schema.sql` is the same schema for `psql`, and
`test_schema_sql_matches_the_app_tables_on_postgres` checks that they agree: same tables, columns, nullability and
primary keys. CI runs it against a PostgreSQL 16 service. It was also verified locally against a throwaway
PostgreSQL 18 cluster.

**D-25. Schema details.**

- `runs.id` is text (D-23). `runs.mode` is the *current* mode, because modes can switch live (D-31).
- `metric_points` gained `mode`, `observed_error_rate` and `false_alarms`, so a replay can draw the noise floor and the
  hero number.
- `concepts` gained a `key` (`theta:412`, `model:3`), unique with `run_id`, so reuse is an upsert of `reuse_count`.
- CHECK constraints cover the two stable enums (`mode`, `source`). `status` is left open, so new statuses need no
  migration.

Recorded as C-04.

**D-26. A detected event is written when its recovery ends.** That way `labels_to_recover` and `bound` are filled in,
and `details.outcome` says how the recovery ended: `recovered`, `interrupted`, `abandoned` or `open_at_close`. The tick
for the dashboard is sent at detection time, as before.

**D-27. One metric point every 5 steps, written in batches every 50 steps.** At 500 steps per second that is 100 rows
per second, well within what a db.t4g.micro handles. `GET /metrics?max_points=` thins on the server with
`step % (5·stride) = 0`, so a long run replays as about 1,500 points.

**D-28. Model snapshots get unique object names.** The name is `runs/{run}/{key}-step{n}.pkl`, in S3 or under
`./models/` (`local://` URIs). The concept row keeps the newest URI. Snapshots are pickles: load only from our own
bucket.

**D-29. On startup, runs still marked `running` become `interrupted`.** Their live state lived in the dead process's
memory.

### API and live updates

**D-30. All endpoints are `async`.** FastAPI runs plain `def` endpoints in a thread pool, where they would mutate a
runner while its loop is stepping. Async endpoints run on the same event loop, so commands and steps never interleave.

**D-31. Mode switches happen live on the same stream** (`PATCH /runs/{id}`). The plan's demo says "switch to robust
mode on the noisy stream". Switching to exact mode relearns from scratch; robust mode keeps its model across switches.

**D-32. Endpoints added to the plan's list:** `GET /runs` (run history), `PATCH /runs/{id}` (mode, p, noise, speed,
memory), `POST /runs/{id}/scenario` (one-click impossibility lab, applied atomically on the server), and
`GET /runs/{id}/concepts`. Recorded as C-05.

**D-33. Tick fields.** Ticks carry the plan's fields plus `y_obs`, `query`, `query_label`, `mode`, `theta`,
`theta_hat`, `observed_error_rate`, `mistakes_total`, `candidates_left` and `false_alarms`. The plan's `event` became
`events`, a list, because one step can carry several events: an injection and a detection, for example. Recorded as
C-05.

**D-34. Hub behaviour.**

- The run loop steps every 50 ms and flushes to the hub every 100 ms. A message carries at most 60 ticks: every tick
  with an event, the last tick, and an even sample of the rest.
- Each viewer has a 32-message queue; a slow viewer loses old messages instead of slowing the run.
- On connect, a viewer gets a snapshot: the last 1,500 steps, 300 events and 200 recoveries. A juror's phone shows
  full charts at once.
- A 15-second heartbeat keeps idle sockets open through CloudFront.
- Send and receive run in an anyio task group. That was a fix: plain asyncio tasks leaked a cancellation when the test
  client closed the socket.

**D-35. Live runs are capped at 4 in memory and auto-stop after 10 minutes with no viewer.** The oldest idle run is
evicted, and it stays in history. A run left streaming after every tab has closed, or started from the API and never
watched, therefore stops on its own instead of keeping the t3.micro's CPU busy and the database growing. A tab left
open counts as a viewer and keeps its run going. These are settings: `MAX_LIVE_RUNS` and `IDLE_STOP_SECONDS`.
*Corrected 7 October 2026:* this entry first claimed the stop also covered a forgotten open tab, which it does not.
*Changed 7 October 2026 (D-54):* the cap is now 12, and runs nobody is watching are evicted first. *Changed again
(D-59):* 24, for three pages.

**D-36. Speed defaults to 20 steps per second, with a maximum of 500.** A stalled loop drops time rather than racing
to catch up, with at most 250 steps per burst.

**D-37. Cache headers: `index.html` is `no-cache`; hashed assets are `immutable` for a year.** Found while testing: a
browser kept a stale `index.html` and ran the previous build. Without this, phones would show an old dashboard after a
redeploy. `DashboardFiles` in `api/main.py`. Recorded as C-12.

### Dashboard

**D-38. Scaffolded with create-vite 9.** That gives React 19, Vite 8 and TypeScript 6, with Recharts 3.10 for charts
and a hand-drawn SVG number line. The template's linter is now oxlint, used instead of the plan's ESLint (C-09).
Recharts 3 deprecates `Cell`, so bars use a custom `shape`.

**D-39. Charts follow a written data-visualization method.**

- The palette was validated with a script for color-blind separation, in light and dark mode.
- The error chart uses the *emphasis* form: error against the true rule in blue, error against the observed labels
  as gray context.
- Recovery paths use the first three categorical slots, with a legend.
- Drift marks use shape as well as color: a hollow triangle for injected, a dot for detected, and a short red tick for
  a false alarm, so dozens of false alarms do not become a wall.
- Every chart has a table view. The aqua slot is below 3:1 contrast on light, and the table view is its relief.
- The y-axis always starts at 0 and stops at the smallest round ceiling that fits (10%, 25%, 50% or 100%), so small
  spikes stay visible.
- Status colors always carry an icon and a label.
- Dark mode had its own validated steps, not an inverted light theme. *Superseded by D-52 and D-55:* there is one
  beige theme now, and the palette was validated again against its cream card color.

**D-40. The number line is the centrepiece.** It shows the band of rules still possible, the engine's rule, the true
rule (which only the simulator knows), stored rules and the last label asked. Clicking or tapping it injects an abrupt
drift to that threshold.

**D-41. The page auto-joins the newest live run and puts its ID in the URL hash.** Everyone who opens the page,
presenter and jury phones alike, watches the same run, and a link pins a run.

**D-42. A live verdict.** The banner and the boundary table compute the four conditions from the run's state and say
which ones are broken, in words.

**D-43. Impossibility lab: four scenarios plus "All clear".** Impossibility 1 has two faces, *no labels* and *noisy
labels*, so there are four buttons for three results (C-06). Scenarios switch to exact mode, since they demonstrate
its limits. "Monitoring off" waits until the engine has settled before drifting; otherwise learning queries would
catch the drift and spoil the point. "All clear" restores clean labels, *p* = 1, no adversary and a threshold rule,
then relearns from scratch. *Since D-52* the scenarios sit in the control panel's Break it tab under plain names (No
labels after a change, Wrong labels (10%), No rule to find, Rule changes every step), and All clear is labeled
Restore everything.

**D-44. Replay of stored runs.** The run history lists runs from the database. A finished run replays its stored
metric points and drift events through the same charts, which shows the jury that the cloud database is in use.

### Verification and docs

**D-45. Rendered, not just compiled.** The dashboard was driven in headless Chrome over the DevTools protocol, with a
separate throwaway profile, and screenshotted on desktop and a 390 px phone, in light and dark, through these
scenarios: abrupt, recurring and gradual drift, worst-case adversary, 10% noise, rule outside the family, and robust
mode. Fixes that came out of looking:

- an unsized status icon;
- a CSS rule that stretched the legend icons;
- the speed menu missing the current speed, and "1 steps/s";
- a fixed 0–100% axis that flattened small spikes;
- a page 695 px wide on a 390 px phone, from a visually hidden table cell positioned against the page;
- the stale-cache problem in D-37;
- "after 1 steps".

**D-46. Bugs the tests caught while building:**

- the wasted recall labels (D-09);
- the drift-timing flag that never cleared (D-18);
- a reuse counter that counted retiring a model as reusing it;
- a test that assumed more history than a fast run produces.

**D-47. Numbers come from `notebooks/experiments.py`, a percent-format notebook.** It is a `.py` file that VS Code's
Jupyter extension runs cell by cell and git diffs cleanly. It runs in about 6 seconds and prints every table in
docs/theory.md.

**D-48. Citations were checked online** before going into docs/theory.md, as the plan asked: Littlestone 1988,
Wolpert 1996, Bifet and Gavaldà 2007, Gama et al. 2014, plus Angluin 1988 and the River paper that were added. All
matched. Bretagnolle and Huber, Kraft, Cover and Thomas, Tsybakov and Yao are cited as standard results.

### Deployment (prepared, not run)

**D-49. Deploy files.**

- `deploy/driftbound.service` is the plan's unit, plus `Wants=network-online.target` and a comment on why there is one
  worker.
- `deploy/deploy.sh` builds, rsyncs, installs and restarts, then calls `/api/health`. It refuses to install if the
  server has no venv yet.
- `deploy/bootstrap_ec2.sh` does the one-time setup on Amazon Linux 2023: Python 3.11, git, rsync, the PostgreSQL 15
  client, the venv, and `/etc/driftbound.env` created root-only (mode 600) from the template.
- Nothing was run against AWS: that needs the team's account, and it costs credits.

**D-50. CI.** `.github/workflows/ci.yml` runs ruff (lint and format check) and pytest on Python 3.11, with a
PostgreSQL 16 service so the schema test runs on every push. A second job runs `npm ci`, lint and build for the
dashboard.

### Tutorial

**D-51. A tutorial built from real runs.** `docs/tutorial.md` walks through the whole service in eleven lessons, from
the idea to deployment, followed by exercises, a "where to change things" table and a glossary. Every example comes
from running the code rather than reading it. The engine traces are seeded, so a reader can reproduce them. The API
session ran the real app in-process through FastAPI's TestClient against a scratch SQLite file, so no server or port
was needed and the local `driftbound.db` was not touched. The exercise that breaks the engine on purpose was checked
on a scratch copy of the repo: changing `>=` to `>` in `predict()` fails exactly two tests. Line links point at the
code as of 7 October 2026. *Considered:* growing README.md, which would bury the quick start.

### Dashboard redesign and the fraud detection test (7 October 2026, at the user's request)

The user asked for a dashboard that reviewers find easy to understand, simpler, in a beige color scheme, and for a
test button at the top right that opens a separate page showing how fraud detection would work.

**D-52. A dashboard for reviewers.**

- **One beige theme.** Cream cards (`#fbf8f1`) on a beige page (`#f3ece0`), serif headings from the system's serif
  fonts (no web font to download at the venue), and a walnut accent (`#6a4b2f`). Dark mode and the theme switch were
  removed: the user asked for beige, and one theme is simpler. A viewer whose system is set to dark mode also sees
  beige. *Considered:* a dark beige variant, which would double the color checking for little gain at a demo.
- **"How to read this page"**: three numbered sentences for a first-time viewer, and a link to the fraud test.
  **Hide** is remembered by the browser.
- **Four tiles instead of six**, in plain words: false alarms, wrong answers, labels used, and detections for the
  number of rule changes. The step and the engine's state moved into a chip on the number line; the run's N and seed
  into Settings.
- **The controls in one card with three tabs**, Play or Pause and the speed above them:
  - **Try it**: the experiments, each saying what to watch;
  - **Break it**: the impossibility scenarios under plain names, slow creep, and Restore everything;
  - **Settings**: the engine, labels while monitoring (*p*), wrong labels (noise), memory recall, and New run.
- **The four conditions as cards** ("When is zero error possible?") instead of a four-column table; run history
  collapsed at the bottom.
- **A red zone on the number line** while a change is still undetected: the answers between the engine's rule and the
  hidden one are wrong, which makes the detection delay visible.
- **On a phone** the two columns become one and the control panel moves up to sit under the number line (CSS
  `display: contents` and `order`).
- **Plain words** in the event log and the charts: "Rule changed", "Change detected", "Relearned in 10 labels
  (limit 10)".

**D-53. A fraud detection test page at `/test/`.**

- **A second page**, opened by the **Test fraud detection** button at the top right of the dashboard. It is a real
  page, from a multi-page Vite build, rather than a tab or a hash route: it has its own address that can be handed
  to reviewers, and Starlette's `StaticFiles` already serves `/test/` from `dist/test/index.html`, so no server
  route was needed. Its **Back to dashboard** button sits in the same top-right spot.
- **The story.** Input x is a transaction of ₹(10 × x), from ₹10 to ₹10,230. Label 1 is fraud, and the threshold is
  the amount where fraud starts, ₹6,000 at first. An analyst check is a label; fraudsters changing tactics is a
  drift. Rupees, because the team and the AWS region are in India; one constant (`RUPEES_PER_STEP`) changes it. The
  page states the simplification: in this simulation, fraud is every transaction at or above one cutoff.
- **Each visitor gets a fresh, paused run** with `kind: "fraud"`, so reviewers testing at the same time do not
  disturb each other or the presenter's dashboard run. The run id goes into the address, so a reload keeps it.
- **What a reviewer can do:**
  - test a transaction (exactly one step with the chosen amount), or take random ones with Next, Next 10 and Play;
  - change the fraudsters' tactics: smaller amounts, larger amounts, an old pattern back, a gradual switch, a typed
    cutoff, or a click on the line;
  - make it harder: wrong analyst answers, no spot checks, random fraud, or the noise-tolerant engine;
  - start over.
- **"What is happening now"** explains the state in one paragraph. After an undetected change it names the exact
  range of amounts that are now judged wrongly, and suggests sending one.
- **The scoreboard** shows decisions against the true rule: fraud stopped, fraud missed and genuine customers blocked
  are the true positives, false negatives and false positives.

**D-54. Backend support for the test page.**

- `Runner.step(x)` processes a chosen input. The input is checked before any state changes.
- `POST /api/runs/{id}/step` takes `count` (1 to 500) and an optional `x` (then `count` must be 1). It steps right
  away, playing or paused. The ticks go to the hub as usual and also come back in the reply; the client skips ticks it
  has already seen, since a step arrives both ways.
- The summary's counters gain `confusion` (tp, fp, tn, fn). The snapshot gains the last 50 full ticks, so a reloaded
  test page keeps its transaction feed.
- Runs carry a `kind`, "dashboard" or "fraud", stored inside the run's config JSON, so the schema did not change. The
  dashboard auto-joins only dashboard runs, and run history tags fraud runs.
- Eviction now takes runs nobody is watching first, then paused ones, oldest first. `MAX_LIVE_RUNS` rose from 4 to
  12, because every test-page visitor holds a run; an exact-mode run takes little memory.

**D-55. The beige palette, checked.** Text contrast (WCAG): ink 13.0:1 on the page; secondary ink at least 6.5:1 on
every surface; muted ink darkened to `#6f6453`, at least 4.9:1 everywhere; walnut buttons 7.6:1. The three chart
colors were validated again with the data-visualization validator against the cream card color: lightness, chroma,
color-blind separation (worst ΔE 9.2) and the normal-vision floor pass. The green slot stays below 3:1 (2.65), relieved
as before by the table view and the legend.

**D-56. The redesign, rendered and checked.** Headless Chrome at 1440 px and on a 390 px phone:

- the dashboard after several drifts, the Break it tab, and the red "guarantee suspended" state;
- the test page through a reviewer's flow: it learned that fraud starts at ₹6,000 in 10 checks; ₹5,000 was approved
  correctly; the cutoff moved to ₹3,000; ₹4,500 was missed and the analyst's check exposed the change; it relearned
  ₹3,000 in 10 checks;
- noisy analysts: 7 false alarms in 80 transactions, each explained in the feed; then the noise-tolerant engine, with
  no further false alarm in 100.

Fixes that came out of looking:

- card headers that squeezed their titles on a phone now wrap;
- "1 runs";
- the result card stayed after later actions, out of date, so other actions now clear it;
- the "Knows the cutoff" chip in robust mode, where the cutoff is only an estimate;
- rupee labels crowding the line on a phone: three ticks below 420 px;
- a hint that said "on the left" on a phone.

### Spam filter test page (7 October 2026, at the user's request)

**D-57. The spam story, and how it maps to the engine.** A separate filter gives every email a spam score from 1 to
1,023; that score is input x. DriftBound does not score emails: it keeps the cutoff right. Emails at or above the
cutoff go to the spam folder (prediction 1), the rest to the inbox. The hidden threshold is the score where real spam
starts, 600 at first. While learning, the engine's query is shown as "Reviewer checked an email scoring 512: not
spam". While monitoring, labels are users' verdicts, and *p* is the share of emails users report on. A drift is
spammers changing their wording; a recurring drift is an old campaign returning, found from memory in 2 to 5 reviews.
A detection is a report that contradicts the cutoff. The page states three simplifications, one sentence each: the
scores come from a separate filter; there is always an email at the score the engine asks about; real scores are not
perfectly ordered, which is what the noise-tolerant engine is for.

*One wording refinement, no engine change.* A real user only clicks "Report spam" on an email in the inbox, or "Not
spam" on one in the spam folder: a report always disagrees with where the email went. The engine's monitoring label
can also agree with the cutoff. Such a label is shown as "A user opened it and left it where it was". For the exact
engine it changes nothing once the cutoff is known; the robust engine learns from it. So *p* counts every verdict,
explicit or implicit.

**D-58. The baseline is computed in the browser.** A filter tuned perfectly on day one (cutoff 600) and never
changed is applied to the same emails the engine files, and the page counts three numbers for each: spam caught, spam
delivered to the inbox, real mail sent to spam. Both columns are tallied in the browser from the same ticks, so they
always cover exactly the same emails: every email since the page opened (after a reload, from the last 50). This
needed no backend change. *Considered:* counting the baseline in the runner, which would survive reloads but changes
the runner and the summary; not worth it for a demo page. The engine's numbers start slightly behind the baseline
(learning, and a change not yet reported) and pull ahead once a wording change is detected.

**D-59. Backend: a third run kind, and room for more runs.** `kind` now accepts `"spam"` (api/schemas.py), so the
dashboard does not auto-join spam runs and run history tags them. `MAX_LIVE_RUNS` rose from 12 to 24: every visitor
to either test page holds a run, and an exact-mode run takes on the order of 1 MB. One API test added. The exact
engine, its proofs and its tests are unchanged. The user approved this change before it was made.

**D-60. Shared code for the two test pages.** `web/src/lib/testRun.ts` (`useTestRun`: one run per visitor, kept in
the address bar, every command, errors as toasts; and the shared decision helpers) and
`web/src/components/TestParts.tsx` (header with links to the other pages, the "what is happening now" box, toggles,
Next / Next 10 / Play, toast). The fraud page now uses both; its behavior and wording are unchanged, except that its
range label now says ₹10,230, the largest amount, instead of ₹10,240. The number line gained a `spam` wording set
and an optional dashed reference cutoff, used for the fixed filter. Each page's story stays in its own file
(`lib/fraud.ts`, `lib/spam.ts`). Simulated subject lines suit the score, not the truth, and are marked as simulated.

**D-61. Checked in the browser.** Headless Chrome at 1440 px and 390 px: learning, a correct email, a typed cutoff of
350, 40 more emails (DriftBound briefly 1 misfiled behind at 20% reports), then 80 more (10 fewer misfiled than the
fixed filter after 131 emails); mis-reports raising false alarms with "(by mistake)" in the feed; the noise-tolerant
engine; no sideways scroll on the phone. The dashboard and /test/ were rechecked: both load, link to /spam/, and the
dashboard joins only a dashboard run.

---

## 4. Changes from the plan

| # | The plan said | What was built | Why |
|---|---|---|---|
| C-01 | Repo rooted at `driftbound/` | Repo at the workspace root | D-01 |
| C-02 | The listed files only | Also `api/config.py` (settings), `api/schemas.py` (request bodies), `pyproject.toml`, `README.md`, this file, `tests/helpers.py`, `deploy/bootstrap_ec2.sh`, `deploy/driftbound.env.example`, `notebooks/experiments.py`, `docs/tutorial.md` | Settings and schemas keep `main.py` and `routes.py` small; the rest supports D-04, D-47, D-49 and D-51 |
| C-03 | `pip install river numpy fastapi ...` | Also `aiosqlite` and `httpx2` | Local fallback database (D-24); Starlette's test client now asks for httpx2 |
| C-04 | Table columns as listed | Extra columns, keys and checks | D-25 |
| C-05 | Ten endpoints; tick field `event` | Four more endpoints; tick field `events` (a list) plus more fields | D-32, D-33 |
| C-06 | "Three one-click scenarios" | Four scenarios plus All clear | D-43 |
| C-07 | "Bars touch the line and never cross it" | Each bar is checked against its own path's bound; recall misses sit above 10 | D-11 (Theorem 6 proves it is unavoidable) |
| C-08 | Theory outline: three impossibility results, one positive theorem | Added Theorem 6 (price of memory), Theorem 8 (no learner avoids the first mistake), the noisy-detection bound, the noise floor formula, and the note on the detecting label | Each answers a question a juror is likely to ask |
| C-09 | VS Code: ESLint + Prettier | oxlint (the create-vite default) + Prettier; extension recommendations updated | D-38 |
| C-10 | `ExactEngine` code as printed | The same update, predict and query logic, plus recall, exclusion of the contradicted rule, and path and bound tracking | D-07 to D-11 |
| C-11 | "River model + ADWIN" | Hoeffding tree with an exhaustive splitter, ADWIN with a direction check and grace, model memory with a reuse test | D-19 to D-21 |
| C-12 | (not covered) | Cache headers on the served dashboard | D-37 |
| C-13 | (not covered) | Live-run cap, idle auto-stop, `interrupted` status | D-29, D-35 |
| C-14 | Dashboard panels as listed | A reviewer-oriented redesign: one beige theme, "How to read this page", four tiles, controls in three tabs, plain words | D-52, D-55 |
| C-15 | (not covered) | A fraud detection test page at `/test/`, opened from the top-right button | D-53 |
| C-16 | Ten endpoints | Also `POST /runs/{id}/step` (with a chosen input), and a run `kind` | D-54 |
| C-17 | (not covered) | A spam filter test page at `/spam/`, with a baseline that never adapts | D-57 to D-61 |

---

## 5. Verification record

| What | How | Result |
|---|---|---|
| Engine guarantees | `pytest tests/test_exact.py test_memory.py test_adversary.py test_bounds.py test_robust.py test_runner.py` | 50 passed |
| API and database | `pytest tests/test_api.py tests/test_db.py` (SQLite) | 15 passed |
| Schema on PostgreSQL | `TEST_DATABASE_URL=... pytest tests/test_db.py` against a throwaway PostgreSQL 18 cluster; `psql -f db/schema.sql` applied twice | Passed; the schema matches the app tables; idempotent |
| Full API on PostgreSQL | Exact and robust runs through the API with asyncpg | Events, metrics and concepts stored; robust snapshot URI recorded |
| Lint | `ruff check .`, `ruff format --check .`, `npx oxlint`, `tsc -b` | Clean |
| Dashboard | Headless Chrome, desktop 1440 px and phone 390 px, light and dark, seven scenarios | Renders; no horizontal scroll on the phone |
| Redesign and fraud test page | Headless Chrome, 1440 px and 390 px, the flows in D-56 | Every flow behaves as described; no horizontal scroll on the phone |
| Dev proxy | Vite on :5173 forwarding REST and WebSocket to :8000 | Works |
| Measured bounds | `python notebooks/experiments.py` | Every proven bound reached or respected (tables in docs/theory.md) |

---

## 6. Known limitations and open items

- **AWS deployment (milestone 7) is not done.** Follow the plan's deploy steps with the scripts in `deploy/`. Check
  first whether CloudFront is available on the account's plan; the fallback is the Elastic IP over plain HTTP. Create
  the RDS instance with the initial database name `driftbound`.
- **Rehearsal (milestone 8):** slides, a timed five-minute demo run twice, and a backup screen recording.
- **Nothing has been committed.** The repo was initialized with `git init` but has no commits. Commit, push to
  GitHub, and CI will run.
- **Live state is in memory.** A server restart ends live runs; their history stays in the database. This is by design
  (one uvicorn worker), and the dashboard offers to start a new run.
- **Membership queries are an assumption.** Exact mode assumes a labeler who can answer "what is the label of x?" for
  any x. Without it, recovery waits for random points to land in the band.
- **Robust mode's reuse threshold (0.75) suits noise up to about 20%.** Beyond that, stored models are rarely reused
  and fresh models start instead, which is still correct, only slower.
- **Robust mode's alarm needs a mature model.** After an abrupt drift at 10% noise, 20 of 20 measured runs raised an
  alarm when the model had seen one rule for 3,000 steps, but only 5 of 20 after 300 steps: a young tree often
  relearns on its own first. The error recovers either way. The README's demo script waits accordingly
  (theory.md §7).
- **The fraud story is a simplification.** On the test page, fraud is every transaction at or above one cutoff.
- **The spam page's baseline lives in the browser.** Its counts restart on reload (from the last 50 emails) and are
  not stored (D-58).
- **One theme.** Viewers whose system is set to dark mode also see the beige theme (D-52).

---

## 7. Change log

All on 7 October 2026, in order.

1. Read the plan and checked the machine: empty folder; Python 3.11/3.13/3.14; Node 24; a local PostgreSQL 18 behind a
   password, which was left untouched.
2. `git init`, created the Python 3.11 venv, and installed the plan's packages plus aiosqlite.
3. Compared six River models for the robust engine (D-19), then prototyped ADWIN, reuse and pickling (D-20, D-21).
4. Wrote `engine/`: bounds, streams and drift injector, memory, the exact engine, the robust engine, the adversary and
   the runner.
5. Smoke test: found the wasted recall labels on the first drift and added exclusion of the contradicted rule (D-09).
6. Wrote the engine tests. They caught the drift-timing flag that never cleared and the reuse miscount (D-18, D-46).
   Added the memory toggle.
7. Wrote `api/`: config, db, storage, hub, manager, routes and main. Fixed a WebSocket teardown leak by switching to an
   anyio task group (D-34).
8. Wrote the API and database tests; switched to httpx2.
9. Started a throwaway PostgreSQL 18 cluster in a scratch folder (port 55432, trust auth, localhost only). Verified
   `schema.sql` with psql and the app over asyncpg.
10. Read the data-visualization method and validated the palette in both modes (D-39).
11. Scaffolded `web/` with create-vite and Recharts. Wrote the types, API client, live hook, number line, both charts
    and the panels.
12. Emitted `recovery_ended` events, so live viewers see interrupted recoveries.
13. Rendered the dashboard in headless Chrome and fixed what looking revealed (D-37, D-45).
14. Added the cache headers to the served dashboard.
15. Added the project files: `.gitignore`, `.env.example`, `.vscode/`, the Prettier config, CI and `deploy/`, and
    renamed the web package to `driftbound-web`.
16. Wrote `notebooks/experiments.py` and ran it; every measurement matched the theory.
17. Checked the citations online and wrote `docs/theory.md`.
18. Wrote `README.md`, `web/README.md` and this file.
19. Wrote `docs/tutorial.md` (D-51) from traces of the engine, the API, the WebSocket and the database, and linked it
    from `README.md`.
20. Fixed four cross-references that named the wrong decision:
    - D-03 and D-05 above: aiosqlite and the PostgreSQL schema test are D-24, and httpx2 belongs with the test setup,
      D-05;
    - the model-comparison note in `engine/robust.py`: D-19, not D-14;
    - the chart-color note in `web/README.md`: D-39, not D-33.
21. Corrected D-35: a tab left open counts as a viewer, so the idle stop does not cover it.
22. Measured how reliably robust mode's alarm fires after an abrupt drift (20 runs per setting): it depends on how long
    the model has seen one rule. Recorded in theory.md §7 and the known limitations, and the README's demo step 6 now
    waits about 3,000 steps before the drift.
23. Redesigned the dashboard for reviewers (D-52): one beige theme (D-55), "How to read this page", four tiles, the
    control panel with Try it, Break it and Settings tabs, the conditions as cards, the red zone on the number line,
    and plain words. Removed the theme switch and `web/src/lib/useTheme.ts`.
24. Added the fraud detection test page at `/test/` (D-53) and its backend (D-54): `Runner.step(x)`, `POST /step`,
    confusion counts, the last 50 ticks in the snapshot, the run `kind`, eviction that spares watched runs, and 12 live
    runs. Four new tests; 65 in all, passing.
25. Rendered both pages on desktop and a phone and fixed what looking revealed (D-56).
26. Updated the docs: README (intro, commands, demo script, API), `web/README.md`, the scenario names in theory.md,
    and the tutorial: the dashboard lesson rewritten, a section on the fraud test page, exercise 10, the API lesson
    (the `/step` endpoint, 12 live runs, the idle-stop sentence), and 20 code links re-pointed after the code moved.
27. Checked for an interrupted `/transfer/` page or "learn from transfers only" mode: none existed, and the working
    tree matched the pushed commit, so nothing was removed.
28. Added the spam filter test page at `/spam/` (D-57, D-58), with the `spam` run kind and 24 live runs (D-59), after
    the user approved the backend change. Moved the shared test-page code into `lib/testRun.ts` and
    `components/TestParts.tsx` (D-60). Linked `/spam/` from the dashboard's top right, its "How to read this page" box
    and the fraud page. One new test; 66 in all, passing.
29. Checked both test pages and the dashboard in the browser (D-61), and updated README.md, docs/tutorial.md and
    web/README.md.
