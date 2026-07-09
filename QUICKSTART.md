# PerfScript — Quick Start

Turn browser recordings into a working, correlated JMeter `.jmx` — and optionally
run it against your test environment to see pass/fail.

---

## 0. One-time setup

1. **Node.js 18+** installed (the launchers auto-find it; nothing to configure).
2. **Apache JMeter** (for the *Validate* step only) — e.g. `D:\apache-jmeter-5.6.3`.
3. **Java 21 recommended** for JMeter 5.6.3. Agent Java-safe mode can strip
   JSR223/Groovy blocks before validation so newer Java versions do not hit the
   Groovy `Unsupported class file major version` failure.
4. Tell the app where those live — copy `perfscript.config.example.json` to
   `perfscript.config.json` and set:
   ```json
   {
     "jmeterHome": "D:/apache-jmeter-5.6.3",
     "javaHome": "D:/Users/nagendra.bpuchala/jdk21/jdk-21.0.11+10",
     "agent": {
       "enabled": false,
       "maxLlmRounds": 1,
       "javaSafeMode": true
     },
     "learning": {
       "enabled": true,
       "autoApplyMinConfidence": 0.85,
       "storePath": "memory/verified-lessons.json",
       "exportFile": "memory/team-lessons.json"
     },
     "inputState": {
       "enabled": true,
       "storePath": ".perfscript-state/processed-inputs.json"
     },
     "successArchive": {
       "enabled": true,
       "folder": "output/successful",
       "keepOriginals": true
     },
    "openai": {
      "apiKey": "",
      "model": "gpt-5.5"
    },
    "gemini": {
       "apiKey": "",
       "model": "gemini-3.5-flash",
       "proModel": "gemini-3.1-pro-preview"
     }
   }
   ```
   (Generating a script needs neither JMeter nor Java — only *Validate* does.)
   Add the OpenAI key later by filling `openai.apiKey` or setting
   `OPENAI_API_KEY`; leave it blank to run deterministic-only. Gemini remains
   available as a fallback via `gemini.apiKey` / `GOOGLE_API_KEY`.

---

## A. Start The Agent From The Folder

Use this when you want one clean launcher instead of choosing between scripts.

1. Double-click **`START_AGENT.cmd`**.
2. Keep the console window open. Your browser opens **http://localhost:7070**.
3. Drag recordings into the UI or put them in `input\`:
   - `flow__run1.har` + `flow__run2.har`
   - `flow__run1.jmx` + `flow__run1.recording.xml`
   - `flow__run2.jmx` + `flow__run2.recording.xml`
4. Select one or many logical scripts in the left panel.
5. Choose **Senior AI Agent**, **Mature PE Agent**, **Generate + Validate**,
   **Generate only**, or **Watch input folder**.
6. Watch the right-side live log. Use **Stop** to cancel the active run, **Rerun
   last** to repeat the previous script, or **Force rerun selected** when the
   input-state cache would otherwise skip unchanged files.
7. Open the report first, then download/open the final `.jmx`.

Existing files in `input\` are processed once, then tracked in
`.perfscript-state\processed-inputs.json`. If the same JMX/HAR/XML files are
unchanged when the agent restarts, they are skipped. If you replace or edit a
file, its size/modified time changes and the agent processes it again.

Close the console window to stop the UI server.

---

## B. Configure and Run

1. **Add recordings** — drag files onto the drop zone, click to browse, or place
   them in `input\`. See **§D** for what files to record and how to name them.

2. *(Only if you'll Validate or use Agent mode)* **Settings** — fill in:
   - **Target URL** — the environment to test, e.g. `https://stage.example.com`
   - **Username / Password** — a valid test login (password is write-only)
   - **Users / Ramp-up / Hold** — load profile (leave blank for a 1-user smoke run)
   - **Business objective / tech stack / domain notes / SLO** — optional mature
     PE context that improves the report and repair strategy.

   Click **Save settings**.

3. **Run:**
   - **Generate only** — correlate and build the `.jmx` with no execution.
   - **Generate + Validate** — also runs it and reports pass/fail.
   - **Senior AI Agent** — validates, uses OpenAI/Gemini only for unresolved
     failures, applies safe JSON patches, and re-runs JMeter.
   - **Mature PE Agent** — adds deeper objective, stack, domain, SLO, and
     business-flow reasoning.
   - **Watch input folder** — keeps the agent running for new files.

   Watch the right-side **live log**. Use **Stop** to cancel a run.

4. **Results** — each output appears with a **GREEN / needs-attention** badge,
   report link, final `.jmx` download, and **Rerun this** action.

---

## C. Using the CLI

Run from a terminal in the project folder:

| Do this | Terminal |
|---|---|
| Generate only | `node index.js` |
| Generate + Validate | `node index.js --run` |
| One-shot Senior AI agent | `node index.js --agent` or `npm run agent` |
| Mature PE agent | `node index.js --agent --senior` |
| Process selected scripts only | `node index.js --agent --input Batch_Print --input login.jmx --force` |
| Always-on Senior AI agent | `node index.js --agent --watch` or `npm run agent:watch` |
| Watch input\ and generate only | `node index.js --watch` |
| Start the web UI | `npm run ui` or double-click `START_AGENT.cmd` |
| Export verified lessons | `node index.js --memory-export memory/team-lessons.json` |
| Import teammate lessons | `node index.js --memory-import memory/team-lessons.json` |

Useful flags: `--input NAME` (process only matching logical input units/files),
`--iterations N` (auto-fix loop budget, default 3), `--agent`
(bounded AI diagnose/patch/re-verify when a key is configured), `--fast-loop`
(quick Node pre-flight without JMeter), `--gemini-pro` (use Gemini 3.1 Pro
Preview instead of default Gemini 3.5 Flash), `--force` (reprocess unchanged
input files after code/prompt changes), `--memory-export FILE`, and
`--memory-import FILE`.

Everything the UI does, the CLI does — the UI just calls `index.js` under the hood.

---

## D. What to put in `input\` (and naming)

The **best** results come from **two recordings of the same flow** (different
user/data) — the app diffs them to tell dynamic values from static config.

| You have | Name the files like | Detected as |
|---|---|---|
| Two HAR captures | `flow__run1.har`, `flow__run2.har` | dual-recording (best) |
| Two JMX + their recordings | `flow__run1.jmx` + `flow__run1.recording.xml`, `flow__run2.jmx` + `flow__run2.recording.xml` | dual-recording (best) |
| One JMX + its recording | `login.jmx` + `login.recording.xml` | single |
| One HAR | `login.har` | single |

**To capture a HAR:** in Chrome DevTools → **Network** tab → do the flow →
right-click the request list → **Save all as HAR with content**. Record it twice
(e.g. two different test users) for the dual-recording advantage.

---

## E. Reading the output (`output\<name>\`)

- **`00_OPEN_THIS_FIRST.txt`** — quick instructions for the folder.
- **`00_USE_THIS_FINAL_VALIDATED_<name>.jmx`** — open this JMX first after a GREEN
  Validate/Agent run. If JMeter validation did not run, the file says
  `FINAL_GENERATED_NOT_VALIDATED` instead.
- **`<name>_report.html`** — open this first: verdict, correlations, failures,
  links to every artifact.
- `<name>.jmx`, `final_validated.jmx`, and patched JMX files are kept for history
  and debugging.
- `<name>_data.csv` — synthesized unique test data (if the flow had user inputs).
- `final.jtl` / dashboard — raw run results (Validate mode).
- `_llm_suggestions.json`, `_llm_validation_round*.json`, `_llm_patches_round*.json`
  — only when OpenAI/Gemini is configured and unresolved failures remain.
- `_memory_matches.json`, `_memory_patches.json`, `_learned_lessons.json` —
  verified learning store evidence: matched lessons, applied memory patches, and
  newly saved redacted lessons after green verification.
- `_java_safe_*.json` — JSR223/Groovy blocks removed before JMeter validation.
- `log.txt`, `<name>_reasoning.md` — what the tool did and why.
- GREEN Validate/Agent runs also get a ZIP copy in `output\successful\`. The
  normal output folder stays readable because `successArchive.keepOriginals` is
  true by default.

---

## F. When Validate shows failures

- In Agent mode, the tool first checks the local verified learning store. Matching
  lessons are redacted, schema-gated, applied as candidate patches, and proven by
  another JMeter run before being accepted.
- **The report/log names the first failing step** — start there.
- **Login/OAuth (auth0/Okta) 401/403** is often **not** a correlation bug: modern
  interactive logins (PKCE) can't be replayed. Options: use a service/ROPC token,
  or inject a live session cookie. See `~/.claude/skills/jmeter-correlation`.
- **Third-party 4xx** (analytics/beacons like Dynatrace, gravatar) are noise —
  ignore them; they aren't your app.

To share knowledge with teammates, export a sanitized bundle:

```powershell
node index.js --memory-export memory/team-lessons.json
```

They can import it on their machine:

```powershell
node index.js --memory-import memory/team-lessons.json
```

---

## G. Troubleshooting

| Symptom | Fix |
|---|---|
| UI won't open / port busy | It auto-tries 7071+; check the console for the actual URL, or set `PERFSCRIPT_UI_PORT`. |
| "JMeter not found" | Set `jmeterHome` in `perfscript.config.json` (or `JMETER_HOME`). |
| Validate runs but 0 samples | Use agent Java-safe mode or point `javaHome` at JDK 21. |
| "engine not found" | Set `PERFSCRIPT_ENGINE` to the engine's `backend` folder. |

---

## H. Copying To Another Machine

Use `SETUP_FOR_TEAMMATES.md`. In short: copy this folder plus the reused engine
checkout, install Node 18+, install JMeter + Java 21, set `PERFSCRIPT_ENGINE` if
the engine is not beside this folder, create a local `perfscript.config.json`,
and add the OpenAI/Gemini key only on that machine if Agent mode should use AI.
