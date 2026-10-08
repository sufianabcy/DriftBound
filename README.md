# DriftBound

**A streaming classifier that detects concept drift and relearns after it, with proofs of exactly where zero error is
possible and where it is not.** Built for the RVIT hackathon by Team Syntax Squad.

[![ci](https://github.com/sufianabcy/DriftBound/actions/workflows/ci.yml/badge.svg)](https://github.com/sufianabcy/DriftBound/actions/workflows/ci.yml)

---

## The problem

A model trained on yesterday's data quietly goes wrong when the world changes: fraudsters move to a new amount,
spammers change their wording, a sensor drifts. This is **concept drift**. The challenge asks for a system that
detects drift and adapts with zero error, under any drift.

That goal, taken literally, is provably impossible. DriftBound gives both halves of the honest answer:

1. **An engine that reaches zero error** under four stated conditions, with label costs that match the best any
   learner can do.
2. **Impossibility results** showing that each of those conditions is necessary, and a live dashboard where you can
   break each one and watch the guarantee fail.

## The guarantees

| Condition | Zero error is achievable when | It is provably impossible when |
|---|---|---|
| A1. Rule family | the true rule comes from a known finite set | any rule at all is allowed |
| A2. Labels | labels are correct | labels are noisy |
| A3. Label access | the engine can request labels after a drift | no labels arrive after a drift |
| A4. Drift timing | drifts are at least one adaptation period apart | the rule may change at every step |

Under A1 to A4, for threshold rules on N = 1023 points, **exact mode** guarantees:

- **Zero false alarms.** It never reports a drift that did not happen.
- **Detection at the first labeled mistake** of a harmful drift; a harmless drift is ignored and costs nothing.
- **Zero error after relearning**, in exactly ⌈log₂(N+1)⌉ = **10 labels**. No learner can use fewer: the lower bound
  is shown live by a worst-case adversary.
- **Concept memory**: a rule that returns is recognised in ⌈log₂K⌉ + 2 labels (2 to 5 in the demo).

No learner can avoid the first mistake after a drift, so "zero error" here means zero false alarms, a bounded number
of mistakes per drift, and zero error once adapted. Full proofs: [docs/theory.md](docs/theory.md).

When the conditions do not hold, **robust mode** (a River Hoeffding tree with the ADWIN drift detector and a memory of
past models) handles noisy labels and rules outside the family, with probabilistic guarantees only.

## What you can try

| Page | URL | What it shows |
|---|---|---|
| **Dashboard** | `/` | The engine live: the number line of candidate rules shrinking to one, error and label charts against the proven bounds, a control panel to change the rule, unleash an adversary, or break a condition |
| **Fraud detection test** | `/test/` | The same story as fraud: send a transaction in rupees, change the fraudsters' tactics, and watch the engine catch the change and relearn |
| **Spam filter test** | `/spam/` | Keeps an existing spam filter's cutoff score right as spammers change their wording, side by side with a filter that never adapts, on the same emails |

The dashboard explains itself to a first-time viewer ("How to read this page"), and the two test pages are linked
from its top right.

## Tech stack

| Layer | Technology |
|---|---|
| Engine | Python 3.11, NumPy, SciPy, [River](https://riverml.xyz) (Hoeffding tree, ADWIN) |
| API | FastAPI, uvicorn, WebSockets, Pydantic |
| Database | SQLAlchemy Core: PostgreSQL (AWS RDS) in production, SQLite locally |
| Model storage | AWS S3 (boto3), or a local folder |
| Frontend | React, TypeScript, Vite, Recharts, hand-drawn SVG |
| Quality | pytest (66 tests, one per theorem), Ruff, oxlint, GitHub Actions CI with a real PostgreSQL |
| Hosting (planned) | AWS EC2 + RDS + S3, systemd |

## Architecture

```
browser (React + Recharts): dashboard /, fraud test /test/, spam test /spam/
   │  REST commands: /api/runs/...            ▲ WebSocket /api/runs/{id}/live: a snapshot,
   ▼                                          │ then batches of ticks about 10 times a second
FastAPI, one uvicorn process ─────────────────┘
   ├─ routes.py    REST + WebSocket
   ├─ manager.py   one asyncio loop per running run; one writer task for all storage
   ├─ live.py      hub: buffers ticks per run, thins and fans them out
   ├─ db.py        PostgreSQL (RDS), or SQLite when DATABASE_URL is empty
   └─ storage.py   robust-model snapshots: S3, or a local folder
engine/ (pure Python, no web imports)
   streams.py    inputs, true rule, noise, drift injector    exact.py    candidate elimination + recall
   memory.py     stored rules (LRU, capacity 8)              robust.py   Hoeffding tree + ADWIN + model memory
   adversary.py  worst case, rapid fire, stealth             bounds.py   every proven number
   runner.py     one step: predict → adversary → label → update → account
```

Each step draws an input, predicts, lets the adversary act, draws the (possibly noisy) label, then either requests a
label (while learning) or checks one with probability *p* (while monitoring), and finally updates, detects, recovers
and emits a tick to the browser.

## Quick start

Needs **Python 3.11** and **Node 20.19 or newer**.

```bash
git clone git@github.com:sufianabcy/DriftBound.git && cd DriftBound
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd web && npm install && cd ..
cp .env.example .env          # empty DATABASE_URL means a local SQLite file; no database server needed
```

Then, each in its own terminal:

```bash
uvicorn api.main:app --reload   # API on http://localhost:8000, interactive API reference at /docs
cd web && npm run dev           # dashboard on http://localhost:5173, fraud test at /test/, spam test at /spam/
```

Other commands:

```bash
pytest                          # every guarantee as a test (about 15 seconds)
python notebooks/experiments.py # every bound measured by simulation
cd web && npm run lint          # lint the frontend
cd web && npm run build         # build all three pages into web/dist/, which the API then serves
```

After `npm run build`, the API alone serves everything, as it will in production: http://localhost:8000,
http://localhost:8000/test/ and http://localhost:8000/spam/.

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | empty | Empty uses `driftbound.db` (SQLite). For PostgreSQL: `postgresql+asyncpg://USER:PASSWORD@HOST:5432/driftbound` |
| `MODELS_BUCKET` | empty | Empty keeps robust-model snapshots in `./models`; otherwise an S3 bucket name |
| `AWS_REGION` | `ap-south-1` | Region for S3 |

## Project structure

```
engine/        the drift engine in pure Python: streams, exact engine, concept memory, robust engine,
               adversary, bounds, and the runner that ties one step together
api/           FastAPI app: REST routes, WebSocket hub, run manager, database and S3 storage
web/           React + Vite frontend: the dashboard, fraud test and spam test pages
db/schema.sql  PostgreSQL schema (the API also creates missing tables on startup)
tests/         pytest: one test per theorem, plus API and database integration tests
notebooks/     experiments.py: every bound measured by simulation
deploy/        systemd unit, deploy script, EC2 bootstrap, environment template
docs/          theory.md: the conditions, theorems, proofs and impossibility results
design.md      every design decision, every change from the original plan, and the change log
```

## The five-minute demo

| # | Do this | What you see |
|---|---|---|
| 1 | Open the dashboard; a run starts in exact mode | The band on the number line collapses in 10 labels and the wrong answers drop to zero |
| 2 | Control panel, **Try it**: **Change the rule** (or click the number line) | Detection at the first checked mistake; relearning in 10 labels |
| 3 | **Bring back an old rule** | Memory finds it in 2 to 5 labels |
| 4 | **Worst-case attacker** | Every recovery takes at least 10 labels: the lower bound, live |
| 5 | **Break it**: **Rule changes every step**, **Wrong labels (10%)**, **No labels after a change**, **No rule to find** | Errors stuck above zero, false alarms climbing, a change never detected, endless detections |
| 6 | With wrong labels on, switch to **Robust** in **Settings**; run at 500 steps/s for about 6 s, then at 20 steps/s **Change the rule** | False alarms stop; the change is detected after roughly 50 to 150 steps; no zero-error claim |
| 7 | **Test fraud detection** (top right): **Next 10**, set fraud to start at ₹3,000, then send ₹4,500 | The engine approves it, but it was fraud: the analyst's check proves the tactics changed, and it relearns |
| 8 | **Test spam filtering** (top right): **Next 10**, set spam to start at score 350, then **Next 10** until a user reports | The fixed filter keeps letting spam in; DriftBound relearns and pulls ahead |
| 9 | Close on **When is zero error possible?** | Which condition each failure broke |

Use **Restore everything** (Break it tab) between scenarios. Step 6 waits because a young robust model often absorbs a
change before its detector has enough evidence (theory.md §7).

## API

Everything sits under `/api`; the interactive reference is at `/docs`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/runs` | Create a run (mode, N, p, noise, seed, θ, memory, speed; `start: true` starts it; `kind: "fraud"` or `"spam"` for the test pages) |
| GET | `/api/runs` | Runs from the database, merged with live state |
| GET / PATCH | `/api/runs/{id}` | Summary against the bounds / change mode, p, noise, speed, memory |
| POST | `/api/runs/{id}/start`, `/stop` | Start or pause the stream |
| POST | `/api/runs/{id}/step` | Run `count` steps now; with `x`, one step on that input |
| POST | `/api/runs/{id}/drift` | Inject a drift: abrupt, gradual, recurring, out_of_family |
| POST | `/api/runs/{id}/adversary` | Turn worst_case, rapid_fire, stealth or noise on or off |
| POST | `/api/runs/{id}/scenario` | Impossibility lab: monitoring_off, noisy_labels, out_of_family, rapid_fire, all_clear |
| GET | `/api/runs/{id}/events`, `/metrics`, `/concepts` | Stored history, for replay |
| WS | `/api/runs/{id}/live` | A snapshot, then batches of ticks about 10 times a second |
| GET | `/api/health` | Database, storage and live-run status |

## Deploying to AWS

The `deploy/` folder holds everything for EC2 + RDS + S3; deployment has not been run yet.

1. Create the EC2 instance, an RDS PostgreSQL database (initial database name `driftbound`), an S3 bucket, and an IAM
   role for the instance that can read and write the bucket.
2. `EC2_HOST=<elastic-ip> ./deploy/deploy.sh` copies the repo up. The first time, run
   `bash ~/driftbound/deploy/bootstrap_ec2.sh` on the instance, fill in `/etc/driftbound.env` (template:
   `deploy/driftbound.env.example`), and load `db/schema.sql`.
3. After that, `./deploy/deploy.sh` builds, copies, installs and restarts the service in one go.

## Known limitations

- Live run state is in memory: a server restart ends live runs, though their history stays in the database.
- Exact mode assumes a labeler that can answer "what is the label of x?" for any x.
- Robust mode's drift alarm needs a mature model; a young model often relearns before the alarm fires.
- The fraud page models fraud as every transaction at or above one cutoff; the spam page's fixed-filter baseline lives
  in the browser and resets on reload.

The full list, and the reasoning behind every decision, is in [design.md](design.md).

## Team

**Syntax Squad**, RVIT hackathon, October 2026.
