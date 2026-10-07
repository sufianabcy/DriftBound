# DriftBound web app

React + TypeScript + Vite, with Recharts for the two charts and a hand-drawn SVG number line. Two pages:

- `/`: the dashboard ([src/App.tsx](src/App.tsx)).
- `/test/`: the fraud detection test ([test/index.html](test/index.html), [src/test/FraudTest.tsx](src/test/FraudTest.tsx)).

```bash
npm install
npm run dev     # http://localhost:5173 and /test/; proxies /api (and the WebSocket) to the API on :8000
npm run lint    # oxlint
npm run build   # type-check, then build both pages into dist/, which FastAPI serves
```

Both pages only use relative `/api` paths, so the same build works behind the Vite proxy and on EC2.

## Layout

- `src/lib/useLiveRun.ts`: one WebSocket per run, with reconnects. It folds the snapshot, tick batches and the replies
  of hand-taken steps into bounded buffers, skipping ticks it has already seen.
- `src/lib/api.ts`: REST calls. `src/lib/types.ts` mirrors the shapes the API sends.
- `src/lib/fraud.ts`: the fraud story: rupee amounts, outcomes, event sentences and "what is happening now".
- `src/components/NumberLine.tsx`: the version space on the line of thresholds (or rupee cutoffs on the test page).
  Click it to move the hidden rule.
- `src/components/ControlPanel.tsx`: play and speed, then the Try it, Break it and Settings tabs.
- `src/components/ErrorChart.tsx`, `LabelsChart.tsx`: the two charts, each with a table view.
- `src/components/Overview.tsx`, `Explainer.tsx`, `Panels.tsx`: the verdict and tiles, "How to read this page", the
  four conditions, the event log and run history.

One beige theme. Colors are roles defined at the top of `src/styles.css`; text colors meet WCAG AA on every surface,
and the chart colors were checked for color-blind separation against the cream card color. Status colors always come
with an icon and a label. See design.md, D-39 and D-52.
