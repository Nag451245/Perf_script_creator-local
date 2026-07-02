# perfscript-local

Local, folder-driven autonomous JMeter scripting. Drop recordings in
`input/`, get scripts in `output/`. No cloud, no upload — runs on your
machine with local JMeter (+ optional Gemini). See **ARCHITECTURE.md** for the
five execution phases and hardening strategies.

It **reuses** the existing PerfScript engine in place (correlation, JMX
generation, the feedback loop) — it does not copy or modify the current app.

## Prerequisites
- **Node.js 18+**
- The PerfScript repo's `backend` folder on disk. Default path is baked into
  `src/engine.js`; override with the `PERFSCRIPT_ENGINE` env var if it moves.
- **JMeter** (only needed for `--run`): set `JMETER_HOME` or put `jmeter` on PATH.

## Usage

**Simple UI (Windows):** double-click **`perfscript-ui.cmd`** (or the *PerfScript
UI* desktop shortcut). Your browser opens `http://localhost:7070` where you can
drag-drop recordings, edit run settings (target / credentials / load profile),
press **Generate** or **Generate + Validate**, watch the live log, cancel a run,
and open the report / download the `.jmx`. Keep the console window open; close it
to stop the server. (Port auto-falls-back if 7070 is busy.)

**One-click validate:** double-click **`perfscript-run.cmd`** = generate + run
through local JMeter in one shot.

**CLI (Windows):** double-click `perfscript.cmd`, or from a terminal:
```bat
perfscript            :: generate scripts from every HAR in input\
perfscript --run      :: also validate with local JMeter
perfscript --watch    :: process files as they appear
```
The launcher finds Node automatically (PATH or common install locations) — no
setup needed if Node is installed anywhere typical.

**Or call Node directly:**
```bash
# 1) Generate scripts from every HAR in input/ (no execution)
node index.js

# 2) Generate AND run+auto-fix against the live target via local JMeter
set JMETER_HOME=D:\apache-jmeter-5.6.3
node index.js --run --iterations 3

# 3) Watch mode — process files as they land in input/
node index.js --watch
```

Output per input file lands in `output/<name>/`:
- `<name>_report.html` — **open this first**: browser-readable summary (verdict,
  stats, request results, failures, links to every artifact)
- `<name>.jmx` — the generated (or validated) script: correlated, parameterized,
  with a Cookie Manager and client-minted values regenerated inline
- `<name>.recording.xml` — full request/response bodies for reference
- `<name>_data.csv` — synthesized unique-per-row data pool (avoids 409 collisions)
- `<name>_parameters.json` — discovered user-input fields
- `<name>_ghosts.json` — client-side (UUID/timestamp/trace) values + JMeter snippet
- `<name>_polling.json` — detected polling loops (wrap in a While Controller)
- `<name>_llm_suggestions.json` — LLM fix proposals (`--run` + Gemini key, on failure)
- `<name>_report.json` — raw stats / run results
- `log.txt` — what happened, step by step

## Configuration (optional)
Copy `perfscript.config.example.json` → `perfscript.config.json` (gitignored)
to set things without command-line flags:
- `jmeterHome` — JMeter location for `--run` (or set `JMETER_HOME`)
- `maxIterations` — default feedback-loop budget (1–5)
- `gemini.apiKey` — enables LLM fix escalation on `--run` (or set `GOOGLE_API_KEY`)
- `run.targetBaseUrlOverride` / `run.credentials` / `run.dataFiles` — used by
  `--run` (credentials become `-JUSERNAME`/`-JPASSWORD`; data files are staged
  next to the JMX)

Secrets can equivalently come from the environment (see `.env.example`).

## Status
Phases 1–5 are built and runnable (see ARCHITECTURE.md for details):
- **1** folder pipeline · **2** local runner (`--run` with credentials/data + verdict)
- **3** hardening — unique-data parameterization, ghost-source regeneration,
  Cookie Manager, polling detection
- **4** LLM fix escalation (opt-in) · **5** headless verify via the bounded
  `--run` feedback loop, summarized in the HTML report

Cross-environment host rewrite is now **built** (recorded host → target, third-
party hosts untouched). Deferred (needs engine IR/renderer changes): auto-
emitting While Controllers for polling.

## Development
```bash
npm test          # node --test — 52 tests over the app's own logic
npm run ui        # start the web UI on :7070
```
A `pre-push` git hook runs the suite before every push (enabled by `npm install`,
or `git config core.hooksPath githooks`). CI runs it too — see
`.github/workflows/test.yml` (set the `ENGINE_REPO` Actions variable so CI can
check out the engine).

## Distribution
`perfscript.cmd` is the supported way to run without PATH setup. A fully
standalone single `.exe` (Node SEA) is **not** provided because the app requires
the engine checkout (`backend/` + its `node_modules`) at runtime by design — an
`.exe` would still need those on disk, so it adds build complexity without
removing the real dependency. To share with a teammate, copy this folder + the
engine checkout (or point `PERFSCRIPT_ENGINE` at theirs); they just need Node.
