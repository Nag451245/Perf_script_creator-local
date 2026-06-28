# perfscript-local — Architecture & Execution Phases

A **local-only, folder-driven autonomous** JMeter scripting agent. Drop
recordings in `input/`, get validated scripts in `output/`. Runs entirely on
your machine (local JMeter + optional Gemini key) so it can reach corporate
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
PHASE 4  LLM Escalation              ghost sources, crypto, complex transforms → JSR223
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

### Phase 4 — LLM Escalation (Gemini)
Triggered **only** when Phase 3 hits a ghost source or an unresolvable
transform chain. Bounded, tool-using, and every suggestion is re-verified by
the deterministic matchers before it ships. Never brute-force permutations.

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
- **Phases 2-5 hardening** — specced above; layered on next.
