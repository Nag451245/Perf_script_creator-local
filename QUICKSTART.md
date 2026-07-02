# PerfScript — Quick Start

Turn browser recordings into a working, correlated JMeter `.jmx` — and optionally
run it against your test environment to see pass/fail.

---

## 0. One-time setup

1. **Node.js 18+** installed (the launchers auto-find it; nothing to configure).
2. **Apache JMeter** (for the *Validate* step only) — e.g. `D:\apache-jmeter-5.6.3`.
3. **Java 8–21** (JMeter 5.6.3 breaks on Java 22+). A JDK 21 is already set up here.
4. Tell the app where those live — copy `perfscript.config.example.json` to
   `perfscript.config.json` and set:
   ```json
   {
     "jmeterHome": "D:/apache-jmeter-5.6.3",
     "javaHome": "D:/Users/nagendra.bpuchala/jdk21/jdk-21.0.11+10"
   }
   ```
   (Generating a script needs neither JMeter nor Java — only *Validate* does.)

---

## A. Using the UI (easiest)

1. **Launch:** double-click **`perfscript-ui.cmd`** (or the **PerfScript UI**
   desktop shortcut). A console window opens and your browser goes to
   **http://localhost:7070**. *Keep the console open; close it to stop the UI.*

2. **Add recordings** — drag your files onto the drop zone (or click to browse).
   See **§C** for what files to record and how to name them.

3. *(Only if you'll Validate)* **Settings** — fill in:
   - **Target URL** — the environment to test, e.g. `https://stage.example.com`
   - **Username / Password** — a valid test login (password is write-only)
   - **Users / Ramp-up / Hold** — load profile (leave blank for a 1-user smoke run)

   Click **Save settings**.

4. **Run:**
   - **Generate** — correlate and build the `.jmx` (no execution).
   - **Generate + Validate (JMeter)** — also runs it and reports pass/fail.

   Watch the **live log**. Use **Cancel** to stop a run.

5. **Results** — each output appears in the list with a **GREEN / needs-attention**
   badge and links to **report** (open first) and **.jmx** (download).

---

## B. Using the CLI / one-click launchers (otherwise)

Double-click a launcher, or run from a terminal in the project folder:

| Do this | Launcher (double-click) | Terminal |
|---|---|---|
| Generate only | `perfscript.cmd` | `node index.js` |
| Generate **+ Validate** | `perfscript-run.cmd` | `node index.js --run` |
| Watch input\ and process on drop | — | `node index.js --watch` |
| Start the web UI | `perfscript-ui.cmd` | `npm run ui` |

Useful flags: `--iterations N` (auto-fix loop budget, default 3), `--fast-loop`
(quick Node pre-flight without JMeter).

Everything the UI does, the CLI does — the UI just calls `index.js` under the hood.

---

## C. What to put in `input\` (and naming)

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

## D. Reading the output (`output\<name>\`)

- **`<name>_report.html`** — open this first: verdict, correlations, failures,
  links to every artifact.
- **`<name>.jmx`** — the generated/validated script (open in JMeter GUI to edit).
- `<name>_data.csv` — synthesized unique test data (if the flow had user inputs).
- `final.jtl` / dashboard — raw run results (Validate mode).
- `log.txt`, `<name>_reasoning.md` — what the tool did and why.

---

## E. When Validate shows failures

- **The report/log names the first failing step** — start there.
- **Login/OAuth (auth0/Okta) 401/403** is often **not** a correlation bug: modern
  interactive logins (PKCE) can't be replayed. Options: use a service/ROPC token,
  or inject a live session cookie. See `~/.claude/skills/jmeter-correlation`.
- **Third-party 4xx** (analytics/beacons like Dynatrace, gravatar) are noise —
  ignore them; they aren't your app.

---

## F. Troubleshooting

| Symptom | Fix |
|---|---|
| UI won't open / port busy | It auto-tries 7071+; check the console for the actual URL, or set `PERFSCRIPT_UI_PORT`. |
| "JMeter not found" | Set `jmeterHome` in `perfscript.config.json` (or `JMETER_HOME`). |
| Validate runs but 0 samples | Java too new — point `javaHome` at a JDK 8–21. |
| "engine not found" | Set `PERFSCRIPT_ENGINE` to the engine's `backend` folder. |
