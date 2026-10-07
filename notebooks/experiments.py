# %% [markdown]
# # DriftBound experiments
#
# Each cell measures one claim from `docs/theory.md` by simulation, so the report
# can quote measured numbers next to the proven ones. Open this file in VS Code
# and use "Run Cell" (Jupyter extension), or run it whole:
#
#     python notebooks/experiments.py
#
# Everything is seeded, so the numbers repeat exactly.

# %%
import random
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd().parent if Path.cwd().name == "notebooks" else Path.cwd()))

from engine import bounds  # noqa: E402
from engine.exact import ExactEngine  # noqa: E402
from engine.memory import ConceptMemory  # noqa: E402
from engine.runner import RunConfig, Runner  # noqa: E402

N = 1023


def table(header, rows):
    widths = [max(len(str(x)) for x in col) for col in zip(header, *rows, strict=True)]
    line = lambda r: "  ".join(str(x).rjust(w) for x, w in zip(r, widths, strict=True))  # noqa: E731
    print(line(header))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        print(line(r))
    print()


def identify(engine, theta):
    labels = 0
    while (q := engine.next_query()) is not None:
        engine.update(q, int(q >= theta))
        labels += 1
    return labels


def until(runner, kind, limit=200_000):
    for _ in range(limit):
        tick = runner.step()
        for e in tick["events"]:
            if e["type"] == kind:
                return e
    raise RuntimeError(f"no {kind} event")


# %% [markdown]
# ## 1. Recovery labels: upper bound = lower bound = 10
# Binary search over all 1,024 rules; every rule takes exactly ceil(log2(N+1)) labels.

# %%
counts = [identify(ExactEngine(N), theta) for theta in range(1, N + 2)]
table(
    ["rules", "min labels", "max labels", "bound", "Kraft sum"],
    [[N + 1, min(counts), max(counts), bounds.recovery_labels(N), bounds.kraft_sum(counts)]],
)

# %% [markdown]
# ## 2. Concept memory: fast on returning rules, a price on new ones (Theorems 5 and 6)

# %%
rng = random.Random(0)
rows = []
for k in (1, 2, 4, 8):
    recurring, novel = [], []
    for _ in range(200):
        stored = rng.sample(range(1, N + 2), k)
        memory = ConceptMemory(8)
        for i, t in enumerate(stored):
            memory.remember(t, i)
        recurring.append(identify(ExactEngine(N, memory), rng.choice(stored)))
        fresh = rng.choice([t for t in range(1, N + 2) if t not in stored])
        novel.append(identify(ExactEngine(N, memory), fresh))
    rows.append(
        [
            k,
            f"{statistics.mean(recurring):.2f}",
            max(recurring),
            bounds.recall_labels(k),
            f"{statistics.mean(novel):.2f}",
            max(novel),
            bounds.recall_fallback_labels(k, N),
        ]
    )
table(["K", "returning mean", "returning max", "bound", "new mean", "new max", "bound"], rows)

# %% [markdown]
# ## 3. Monitoring cost: about 1/p mistakes before detection (Theorem 7)

# %%
rows = []
for p in (1.0, 0.5, 0.25, 0.1):
    samples, delays = [], []
    for seed in range(300):
        runner = Runner(RunConfig(seed=seed, p=p, memory=False))
        until(runner, "recovered")
        runner.inject("abrupt")
        detected = until(runner, "detected")
        samples.append(detected["mistakes_before_detection"])
        delays.append(detected["delay"])
    rows.append([p, f"{statistics.mean(samples):.2f}", f"{1 / p:.2f}", f"{statistics.mean(delays):.1f}"])
table(["p", "mistakes before detection", "1/p", "mean delay (steps)"], rows)

# %% [markdown]
# ## 4. Small drifts hide: detection delay grows like N / |drift| (Impossibility 1b)

# %%
rows = []
for gap in (256, 64, 16, 4, 1):
    delays = []
    for seed in range(200):
        runner = Runner(RunConfig(seed=seed, theta=500, memory=False))
        until(runner, "recovered")
        runner.inject("abrupt", theta=500 + gap)
        delays.append(until(runner, "detected")["delay"])
    rows.append([gap, f"{statistics.mean(delays):.0f}", f"{N / gap:.0f}"])
table(["|drift|", "mean delay (steps, p = 1)", "N / |drift|"], rows)

# %% [markdown]
# ## 5. Label noise: exact mode raises false alarms, robust mode does not

# %%
rows = []
for noise in (0.0, 0.02, 0.05, 0.1, 0.2):
    exact = Runner(RunConfig(seed=1, noise=noise, mode="exact"))
    robust = Runner(RunConfig(seed=1, noise=noise, mode="robust"))
    for _ in range(10_000):
        exact.step()
        robust.step()
    rows.append(
        [
            noise,
            exact.false_alarms,
            robust.false_alarms,
            f"{robust.mistakes / 10_000:.3f}",
            f"{robust.observed_mistakes / 10_000:.3f}",
        ]
    )
table(["noise", "exact false alarms", "robust false alarms", "robust true error", "robust observed error"], rows)

# %% [markdown]
# ## 6. The worst-case adversary forces at least 10 labels, with or without memory

# %%
rows = []
for memory in (False, True):
    runner = Runner(RunConfig(seed=4, memory=memory))
    until(runner, "recovered")
    for _ in range(4):
        runner.inject("abrupt")
        until(runner, "recovered")
    runner.set_adversary("worst_case", True, gap=20)
    labels = []
    while len(labels) < 30:
        tick = runner.step()
        labels += [e["labels"] for e in tick["events"] if e["type"] == "recovered"]
    rows.append([memory, len(labels), min(labels), f"{statistics.mean(labels):.2f}", max(labels)])
table(["memory", "recoveries", "min labels", "mean", "max"], rows)

# %% [markdown]
# ## 7. Drift speed: rapid fire every k steps keeps the error at or above 1/k (Impossibility 3)

# %%
rows = []
for k in (1, 2, 5, 10, 50):
    runner = Runner(RunConfig(seed=k))
    until(runner, "recovered")
    runner.set_adversary("rapid_fire", True, k=k)
    start = runner.mistakes
    for _ in range(5_000):
        runner.step()
    rows.append([k, f"{(runner.mistakes - start) / 5_000:.3f}", f"{1 / k:.3f}"])
table(["k", "error rate", "1/k"], rows)
