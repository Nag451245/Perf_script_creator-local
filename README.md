# perfscript-local

Local, folder-driven autonomous JMeter scripting. Drop recordings in
`input/`, get scripts in `output/`. No cloud, no upload — runs on your
machine with local JMeter (+ optional OpenAI/Gemini). See **ARCHITECTURE.md** for the
five execution phases and hardening strategies.

It **reuses** the existing PerfScript engine in place (correlation, JMX
generation, the feedback loop) — it does not copy or modify the current app.

## Prerequisites
- **Node.js 18+**
- The PerfScript repo's `backend` folder on disk. Default path is baked into
  `src/engine.js`; override with the `PERFSCRIPT_ENGINE` env var if it moves.
- **JMeter** (only needed for `--run`): set `JMETER_HOME` or put `jmeter` on PATH.

## Usage

**Start Agent (folder button):** double-click **`START_AGENT.cmd`**. It opens
`input\` and watches it. Drop a pair of HAR files, or the JMX files plus their
matching `.recording.xml` files, and the agent automatically groups the files,
generates the JMX, validates it with JMeter, and asks OpenAI/Gemini for bounded
safe fixes whenever deterministic repair still leaves failures. Keep the console
window open; close it to stop the agent. Files are tracked by path, size, and
modified time, so an existing input is processed once and skipped on future
restarts unless it changes.

**Simple UI (Windows):** double-click **`perfscript-ui.cmd`** (or the *PerfScript
UI* desktop shortcut). Your browser opens `http://localhost:7070` where you can
drag-drop recordings, edit run settings (target / credentials / load profile),
press **Generate**, **Generate + Validate**, or **Senior AI Agent**, watch the
live log, cancel a run, and open the report / download the `.jmx`. Keep the
console window open; close it to stop the server. (Port auto-falls-back if 7070
is busy.)

**One-click validate:** double-click **`perfscript-run.cmd`** = generate + run
through local JMeter in one shot.

**One-click agent:** double-click **`perfscript-agent.cmd`** = generate + validate
through local JMeter, then use OpenAI/Gemini for unresolved failures when configured.
This is one-shot. Use **`START_AGENT.cmd`** when you want the folder to keep
watching for new inputs.

**CLI (Windows):** double-click `perfscript.cmd`, or from a terminal:
```bat
perfscript            :: generate scripts from every HAR in input\
perfscript --run      :: also validate with local JMeter
perfscript --agent    :: validate + bounded AI diagnose/patch/re-verify
perfscript --agent --gemini-pro :: use Gemini 3.1 Pro Preview for agent fixes
perfscript --agent --watch :: keep watching input\ and agent-process new files
perfscript --agent --force :: reprocess unchanged input files after code/prompt changes
perfscript --watch    :: process files as they appear in generate-only mode
perfscript --memory-export memory\team-lessons.json :: export sanitized lessons
perfscript --memory-import memory\team-lessons.json :: import teammate lessons
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

# 3) Agent mode — same local run, with safe OpenAI/Gemini escalation when configured
node index.js --agent --iterations 3

# 3b) Agent mode with Gemini 3.1 Pro Preview instead of default Flash
node index.js --agent --gemini-pro --iterations 3

# 4) Watch mode — process files as they land in input/
node index.js --watch

# 5) Always-on agent — what START_AGENT.cmd runs
node index.js --agent --watch

# 6) Team-share verified learning memory
node index.js --memory-export memory/team-lessons.json
node index.js --memory-import memory/team-lessons.json
```

Output per input file lands in `output/<name>/`:
- `00_OPEN_THIS_FIRST.txt` — quick instructions for the folder.
- `00_USE_THIS_FINAL_VALIDATED_<name>.jmx` — **open this JMX first** after a
  GREEN Validate/Agent run. If validation did not run, the copy is named
  `00_USE_THIS_FINAL_GENERATED_NOT_VALIDATED_<name>.jmx`.
- `<name>_report.html` — **open this first**: browser-readable summary (verdict,
  stats, request results, failures, links to every artifact)
- `<name>.jmx`, `final_validated.jmx`, patched JMX files — kept for debugging and
  history; use the top-sorted `00_USE_THIS...jmx` copy for normal JMeter opening.
- `<name>.recording.xml` — full request/response bodies for reference
- `<name>_data.csv` — synthesized unique-per-row data pool (avoids 409 collisions)
- `<name>_parameters.json` — discovered user-input fields
- `<name>_ghosts.json` — client-side (UUID/timestamp/trace) values + JMeter snippet
- `<name>_polling.json` — detected polling loops (wrap in a While Controller)
- `<name>_llm_suggestions.json` / `_llm_validation_round*.json` — AI proposals
  and strict schema-gate results (`--agent`, or `agent.enabled=true`, on failure)
- `<name>_java_safe_*.json` — JSR223 blocks stripped before JMeter when Java-safe
  mode is enabled
- `<name>_java_safe_generate.json` — Groovy JSR223 blocks stripped from the
  shipped `.jmx` so manual JMeter runs work under Java 22+/25
- `<name>_memory_matches.json` / `_memory_patches.json` — verified lessons the
  agent tried before AI escalation, plus what the schema-gated patcher applied
- `<name>_learned_lessons.json` — redacted lessons saved only after green
  verification
- `<name>_report.json` — raw stats / run results
- `log.txt` — what happened, step by step

When Validate/Agent finishes **GREEN**, the app also writes a ZIP copy under
`output/successful/`. The normal `output/<name>/` files are kept readable by
default.

## Configuration (optional)
Copy `perfscript.config.example.json` → `perfscript.config.json` (gitignored)
to set things without command-line flags:
- `jmeterHome` — JMeter location for `--run` (or set `JMETER_HOME`)
- `maxIterations` — default feedback-loop budget (1–5)
- `openai.apiKey` — preferred key used by agent mode (or set `OPENAI_API_KEY`)
- `openai.model` — default model, `gpt-5.5`
- `gemini.apiKey` — optional fallback key used by agent mode (or set `GOOGLE_API_KEY`)
- `gemini.model` — default model, `gemini-3.5-flash`
- `gemini.proModel` — model used by `--gemini-pro`, `gemini-3.1-pro-preview`
- `agent.enabled` — makes normal validate runs behave like `--agent`
- `agent.maxLlmRounds` — bounded AI patch/re-verify rounds (1–3, default 1)
- `agent.javaSafeMode` — strips JSR223 pre/post processors before JMeter so Java
  22+ does not hit Groovy class-version failures
- `learning.enabled` — enables the verified learning store (default true)
- `learning.autoApplyMinConfidence` — minimum confidence before a lesson can be
  tried before AI escalation; every imported lesson still goes through the safe patch
  schema gate and JMeter re-verification
- `learning.storePath` — local default is `memory/verified-lessons.json`
- `learning.exportFile` — suggested sanitized team bundle path
- `inputState.enabled` / `inputState.storePath` — persistent tracking for files
  already handled in `input\`, so unchanged JMX/HAR/XML inputs are skipped after
  restart
- `successArchive.enabled` / `successArchive.folder` / `successArchive.keepOriginals`
  — ZIP GREEN run folders into `output/successful/` while keeping loose files
  visible by default
- `run.targetBaseUrlOverride` / `run.credentials` / `run.dataFiles` — used by
  `--run` (credentials become `-JUSERNAME`/`-JPASSWORD`; data files are staged
  next to the JMX)

Secrets can equivalently come from the environment (see `.env.example`).

## Verified Learning Store
Agent mode now remembers only evidence-backed repairs. A lesson is saved after a
run turns green, then stored as a redacted pattern plus one of the existing safe
patch shapes. The store never keeps passwords, cookies, bearer tokens, CSRF
values, raw bodies, or sensitive query strings.

On the next failed run, the agent searches verified memory before AI escalation. A match
is only a candidate: it is schema-gated, applied to the JMX, and re-run through
JMeter before being accepted. Use explicit export/import commands to share
sanitized bundles with teammates without sharing recordings or secrets.

## Status
Phases 1–5 are built and runnable (see ARCHITECTURE.md for details):
- **1** folder pipeline · **2** local runner (`--run` with credentials/data + verdict)
- **3** hardening — unique-data parameterization, ghost-source regeneration,
  Cookie Manager, polling detection
- **4** safe bounded AI agent escalation (OpenAI preferred, Gemini fallback) · **5** headless verify via
  the bounded `--run` / `--agent` feedback loop, summarized in the HTML report

Cross-environment host rewrite is now **built** (recorded host → target, third-
party hosts untouched). Deferred (needs engine IR/renderer changes): auto-
emitting While Controllers for polling.

## Development
```bash
npm test          # node --test — local app test suite
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
See `SETUP_FOR_TEAMMATES.md` for the full copy/setup checklist.
