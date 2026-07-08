# PerfScript Local Setup For Teammates

Use this when copying `perfscript-local` to another Windows machine.

## What Must Be Copied

Copy both folders:

1. `perfscript-local`
2. The reused PerfScript engine `backend` folder, or the full repo that contains it.

This app is not a standalone `.exe`. It reuses the existing engine at runtime, so the copied machine must have that engine checkout available.

## Machine Prerequisites

Install or provide:

- Node.js 18 or newer.
- Apache JMeter, for Validate and Agent runs.
- Java 21 recommended for JMeter 5.6.3.
- Access to the target environment, including VPN/corporate network if needed.
- Valid test credentials and test data for the application under test.
- Optional OpenAI API key for Senior AI Agent mode. Gemini can be kept as a fallback.

## One-Time Setup

1. Copy `perfscript.config.example.json` to `perfscript.config.json`.

2. Set local paths:

```json
{
  "jmeterHome": "D:/apache-jmeter-5.6.3",
  "javaHome": "D:/path/to/jdk-21",
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
    "apiKey": "PASTE_OPENAI_KEY_HERE_OR_LEAVE_EMPTY",
    "model": "gpt-5.5"
  },
  "gemini": {
    "apiKey": "PASTE_KEY_HERE_OR_LEAVE_EMPTY",
    "model": "gemini-3.5-flash",
    "proModel": "gemini-3.1-pro-preview"
  },
  "run": {
    "targetBaseUrlOverride": "https://stage.example.com",
    "credentials": {
      "username": "test-user",
      "password": "test-password"
    }
  }
}
```

3. Point to the engine if it is not in a sibling folder:

```powershell
setx PERFSCRIPT_ENGINE "D:\path\to\jmeter-script-creator-main\backend"
```

Alternatively create `.env`:

```text
PERFSCRIPT_ENGINE=D:/path/to/jmeter-script-creator-main/backend
JMETER_HOME=D:/apache-jmeter-5.6.3
OPENAI_API_KEY=
GOOGLE_API_KEY=
```

4. If the engine repo was copied without dependencies, run this in the engine `backend` folder:

```powershell
npm install
```

## How To Run

Start the always-on folder agent:

```powershell
START_AGENT.cmd
```

Then drop supported file groups into `input\`. The agent will keep watching,
process each fresh group, validate with JMeter, and ask OpenAI/Gemini for safe bounded
fixes only when deterministic repair leaves unresolved failures.

Input files are tracked by path, size, and modified time. Existing files are
processed once, then skipped on future restarts unless they are edited/replaced.
Successful GREEN runs are also zipped into `output\successful\`; the normal
`output\<flow>\` folder stays readable by default.

Or start the web UI:

```powershell
perfscript-ui.cmd
```

Then:

1. Drop two HAR files, or two JMX files plus their `.recording.xml` files.
2. Fill Settings with target URL and credentials.
3. Click one of:
   - `Generate`: build the correlated JMX only.
   - `Generate + Validate (JMeter)`: run deterministic validation.
   - `Senior AI Agent`: validate, ask OpenAI/Gemini only for unresolved failures, apply safe JSON patches, and re-run JMeter.

CLI alternatives:

```powershell
node index.js
node index.js --run
node index.js --agent
node index.js --agent --gemini-pro
node index.js --agent --watch
node index.js --memory-export memory/team-lessons.json
node index.js --memory-import memory/team-lessons.json
npm run agent
npm run agent:watch
```

## Sharing Verified Lessons

The local store at `memory/verified-lessons.json` is intentionally gitignored.
It contains only lessons saved after a green JMeter verification, with secrets
and raw sensitive values redacted.

To share reusable learning with a teammate, export a sanitized bundle:

```powershell
node index.js --memory-export memory/team-lessons.json
```

Copy only the exported bundle to the teammate machine, then import it there:

```powershell
node index.js --memory-import memory/team-lessons.json
```

Imported lessons are never trusted blindly. The agent still runs them through the
safe patch schema gate and JMeter re-verification before accepting the result.

## What Will Not Work If Missing

- No engine checkout: app fails with `PerfScript engine not found`.
- No JMeter: Generate works, Validate and Agent fail.
- No Java/JMeter-compatible Java: Validate may fail or produce zero samples.
- No target/VPN access: JMeter cannot replay the app flow.
- No OpenAI/Gemini key: Agent still runs deterministic validation, but skips AI escalation.
- No valid credentials/test data: login or business requests may fail.

## Security Notes

- `perfscript.config.json` and `.env` are gitignored.
- Do not commit OpenAI/Gemini keys, passwords, generated `_secrets.json`, or live session cookies.
- Do not commit `memory/verified-lessons.json`; use sanitized exports for sharing.
- Do not commit `.perfscript-state`; it only tracks local processed inputs.
- Prefer test accounts and non-production data.
