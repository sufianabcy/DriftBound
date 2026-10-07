# DriftBound

A streaming classifier that detects concept drift and relearns after it, with proofs of exactly where zero error is
possible and where it is not. Built for the RVIT hackathon by Syntax Squad.

- **Exact mode** keeps every threshold rule that fits the labels. Under four stated conditions it has zero false
  alarms, catches a harmful drift at its first labeled mistake, and recovers in at most ⌈log₂(N+1)⌉ = 10 labels, which
  no learner can beat.
- **Robust mode** (River Hoeffding tree plus ADWIN) handles noisy labels and rules outside the family, with
  probabilistic guarantees only.
- **A live dashboard**, in a warm beige theme, explains itself to a first-time viewer. The jury can change the rule,
  unleash an adversary, and break each condition from the control panel while the charts show the proven bounds.
- **A fraud detection test page** (`/test/`, the button at the top right of the dashboard) tells the same story as
  fraud: send a transaction, change the fraudsters' tactics, and watch the engine catch the change and relearn.
- **A spam filter test page** (`/spam/`, also at the top right) keeps the cutoff score of an existing spam filter right
  as spammers change their wording, beside a filter that never adapts, on the same emails.

The proofs are in [docs/theory.md](docs/theory.md). Every decision and every change from the original plan is
recorded in [design.md](design.md). New to the code? [docs/tutorial.md](docs/tutorial.md) is a guided tour of the
whole service, built from real runs.

## Quick start (macOS)

Needs Python 3.11 and Node 20.19 or newer.

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd web && npm install && cd ..
cp .env.example .env          # empty DATABASE_URL means a local SQLite file; no server needed
```

Daily commands, each in its own terminal:

```bash
uvicorn api.main:app --reload   # API on http://localhost:8000, interactive test page at /docs
cd web && npm run dev           # dashboard on http://localhost:5173, fraud test at /test/, spam test at /spam/
pytest                          # every guarantee as a test (about 15 seconds)
python notebooks/experiments.py # measured numbers for the report
```

To run the built pages from the API alone, the way they run on EC2: `cd web && npm run build`, then open
http://localhost:8000 (the dashboard), http://localhost:8000/test/ (the fraud test) and http://localhost:8000/spam/
(the spam test).

In VS Code, pick the `.venv` interpreter (Command Palette, "Python: Select Interpreter") and press F5 to run the API
with breakpoints.

## What is where

```
engine/        pure Python, no web imports: stream and drift injector, exact engine, concept memory,
               robust engine, adversary, bounds, runner (one step: predict, attack, label, update)
api/           FastAPI: REST routes, WebSocket hub, run manager, batched database writes, S3 model snapshots
web/           React + Vite + Recharts: the dashboard (/), fraud test (/test/) and spam test (/spam/)
db/schema.sql  the PostgreSQL schema (the API also creates missing tables on startup)
deploy/        systemd unit, deploy script, EC2 bootstrap, environment template
tests/         pytest: one test per theorem, plus API and database integration tests
notebooks/     experiments.py: every bound measured by simulation (run cell by cell in VS Code)
docs/          theory.md: the proofs; tutorial.md: a guided tour of the whole service
design.md      decisions, changes from the plan, and the change log
```

## The five-minute demo

| # | Do this | What the jury sees |
|---|---|---|
| 1 | Open the dashboard; a run starts in exact mode | The band on the number line collapses in 10 labels and the wrong answers drop to zero |
| 2 | Control panel, **Try it**: **Change the rule** (or click the number line) | Detection at the first checked mistake; relearning in 10 labels, the bar reaches its tick |
| 3 | **Bring back an old rule** | Memory finds it in 2 to 5 labels |
| 4 | **Worst-case attacker** | Every recovery takes at least 10 labels: the lower bound, live |
| 5 | **Break it**: **Rule changes every step**, **Wrong labels (10%)**, **No labels after a change**, **No rule to find** | Errors stuck above zero, false alarms climbing, a change that is never detected, endless detections |
| 6 | With wrong labels on, switch the engine to **Robust** in **Settings**. Run at 500 steps/s for about 6 seconds, then at 20 click **Change the rule** | False alarms stop; the change is detected after roughly 50 to 150 steps; no zero-error claim |
| 7 | **Test fraud detection** (top right): **Next 10**, set fraud to start at ₹3,000, then send ₹4,500 | The engine approves it, but it was fraud: the analyst's check proves the tactics changed, and it relearns |
| 8 | **Test spam filtering** (top right): **Next 10**, set spam to start at score 350, then **Next 10** until a user reports | The fixed filter keeps letting spam into the inbox; DriftBound relearns and pulls ahead in the comparison |
| 9 | Close on **When is zero error possible?** | Which condition each failure broke |

Use **Restore everything** (Break it tab) between scenarios. Step 6 waits because a young robust model often absorbs a
change before its detector has enough evidence, so no detection mark would appear (theory.md §7). Before the demo, see the checklist in the build plan: start the EC2 instance and
the RDS database the day before, and record a backup screen capture.

## API

Everything sits under `/api`. The interactive reference is at `/docs`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/runs` | Create a run (mode, N, p, noise, seed, θ, memory, speed; `start: true` starts it; `kind: "fraud"` or `"spam"` for the test pages) |
| GET | `/api/runs` | Runs from the database, merged with live state |
| GET / PATCH | `/api/runs/{id}` | Summary against the bounds / change mode, p, noise, speed, memory |
| POST | `/api/runs/{id}/start`, `/stop` | Start or pause the stream |
| POST | `/api/runs/{id}/step` | Run `count` steps now, playing or paused; with `x`, one step that processes that input |
| POST | `/api/runs/{id}/drift` | Inject a drift: abrupt, gradual, recurring, out_of_family |
| POST | `/api/runs/{id}/adversary` | Turn worst_case, rapid_fire, stealth or noise on or off |
| POST | `/api/runs/{id}/scenario` | Impossibility lab: monitoring_off, noisy_labels, out_of_family, rapid_fire, all_clear |
| GET | `/api/runs/{id}/events`, `/metrics`, `/concepts` | Stored history, for replay |
| WS | `/api/runs/{id}/live` | A snapshot, then batches of ticks about 10 times a second |
| GET | `/api/health` | Database, storage and live-run status |

## Deploying to AWS

Deployment (milestone 7) is the next step and has not been run. The plan's deploy steps hold. `deploy/` has the
pieces:

1. Create the EC2 instance, RDS database (initial database name `driftbound`), S3 bucket and IAM role as in the plan.
2. `EC2_HOST=<elastic-ip> ./deploy/deploy.sh` copies the repo up. The first time, run
   `bash ~/driftbound/deploy/bootstrap_ec2.sh` on the instance, fill in `/etc/driftbound.env`, and load
   `db/schema.sql`.
3. After that, `./deploy/deploy.sh` builds, copies, installs and restarts in one go.

To work locally against RDS, open the SSH tunnel from the plan and point `DATABASE_URL` in `.env` at `localhost:5432`.
