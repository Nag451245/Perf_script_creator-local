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

Deferred (needs engine IR/renderer changes, kept out to not disturb the current
app): auto-emitting While Controllers for polling, cross-environment host rewrite.
