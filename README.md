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
- `<name>.jmx` — the generated (or validated) script
- `<name>.recording.xml` — full request/response bodies for reference
- `<name>_report.json` — correlations/samplers stats (and run results with `--run`)
- `log.txt` — what happened, step by step

## Status
Phase 1 (folder pipeline over the reused engine) is built and runnable.
Phases 2-5 (segment-replay state isolation, ghost-source JSR223 synthesis,
elastic polling blocks, Gemini escalation, headless verification) are specced
in ARCHITECTURE.md and layer on next.
