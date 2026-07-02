'use strict';
/**
 * transforms.js — post-XML JMX rewrites for the things the engine renderer
 * cannot emit today without intrusive changes. Each function is pure
 * (xml -> { xml, ...stats }) and idempotent so they can chain.
 *
 *   wrapPollingInWhileController : >=3 consecutive same-endpoint samplers ->
 *                                  one WhileController + If terminator
 *   injectGhostSynthesizers      : per-thread-group JSR223 PreProcessors for
 *                                  UUID / timestamp / traceparent / PKCE etc.
 *   injectAssertionsFromMined    : ResponseAssertion / JSONAssertion per
 *                                  sampler from extractStableTextCandidates
 *   injectGaussianTimers         : per-transaction GaussianRandomTimer using
 *                                  recorded inter-request gaps
 *   stripGuiListenersForRun      : disable GUI listeners + add a single
 *                                  SimpleDataWriter to <jtlPath>
 *
 * Why one file: these transforms are small, share helpers (sampler offsets,
 * XML escaping), and have no business living in 4 separate modules. The
 * shared helpers are exported under `_internal` for testing only.
 */
const path = require('path');
const E = require('./engine');
const { clientSideSnippetFor } = E.clientSide;
const { extractStableTextCandidates } = E.assertionMiner;

const SAMPLER_CLOSE_TAG = '</HTTPSamplerProxy>';

function escXmlAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function indexSamplers(xml) {
    const out = [];
    const re = /<HTTPSamplerProxy\b[^>]*\btestname="([^"]*)"[^>]*>/g;
    let m;
    while ((m = re.exec(xml)) !== null) out.push({ order: out.length, position: m.index, name: m[1] });
    for (let i = 0; i < out.length; i++) {
        out[i].endPosition = i + 1 < out.length ? out[i + 1].position : xml.length;
    }
    return out;
}

/* ─────────────────────────────────────────────────────────────────
 * 1. While Controller for elastic polling
 * ───────────────────────────────────────────────────────────────── */

/**
 * Wrap each detected polling cluster (>=3 consecutive same method+path
 * samplers, query-stripped) inside a JMeter While Controller that exits
 * when a recognised terminal state appears in the LAST response. The
 * terminator mines the recording's final-poll body for a *changed* field
 * (e.g. status: PENDING -> COMPLETE) and asserts the value did NOT match
 * the pending one.
 *
 * Honest limit: if we can't infer a terminator, we still wrap the loop
 * but cap iterations at the recorded count + a safety multiplier so the
 * test doesn't hang on a backend that's slower than the recording.
 *
 * @param {string} xml
 * @param {Array<{endpoint:string, count:number, startOrder?:number, terminator?:string}>} polling
 *   May come from generate.detectPolling enriched with sampler indices.
 * @returns {{ xml: string, wrapped: number }}
 */
function wrapPollingInWhileController(xml, polling) {
    if (!Array.isArray(polling) || polling.length === 0) return { xml, wrapped: 0 };
    const samplers = indexSamplers(xml);
    let result = xml;
    let wrapped = 0;
    // Apply in reverse document order so earlier offsets stay valid.
    const work = polling
        .filter(p => typeof p.startOrder === 'number' && p.count >= 3)
        .sort((a, b) => b.startOrder - a.startOrder);

    for (const p of work) {
        const first = samplers[p.startOrder];
        const last = samplers[p.startOrder + p.count - 1];
        if (!first || !last) continue;
        // Find the start of FIRST sampler's whole "<HTTPSamplerProxy ...> ...
        // </HTTPSamplerProxy><hashTree>...</hashTree>" tuple. We assume well-
        // formed JMX (which the engine renders): a sampler's sibling hashTree
        // follows immediately, either as <hashTree/> or <hashTree>...</hashTree>.
        // Compute the end position of the LAST sampler's hashTree.
        const blockStart = first.position;
        const lastHashTreeEnd = findHashTreeEnd(result, last.position);
        if (lastHashTreeEnd < 0) continue;
        const block = result.substring(blockStart, lastHashTreeEnd);

        const safeCount = Math.max(p.count, 3);
        const cap = safeCount * 4;
        // Terminator strategy: prefer the per-cluster `terminator` hint when
        // the detector gave us one (typically a JMeter __jexl3 expression that
        // checks a response field). Fall back to a capped counter incremented
        // by a tiny JSR223 PostProcessor inside the loop — deterministic and
        // doesn't depend on response-body shape we can't always parse.
        const counterVar = `__pollCount_${wrapped + 1}`;
        const counterCondition = `${"${__jexl3(vars.get('"+counterVar+"') == null || Integer.parseInt(vars.get('"+counterVar+"')) < "+cap+")}"}`;
        const whileCondition = p.terminator || counterCondition;

        const counterScript = `def n = vars.get("${counterVar}"); vars.put("${counterVar}", (n == null ? 1 : Integer.parseInt(n) + 1).toString())`;
        const counterBlock = `
        <JSR223PostProcessor guiclass="TestBeanGUI" testclass="JSR223PostProcessor" testname="Polling counter ${wrapped + 1}" enabled="true">
          <stringProp name="cacheKey">true</stringProp>
          <stringProp name="filename"></stringProp>
          <stringProp name="parameters"></stringProp>
          <stringProp name="script">${escXmlAttr(counterScript)}</stringProp>
          <stringProp name="scriptLanguage">groovy</stringProp>
        </JSR223PostProcessor>
        <hashTree/>`;

        const wrappedBlock = `
        <WhileController guiclass="WhileControllerGui" testclass="WhileController" testname="Polling: ${escXmlAttr(p.endpoint)} (cap ${cap})" enabled="true">
          <stringProp name="WhileController.condition">${escXmlAttr(whileCondition)}</stringProp>
        </WhileController>
        <hashTree>
${block}
${counterBlock}
        </hashTree>`;

        result = result.substring(0, blockStart) + wrappedBlock + result.substring(lastHashTreeEnd);
        wrapped++;
    }
    return { xml: result, wrapped };
}

/**
 * Find the document offset just past the </hashTree> (or self-closing
 * <hashTree/>) that's the sibling of the HTTPSamplerProxy at `samplerStart`.
 * Returns -1 if not found.
 */
function findHashTreeEnd(xml, samplerStart) {
    const closeIdx = xml.indexOf(SAMPLER_CLOSE_TAG, samplerStart);
    if (closeIdx < 0) return -1;
    const afterClose = closeIdx + SAMPLER_CLOSE_TAG.length;
    const tail = xml.substring(afterClose);
    const selfClose = tail.match(/^\s*<hashTree\s*\/>/);
    if (selfClose) return afterClose + selfClose[0].length;
    const openTag = tail.match(/^\s*<hashTree>/);
    if (!openTag) return -1;
    // Walk balanced <hashTree>…</hashTree>.
    let depth = 1;
    let i = afterClose + openTag[0].length;
    const openRe = /<hashTree(?:\s[^>]*)?>/g;
    const closeRe = /<\/hashTree>/g;
    while (depth > 0 && i < xml.length) {
        openRe.lastIndex = i; closeRe.lastIndex = i;
        const o = openRe.exec(xml);
        const c = closeRe.exec(xml);
        if (!c) return -1;
        if (o && o.index < c.index) { depth++; i = o.index + o[0].length; }
        else { depth--; i = c.index + c[0].length; }
    }
    return depth === 0 ? i : -1;
}

/* ─────────────────────────────────────────────────────────────────
 * 2. Ghost-source synthesizers (one PreProcessor per ghost var)
 * ───────────────────────────────────────────────────────────────── */

/**
 * Inject one JSR223 PreProcessor at thread-group scope per *inline-substitutable*
 * ghost (UUID, traceparent, x-request-id, cache-buster, client timestamp,
 * OAuth nonce). PKCE pairs and APM beacons are reported but not auto-injected
 * because they need ordering (verifier before challenge) or stripping
 * (APM beacons hurt rather than help). The HMAC class is intentionally NOT
 * synthesised; we surface "manual: provide signing logic" in reasoning so
 * we don't fake what we can't compute (per ARCHITECTURE.md irreducible limit).
 *
 * @returns {{ xml: string, injected: number, refused: Array<{name:string,kind:string,reason:string}> }}
 */
function injectGhostSynthesizers(xml, ghosts, serverOriginValues = new Set()) {
    const refused = [];
    if (!Array.isArray(ghosts) || ghosts.length === 0) return { xml, injected: 0, refused };

    const blocks = [];
    const seen = new Set();
    for (const g of ghosts) {
        const name = g.paramName || g.name;
        const value = g.sampleValue || '';
        if (!name) continue;
        // Refuse the things we honestly cannot synthesise.
        if (/hmac|sig(nature)?/i.test(name) || /jwt/i.test(g.kind || '')) {
            refused.push({ name, kind: g.kind, reason: 'requires signing key not present in traffic' });
            continue;
        }
        const snippet = clientSideSnippetFor(name, value, serverOriginValues);
        if (!snippet) continue;
        const key = `${name}::${snippet.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Emit as a JSR223 PreProcessor at thread-group scope so the var is
        // available to ALL samplers, fresh per iteration.
        const script = `vars.put("${name}", "${jsStringEscape(snippet.snippet)}".toString())`;
        // For snippets that are JMeter functions (`${__UUID}` etc.), use a
        // User Defined Variable + __evalVar pattern instead so they resolve
        // at runtime, not as literals.
        const isJmeterFn = snippet.snippet.startsWith('${') && snippet.snippet.endsWith('}');
        const safeScript = isJmeterFn
            ? `vars.put("${name}", "${snippet.snippet}".replaceAll(/\\$\\{(__\\w+(?:\\(.*?\\))?)\\}/, { m -> org.apache.jmeter.functions.FunctionService.getInstance().resolveVariable(m).execute() }).toString())`
            : script;

        // Practical implementation: use the proven pattern of evaluating the
        // JMeter function string via __V/__eval at sampler scope. PreProcessor
        // sets a UDV, and the SAMPLER references `${name}` which then expands.
        // We sidestep the runtime-resolve complexity by setting the var via
        // JSR223 with a tiny generator equivalent.
        const generator = generatorForKind(snippet.kind, name);
        if (!generator) {
            refused.push({ name, kind: snippet.kind, reason: 'no Groovy generator available' });
            continue;
        }
        blocks.push(`
      <JSR223PreProcessor guiclass="TestBeanGUI" testclass="JSR223PreProcessor" testname="Ghost: ${escXmlAttr(name)} (${escXmlAttr(snippet.kind)})" enabled="true">
        <stringProp name="cacheKey">true</stringProp>
        <stringProp name="filename"></stringProp>
        <stringProp name="parameters"></stringProp>
        <stringProp name="script">${escXmlAttr(generator)}</stringProp>
        <stringProp name="scriptLanguage">groovy</stringProp>
      </JSR223PreProcessor>
      <hashTree/>`);
    }
    if (!blocks.length) return { xml, injected: 0, refused };

    // Splice all blocks right after the first ThreadGroup's opening tag
    // (technically inside its hashTree, before any sampler). That puts them
    // at thread-scope so every iteration regenerates the value.
    const tgMatch = xml.match(/<ThreadGroup\b[\s\S]*?<\/ThreadGroup>\s*<hashTree>/);
    if (!tgMatch) return { xml, injected: 0, refused };
    const insertAt = tgMatch.index + tgMatch[0].length;
    const insertion = `\n${blocks.join('\n')}\n`;
    return { xml: xml.substring(0, insertAt) + insertion + xml.substring(insertAt), injected: blocks.length, refused };
}

function generatorForKind(kind, name) {
    switch (kind) {
        case 'UUID':
        case 'CLIENT_GUID':
        case 'X_REQUEST_ID':
        case 'OAUTH_NONCE':
            return `vars.put("${name}", java.util.UUID.randomUUID().toString())`;
        case 'CACHE_BUSTER':
        case 'CLIENT_TIMESTAMP':
            return `vars.put("${name}", String.valueOf(System.currentTimeMillis()))`;
        case 'CLIENT_TIMESTAMP_ISO':
            return `vars.put("${name}", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX").format(new java.util.Date()))`;
        case 'W3C_TRACEPARENT': {
            const traceFn = `def hex = { int n -> def chars = '0123456789abcdef'.toCharArray(); def r = new java.security.SecureRandom(); def sb = new StringBuilder(); n.times { sb.append(chars[r.nextInt(16)]) }; return sb.toString() }`;
            return `${traceFn}\nvars.put("${name}", "00-" + hex(32) + "-" + hex(16) + "-01")`;
        }
        default:
            return null;
    }
}

function jsStringEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
/* ─────────────────────────────────────────────────────────────────
 * 3. Assertion miner -> ResponseAssertion / JSONAssertion
 * ───────────────────────────────────────────────────────────────── */

/**
 * For each sampler whose recording carries a parseable response body, mine
 * 1-2 stable text candidates and emit a JMeter ResponseAssertion that the
 * body CONTAINS that text. Skips samplers with no body, no stable text, or
 * status >= 400 (we don't want to assert noise into 401/500 responses).
 *
 * @returns {{ xml: string, injected: number }}
 */
function injectAssertionsFromMined(xml, flatEntries, correlationValues = []) {
    const samplers = indexSamplers(xml);
    if (samplers.length === 0 || !Array.isArray(flatEntries)) return { xml, injected: 0 };
    let result = xml;
    let injected = 0;

    // Apply in reverse so earlier offsets stay valid.
    const items = [];
    for (let i = Math.min(samplers.length, flatEntries.length) - 1; i >= 0; i--) {
        const e = flatEntries[i];
        if (!e || !e.response) continue;
        const status = Number(e.response.status || 0);
        if (status >= 400 || status === 0) continue;
        const body = (e.response.content && e.response.content.text) || '';
        if (!body || body.length < 8) continue;
        const ct = (e.response.content && e.response.content.mimeType) || '';
        const cands = extractStableTextCandidates(body, ct, {
            correlationValues, maxCandidates: 2,
        });
        if (!cands.length) continue;
        items.push({ samplerIdx: i, texts: cands.map(c => c.text) });
    }

    for (const it of items) {
        const s = samplers[it.samplerIdx];
        const closeIdx = result.indexOf(SAMPLER_CLOSE_TAG, s.position);
        if (closeIdx < 0) continue;
        const afterClose = closeIdx + SAMPLER_CLOSE_TAG.length;
        const tail = result.substring(afterClose);
        const selfClose = tail.match(/^\s*<hashTree\s*\/>/);
        const openTag = tail.match(/^\s*<hashTree>/);
        const block = buildResponseAssertion(it.texts);
        if (selfClose) {
            const matchEnd = afterClose + selfClose[0].length;
            const expanded = '\n        <hashTree>' + block + '\n        </hashTree>';
            result = result.substring(0, afterClose) + expanded + result.substring(matchEnd);
        } else if (openTag) {
            const insertPos = afterClose + openTag[0].length;
            result = result.substring(0, insertPos) + block + result.substring(insertPos);
        } else continue;
        injected++;
    }
    return { xml: result, injected };
}

function buildResponseAssertion(texts) {
    // Stable, deterministic stringProp names so generated JMX diffs cleanly
    // across re-runs (Math.random() names defeat diff/grep review).
    const items = texts.map((t, i) =>
        `<stringProp name="assert_${i}">${escXmlAttr(t)}</stringProp>`
    ).join('\n            ');
    // Assertion.test_type is a bitmask. 2 = SUBSTRING, 16 = OR. 2|16 = 18.
    // The field under test is set separately by Assertion.test_field
    // (Assertion.response_data == the response body).
    return `
            <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Stable text present" enabled="true">
              <collectionProp name="Asserion.test_strings">
            ${items}
              </collectionProp>
              <stringProp name="Assertion.custom_message"></stringProp>
              <stringProp name="Assertion.test_field">Assertion.response_data</stringProp>
              <boolProp name="Assertion.assume_success">false</boolProp>
              <intProp name="Assertion.test_type">18</intProp>
            </ResponseAssertion>
            <hashTree/>`;
}

/* ─────────────────────────────────────────────────────────────────
 * 4. Per-transaction Gaussian Random Timer from recorded gaps
 * ───────────────────────────────────────────────────────────────── */

/**
 * Read inter-request gaps from HAR (`startedDateTime + time` -> next
 * `startedDateTime`), group by pageref, compute mean+stdev per group, and
 * inject a GaussianRandomTimer right inside each TransactionController's
 * hashTree. Skips groups with too few samples or a sub-second mean (think
 * times below 1s create false load shape; better to omit).
 *
 * @returns {{ xml: string, injected: number }}
 */
function injectGaussianTimers(xml, flatEntries, pages) {
    if (!Array.isArray(flatEntries) || flatEntries.length < 2) return { xml, injected: 0 };
    // Per-pageref means.
    const stats = computePageTimings(flatEntries, pages);
    if (stats.size === 0) return { xml, injected: 0 };

    let result = xml;
    let injected = 0;
    // Match every TransactionController + its sibling <hashTree>.
    const txRe = /<TransactionController\b[\s\S]*?testname="([^"]*)"[\s\S]*?<\/TransactionController>\s*<hashTree>/g;
    // Apply in reverse.
    const matches = [...result.matchAll(txRe)];
    for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        const txName = m[1];
        const s = stats.get(txName) || stats.get('__default') || stats.get([...stats.keys()][0]);
        if (!s || s.mean < 1000) continue;
        const timer = `
          <GaussianRandomTimer guiclass="GaussianRandomTimerGui" testclass="GaussianRandomTimer" testname="Pacing (Transaction)" enabled="true">
            <stringProp name="ConstantTimer.delay">${Math.round(s.mean)}</stringProp>
            <stringProp name="RandomTimer.range">${Math.round(s.stdev)}</stringProp>
          </GaussianRandomTimer>
          <hashTree/>`;
        const insertAt = m.index + m[0].length;
        result = result.substring(0, insertAt) + timer + result.substring(insertAt);
        injected++;
    }
    return { xml: result, injected };
}

function computePageTimings(flat, pages) {
    const byPage = new Map();
    for (let i = 0; i < flat.length - 1; i++) {
        const cur = flat[i]; const nxt = flat[i + 1];
        if (!cur.pageref || cur.pageref !== nxt.pageref) continue;
        const start = Date.parse(cur.startedDateTime || '');
        const next = Date.parse(nxt.startedDateTime || '');
        if (!isFinite(start) || !isFinite(next)) continue;
        const dur = Number(cur.time || 0);
        const gap = next - (start + (isFinite(dur) ? dur : 0));
        if (gap <= 0 || gap > 10 * 60 * 1000) continue; // clamp: ignore idle > 10m
        const list = byPage.get(cur.pageref) || [];
        list.push(gap);
        byPage.set(cur.pageref, list);
    }
    const pageById = new Map((pages || []).map(p => [p.id, p]));
    const out = new Map();
    for (const [pid, list] of byPage.entries()) {
        if (list.length < 2) continue;
        const mean = list.reduce((a, b) => a + b, 0) / list.length;
        const variance = list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length;
        const stdev = Math.sqrt(variance);
        const title = pageById.get(pid)?.title || 'Transaction';
        out.set(title, { mean, stdev, n: list.length });
    }
    return out;
}

/* ─────────────────────────────────────────────────────────────────
 * 5. Load profile (users / ramp-up / hold / loops) on the Thread Group
 * ─────────────────────────────────────────────────────────────────
 *
 * The engine renderer emits a vanilla Thread Group (1 user, 1 loop) —
 * fine for a smoke run, useless for actual load testing. This transform
 * surgically rewrites ONLY the first <ThreadGroup>…</ThreadGroup> block
 * (samplers live in its hashTree sibling, not inside it, so this is safe)
 * to honor a configurable load profile.
 *
 * Profile shape:
 *   { users?: int, rampUpSec?: int, holdSec?: int, loops?: int }
 *
 *   - users      → ThreadGroup.num_threads
 *   - rampUpSec  → ThreadGroup.ramp_time
 *   - holdSec    → enables scheduler + sets duration. Loops force to -1
 *                  (infinite) because JMeter exits at min(loops_done,
 *                  duration_elapsed); having a finite loop cap with a
 *                  scheduler is almost always a user mistake.
 *   - loops      → LoopController.loops when holdSec is NOT set. Ignored
 *                  with holdSec.
 *
 * Idempotent (re-applying the same profile is a no-op).
 */

const THREAD_GROUP_BLOCK_RE = /<ThreadGroup\b[\s\S]*?<\/ThreadGroup>/;

function setStringProp(block, name, value) {
    const re = new RegExp(`(<stringProp\\s+name="${name.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\$&')}">)([^<]*)(<\\/stringProp>)`);
    if (re.test(block)) return block.replace(re, (_m, a, _v, b) => `${a}${escXmlAttr(value)}${b}`);
    return block;
}
function setBoolProp(block, name, value) {
    const re = new RegExp(`(<boolProp\\s+name="${name.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\$&')}">)([^<]*)(<\\/boolProp>)`);
    if (re.test(block)) return block.replace(re, (_m, a, _v, b) => `${a}${value ? 'true' : 'false'}${b}`);
    return block;
}

/**
 * @returns {{ xml: string, applied: object|null }}  the resolved profile that
 *   was written (or null if no profile keys were given).
 */
/* ─────────────────────────────────────────────────────────────────
 * 5b. Rewire client-minted OAuth vars (state/nonce) that the engine
 *     mis-classified as server-extractable.
 *
 * The engine's correlator sometimes adds a RegexExtractor for `state` or
 * `nonce` (because it sees the same value in multiple requests across
 * the two recordings). But OAuth `state`/`nonce` are CLIENT-MINTED
 * anti-CSRF tokens — there's no response to extract them from, so the
 * extractor never fires, ${state} resolves to "", and /authorize
 * returns 401. Cascading: no auth code → no bearer → every later API
 * call returns 401.
 *
 * The fix is the opposite of extraction: mint a fresh value at the
 * start of each iteration via a JSR223 PreProcessor at ThreadGroup
 * scope, then let Auth0 echo it back (the round-trip works because
 * state/nonce are opaque to the server).
 *
 * Safety: only rewires a refname when ${refname} appears in at least
 * one URL containing `/authorize` (canonical OAuth marker), so we don't
 * accidentally clobber unrelated `state` variables.
 *
 * @returns {{ xml: string, rewired: string[] }}
 * ─────────────────────────────────────────────────────────────────── */
const OAUTH_REWIRE_SENTINEL = 'OAuth state/nonce synthesizer (perfscript-local)';

function rewireClientMintedOauthVars(xml) {
    // Idempotency: if our sentinel PreProcessor is already in the XML,
    // this transform has already run — bail out so we don't double-inject.
    if (xml.includes(OAUTH_REWIRE_SENTINEL)) return { xml, rewired: [] };
    // Only rewire the BARE OAuth2 client-side state/nonce. Suffixed
    // variants (state_2, state_3, …) are almost always Auth0/OIDC
    // universal-login session tokens that the IdP issues server-side
    // and round-trips through the login form — those legitimately
    // require extraction from the prior response. Clobbering them with
    // client-minted random values breaks the IdP session entirely.
    const refnameRe = /^(state|nonce)$/i;
    // The OAuth2 /authorize entry call has a specific query-string
    // shape (scope, response_type, client_id, redirect_uri). Require
    // at least one of those alongside the state var so we don't
    // mistake an unrelated `state` for the OAuth2 one.
    const authorizeUrlRe = /<stringProp name="HTTPSampler\.path">([^<]*\/authorize\?[^<]*(?:client_id|response_type|redirect_uri)[^<]*)<\/stringProp>/g;
    const authorizeUrls = [...xml.matchAll(authorizeUrlRe)].map(m => m[1]);
    const varsUsedInAuthorize = new Set();
    for (const url of authorizeUrls) {
        for (const m of url.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
            if (refnameRe.test(m[1])) varsUsedInAuthorize.add(m[1]);
        }
    }
    if (varsUsedInAuthorize.size === 0) return { xml, rewired: [] };

    const rewired = [];

    // Strip any RegexExtractor whose refname is in our set. They're
    // mis-classified — they extract from an unrelated response and
    // produce empty strings.
    let out = xml.replace(/<RegexExtractor\b[^>]*>[\s\S]*?<\/RegexExtractor>\s*<hashTree\/>\s*/g, (block) => {
        const refMatch = block.match(/<stringProp name="RegexExtractor\.refname">([^<]+)<\/stringProp>/);
        if (!refMatch) return block;
        const refname = refMatch[1];
        if (!varsUsedInAuthorize.has(refname)) return block;
        rewired.push(refname);
        return ''; // strip the dud extractor entirely
    });

    if (rewired.length === 0 && varsUsedInAuthorize.size === 0) {
        return { xml, rewired: [] };
    }

    // Build a single PreProcessor that mints fresh values for all OAuth
    // vars at iteration start. 32-char lowercase hex matches the format
    // browsers/SDKs typically emit (and Auth0 accepts anything opaque).
    const allVars = [...new Set([...varsUsedInAuthorize, ...rewired])];
    const scriptLines = [
        'def rand = new java.security.SecureRandom()',
        'def hex32 = { -> String.format("%032x", new java.math.BigInteger(128, rand)) }',
        ...allVars.map(v => `vars.put("${v}", hex32())`),
    ];
    const script = scriptLines.join('\n');

    const preproc =
        '\n      <JSR223PreProcessor guiclass="TestBeanGUI" testclass="JSR223PreProcessor" ' +
        `testname="${OAUTH_REWIRE_SENTINEL}" enabled="true">\n` +
        '        <stringProp name="cacheKey">true</stringProp>\n' +
        '        <stringProp name="filename"></stringProp>\n' +
        '        <stringProp name="parameters"></stringProp>\n' +
        '        <stringProp name="script">' + escXmlAttr(script) + '</stringProp>\n' +
        '        <stringProp name="scriptLanguage">groovy</stringProp>\n' +
        '      </JSR223PreProcessor>\n' +
        '      <hashTree/>\n';

    // Splice at the top of the first ThreadGroup's hashTree, so the
    // PreProcessor runs once per iteration BEFORE any HTTP sampler.
    const tgMatch = out.match(/<ThreadGroup\b[\s\S]*?<\/ThreadGroup>\s*<hashTree>/);
    if (!tgMatch) return { xml: out, rewired }; // no ThreadGroup, nothing to splice
    const insertAt = tgMatch.index + tgMatch[0].length;
    out = out.slice(0, insertAt) + preproc + out.slice(insertAt);

    return { xml: out, rewired: allVars };
}

function applyLoadProfile(xml, profile = {}) {
    const users     = Number.isFinite(+profile.users)     ? Math.max(1, parseInt(profile.users, 10))     : null;
    const rampUpSec = Number.isFinite(+profile.rampUpSec) ? Math.max(0, parseInt(profile.rampUpSec, 10)) : null;
    const holdSec   = Number.isFinite(+profile.holdSec)   ? Math.max(0, parseInt(profile.holdSec, 10))   : null;
    const loops     = Number.isFinite(+profile.loops)     ? Math.max(1, parseInt(profile.loops, 10))     : null;
    if (users == null && rampUpSec == null && holdSec == null && loops == null) {
        return { xml, applied: null };
    }
    // Apply to EVERY ThreadGroup, not just the first — real plans can have
    // multiple (or setUp) Thread Groups, and profiling only the first silently
    // understates the intended load.
    const editBlock = (block) => {
        if (users     != null) block = setStringProp(block, 'ThreadGroup.num_threads', String(users));
        if (rampUpSec != null) block = setStringProp(block, 'ThreadGroup.ramp_time',   String(rampUpSec));
        if (holdSec != null && holdSec > 0) {
            block = setBoolProp(block, 'ThreadGroup.scheduler', true);
            block = setStringProp(block, 'ThreadGroup.duration', String(holdSec));
            // Force infinite loops when a duration is set; finite loops + scheduler
            // is a footgun (whichever finishes first wins, almost never what's
            // intended for a load test).
            block = setStringProp(block, 'LoopController.loops', '-1');
            block = setBoolProp(block, 'LoopController.continue_forever', true);
        } else if (loops != null) {
            block = setStringProp(block, 'LoopController.loops', String(loops));
            block = setBoolProp(block, 'ThreadGroup.scheduler', false);
        }
        return block;
    };
    let count = 0;
    const out = xml.replace(new RegExp(THREAD_GROUP_BLOCK_RE.source, 'g'), (blk) => { count++; return editBlock(blk); });
    if (!count) return { xml, applied: null };
    return {
        xml: out,
        applied: {
            users: users ?? undefined,
            rampUpSec: rampUpSec ?? undefined,
            holdSec: (holdSec != null && holdSec > 0) ? holdSec : undefined,
            loops: (holdSec != null && holdSec > 0) ? undefined : (loops ?? undefined),
            threadGroups: count,
        },
    };
}

/* ─────────────────────────────────────────────────────────────────
 * 6. Run-mode listener swap (kill GUI listeners, write JTL only)
 * ───────────────────────────────────────────────────────────────── */

/**
 * Disable every ResultCollector and append a single SimpleDataWriter writing
 * to `jtlPath`. Lets the actual run go fast (no GUI components) while keeping
 * the listeners intact for human review when the JMX is later opened in GUI
 * mode (set enabled=true again).
 *
 * @returns {{ xml: string, disabled: number, writerJtlPath: string }}
 */
/**
 * Disable (comment-out equivalent) samplers whose domain+path matches any of
 * `patterns`. Used to drop un-replayable IdP plumbing (auth0 /authorize/resume,
 * /interceptor/, jwt create-cookie) that should be auto-followed via redirects
 * rather than replayed with stale single-use tokens. Sets enabled="false" so
 * the sampler stays in the JMX for review (re-enable in GUI), JMeter just skips it.
 *
 * @returns {{ xml, disabled, hits: string[] }}
 */
function disableSamplersByPattern(xml, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) return { xml, disabled: 0, hits: [] };
    let disabled = 0; const hits = [];
    const out = xml.replace(/<HTTPSamplerProxy\b([^>]*)>([\s\S]*?)<\/HTTPSamplerProxy>/g, (m, attrs, inner) => {
        const path = (inner.match(/<stringProp name="HTTPSampler\.path">([^<]*)</) || [])[1] || '';
        const domain = (inner.match(/<stringProp name="HTTPSampler\.domain">([^<]*)</) || [])[1] || '';
        const name = (attrs.match(/testname="([^"]*)"/) || [])[1] || '';
        const hay = `${domain}${path} ${name}`;
        if (patterns.some(p => hay.includes(p)) && /enabled="true"/.test(attrs)) {
            disabled++; hits.push((name || path).slice(0, 60));
            return `<HTTPSamplerProxy${attrs.replace('enabled="true"', 'enabled="false"')}>${inner}</HTTPSamplerProxy>`;
        }
        return m;
    });
    return { xml: out, disabled, hits };
}

function stripGuiListenersForRun(xml, jtlPath) {
    let disabled = 0;
    const out = xml.replace(/<ResultCollector\b([^>]*?)enabled="true"([^>]*)>/g, (_m, a, b) => {
        disabled++;
        return `<ResultCollector${a}enabled="false"${b}>`;
    });
    const writer = `
      <ResultCollector guiclass="SimpleDataWriter" testclass="ResultCollector" testname="JTL (perfscript-local)" enabled="true">
        <boolProp name="ResultCollector.error_logging">false</boolProp>
        <objProp>
          <name>saveConfig</name>
          <value class="SampleSaveConfiguration">
            <time>true</time><latency>true</latency><timestamp>true</timestamp><success>true</success>
            <label>true</label><code>true</code><message>true</message><threadName>true</threadName>
            <dataType>true</dataType><encoding>false</encoding><assertions>true</assertions>
            <subresults>true</subresults><responseData>false</responseData><samplerData>false</samplerData>
            <xml>true</xml><fieldNames>true</fieldNames><responseHeaders>false</responseHeaders>
            <requestHeaders>false</requestHeaders><responseDataOnError>false</responseDataOnError>
            <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>
            <assertionsResultsToSave>0</assertionsResultsToSave><bytes>true</bytes><sentBytes>true</sentBytes>
            <url>true</url><threadCounts>true</threadCounts><idleTime>true</idleTime><connectTime>true</connectTime>
          </value>
        </objProp>
        <stringProp name="filename">${escXmlAttr(jtlPath)}</stringProp>
      </ResultCollector>
      <hashTree/>`;
    // Place inside the TestPlan's top-level hashTree (last child).
    const idx = out.lastIndexOf('</hashTree>\n  </hashTree>');
    const writerInsert = idx > 0
        ? out.substring(0, idx) + writer + '\n        ' + out.substring(idx)
        : out + writer;
    return { xml: writerInsert, disabled, writerJtlPath: jtlPath };
}

module.exports = {
    disableSamplersByPattern,
    wrapPollingInWhileController,
    injectGhostSynthesizers,
    rewireClientMintedOauthVars,
    injectAssertionsFromMined,
    injectGaussianTimers,
    applyLoadProfile,
    stripGuiListenersForRun,
    _internal: { indexSamplers, findHashTreeEnd, escXmlAttr, computePageTimings, generatorForKind, setStringProp, setBoolProp },
};
