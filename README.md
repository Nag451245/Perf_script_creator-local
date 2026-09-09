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

**Single Agent Launcher (Windows):** double-click **`START_AGENT.cmd`**. Your
browser opens `http://localhost:7070` with one control center for everything:
drag-drop recordings, see logical HAR/JMX/XML script groups, select one or many
scripts, run Generate / Validate / Senior Agent / Mature PE Agent / Watch mode,
rerun the last script, force rerun selected scripts, stop the active run, and
watch live logs beside the controls. Keep the launcher console open; close it to
stop the UI server. The port auto-falls back if 7070 is busy.

**CLI (terminal only):**
```bat
node index.js            :: generate scripts from every HAR/JMX unit in input\
node index.js --run      :: also validate with local JMeter
node index.js --agent    :: validate + bounded AI diagnose/patch/re-verify
node index.js --agent --senior :: mature mode with deeper business/stack/SLO evidence
node index.js --agent --gemini-pro :: use Gemini 3.1 Pro Preview for agent fixes
node index.js --agent --watch :: keep watching input\ and agent-process new files
node index.js --agent --force :: reprocess unchanged input files
node index.js --agent --input Batch_Print :: process only a selected logical script
node index.js --agent --retry-failed 5 :: retry unchanged failed inputs up to 5 failed attempts
node index.js --memory-export memory\team-lessons.json :: export sanitized lessons
node index.js --memory-import memory\team-lessons.json :: import teammate lessons
```
`START_AGENT.cmd` finds Node automatically (PATH or common install locations), so
normal users do not need PATH setup.

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

# 3c) Mature PE mode — add deeper objective, stack, domain, and SLO reasoning
node index.js --agent --senior --iterations 3

# 4) Process only selected logical inputs/files from input/
node index.js --agent --input Batch_Print --input login.jmx --force

# 5) Watch mode — process files as they land in input/
node index.js --watch

# 6) Always-on agent
node index.js --agent --watch

# 7) Team-share verified learning memory
node index.js --memory-export memory/team-lessons.json
node index.js --memory-import memory/team-lessons.json
```

Output per input file lands in `output/<name>/`. The root holds only what a
human opens; everything else is filed into folders, moved rather than copied, so
there is exactly one of each file:

- **`00_OPEN_THIS_FIRST.txt`** — starts with what to DO with this script (run
  it, run it but check these first, or do not run it yet and why), then what
  changed since the last run of this flow, then where everything lives.
- **`00_RUN_THIS_SCRIPT.jmx`** — the deliverable. One stable name every run, so
  JMeter reopens the same path and no folder ends up with several near-identical
  scripts. The verdict lives in the report, not in the filename.
- **`<name>_report.html`** — the full picture in a browser: verdict, gates,
  correlations, request results, failures, and the long-form analyses embedded
  as expandable sections.
- `<name>_data.csv` — the data pool, which must stay beside the script (the
  CSVDataSet path is relative).
- `final.jtl`, `log.txt`, `00_OUTPUT_INDEX.txt`, `output_manifest.json`.

Folders, for when you need to dig:

| folder | what is in it |
| --- | --- |
| `scripts/` | a backup copy of the deliverable, and the pre-repair original |
| `reports/` | gate verdicts and run status |
| `results/` | JTL data and the JMeter dashboard |
| `evidence/` | label map, recording, parameters, correlations, forensics, diagnosis, run history |
| `data/` | additional data pools and upload staging |

Set `run.diagnostics` to `"full"` in the config to keep the machine-only JSON
twins of artifacts that are already written for humans.

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
- `agent.maxReplans` — bounded regenerate-with-a-different-strategy attempts
  after repair rounds are exhausted (0–2, default 0)
- `agent.seniorMode` — `strong` by default in agent mode; set `mature` or run
  `--agent --senior` to add deeper objective, stack, domain, and SLO evidence
- `agent.javaSafeMode` — strips JSR223 pre/post processors before JMeter so Java
  22+ does not hit Groovy class-version failures
- `learning.enabled` — enables the verified learning store (default true)
- `learning.autoApplyMinConfidence` — minimum confidence before a lesson can be
  tried before AI escalation; every imported lesson still goes through the safe patch
  schema gate and JMeter re-verification
- `learning.storePath` — local default is `memory/verified-lessons.json`
- `learning.exportFile` — suggested sanitized team bundle path
- `inputState.enabled` / `inputState.storePath` / `inputState.maxFailedAttempts`
  — persistent tracking for files already handled in `input\`. GREEN/generated
  inputs skip after restart; failed Validate/Agent inputs retry until the cap.
- `successArchive.enabled` / `successArchive.folder` / `successArchive.keepOriginals`
  — ZIP GREEN run folders into `output/successful/` while keeping loose files
  visible by default
- `run.targetBaseUrlOverride` / `run.credentials` / `run.dataFiles` — used by
  `--run` (credentials become `-JUSERNAME`/`-JPASSWORD`; data files are staged
  next to the JMX)
- `run.uploadSearchDirs` — local folders to search for files referenced by
  multipart upload steps. Defaults include `input/` and `bin/`.
- `run.testObjective` — senior PE workload objective. Examples:
  `single-scenario certification`, `stress/capacity`, `soak/endurance`,
  `search/cache-behavior`, `spike`. If blank, the agent assumes mixed-load
  capacity and reports the assumption.
- `run.techStack` / `run.domainNotes` / `run.businessCriticalSteps` — optional
  mature PE context used to interpret the business journey and stack-specific
  risks. Names are hints only; replay evidence and deterministic gates still win.
- `run.slo.p95Ms` / `run.slo.errorRatePct` — optional performance targets used
  in senior PE reports and scenario-gap checks.
- `run.allowJsr223` — default `false`; keep generated JMX Java-safe by stripping
  Groovy helpers. Set `true` only when you intentionally need JSR223 and have a
  compatible JMeter/Java runtime.
- `run.mineAssertions` — default `false`; generic page-text assertions are
  opt-in because titles/headings can drift. Business outcome probes and protected
  sampler checks still run by default.
- `run.protectedCalls` / `run.disableCalls` — business samplers to protect, or
  intentional noise/plumbing to disable. `disableCalls` will not remove
  login/session/business producers unless `run.allowUnsafeDisableProtected`
  is deliberately set to `true`.
- `flows.<name>` — **settings for one flow only.** Everything under `run` is
  global, so a disable tuned for one recording used to apply to every other one:
  `/jwt/v2/create-cookie`, added while working on `createtask`, disabled the
  session minter on an unrelated flow and that script served login pages for
  weeks. Put flow-specific settings under the flow's name instead, and they stay
  there. Keys not overridden still come from `run`; **lists replace rather than
  merge**, so a flow that names its own `disableCalls` never inherits another's:

  ```json
  "run":   { "disableCalls": ["/beacon"] },
  "flows": { "createtask": { "disableCalls": ["/beacon", "/jwt/v2/create-cookie"] } }
  ```
- `run.parameterization.includeNames` / `excludeNames` — optional guardrails so
  CSV data is limited to business/user data, not auth/session/protocol values.

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
`START_AGENT.cmd` is the supported way to run without PATH setup. A fully
standalone single `.exe` (Node SEA) is **not** provided because the app requires
the engine checkout (`backend/` + its `node_modules`) at runtime by design — an
`.exe` would still need those on disk, so it adds build complexity without
removing the real dependency. To share with a teammate, copy this folder + the
engine checkout (or point `PERFSCRIPT_ENGINE` at theirs); they just need Node.
See `SETUP_FOR_TEAMMATES.md` for the full copy/setup checklist.
