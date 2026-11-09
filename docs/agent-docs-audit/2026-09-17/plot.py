# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib"]
# ///
"""Plot agent-doc growth against the model mix that was reading it.

Run with `uv run plot.py` from this directory; it reads the two CSVs beside it.
Matplotlib is not a repo dependency, which is why this lives with the snapshot
rather than in scripts/.
"""

import collections
import csv
import datetime as dt

from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt

HERE = Path(__file__).parent

SERIES = [
    ("agents_md", "AGENTS.md (always loaded)", "#d62728"),
    ("skills", "Skills (SKILL.md)", "#1f77b4"),
    ("prompts", "Prompt templates", "#2ca02c"),
    ("subagent_defs", "Subagent definitions", "#ff7f0e"),
]
MODEL_COLORS = {
    "claude-opus-4-6": "#8c564b",
    "claude-sonnet-4-6": "#c5b0d5",
    "claude-opus-4-8": "#9467bd",
    "claude-sonnet-5": "#17becf",
    "claude-opus-5": "#e377c2",
    "claude-fable-5": "#bcbd22",
    "claude-fable-5-1": "#dbdb8d",
    "deepseek-v4-flash": "#7f7f7f",
}
OPUS5 = dt.date(2026, 7, 21)  # first week Opus 5 takes majority share

with open(HERE / "doc-growth.csv") as fh:
    growth = list(csv.DictReader(fh))
dates = [dt.date.fromisoformat(r["date"]) for r in growth]
data = {k: [int(r[k]) for r in growth] for k, _, _ in SERIES}
totals = [sum(data[k][i] for k, _, _ in SERIES) for i in range(len(growth))]

with open(HERE / "model-usage.csv") as fh:
    usage = list(csv.DictReader(fh))
by_week = collections.defaultdict(collections.Counter)
for r in usage:
    by_week[dt.date.fromisoformat(r["week"])][r["model"]] += int(r["tokens"])
weeks = sorted(by_week)
models = sorted(
    {m for c in by_week.values() for m in c},
    key=lambda m: -sum(c[m] for c in by_week.values()),
)
shares = {
    m: [100 * by_week[w][m] / max(sum(by_week[w].values()), 1) for w in weeks]
    for m in models
}

fig, (ax, ax2) = plt.subplots(
    2, 1, figsize=(12, 9.5), sharex=True, gridspec_kw={"height_ratios": [3, 2]}
)

for a in (ax, ax2):
    a.axvspan(OPUS5, dates[-1] + dt.timedelta(days=25), color="#ffe9f4", zorder=0)
ax.axvline(OPUS5, color="#e377c2", lw=1.5, ls=":", zorder=1)
ax2.axvline(OPUS5, color="#e377c2", lw=1.5, ls=":", zorder=3)

for key, label, color in SERIES:
    ax.plot(dates, data[key], marker="o", ms=3.5, lw=2, color=color, label=label, zorder=3)
ax.plot(dates, totals, ls="--", lw=1.5, color="0.35", label="Total", zorder=3)
for key, _, color in SERIES:
    ax.annotate(
        f"{data[key][-1]:,}", (dates[-1], data[key][-1]),
        textcoords="offset points", xytext=(6, -2), fontsize=8, color=color,
    )
ax.annotate(
    f"{totals[-1]:,}", (dates[-1], totals[-1]),
    textcoords="offset points", xytext=(6, -2), fontsize=8, color="0.35",
)
ax.annotate(
    "Opus 5 era\nAGENTS.md +635 words/wk\n(was +233/wk)",
    (OPUS5 + dt.timedelta(days=4), 62000), fontsize=9, color="#b0308a",
)
ax.set_title(
    "Agent documentation growth vs. the model reading it — lazuee/pi-packages",
    fontsize=13,
)
ax.set_ylabel("words (weekly snapshot of HEAD)")
ax.grid(alpha=0.3, zorder=0)
ax.legend(loc="upper left", fontsize=9)
ax.set_xlim(dates[0], dates[-1] + dt.timedelta(days=25))

ax2.stackplot(
    weeks,
    [shares[m] for m in models],
    labels=[m.replace("claude-", "") for m in models],
    colors=[MODEL_COLORS.get(m, "#dddddd") for m in models],
    alpha=0.9,
    zorder=2,
)
ax2.set_ylim(0, 100)
ax2.set_ylabel("share of assistant tokens (%)")
ax2.set_xlabel("week")
ax2.legend(loc="lower left", fontsize=8, ncol=4, framealpha=0.9)
ax2.set_title(
    "Model mix, from local Pi session transcripts (thinking level: 100% high since 2026-07-27)",
    fontsize=10,
)
ax2.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
ax2.xaxis.set_major_locator(mdates.MonthLocator())

fig.tight_layout()
fig.savefig(HERE / "growth-vs-model-mix.png", dpi=150)
print(f"wrote {HERE / 'growth-vs-model-mix.png'}")
