# perfscript-local — Architecture & Execution Phases

A **local-only, folder-driven autonomous** JMeter scripting agent. Drop
recordings in `input/`, get validated scripts in `output/`. Runs entirely on
your machine (local JMeter + optional OpenAI/Gemini key) so it can reach corporate
staging and never sends PHI to the cloud. Reuses the proven PerfScript engine
(see `src/engine.js`) — this folder is the autonomous wrapper + the hardened
verification loop on top of it.

## Why a separate local app (vs. the cloud app)
Every operational failure of the hosted app is an artifact of the cloud split
(stale deploys, ephemeral storage wiping files, idle spin-down, agent pairing,
CORS, cloud-can't-reach-staging). A single local process deletes that entire
class. The correlation/generation *brain* is identical and reused as-is.

---

## Five hardened execution phases

```
PHASE 1  Dual-Record & Index        flat Source→Sink value-flow enumeration
   ↓
PHASE 2  Replay Baseline & Localize  hit live env unmodified; find the FIRST divergence
   ↓
PHASE 3  Deterministic Repair Loop   fuzzy/transform matchers, verified vs recorded bytes
   ↓
PHASE 4  LLM Escalation              unresolved failures → safe structured patches
   ↓
PHASE 5  JMX Emission & Headless Verify   jmeter -n, parse .jtl, confirm metrics mirror replay
```

### Phase 1 — Dual-Record & Index
Capture **two** runs; strip static config via variance analysis; populate a
flat Source/Sink matrix across **all** locations (URL, body, every header
incl. microservice/`x-*`, Set-Cookie, status lines). Two recordings make
"dynamic vs static" a fact, not a guess, and feed the existing dual-HAR
compare. **Status:** single-HAR path reuses the engine today; auto-dual-record
(self-capture via CDP/Playwright) is the input-moat upgrade.

### Phase 2 — Replay Baseline & Fault Localization
Hit the live environment with **unmodified** recorded data and strict
assertions (status + response structure) to pinpoint the exact index where the
flow first diverges — repair there, not everywhere. **Status:** the current
JMeter feedback loop localizes by failed sampler; segment-precise localization
is the upgrade.

### Phase 3 — Deterministic Repair Loop
Run fuzzy/transform matchers (Base64, URL-encode, JSON paths, boundary
extraction) against the localized failure; **verify the extractor against the
raw recorded byte arrays before execution** (the engine already round-trip
verifies). Source priority: **body → response-header → Set-Cookie** (a body
value reproduces; a redirect header may not).

### Phase 4 — LLM Escalation (OpenAI Preferred, Gemini Fallback)
Triggered **only** when Phase 3 leaves unresolved failures. AI returns
structured suggestions; the local app auto-applies only a safe subset
(`addExtractor`, `replaceValueWithVar`, `setSamplerEnabled`) and re-verifies
with JMeter before anything ships. Never brute-force permutations.

### Phase 5 — Target JMX Emission & Headless Verification
Emit the final `.jmx`, drive it via `jmeter -n`, parse the `.jtl`, and confirm
transaction success + response-length metrics **mirror the replay baseline**.
Listener filenames are stripped so no "file already exists" prompt.

---

## Four hardening strategies (the missing links)

### 1. Idempotency & state-pollution wall  *(highest priority)*
Re-running a non-idempotent step (`POST /create`) every loop consumes test
data → later iterations fail with `409` from **upstream state pollution**, not
a correlation bug. **Strategy (in priority order):**
1. **Segment replay** — replay only the window under test; **fast-forward /
   mock already-green upstream steps** from the recording. *(primary)*
2. **Dynamic data generation** — unique identifiers (timestamp/UUID-suffixed
   usernames) seeded before the baseline run.
3. **Environment snapshot reset** between iterative cycles (when available).

### 2. Ghost sources (client-side value synthesis)
A value flagged dynamic with **zero upstream matches** was born in browser JS
(UUIDv4, epoch, nonce, HMAC). It bypasses deterministic extraction and
escalates to Phase 4: *"classify by format and emit a JSR223 PreProcessor that
generates it locally."* **Honest limit:** an HMAC/signature needs the signing
key + algorithm — if the key is a server secret never in traffic, surface
"manual: provide signing logic," do not fake it.

### 3. Elastic sequences (the polling-loop trap)
Recorded `GET /status → PENDING ×N → COMPLETE` must not become a hardcoded
count. Group sequential duplicate requests into an **Elastic Polling Block**:
a JMeter **While Controller** that repeats until a state-change termination
condition (a JSON key flips), tolerant of faster/slower live backends.

### 4. Cookie-jar divergence
A custom replay engine's native cookie jar can **mask** a `Set-Cookie`
dependency that JMeter then fails to emit. **Strategy:** disable native cookie
handling in the replay engine; force cookies through the same flat index
(`Set-Cookie` → Source, `Cookie` → Sink) so the dependency is explicitly
tracked and emitted in the JMX. *(This is exactly the session-token-in-body
class the engine now handles.)*

---

## Architectural note: replay engine
Phases 2-4 are fastest with a **custom HTTP replay engine** (no per-loop JVM
cost), with JMeter reserved for Phase-5 verification. v1 reuses the existing
**JMeter-based** loop + adds the hardening strategies; the custom replay engine
is the endgame. `src/engine.js` isolates the engine so that swap is clean.

## Irreducible limits (no architecture removes these)
- Needs valid **credentials + test data** (a secret only the user has).
- **MFA / single-use / true-secret HMAC** auth cannot be replayed/synthesized.
The goal is 80%-grunt-work → 20%-review, fully auditable — not zero-human.

## Build status
- **Phase 1 front door** — built (`index.js`): folder pipeline, reuse engine,
  generate + optional local-JMeter run/validate.
- **Phase 2 local runner** — built (`src/runner.js`): config-driven `--run`
  with credentials / data files / target over the reused `runFeedbackLoop`;
  emits a GREEN/needs-attention verdict. Engine untouched.
- **Phase 3 hardening** — built (`src/generate.js`, the local app's own
  generation so it can inject what the orchestrator can't):
  - 3a/3b **state pollution** — discover user-input fields, synthesize a
    unique-per-row pool, wire a CSV Data Set (`_data.csv`, `_parameters.json`).
  - 3c **ghost sources** — surfaced; the JMeter renderer already rewrites
    client-minted values inline (`${__UUID}`/`${__time}`/…). Report +
    `_ghosts.json`.
  - 3d **cookie-jar** — already handled by the engine (Cookie Manager emitted +
    correlation covers cookies it can't carry). **Elastic polling** — detected
    + reported (`_polling.json`); auto-emitting a While Controller needs engine
    IR/renderer support (deferred to avoid disturbing the current app).
- **Phases 4-5** — safe bounded AI escalation + headless verify (`--run` and
  `--agent` run a bounded headless loop; OpenAI/Gemini is optional and key-gated).

## Update log (built since the phase notes above)
- **Golden-script learner** (`src/golden-diff.js`) — drop a human-fixed
  WORKING script into `input/` as `<flow>__golden.jmx`: its proven extractors
  are copied verbatim, its enable/disable judgments mirrored (guard treats
  them as operator decisions), its literal→`${var}` substitutions re-applied.
  Trusted but verified — the merged script still runs the full loop.
- **Stack playbooks** (`src/playbooks.js` + `playbooks/*.json`) — senior
  priors as DATA, matched by recording evidence (fingerprint/hosts/paths),
  merged with precedence config > playbook > defaults. Starter set: Auth0
  Universal Login, Dynatrace RUM, Next.js build-data, LaunchDarkly, SAML
  auto-POST.
- **Blocked-state report** (`src/blockers.js`) — a not-GREEN run now ends
  with PRECISE human asks (`_blockers.md`): credentials, MFA account, env
  health check, second recording, signing secrets — instead of "needs
  attention".
- **Scenario designer** (`src/scenario.js`, `run.scenario`) — Little's Law
  from transactions/hour + recorded session length to threads / ramp /
  pacing (native Precise Throughput Timer) / CSV pool size, math shown in
  `<flow>_scenario.md`. Explicit `run.loadProfile` still wins.
- **Outcome probe** (`src/outcome-probe.js`) — finds the recorded echo pair
  (business mutation submits V → later read's response contains V) and
  asserts it, so "every request 200s but nothing was created" can no longer
  be GREEN.
- **Fingerprint-keyed lessons** — verified lessons now carry the stack
  fingerprint; same-stack experience ranks first when matching, so lessons
  transfer across apps built on the same stack.
- **Eval harness** (`npm run eval`, `eval-corpus/`) — outcome-level
  regression corpus for the agent's judgment (sampler counts, wirings,
  probes, zero orphans). Synthetic fixtures are committed; real recordings
  stay local in gitignored `eval-corpus/local-*` dirs.
- **Form hidden-input correlation** (`correlateFormHiddenInputs` in
  `src/transforms.js`) — the class the manually-fixed Tasking script solved by
  hand: a page body carries `<input type="hidden" name=X value=V>` (IdP login
  `state`, SSO auto-POST bridge `token`) and later requests must send the FRESH
  value. Recording-evidence-driven: producer = entry whose HTML response holds
  the hidden input, wired only when a later entry provably consumes the value;
  emits a CSS HtmlExtractor after the producer and substitutes `${var}` in all
  later sampler fields (path / body args / headers). Generic — no app names.
- **Flow profiles moved to config** — app/flow-specific knowledge (disable
  patterns, `oauth.dropBareStateNonce`, LLM flow notes) now lives in
  `perfscript.config.json` (`run.disableCalls` / `run.oauth` /
  `run.llmFlowNotes`), not in code. The business guard treats
  `run.disableCalls` as an operator override: explicitly disabled samplers are
  never "protected", so an intentional disable can't fail the verdict.
- **Verdict recovery from JTL** — the engine loop's result parse can return an
  empty or PARTIAL samples array after JMeter ran; per-sampler rows are
  recovered/merged from `final.jtl` (`recoverSamplesFromJtl`), which is also
  deleted at run start (SimpleDataWriter appends — stale rows from a previous
  run must not pollute the verdict). Fixes "0/0 requests passed" and the
  guard's false "protected sampler did not execute".
- **Dead-extractor repair** (`repairDeadExtractorConsumers`) — an extractor
  stranded under a disabled sampler can never populate its variable, so its
  `${var}` consumers would send the literal brace string (URISyntaxException
  in URLs). Restores the recorded literal at each consumer, evidenced from the
  consumer's recorded request.
- **Bridge-page assertion skip** — auto-submit SSO bridge pages (POST form of
  hidden inputs + `.submit()`) get no mined assertions: with redirects
  followed, the replay lands PAST the bridge, so recorded-bridge text always
  fails on a correct run.
- **Correlation convergence** — the variance/verify-gate/body-parsing correlator
  (`src/auto-correlate.js`) is now wired into the app: `generate.js` runs it as a
  final **body/session pass** when a 2nd recording is present, filling dynamics
  the engine leaves literal (GraphQL `<queryString>` bodies, the
  `sessionId:"Token <cookie>"` session-in-body class). Layers safely (consumed-
  gate + extractor verification + no var-name clobber). Previously this lived in
  a dev-only tool; the two correlators are now one.
- **Cross-env host rewrite** — **built** (`src/host-rewrite.js`, applied in
  `generate.js`): the recorded primary host is repointed to the target; third-
  party hosts are left alone. (Supersedes the older "samplers still hit recorded
  hosts / later phase" note.)
- **Fast-replay pre-flight** — the Node replay engine now runs automatically in
  `--run` (not only `--fast-loop`) when a target is set: cheap Phase-2
  localization before the JVM boots.
- **Load profile** — applies to **every** Thread Group (setUp/multi-TG safe).
- **Web UI** (`src/ui-server.js`, `perfscript-ui.cmd`) — drag-drop recordings,
  Generate / Generate+Validate / Senior AI Agent, a settings panel
  (target/credentials/load profile), live log, cancel, and links to the report
  + `.jmx`.
- **Test gate** — `githooks/pre-push` runs the suite before every push;
  `.github/workflows/test.yml` runs it in CI (set the `ENGINE_REPO` Actions
  variable so CI can check out the engine). Run `npm test` locally before
  sharing changes.
