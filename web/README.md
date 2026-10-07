# DriftBound web app

React + TypeScript + Vite, with Recharts for the two charts and a hand-drawn SVG number line. Three pages:

- `/`: the dashboard ([src/App.tsx](src/App.tsx)).
- `/test/`: the fraud detection test ([test/index.html](test/index.html), [src/test/FraudTest.tsx](src/test/FraudTest.tsx)).
- `/spam/`: the spam filter test ([spam/index.html](spam/index.html), [src/spam/SpamTest.tsx](src/spam/SpamTest.tsx)).

```bash
npm install
npm run dev     # http://localhost:5173, /test/ and /spam/; proxies /api (and the WebSocket) to the API on :8000
npm run lint    # oxlint
npm run build   # type-check, then build all three pages into dist/, which FastAPI serves
```

All pages only use relative `/api` paths, so the same build works behind the Vite proxy and on EC2.

## Layout

- `src/lib/useLiveRun.ts`: one WebSocket per run, with reconnects. It folds the snapshot, tick batches and the replies
  of hand-taken steps into bounded buffers, skipping ticks it has already seen.
- `src/lib/api.ts`: REST calls. `src/lib/types.ts` mirrors the shapes the API sends.
- `src/lib/fraud.ts`, `src/lib/spam.ts`: each test page's story: units, outcomes, event sentences and "what is
  happening now".
- `src/lib/testRun.ts`, `src/components/TestParts.tsx`: what the two test pages share: one run per visitor, the
  commands, the header, the step controls.
- `src/components/NumberLine.tsx`: the version space on the line of thresholds (or rupee cutoffs on the test page).
  Click it to move the hidden rule.
- `src/components/ControlPanel.tsx`: play and speed, then the Try it, Break it and Settings tabs.
- `src/components/ErrorChart.tsx`, `LabelsChart.tsx`: the two charts, each with a table view.
- `src/components/Overview.tsx`, `Explainer.tsx`, `Panels.tsx`: the verdict and tiles, "How to read this page", the
  four conditions, the event log and run history.

One beige theme. Colors are roles defined at the top of `src/styles.css`; text colors meet WCAG AA on every surface,
and the chart colors were checked for color-blind separation against the cream card color. Status colors always come
with an icon and a label. See design.md, D-39 and D-52.
