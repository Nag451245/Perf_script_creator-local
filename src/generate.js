'use strict';
/**
 * generate.js — the local app's own HAR→JMX generation.
 *
 * Mirrors the engine's generateCorrelatedJmx (filter → correlate → relevance
 * → placement → group → buildPlanFromHar → render → validate → repair →
 * UDV-inject) but adds PARAMETERIZATION: discover user-input fields, synthesize
 * a unique-per-row data pool, and wire a CSV Data Set so the script actually
 * USES that data (state-pollution defense — blueprint #1). The orchestrator
 * hardcodes empty parameterizations and can't be changed without touching the
 * current app, so we orchestrate the same reused sub-modules here.
 */
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const FilterEngine = E.req('src/modules/filter');
const CorrelationEngine = E.req('src/modules/correlation');
const placementFixer = E.req('src/modules/correlation-placement-fixer');
const { buildPlanFromHar } = E.req('src/modules/test-plan-ir');
const { getRenderer, DEFAULT_RENDERER_ID } = E.req('src/modules/renderers');
const dryRunValidator = E.req('src/modules/jmx-dry-run-validator');
const jmxAutoRepair = E.req('src/modules/jmx-auto-repair');
const udvInjector = E.req('src/modules/udv-injector');
const { filterForGeneration } = E.req('src/modules/correlation-relevance');
const { suggestParameterizations } = E.paramAdvisor;
const { synthesizeCsv } = E.dataSynth;
const { detectClientSideDynamic } = E.clientSide;
const { knownDefinedVars, planExtractor, injectAfterSampler } = require('./extractors');
const { correlateBodyDynamics } = require('./auto-correlate');
const { propagateGraphqlCsrfTokens } = require('./graphql-auth-repair');
const { rewriteHost } = require('./host-rewrite');
const { sanitizeJavaUnsafeJmx } = require('./java-safe');
const volatileProtocol = require('./volatile-protocol');
const pkce = require('./pkce');
const seniorPe = require('./senior-pe');
const playbooks = require('./playbooks');
const scenario = require('./scenario');
const outcomeProbe = require('./outcome-probe');
const redirectHops = require('./redirect-hops');
const foldSafetyModule = require('./fold-safety');
const renderedRequestCheck = require('./rendered-request-check');
const dateIntent = require('./date-intent');
const jsChallengeToken = require('./js-challenge-token');
const uploadFiles = require('./upload-files');
const valueFlowDecisions = require('./value-flow-decisions');
const peNaming = require('./pe-naming');
const {
    wrapPollingInWhileController,
    injectGhostSynthesizers,
    injectAssertionsFromMined,
    injectGaussianTimers,
    applyLoadProfile,
    disableSamplersByPattern,
    repairAuth0LoginStateExtractors,
    correlateFormHiddenInputs,
    repairDeadExtractorConsumers,
    rewireClientMintedOauthVars,
} = require('./transforms');

// Elastic polling (blueprint #3): a run of >=3 consecutive requests to the same
// method+path (query stripped, so cache-busted poll URLs still match) is a
// poll loop. The engine can't yet EMIT a While Controller (no renderer support,
// and adding it would touch the current app), so we detect + report with a
// termination hint for the user to wrap manually.
/**
 * Disambiguate correlation variable-name collisions. Real flows reuse the same
 * param NAME for many DIFFERENT values — e.g. an auth0 login has `state` 7×
 * (multiple login attempts + OAuth vs login state), `nonce` 3×, `id` 9×. The
 * generator can only bind one variable per name, so without this it wires one
 * occurrence and leaves the other six values HARDCODED — which breaks the auth
 * chain (stale state/nonce ⇒ 401). Here each DISTINCT value keeps a unique
 * variable name (state, state_2, state_3, …); identical values that legitimately
 * share a name are left merged. Mutates `corrs` in place.
 */
function uniquifyVariableNames(corrs) {
    const used = new Set();
    const byNameValue = new Map(); // `${base}${value}` -> assigned unique name
    for (const c of corrs || []) {
        const base = c.variableName || c.name || 'var';
        const value = String(c.value == null ? '' : c.value);
        const key = `${base}${value}`;
        let name = byNameValue.get(key);
        if (!name) {
            name = base;
            if (used.has(name)) {
                let i = 2;
                while (used.has(`${base}_${i}`)) i++;
                name = `${base}_${i}`;
            }
            used.add(name);
            byNameValue.set(key, name);
        }
        c.variableName = name;
        if ('name' in c) c.name = name;
    }
    return corrs;
}

/**
 * Enforce correlation substitution EVERYWHERE. The engine wires a value at its
 * one registered target; when the same value recurs across many requests (an
 * auth0 login state threaded through identifier→password→resume), the other
 * occurrences stay hardcoded ⇒ stale ⇒ 401. Replace every remaining recorded
 * literal with its ${var} inside request + header blocks only (never inside
 * extractors/listeners). Unique names (uniquifyVariableNames) keep it
 * collision-free; high-entropy values (len ≥ 8) avoid clobbering short tokens.
 */
function enforceSubstitutions(xml, corrs) {
    let count = 0;
    // Longest value first so a token that CONTAINS another correlated token is
    // rewritten before its substring can shred it; substitution is scoped to
    // stringProp text nodes so testname attributes and tag structure inside a
    // sampler/header block are never rewritten.
    const subs = (corrs || [])
        .map(c => ({
            value: String(c.value == null ? '' : c.value),
            ref: '${' + (c.variableName || c.name) + '}',
        }))
        .filter(s => s.value.length >= 8)
        .sort((a, b) => b.value.length - a.value.length);
    const apply = (block) => block.replace(
        /(<stringProp\b[^>]*>)([^<]*)(<\/stringProp>)/g,
        (_m, open, content, close) => {
            let c = content;
            for (const s of subs) {
                if (c.includes(s.value)) { c = c.split(s.value).join(s.ref); count++; }
            }
            return open + c + close;
        }
    );
    const out = xml
        .replace(/<HTTPSamplerProxy[\s\S]*?<\/HTTPSamplerProxy>/g, apply)
        .replace(/<HeaderManager[\s\S]*?<\/HeaderManager>/g, apply);
    return { xml: out, count };
}

function repairStaticOauthConstants(xml) {
    const before = xml;
    const out = xml.replace(/\$\{response_type\}/g, 'code');
    return { xml: out, repaired: before !== out ? 1 : 0 };
}

function applyForcedNativeManagers(xml, force = {}) {
    const requested = ['cookie', 'cache', 'authorization', 'redirects'].filter(k => force && force[k]);
    const result = {
        xml,
        applied: [],
        inserted: [],
        existing: [],
        cookieHeadersRemoved: 0,
        redirectSamplersUpdated: 0,
    };
    if (!requested.length) return result;

    const missingBlocks = [];
    for (const key of ['cookie', 'cache', 'authorization']) {
        if (!requested.includes(key)) continue;
        result.applied.push(key);
        if (nativeManagerExists(result.xml, key)) {
            result.existing.push(key);
        } else {
            missingBlocks.push(nativeManagerBlock(key));
            result.inserted.push(key);
        }
    }
    if (missingBlocks.length) {
        result.xml = insertNativeManagerBlocks(result.xml, missingBlocks.join(''));
    }
    if (requested.includes('cookie')) {
        const stripped = removeCookieHeaders(result.xml);
        result.xml = stripped.xml;
        result.cookieHeadersRemoved = stripped.count;
    }
    if (requested.includes('redirects')) {
        result.applied.push('redirects');
        const redirects = forceFollowRedirects(result.xml);
        result.xml = redirects.xml;
        result.redirectSamplersUpdated = redirects.updated;
    }
    return result;
}

function nativeManagerExists(xml, key) {
    const tag = key === 'authorization' ? 'AuthManager' : key === 'cache' ? 'CacheManager' : 'CookieManager';
    return new RegExp(`<${tag}\\b`).test(xml);
}

function nativeManagerBlock(key) {
    if (key === 'cookie') {
        return `
        <CookieManager guiclass="CookiePanel" testclass="CookieManager" testname="HTTP Cookie Manager" enabled="true">
          <collectionProp name="CookieManager.cookies"/>
          <boolProp name="CookieManager.clearEachIteration">true</boolProp>
          <boolProp name="CookieManager.controlledByThreadGroup">false</boolProp>
        </CookieManager>
        <hashTree/>
`;
    }
    if (key === 'cache') {
        return `
        <CacheManager guiclass="CacheManagerGui" testclass="CacheManager" testname="HTTP Cache Manager" enabled="true">
          <boolProp name="clearEachIteration">true</boolProp>
          <boolProp name="useExpires">true</boolProp>
          <intProp name="maxSize">5000</intProp>
          <boolProp name="CacheManager.controlledByThread">false</boolProp>
        </CacheManager>
        <hashTree/>
`;
    }
    return `
        <AuthManager guiclass="AuthPanel" testclass="AuthManager" testname="HTTP Authorization Manager" enabled="true">
          <collectionProp name="AuthManager.auth_list"/>
        </AuthManager>
        <hashTree/>
`;
}

function insertNativeManagerBlocks(xml, blocks) {
    const threadGroupTree = /(<ThreadGroup\b[\s\S]*?<\/ThreadGroup>\s*<hashTree>)/;
    if (threadGroupTree.test(xml)) return xml.replace(threadGroupTree, `$1${blocks}`);
    const testPlanTree = /(<TestPlan\b[\s\S]*?<\/TestPlan>\s*<hashTree>)/;
    if (testPlanTree.test(xml)) return xml.replace(testPlanTree, `$1${blocks}`);
    return xml;
}

function removeCookieHeaders(xml) {
    let count = 0;
    const out = xml.replace(/<elementProp\b(?=[^>]*elementType="Header")[\s\S]*?<\/elementProp>/g, block => {
        if (!/<stringProp name="Header\.name">\s*Cookie\s*<\/stringProp>/i.test(block)) return block;
        count++;
        return '';
    });
    return { xml: out, count };
}

function forceFollowRedirects(xml) {
    let updated = 0;
    const out = xml.replace(/<HTTPSamplerProxy\b[\s\S]*?<\/HTTPSamplerProxy>/g, block => {
        const next = setSamplerBoolProp(
            setSamplerBoolProp(block, 'HTTPSampler.follow_redirects', true),
            'HTTPSampler.auto_redirects',
            false,
        );
        if (next !== block) updated++;
        return next;
    });
    return { xml: out, updated };
}

function setSamplerBoolProp(block, name, value) {
    const re = new RegExp(`<boolProp name="${escapeRegExp(name)}">(?:true|false)<\\/boolProp>`);
    const prop = `<boolProp name="${name}">${value ? 'true' : 'false'}</boolProp>`;
    if (re.test(block)) return block.replace(re, prop);
    return block.replace('</HTTPSamplerProxy>', `          ${prop}\n        </HTTPSamplerProxy>`);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Body fingerprint used by `detectPolling` to distinguish *real* polling
 * (same URL + same body, repeated) from *different work on the same endpoint*
 * (POST /graphql with a different operation each time). Without this, every
 * GraphQL-heavy app gets dozens of unrelated mutations wrapped in a single
 * While Controller and the test runs the same query N times.
 */
// Cache-buster / anti-cache query params that vary between otherwise-identical
// poll requests and must be ignored when deciding "same resource".
const CACHE_BUSTER_PARAM = /^(_|cb|t|ts|timestamp|rnd|rand|random|nocache|_dc|v|_ts|ms|time|__)$/i;
function canonicalPollQuery(searchParams) {
    const pairs = [];
    for (const [k, v] of searchParams) {
        if (CACHE_BUSTER_PARAM.test(k)) continue;
        pairs.push(`${k}=${v}`);
    }
    return pairs.sort().join('&');
}

function bodyFingerprint(e) {
    const method = (e.request?.method || 'GET').toUpperCase();
    if (!/^(POST|PUT|PATCH)$/.test(method)) return '';
    const body = (e.request?.postData?.text || '').trim();
    if (!body) return '';
    if (body.startsWith('{') || body.startsWith('[')) {
        try {
            const j = JSON.parse(body);
            if (j && typeof j === 'object' && (j.query || j.mutation)) {
                if (j.operationName) return `gql:${j.operationName}`;
                const q = String(j.query || j.mutation || '').replace(/\s+/g, ' ').slice(0, 80);
                return `gql:${q}`;
            }
            if (j && typeof j === 'object' && !Array.isArray(j)) {
                return `json:${Object.keys(j).sort().join(',')}`;
            }
        } catch { /* fall through */ }
    }
    return `raw:${body.replace(/\s+/g, ' ').slice(0, 80)}`;
}

function detectPolling(flat) {
    const keyOf = (e) => {
        let p = e.request?.url || '';
        let q = '';
        try {
            const u = new URL(e.request.url);
            p = u.pathname;
            q = canonicalPollQuery(u.searchParams);
        } catch { /* keep raw */ }
        const method = (e.request?.method || 'GET').toUpperCase();
        const fp = bodyFingerprint(e);
        // Include the canonical query (cache-busters stripped): a real status
        // poll hits the SAME resource repeatedly, differing at most by a
        // cache-buster. Consecutive requests to the same PATH but with
        // DIFFERENT substantive query params are DIFFERENT resources (e.g. six
        // /rdChart2.aspx?chartId=055..060 report charts) — NOT a poll, and must
        // not be wrapped in a While loop that would replay only the first.
        return `${method} ${p}${q ? '?' + q : ''}${fp ? ' :: ' + fp : ''}`;
    };
    const keys = flat.map(keyOf);
    const groups = [];
    let i = 0;
    while (i < keys.length) {
        let j = i;
        while (j + 1 < keys.length && keys[j + 1] === keys[i]) j++;
        const count = j - i + 1;
        if (count >= 3) {
            groups.push({
                endpoint: keys[i], count, startOrder: i,
                hint: 'Wrapped in a While Controller with a per-loop counter cap; refine the condition to exit on response state when known.',
            });
        }
        i = j > i ? j + 1 : i + 1;
    }
    return groups;
}

const NOISE_SESSION_COOKIE_RE = /(?:sess|session|csrf|xsrf|auth|iam|idem|sso|jwt|phpsessid|token)/i;
const BEACON_KEEP_PATH_RE = /(?:login|logon|auth|oauth|oidc|saml|sso|callback|token|session|authorize|verify|redirect|iam|jwt|logout|saveSOAP|save|create|update|submit|checkout|order|payment|patientChart)/i;
/**
 * Evidence-based noise detection from the RECORDING (not a path prior). A
 * fire-and-forget telemetry/analytics beacon (RUM, domain-reliability, page-view
 * reporting like /enterprise/url/report) repeats the same endpoint MANY times,
 * every recorded response is 2xx, none mints a session cookie, and — critically
 * — it PRODUCES NOTHING the flow consumes (no sampler for it owns an extractor).
 * That last fact makes folding it provably correlation-safe: there is no value
 * to break. A one-off business request never repeats like that, and an auth /
 * session / business-action path is kept regardless.
 * @param {Array} flat recording entries
 * @param {Object} opts { producerPaths:Set<string>, minRepeats, keepPathRe }
 */
function detectRecordedNoiseBeacons(flat, opts = {}) {
    const minRepeats = Number(opts.minRepeats) > 0 ? Number(opts.minRepeats) : 5;
    const producerPaths = opts.producerPaths instanceof Set ? opts.producerPaths : new Set();
    const keepRe = opts.keepPathRe instanceof RegExp ? opts.keepPathRe : BEACON_KEEP_PATH_RE;
    const byKey = new Map();
    for (const e of flat || []) {
        const req = e && e.request; const resp = e && e.response;
        if (!req || !resp) continue;
        const method = String(req.method || 'GET').toUpperCase();
        let path = '';
        try { path = new URL(req.url).pathname; } catch { path = String(req.url || '').split('?')[0]; }
        if (!path) continue;
        const key = `${method} ${path}`;
        const status = Number(resp.status || 0);
        const setsCookie = (resp.headers || []).some(h =>
            /^set-cookie$/i.test(String(h.name || '')) && NOISE_SESSION_COOKIE_RE.test(String((h.value || '').split('=')[0])));
        const g = byKey.get(key) || { count: 0, all2xx: true, anyCookie: false, path };
        g.count++;
        if (status < 200 || status >= 300) g.all2xx = false;
        if (setsCookie) g.anyCookie = true;
        byKey.set(key, g);
    }
    const beacons = [];
    for (const g of byKey.values()) {
        if (g.count < minRepeats || !g.all2xx || g.anyCookie) continue;
        if (keepRe.test(g.path)) continue;         // never fold auth/session/business-action paths
        if (producerPaths.has(g.path)) continue;    // never fold a correlation producer
        beacons.push({ path: g.path, count: g.count });
    }
    return beacons;
}

/** Paths of samplers that own an extractor (produce a correlated value). */
function extractorProducerPaths(xml) {
    const set = new Set();
    const re = /<HTTPSamplerProxy\b[^>]*>([\s\S]*?)<\/HTTPSamplerProxy>\s*<hashTree>([\s\S]*?)<\/hashTree>/g;
    let m;
    while ((m = re.exec(xml || '')) !== null) {
        if (!/Extractor|PostProcessor/.test(m[2])) continue;
        const path = (m[1].match(/<stringProp name="HTTPSampler\.path">([^<]*)</) || [])[1] || '';
        let p = path; try { p = new URL(path, 'http://x').pathname; } catch { p = String(path).split('?')[0]; }
        if (p) set.add(p);
    }
    return set;
}

// App-agnostic noise only: browser telemetry every Chrome recording picks up,
// plus standard OIDC single-use plumbing (/authorize/resume, /oauth/token) and
// logout, which are auto-followed redirect hops that never replay. Anything
// tied to ONE app or ONE recording (step-numbered samplers, vendor callback
// paths like /iam/callback or /s/interceptor) belongs in run.disableCalls in
// perfscript.config.json — a default here would silently disable business
// samplers on every other app.
const DEFAULT_DISABLE_PATTERNS = [
    'ohttp_gateway',
    'ohttp-relay-safebrowsing-chrome',
    'OHTTP_RELAY_SAFEBROWSING_CHROME_SERVER',
    'domainreliability',
    'gstatic.com',
    'beacons',
    // Google device/push plumbing every Chrome/Android capture picks up — the
    // sampler cannot even build a valid request (IllegalArgumentException).
    'android.clients.google.com',
    '/c2dm/',
    '/authorize/resume',
    '/oauth/token',
    '/logout',
    '/v2/logout',
];

const AUTH_SESSION_DISABLE_PROTECT_RE = /\/(?:u\/login(?:\/|\?|$)|user\/login(?:\/|\?|$)|authorization(?:\/|\?|$)|user\/iam\/save(?:\/|\?|$)|jwt\/v2\/create-cookie(?:\/|\?|$)|iam\/callback(?:\/|\?|$))/i;
const JWT_CREATE_COOKIE_RE = /\/jwt\/v2\/create-cookie(?:\/|\?|$)/i;
const AUTH_HOST_RE = /(?:^|[.-])(?:login|logon|auth|sso|idp|iam|oauth|oidc|saml|identity|account|okta|ping|keycloak|adfs|cognito|auth0|onelogin|forgerock)(?:[.-]|$)|microsoftonline|accounts\.google|my\.salesforce|stage|stg/i;
const SAFE_DISABLE_NOISE_RE = /ohttp|safebrowsing|domainreliability|beacon|gstatic|launchdarkly|\/sdk\/evalx|\/avatar\/|\/_next\/data\//i;
const MUTATING_METHOD_RE = /^(POST|PUT|PATCH|DELETE)$/i;
const INTERCEPTOR_ROOT_RE = /\/s\/interceptor\/?(?:\?|$)/i;

// A parameter value that is short or a common boolean/enum token cannot be
// substituted into the JMX safely: the engine replaces the recorded literal
// wherever it appears, so a 2-char value like "on" (a checkbox default) shreds
// unrelated text — "application/json" -> "applicati${x}/js${x}", the username
// "AshtonK" -> "Asht${x}K", the path "authenticate.json" -> "authenticate.js${x}".
// Such fields are constants, not per-user data, so dropping them from
// parameterization loses nothing and prevents catastrophic corruption. An
// operator can still force one back via run.parameterization.includeNames.
const BOOLEAN_ENUM_VALUE_RE = /^(on|off|true|false|yes|no|nil|null|none|checked|unchecked|enabled|disabled|undefined)$/i;
function isUnsafeParameterValue(value) {
    const v = String(value == null ? '' : value).trim();
    if (v.length < 4) return true;               // too short -> matches as a substring everywhere
    if (BOOLEAN_ENUM_VALUE_RE.test(v)) return true; // boolean/checkbox/enum constant
    if (/^\d{1,3}$/.test(v)) return true;         // "0".."999": ambiguous + low load value
    return false;
}
function candidateHasUnsafeValue(c) {
    const vals = Array.isArray(c.distinctValues) && c.distinctValues.length ? c.distinctValues : [c.value];
    return vals.some(isUnsafeParameterValue);
}

// Post-render corruption detector. A safely-substituted parameter replaces the
// COMPLETE value of its own field, so its ${var} appears about as often as the
// field occurs (a handful of times). A value substituted as a SUBSTRING
// explodes far past that — the shredding signature. When a token appears grossly
// more than the field's recorded occurrence count (or, absent that count, a
// short value appears many times), restore the recorded literal everywhere:
// replacing ${var} back with the value exactly reverses the global substitution.
function detectAndRevertParameterCorruption(xml, params) {
    let out = String(xml || '');
    const reverted = [];
    for (const p of params || []) {
        const name = p.variableName || p.name;
        const value = String(p.value == null ? '' : p.value);
        if (!name || !value) continue;
        const ref = '${' + name + '}';
        const refCount = out.split(ref).length - 1;
        if (refCount === 0) continue;
        const expected = Number(p.occurrences) || null;
        const suspicious = expected != null
            ? refCount > Math.max(expected * 3, expected + 6)
            : (value.length < 6 && refCount > 8);
        if (!suspicious) continue;
        out = out.split(ref).join(value);
        reverted.push({ name, value, refCount, expected });
    }
    return { xml: out, reverted };
}

function filterParameterCandidates(candidates, policy = {}) {
    const include = toLowerList(policy.includeNames);
    const exclude = toLowerList(policy.excludeNames);
    return (candidates || []).filter(c => {
        if (isGraphqlOperationDocument(c)) return false;
        const name = String(c.name || '').toLowerCase();
        const forced = include.length > 0 && include.some(term => name.includes(term));
        if (include.length && !forced) return false;
        if (exclude.length && exclude.some(term => name.includes(term))) return false;
        // Value safety: never parameterize a value too short/common to substitute
        // without shredding unrelated text. An explicit include list overrides.
        if (!forced && candidateHasUnsafeValue(c)) return false;
        return true;
    });
}

function toLowerList(values) {
    return Array.isArray(values) ? values.map(v => String(v || '').toLowerCase()).filter(Boolean) : [];
}

function isGraphqlOperationDocument(candidate) {
    if (!candidate) return false;
    if (String(candidate.name || '').toLowerCase() !== 'query') return false;
    const value = String(candidate.value || '').trim();
    return /^(query|mutation|subscription)\b/i.test(value) && /[{]/.test(value);
}

function shouldRepeatRecordedCredential(candidate, policy = {}) {
    if (!candidate || policy.uniqueCredentials === true) return false;
    const name = String(candidate.name || '').toLowerCase();
    const path = String(candidate.urlPath || candidate.path || '').toLowerCase();
    if (/^(password|passwd|pwd)$/.test(name)) return true;
    if (/^(user(name)?|login|email)$/.test(name) && /login|auth|iam|sso|identifier|password/.test(path)) return true;
    return false;
}

function valuesForParameterCandidate(candidate, rows, policy = {}) {
    if (shouldRepeatRecordedCredential(candidate, policy)) {
        return Array.from({ length: rows }, () => candidate.value);
    }
    return E.dataSynth.synthesizeValues(candidate.name, candidate.value, rows);
}

/**
 * Map a rendered sampler back to its flat-entry index. Sampler testnames carry
 * the recorded step number (…-NNN or "Step NN - …"); fall back to method+path.
 */
function flatIndexForSampler(flat, sampler) {
    const step = Number((String(sampler.name || '').match(/(?:Step\s+0*(\d+)\b|-(\d+)$)/) || [])
        .slice(1).find(Boolean));
    if (Number.isFinite(step) && step >= 1 && flat[step - 1]) return step - 1;
    const method = String(sampler.method || '').toUpperCase();
    const path = String(sampler.path || '').split('?')[0];
    for (let i = 0; i < flat.length; i++) {
        const e = flat[i];
        let ep = '';
        try { ep = new URL(e.request.url).pathname; } catch { /* skip */ }
        if (ep === path && (!method || String(e.request.method || 'GET').toUpperCase() === method)) return i;
    }
    return -1;
}

/** Sampler order → {name, path, position, openEnd} map built from the XML. */
function indexSamplersForGenerate(xml) {
    const out = [];
    const re = /<HTTPSamplerProxy\b([^>]*)>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const attrs = m[1] || '';
        const openEnd = m.index + m[0].length;
        const tail = xml.slice(openEnd, xml.indexOf('</HTTPSamplerProxy>', openEnd));
        out.push({
            order: out.length,
            position: m.index,
            openEnd,
            name: (attrs.match(/testname="([^"]*)"/) || [])[1] || '',
            path: (tail.match(/<stringProp name="HTTPSampler\.path">([^<]*)</) || [])[1] || '',
            enabled: !/enabled="false"/.test(attrs),
        });
    }
    return out;
}

/** Flip one sampler's enabled attribute at its exact document position. */
function flipEnabledAtPosition(xml, sampler) {
    if (!sampler || !sampler.enabled) return { xml, changed: false };
    const openTag = xml.slice(sampler.position, sampler.openEnd);
    const nextTag = openTag.replace('enabled="true"', 'enabled="false"');
    if (nextTag === openTag) return { xml, changed: false };
    return { xml: xml.slice(0, sampler.position) + nextTag + xml.slice(sampler.openEnd), changed: true };
}

function shouldProtectDisableTarget(sampler = {}, runCfg = {}, valueFlow = null) {
    if (runCfg.allowUnsafeDisableProtected === true) return false;
    const hay = `${sampler.name || ''} ${sampler.domain || ''}${sampler.path || ''}`;
    if (SAFE_DISABLE_NOISE_RE.test(hay)) return false;
    if (matchesConfiguredPattern(hay, runCfg.protectedCalls)) return true;
    const flow = valueFlowForSampler(sampler, valueFlow);
    if (flow && flow.consumedOutputCount > 0) return true;
    if (JWT_CREATE_COOKIE_RE.test(sampler.path || '') && matchesConfiguredPattern(hay, runCfg.disableCalls)) return false;
    if (AUTH_SESSION_DISABLE_PROTECT_RE.test(sampler.path || '')) return true;
    if (MUTATING_METHOD_RE.test(sampler.method || methodFromSamplerName(sampler.name)) && /^\/?$/.test(String(sampler.path || '/'))) return true;
    if (MUTATING_METHOD_RE.test(sampler.method || methodFromSamplerName(sampler.name)) && AUTH_HOST_RE.test(sampler.domain || '')) return true;
    if (/GraphQL mutation/i.test(sampler.name || '') && /(login|authenticate|verify|token|session)/i.test(hay)) return true;
    return false;
}

function isHardProtectedDisableTarget(sampler = {}, runCfg = {}, valueFlow = null) {
    if (runCfg.allowUnsafeDisableProtected === true) return false;
    const method = String(sampler.method || methodFromSamplerName(sampler.name)).toUpperCase();
    const path = String(sampler.path || '');
    if (!INTERCEPTOR_ROOT_RE.test(path) || method !== 'POST') return false;
    const flow = valueFlowForSampler(sampler, valueFlow);
    return !!(flow && flow.consumedOutputCount > 0) || hasTokenParameter(sampler.body);
}

function hasTokenParameter(body = '') {
    return /<stringProp name="Argument\.name">token<\/stringProp>/i.test(String(body || '')) ||
        /<elementProp name="token"\b/i.test(String(body || ''));
}

function matchesConfiguredPattern(hay, patterns) {
    return Array.isArray(patterns) && patterns.some(p => p && String(hay || '').includes(String(p)));
}

function valueFlowForSampler(sampler, valueFlow) {
    if (!sampler || !valueFlow || !valueFlow.bySampler) return null;
    return valueFlow.bySampler[sampler.name] || null;
}

function methodFromSamplerName(name) {
    const match = /\b(GET|POST|PUT|PATCH|DELETE)\b/i.exec(String(name || ''));
    return match ? match[1].toUpperCase() : '';
}

function filterBareOauthStateNonceCorrelations(corrs, entries) {
    return volatileProtocol.filterVolatileProtocolCorrelations(corrs, entries);
}

function observedVolatileAuthProtocolNames(entries) {
    return volatileProtocol.observedVolatileProtocolNames(entries);
}

function generate(entriesRaw, pages, outDir, name, opts = {}) {
    const { dataRows = 10, dualHarHints = {} } = opts;
    let runCfg = opts.runCfg || {};
    fs.mkdirSync(outDir, { recursive: true });
    const reasoning = [];
    const note = (phase, hypothesis, evidence, action) =>
        reasoning.push({ phase, hypothesis, evidence, action, at: new Date().toISOString() });

    // Stack playbooks: a senior's priors, selected by recording evidence
    // (fingerprint signals + hosts + paths) BEFORE any decision reads runCfg.
    // Explicit config always wins; playbooks only add disables/notes and fill
    // unset oauth flags.
    const fingerprint = seniorPe._internal.fingerprintStack(entriesRaw);
    const pbResult = playbooks.applyPlaybooks({
        entries: entriesRaw,
        fingerprintSignals: fingerprint.signals || [],
        runCfg,
        dir: opts.playbookDir,
    });
    runCfg = pbResult.runCfg;
    if (pbResult.applied.length) {
        note('playbooks',
            `${pbResult.applied.length} stack playbook(s) matched this recording`,
            pbResult.applied.map(p => `${p.id} (${p.evidence.slice(0, 3).join(', ')})`).join('; '),
            `merged priors: +${pbResult.addedDisables.length} disable pattern(s), notes appended — explicit config keeps precedence`);
    }

    // Scenario design: business objective (run.scenario) → Little's Law math
    // → threads / ramp / pacing / data-pool size. Explicit run.loadProfile
    // still wins; the scenario fills what the operator left unset.
    const scenarioPlan = scenario.designScenario({ entries: entriesRaw, runCfg });
    if (scenarioPlan) {
        if (!runCfg.loadProfile) runCfg = { ...runCfg, loadProfile: scenarioPlan.loadProfile };
        note('scenario',
            `objective: ${scenarioPlan.objective.transactionsPerHour}/hour for ${scenarioPlan.objective.durationMin}min`,
            `recorded session R=${scenarioPlan.sessionSeconds.toFixed(1)}s ⇒ Little's Law threads=${scenarioPlan.threads}, ` +
            `pacing=${scenarioPlan.pacingSeconds ? scenarioPlan.pacingSeconds.toFixed(1) + 's' : 'unpaced'}, ` +
            `data pool=${scenarioPlan.uniqueRows} rows`,
            `derived loadProfile ${runCfg.loadProfile === scenarioPlan.loadProfile ? 'applied' : 'NOT applied (explicit run.loadProfile wins)'} — see _scenario.md for the math`);
    }

    // 1. Filter noise (background auth, static assets, analytics, tunnels).
    //    Operator transaction markers (HAR entry comments — "Login",
    //    "Display_Patients") are boundaries, not requests: when the entry
    //    CARRYING a comment gets filtered as noise, the comment must survive
    //    onto the next kept entry or the transaction grouping loses that step.
    const filter = new FilterEngine();
    const bgAuth = filter.detectBackgroundAuthIndices(entriesRaw);
    const flat = [];
    let pendingComment = '';
    entriesRaw.forEach((e, i) => {
        const u = e.request?.url || '';
        const comment = e && e.comment && String(e.comment).trim();
        const dropped = bgAuth.has(i) ||
            filter.isTunnelRequest(e) || filter.isStaticAsset(u) || filter.isExcludedPath(u) ||
            filter.isAnalyticsDomain(u) || filter.isBrowserNoise(u);
        if (dropped) { if (comment) pendingComment = comment; return; }
        if (pendingComment && !comment) { e.comment = pendingComment; }
        pendingComment = '';
        flat.push(e);
    });

    // 2. Correlate + relevance gate.
    const rawCorrs = new CorrelationEngine().detectCorrelations(flat);
    let { kept: corrs } = filterForGeneration(rawCorrs);
    const oauthStatic = filterBareOauthStateNonceCorrelations(corrs, flat);
    corrs = oauthStatic.kept;
    const volatileNames = new Set([
        ...oauthStatic.removed.map(c => String(c.variableName || c.name || '').toLowerCase()),
        ...observedVolatileAuthProtocolNames(flat),
    ]);
    if (volatileNames.size) note('oauth-volatile-ignore',
        `${volatileNames.size} volatile OAuth/protocol field name(s) identified: ${[...volatileNames].join(', ')}`,
        `state/nonce/code-style values in auth protocol context are single-use or client-minted protocol plumbing`,
        `left them out of correlation planning so deterministic repair and AI do not fight stale protocol values`);
    uniquifyVariableNames(corrs); // disambiguate name collisions (state x7, nonce x3, id x9)
    placementFixer.fix(corrs, flat);

    // 3. Group into PE-readable business transactions while preserving request
    // order and Step NN alignment through the label map.
    const peModel = peNaming.buildPeNamingModel({
        entries: flat,
        pages,
        flowName: name,
        transactionNames: runCfg.transactionNames,
    });
    const groups = peModel.groups;
    fs.writeFileSync(path.join(outDir, `${name}_label_map.json`), JSON.stringify(peNaming.labelMapForArtifact(peModel), null, 2));
    if (peModel.requests.length) note('pe-naming',
        `${peModel.requests.length} request sampler label(s) mapped to ${peModel.scenarioCode}_Txx_* names`,
        `${peModel.groups.length} transaction controller group(s) named as PE deliverables`,
        `original Step NN alignment preserved in ${name}_label_map.json`);

    // Ghost sources (blueprint #2): client-minted values (UUID/timestamp/trace/
    // cache-buster) with no server origin. The JMeter renderer ALREADY rewrites
    // these inline (guid->${__UUID}, _=->${__time}, …), so this only surfaces
    // them for the report — pass correlated values as server-origin so already-
    // correlated dynamics aren't mislabeled as ghosts.
    const serverOrigin = new Set(corrs.map(c => c.value).filter(Boolean));
    const ghosts = detectClientSideDynamic(flat, serverOrigin) || [];
    if (ghosts.length) fs.writeFileSync(path.join(outDir, `${name}_ghosts.json`), JSON.stringify(ghosts, null, 2));

    // Elastic polling loops (advisory — see detectPolling).
    const polling = detectPolling(flat);
    if (polling.length) fs.writeFileSync(path.join(outDir, `${name}_polling.json`), JSON.stringify(polling, null, 2));

    const uploadPlan = uploadFiles.resolveAndStageUploads({
        entries: flat,
        searchDirs: uploadSearchDirs(opts, runCfg),
        outDir,
    });
    if (uploadPlan.required.length) {
        fs.writeFileSync(path.join(outDir, `${name}_file_uploads.json`), JSON.stringify(uploadPlan, null, 2));
        note('file-uploads',
            `${uploadPlan.required.length} multipart upload file(s) referenced by the recording`,
            uploadPlan.matched.length
                ? `staged ${uploadPlan.matched.map(u => u.fileName).join(', ')} under test_files/`
                : `missing ${uploadPlan.missing.map(u => u.fileName).join(', ')}`,
            uploadPlan.missing.length
                ? `ask the user to place missing file(s) in input/ or bin/ before validation`
                : `mapped JMeter HTTPFileArg paths to staged local files`);
    }
    uploadFiles.applyResolvedUploadsToEntries(flat, uploadPlan);

    // 4. Parameterization + unique data (state-pollution defense). Discover
    //    user-input fields, synthesize a multi-row pool, wire one CSV Data Set.
    const rawCandidates = suggestParameterizations(flat) || [];
    const allCandidates = filterParameterCandidates(rawCandidates, runCfg.parameterization || {});
    // R4 — date fields are made RELATIVE to run time via ${__timeShift}, not
    // shipped as stale CSV literals. Pull them OUT of the CSV parameterization
    // set; they are substituted directly into the samplers after render.
    const dateRef = dateIntent.recordingReference(flat);
    const datePlan = dateIntent.planDateShifts(allCandidates, dateRef, runCfg.dates || {});
    const dateNames = new Set(datePlan.shifts.map(s => s.name));
    // DEDUPE by variable name — the advisor can emit the SAME field name from
    // different pages ("ID" twice, "CaseID" twice). The CSV writer emits one
    // column per candidate but the CSVDataSet deduplicates variableNames, so
    // duplicates SHIFT every later column: ${userName} read a comment field and
    // ${password} read the username — the login silently sent garbage. One
    // name = one variable = one column.
    const seenNames = new Set();
    const candidates = allCandidates.filter(c => {
        if (dateNames.has(c.name)) return false;
        if (seenNames.has(c.name)) return false;
        seenNames.add(c.name);
        return true;
    });
    const skippedParameterCandidates = rawCandidates.length - allCandidates.length;
    if (datePlan.shifts.length) note('date-intent',
        `${datePlan.shifts.length} date field(s) made relative to run time (not hardcoded)`,
        datePlan.shifts.slice(0, 6).map(s => `${s.name}=${s.value} → ${s.offsetDays >= 0 ? '+' : ''}${s.offsetDays}d in ${s.jmeterFormat}`).join('; '),
        `substituted \${__timeShift(...)} so a date-filtered request stays valid whenever the test runs; pin a genuinely FIXED window in run.dates.shift=false`);
    if (datePlan.skippedAmbiguous.length) note('date-intent',
        `${datePlan.skippedAmbiguous.length} ambiguous MM/dd-vs-dd/MM date(s) left as recorded literals`,
        datePlan.skippedAmbiguous.slice(0, 6).join(', '),
        `could not prove the format from the value alone — review if these should be relative`);
    if (skippedParameterCandidates > 0) {
        note('parameterization',
            `${skippedParameterCandidates} structural GraphQL document field(s) skipped`,
            `GraphQL query/mutation text is application code, not runtime test data`,
            `kept variables/data values parameterizable, left operation document static`);
    }
    let params = [];
    let csvFile = null;
    if (candidates.length) {
        csvFile = `${name}_data.csv`;
        const delimiter = '|';
        const escape = (val) => {
            const s = String(val == null ? '' : val);
            const rx = new RegExp(`[\\"${delimiter}\\n\\r]`);
            return rx.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const rows = Math.max(dataRows, (scenarioPlan && scenarioPlan.uniqueRows) || 0);
        const columns = candidates.map(c => ({
            name: c.name,
            values: valuesForParameterCandidate(c, rows, runCfg.parameterization || {}),
        }));
        const lines = [columns.map(c => escape(c.name)).join(delimiter)];
        for (let r = 0; r < rows; r++) {
            lines.push(columns.map(c => escape(c.values[r])).join(delimiter));
        }
        const pipeCsvContent = lines.join('\n') + '\n';
        fs.writeFileSync(path.join(outDir, csvFile), pipeCsvContent);
        fs.writeFileSync(path.join(outDir, `${name}_parameters.json`), JSON.stringify(candidates, null, 2));
        params = candidates.map(c => ({
            variableName: c.name, name: c.name,
            originalValue: c.value, value: c.value,
            occurrences: Number(c.occurrences) || null,
            source: 'csv', csvFilename: csvFile,
        }));
    }

    // 5. Build IR → render → validate → plan deterministic extractors → fall
    //    back to engine JSR223 auto-repair → UDV-inject.
    const genOpts = {
        sourceFile: name, recordingFilename: `${name}.recording.xml`,
        includeThinkTimes: false, includeAssertions: false,
        parameterizations: params, userDefinedVariables: params,
        fileMappings: uploadPlan.fileMappings,
        harGapValues: [], userDefinedGaps: [], stableAssertions: [],
    };
    const ir = buildPlanFromHar({
        flatEntries: flat, enrichedGroups: groups, correlations: corrs, generatorOptions: genOpts,
        metadata: { sourceFilename: name, recordingFilename: `${name}.recording.xml`, sourceFormat: 'har' },
        config: { correlationThreshold: 0.75 },
    });
    let xml = getRenderer(DEFAULT_RENDERER_ID).render(ir).xml;
    // Safety net (defence-in-depth for the value guard above): if a parameter's
    // value was substituted as a SUBSTRING and shredded the plan — its ${var}
    // now appears far more often than the field could legitimately occur — undo
    // it by restoring the recorded literal everywhere. Reverting the token
    // exactly reverses the global substitution (authenticate.js${x} -> .json).
    const corruptionCheck = detectAndRevertParameterCorruption(xml, params);
    if (corruptionCheck.reverted.length) {
        xml = corruptionCheck.xml;
        params = params.filter(p => !corruptionCheck.reverted.some(r => r.name === (p.variableName || p.name)));
        note('parameterization-corruption',
            `${corruptionCheck.reverted.length} parameter(s) were substituted as substrings and shredded the plan — reverted to the recorded literal`,
            corruptionCheck.reverted.map(r => `\${${r.name}} appeared ${r.refCount}× (field occurs ~${r.expected ?? '?'}×): value "${r.value}"`).join('; '),
            `these values are too short/common to substitute safely; kept as literals. Force one back with run.parameterization.includeNames if you truly need it.`);
    }
    if (candidates.length) {
        // Our synthesized data CSV is PIPE-delimited (so comma-bearing values —
        // date-column lists, address fields — never split a column). The
        // renderer emits delimiter=","/quotedData=false, so retarget BOTH on
        // the data CSVDataSet: delimiter -> "|" and quotedData -> true. The CSV
        // writer (escape() above) RFC-4180-quotes any field containing a pipe,
        // quote, or newline; without quotedData=true JMeter reads those quotes
        // literally and shifts every later column — the class that made
        // ${username}/${password} resolve to a neighbouring column's value and
        // 400'd every login. Scope the flip to CSVDataSet blocks only.
        xml = xml.replace(/<CSVDataSet\b[\s\S]*?<\/CSVDataSet>/g, (block) => block
            .replace(/(<stringProp name="delimiter">),(<\/stringProp>)/g, '$1|$2')
            .replace(/(<boolProp name="quotedData">)false(<\/boolProp>)/g, '$1true$2'));
    }
    // R4 — substitute ${__timeShift(...)} for each recorded date literal so
    // date-filtered requests stay valid at run time (native function; survives
    // the java-safe strip).
    let dateShiftsApplied = 0;
    if (datePlan.shifts.length) {
        const ds = dateIntent.injectDateShifts(xml, datePlan.shifts);
        xml = ds.xml; dateShiftsApplied = ds.applied;
    }
    const nativeManagers = applyForcedNativeManagers(xml, runCfg.forceNativeManagers || {});
    xml = nativeManagers.xml;
    if (nativeManagers.applied.length) note('native-managers',
        `forced native JMeter manager strategy applied: ${nativeManagers.applied.join(', ')}`,
        `inserted=${nativeManagers.inserted.join(', ') || 'none'}; existing=${nativeManagers.existing.join(', ') || 'none'}; cookieHeadersRemoved=${nativeManagers.cookieHeadersRemoved}`,
        `honored replan forceNativeManagers before validator/repair passes`);
    let vr = dryRunValidator.validate(xml, corrs);

    // Filter false orphans: anything the test plan already supplies via a
    // CSV column / UDV / a previously emitted extractor refname. Without
    // this, the engine's validator (200-char CSVDataSet look-back) misses
    // our CSV block and the auto-repair injects a 30-line Groovy stanza
    // per CSV variable. Wider scan here = zero bogus injections.
    const defined = knownDefinedVars(xml, params.map(p => p.variableName || p.name));
    const realOrphans = (vr.orphanReferences || []).filter(o => !defined.has(o.variable));
    const filteredOut = (vr.orphanReferences || []).length - realOrphans.length;
    if (filteredOut > 0) {
        note('extractors', `${filteredOut} orphan reference(s) are actually supplied by CSV/UDV`,
            `engine validator's look-back window misses wide CSVDataSet blocks`,
            `skipped JSR223 auto-repair for them`);
    }

    // Try deterministic native extractor first; only un-located vars get the
    // engine's JSR223 fallback (one block per var instead of three).
    const stillOrphans = [];
    const plannedExtractors = [];
    for (const orphan of realOrphans) {
        const plan = planExtractor(
            orphan.variable,
            [{ name: orphan.variable, value: lookupValueForVar(flat, orphan.variable, params) }],
            flat, orphan.samplerOrder || 0,
        );
        if (plan) {
            xml = injectAfterSampler(xml, plan.sourceOrder, plan.block);
            plannedExtractors.push({
                variable: orphan.variable,
                type: plan.type,
                source: plan.sourceLabel,
                verified: plan.type !== 'regex' || !!plan.extractedValue,
            });
            note('extractors', `correlate ${orphan.variable} from earlier response`,
                `value located in ${plan.sourceLabel} as ${plan.type}${plan.type === 'regex' ? ' and regex proof captured the recorded value' : ''}`,
                `emitted native ${plan.type === 'json' ? 'JSONPostProcessor' : 'RegexExtractor'}`);
        } else {
            stillOrphans.push(orphan);
        }
    }
    if (stillOrphans.length) {
        const synthetic = { ...vr, orphanReferences: stillOrphans };
        const rr = jmxAutoRepair.repair(xml, synthetic, { injectOrphanFixes: true });
        if (rr.changed) xml = rr.xml;
        note('extractors', `${stillOrphans.length} variable(s) had no traceable source`,
            `searched all earlier response bodies / headers`,
            `fell back to engine JSR223 Auto-Discovery (one per var)`);
    } else {
        // We still need the engine's listener-filename strip pass even when no
        // orphans remain; the engine's auto-repair runs it as side-effect.
        const rr = jmxAutoRepair.repair(xml, { ...vr, orphanReferences: [] }, { injectOrphanFixes: false });
        if (rr.changed) xml = rr.xml;
    }

    xml = udvInjector.inject(xml).xml;

    // Enforce correlation substitution across ALL request occurrences (not just
    // the engine's single registered target). Closes the "value reused in N
    // later requests stays hardcoded" gap that breaks threaded auth state.
    const enf = enforceSubstitutions(xml, corrs);
    xml = enf.xml;
    if (enf.count) note('correlation',
        `${enf.count} extra hardcoded occurrence(s) of correlated values replaced with their variable`,
        `engine substitutes only the first target; the same value recurs in later requests`,
        `enforced \${var} across all request/header fields`);

    const oauthConstants = repairStaticOauthConstants(xml);
    xml = oauthConstants.xml;
    if (oauthConstants.repaired) note('oauth-constants',
        `static OAuth response_type restored`,
        `response_type=code is protocol syntax, not runtime session data`,
        `replaced \${response_type} with literal code to avoid corrupting query names and content types`);

    // Optional cross-environment host rewrite (Phase 5b). Repoints the
    // recording's primary host to a target base URL while leaving 3P hosts
    // alone, so the same JMX replays against staging without re-recording.
    let hostRewriteCount = 0;
    if (runCfg.hostRewrite && runCfg.hostRewrite.from && runCfg.hostRewrite.to) {
        const out = rewriteHost(xml, runCfg.hostRewrite.from, runCfg.hostRewrite.to);
        xml = out.xml; hostRewriteCount = out.count;
        if (hostRewriteCount > 0) note('host-rewrite',
            `repoint recorded host ${runCfg.hostRewrite.from} -> ${runCfg.hostRewrite.to}`,
            `${hostRewriteCount} sampler/config block(s) matched`,
            `xml rewritten`);
    }

    // 6. Post-XML transforms — things the engine renderer cannot emit today.
    //
    //    Order matters: WhileController wrap MUST run BEFORE injecting per-
    //    sampler assertions/extractors so the inner-sampler hashTree splices
    //    stay valid after wrapping.
    const wc = wrapPollingInWhileController(xml, polling);
    xml = wc.xml;
    if (wc.wrapped) note('polling',
        `${wc.wrapped} polling cluster(s) detected (>=3 consecutive same endpoint)`,
        `recording shows repeated calls — likely status polling`,
        `wrapped in WhileController + per-loop counter cap`);

    const ghostInj = injectGhostSynthesizers(xml, ghosts, serverOrigin);
    xml = ghostInj.xml;
    if (ghostInj.injected) note('ghosts',
        `${ghostInj.injected} client-minted value(s) cannot be correlated`,
        `value has no upstream server source`,
        `injected per-thread JSR223 PreProcessor to regenerate on every iteration`);
    if (ghostInj.refused.length) note('ghosts',
        `${ghostInj.refused.length} value(s) require server-side signing secrets we don't have`,
        ghostInj.refused.map(r => `${r.name}: ${r.reason}`).join('; '),
        `surfaced for manual handling (per ARCHITECTURE irreducible-limits)`);

    const auth0State = repairAuth0LoginStateExtractors(xml);
    xml = auth0State.xml;
    if (auth0State.repaired) note('auth0-login-state',
        `${auth0State.repaired} Auth0 login state extractor(s) repaired`,
        `Universal Login state is produced in /authorize Location, not a hidden input`,
        `replaced CSS hidden-input extractor with Location-header RegexExtractor`);

    // Backstop: a BARE OAuth2 /authorize state/nonce is client-minted, so any
    // RegexExtractor for it pulls from an unrelated response and yields ''. Strip
    // the dud extractor and mint the value natively (__RandomString, Java-safe).
    // Self-gating: no-op unless an /authorize?client_id... URL uses ${state}/
    // ${nonce}, so it never touches server-issued suffixed session tokens.
    const oauthRewire = rewireClientMintedOauthVars(xml);
    xml = oauthRewire.xml;
    if (oauthRewire.rewired && oauthRewire.rewired.length) note('oauth-client-minted-state',
        `${oauthRewire.rewired.length} bare OAuth2 state/nonce value(s) minted client-side`,
        `client-minted /authorize state/nonce have no server producer to extract from`,
        `stripped dud extractor(s) and used native __RandomString: ${oauthRewire.rewired.join(', ')}`);

    // PKCE (RFC 7636): 'plain' is Java-safe (challenge==verifier); 'S256' needs
    // SHA-256(base64url) which JMeter cannot do Java-safe — flag it precisely
    // rather than faking a challenge that the server will reject.
    const pkceInfo = pkce.analyzePkce(flat);
    if (pkceInfo.present && pkceInfo.note) {
        note('oauth-pkce', pkceInfo.note.summary, pkceInfo.note.why, pkceInfo.note.action);
    }
    if (pkceInfo.present && pkceInfo.blocker) {
        note('oauth-pkce-s256', pkceInfo.blocker.title, pkceInfo.blocker.detail,
            `NEEDS ATTENTION — ${pkceInfo.blocker.options[0]}`);
    }

    // Form hidden-input correlation (login state, SSO auto-POST bridge token).
    // The class the manually-fixed Tasking script solved by hand: a page body
    // carries <input type="hidden" name=X value=V> and later requests must
    // send the FRESH V, not the recorded literal. Runs after the Auth0 repair
    // pass so that pass cannot rewrite the CSS extractors emitted here.
    const formCorr = correlateFormHiddenInputs(xml, flat, {
        maxVars: runCfg.formCorrelation && runCfg.formCorrelation.maxVars,
    });
    if (formCorr.skippedByCap && formCorr.skippedByCap.length) {
        note('form-correlation',
            `${formCorr.skippedByCap.length} additional form hidden-input value(s) skipped by the correlation cap`,
            `each wired variable costs a CSS DOM parse per response at runtime; the most-consumed ones were kept`,
            `raise run.formCorrelation.maxVars deliberately if a skipped field breaks replay: ${formCorr.skippedByCap.slice(0, 6).map(s => s.input).join(', ')}`);
    }
    xml = formCorr.xml;
    if (formCorr.wired.length) note('form-correlation',
        `${formCorr.wired.length} form hidden-input value(s) must be fresh per run`,
        formCorr.wired.map(w => `${w.input} produced by "${w.producerSampler}" (recorded page body carries the hidden input; later requests consume it)`).join('; '),
        `emitted CSS extractor per producer + substituted \${var} at ${formCorr.wired.reduce((n, w) => n + w.substitutions, 0)} consumer field(s)`);

    // Generic mined page-text assertions are opt-in. They catch false-200 pages,
    // but they also overfit titles/headings such as "WebPT Dashboard" and made
    // previously valid scripts red after routine copy/layout changes. Business
    // outcome probe + strict business guard remain enabled by default.
    const assertInj = runCfg.mineAssertions === true
        ? injectAssertionsFromMined(xml, flat, corrs.map(c => c.value).filter(Boolean))
        : { xml, injected: 0 };
    xml = assertInj.xml;
    if (assertInj.injected) note('assertions',
        `${assertInj.injected} sampler(s) had stable response text to assert on`,
        `mined HTML titles / JSON status keys / page headings from recording`,
        `injected ResponseAssertion (substring, OR) per sampler`);
    if (runCfg.mineAssertions !== true) note('assertions',
        'mined text assertions disabled by default',
        'separate brittle page text from real flow breakage',
        'no mined ResponseAssertions injected (outcome probe and business guard still verify)');

    // Outcome probe: the recording shows some later read ECHOES the value the
    // business mutation submitted. Assert that echo so "every request 200s
    // but the task was never created" can no longer be GREEN.
    const probe = outcomeProbe.planOutcomeProbe({ entries: flat, flowName: name, params, runCfg });
    let probeInjected = 0;
    if (probe) {
        const pi = outcomeProbe.injectOutcomeProbe(xml, probe);
        xml = pi.xml;
        probeInjected = pi.injected;
        if (pi.injected) note('outcome-probe',
            `the business result must be VISIBLE, not just accepted`,
            `recorded: "${probe.mutatingLabel}" submitted a distinctive value that later appears in "${probe.probeLabel}"`,
            `asserted ${probe.isVariable ? 'the runtime ' + probe.text : 'the submitted value'} in that response — a run that creates nothing can no longer be GREEN`);
    }

    const pacingInj = injectGaussianTimers(xml, flat, pages);
    xml = pacingInj.xml;
    if (pacingInj.injected) note('pacing',
        `${pacingInj.injected} transaction(s) had measurable inter-request gaps`,
        `derived mean+stdev from recording timings`,
        `added GaussianRandomTimer per transaction`);

    // Optional load profile (users / ramp-up / hold / loops). Honored at
    // BOTH generate-only and --run paths, so the JMX that ships from this
    // folder is the same one that ran in --run.
    const loadProfileIn = (runCfg && runCfg.loadProfile) || (opts.loadProfile) || null;
    let loadProfileApplied = null;
    if (loadProfileIn) {
        const lp = applyLoadProfile(xml, loadProfileIn);
        xml = lp.xml;
        loadProfileApplied = lp.applied;
        if (lp.applied) note('load-profile',
            `applied load profile to Thread Group`,
            `users=${lp.applied.users ?? 'unchanged'} · rampUpSec=${lp.applied.rampUpSec ?? 'unchanged'} · ` +
            `holdSec=${lp.applied.holdSec ?? 'n/a'} · loops=${lp.applied.loops ?? 'n/a'}`,
            `rewrote ThreadGroup props in-place`);
    }

    // Disable un-replayable calls (e.g. IdP redirect plumbing the user/heuristic
    // flags: /authorize/resume, /interceptor/, jwt create-cookie). They carry
    // single-use tokens and are meant to be auto-followed, not replayed.
    let disabledCount = 0;
    const disableValueFlow = valueFlowDecisions.classifySamplerDisableDecisions({
        entries: flat,
        protectedCalls: runCfg.protectedCalls,
    });

    // FOLD-SAFETY GATE — the evidence every heuristic disable must clear.
    // Answers the two senior-engineer questions from the recording alone:
    //   (2) does this request GENERATE a value a later request consumes, or
    //       NAVIGATE to a page the next request depends on?  → UNSAFE to fold
    //   (1) does an UPSTREAM request feed a value INTO this one?  → UNCERTAIN;
    //       don't fold on a hunch, let the live probe decide.
    // Proven duplicate hops are exempt from the navigation/cookie checks
    // because the parent's followed chain reproduces them. Operator-explicit
    // disables never consult this gate (their tier is absolute).
    const dupHops = redirectHops.detectDuplicateRedirectHops(flat);
    const dupHopIndexSet = new Set(dupHops.indexes);
    const foldSafety = foldSafetyModule.assessFoldSafety(flat, {
        foldingIndexes: dupHopIndexSet,
        duplicateHopIndexes: dupHopIndexSet,
    });
    const foldSafetyVetoes = [];
    // Maps a live sampler (from the rendered XML) back to its flat-entry index
    // so a pattern match can consult the fold-safety verdict.
    const foldVerdictForSampler = (sampler) => {
        const idx = flatIndexForSampler(flat, sampler);
        if (idx < 0) return null;
        return foldSafety.byIndex[idx] || null;
    };

    // TIER 1 — OPERATOR disables (config / steering / golden / playbook).
    // Operator intent outranks heuristics for proven redirect plumbing (the
    // live LOGI failure was "/s/interceptor/authorize/" being vetoed). It does
    // not outrank evidence that a matched sampler is a token/session handoff;
    // disabling that class requires allowUnsafeDisableProtected=true.
    const operatorPatterns = (runCfg && runCfg.disableCalls) || [];
    if (operatorPatterns.length) {
        const heuristicDisagreements = [];
        const hardProtectedDisables = [];
        const dis = disableSamplersByPattern(xml, operatorPatterns, {
            protect: sampler => {
                const hay = `${sampler.name || ''} ${sampler.domain || ''}${sampler.path || ''}`;
                if (matchesConfiguredPattern(hay, runCfg.protectedCalls)) return true; // operator vs operator: protect wins
                if (isHardProtectedDisableTarget(sampler, runCfg, disableValueFlow)) {
                    hardProtectedDisables.push(sampler.name || sampler.path);
                    return true;
                }
                // Heuristics may WARN about an operator disable, never veto it.
                if (shouldProtectDisableTarget(sampler, runCfg, disableValueFlow)) {
                    heuristicDisagreements.push(sampler.name || sampler.path);
                }
                return false;
            },
        });
        xml = dis.xml; disabledCount += dis.disabled;
        if (dis.disabled) note('disable-calls',
            `${dis.disabled} sampler(s) disabled on operator instruction (run.disableCalls)`,
            `matched: ${dis.hits.slice(0, 8).join(', ')}`,
            `operator tier is absolute — heuristics may not veto an explicit disable`);
        if (heuristicDisagreements.length) note('disable-calls-warning',
            `${heuristicDisagreements.length} operator-disabled sampler(s) look like auth/session producers to the heuristics`,
            `disabled anyway (operator wins): ${heuristicDisagreements.slice(0, 8).join(', ')}`,
            `if the run now fails at a downstream consumer, re-enable these or move them to protectedCalls`);
        if (dis.skippedProtected && dis.skippedProtected.length) note('disable-calls-conflict',
            `${dis.skippedProtected.length} sampler(s) matched disableCalls but were kept enabled by protectedCalls or hard safety guards`,
            `kept enabled: ${dis.skippedProtected.slice(0, 8).join(', ')}`,
            hardProtectedDisables.length
                ? `token/session handoff detected; set run.allowUnsafeDisableProtected=true only if you deliberately want to bypass this`
                : `explicit protect outranks explicit disable — resolve the conflict in config`);
    }

    // TIER 3 — code-default noise patterns. These are priors, so the full
    // heuristic protection hook applies to them (a default must never fold a
    // producer the evidence says is consumed).
    const defaultPatterns = (runCfg && runCfg.disableDefaultNoise === false) ? [] : DEFAULT_DISABLE_PATTERNS;
    if (defaultPatterns.length) {
        const dis = disableSamplersByPattern(xml, defaultPatterns, {
            protect: sampler => {
                if (shouldProtectDisableTarget(sampler, runCfg, disableValueFlow)) return true;
                // The fold-safety gate: a default noise pattern is a strong
                // prior, but it may NOT fold a request the recording proves is
                // load-bearing (Check 2 — generates a downstream-consumed value
                // or a navigation the next request needs). Check 1 alone
                // (merely consuming an upstream cookie, which nearly every
                // request does) does NOT override a known-noise pattern; that
                // caution is for the live fold-probe on self-initiated folds.
                const v = foldVerdictForSampler(sampler);
                if (v && v.verdict === 'unsafe') {
                    foldSafetyVetoes.push({ sampler: sampler.name || sampler.path, verdict: v.verdict, reason: v.reasons[0] });
                    return true;
                }
                return false;
            },
        });
        xml = dis.xml; disabledCount += dis.disabled;
        if (dis.disabled) note('disable-calls',
            `${dis.disabled} browser/OIDC/noise sampler(s) disabled by default patterns`,
            `matched: ${dis.hits.slice(0, 8).join(', ')}`,
            `set enabled=false so JMeter skips non-business / un-replayable plumbing`);
        if (dis.skippedProtected && dis.skippedProtected.length) note('disable-calls-protected',
            `${dis.skippedProtected.length} default-pattern match(es) blocked — evidence says they are producers`,
            `kept enabled: ${dis.skippedProtected.slice(0, 8).join(', ')}`,
            `default patterns are priors; evidence outranks them`);
    }
    if (foldSafetyVetoes.length) note('fold-safety',
        `${foldSafetyVetoes.length} heuristic fold(s) blocked by recording evidence`,
        foldSafetyVetoes.slice(0, 6).map(v => `${v.sampler} [${v.verdict}]: ${v.reason}`).join('; '),
        `a request that generates a downstream-consumed value or a load-bearing navigation is never folded on a pattern hunch`);

    // TIER 2c — EVIDENCE: RECORDED failures. A request the user's own browser
    // saw fail while recording (404 document probes, 502/504 flaky embeds) can
    // never be a pass-requirement on replay — the recording proves the failure
    // is the app's normal behaviour, not a correlation gap. Fold them so they
    // don't block the verdict; an operator protect wins as always.
    if (runCfg.disableRecordedFailures !== false) {
        // Primary app host = the host most requests target; a recorded failure
        // on a THIRD-PARTY host indicts that host+path family (flaky embeds
        // like an external HEP widget 502/504-ing), so every instance of the
        // family folds regardless of its rotating query string.
        const hostTally = new Map();
        for (const e of flat) {
            try { const h = new URL(e.request.url).hostname; hostTally.set(h, (hostTally.get(h) || 0) + 1); } catch { /* skip */ }
        }
        const primaryHost = [...hostTally.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || '';
        const primaryApex = primaryHost.split('.').slice(-2).join('.');
        // Fold by ENTRY INDEX, not text patterns — generated samplers carry the
        // host as a ${SERVER} variable, so host-based patterns never match.
        // Family membership is decided on the RECORDING entries themselves.
        const recordedFailures = [];
        const failFamilies = new Set();   // third-party host+pathname (all query variants)
        const failExact = new Set();      // host + pathname + query (any host)
        for (const e of flat) {
            const st = Number(e && e.response && e.response.status || 0);
            if (st < 400) continue;
            const mintsSession = ((e.response && e.response.headers) || []).some(h =>
                /^set-cookie$/i.test(String(h.name || '')) && /(?:sess|auth|token|iam|idem|csrf)/i.test(String((h.value || '').split('=')[0])));
            if (mintsSession) continue; // a 401/403 handshake step that still sets session material stays
            try {
                const u = new URL(e.request.url);
                recordedFailures.push({ path: u.pathname + (u.search || ''), status: st });
                failExact.add(u.hostname + u.pathname + (u.search || ''));
                if (!u.hostname.endsWith(primaryApex)) failFamilies.add(u.hostname + u.pathname);
            } catch { /* skip unparseable */ }
        }
        if (failExact.size || failFamilies.size) {
            const samplerIndexRF = indexSamplersForGenerate(xml);
            let foldedRF = 0;
            for (let i = 0; i < flat.length; i++) {
                let host = '', pathname = '', exact = '';
                try { const u = new URL(flat[i].request.url); host = u.hostname; pathname = u.pathname; exact = host + pathname + (u.search || ''); }
                catch { continue; }
                if (!failExact.has(exact) && !failFamilies.has(host + pathname)) continue;
                const s = samplerIndexRF[i];
                if (!s) continue;
                if (matchesConfiguredPattern(`${s.name} ${s.path || ''}`, runCfg.protectedCalls)) continue;
                const flipped = flipEnabledAtPosition(xml, s);
                if (flipped.changed) { xml = flipped.xml; foldedRF++; }
            }
            disabledCount += foldedRF;
            if (foldedRF) note('recorded-failures',
                `${foldedRF} sampler(s) folded because the RECORDING itself shows them failing`,
                recordedFailures.slice(0, 6).map(f => `${f.status} ${f.path.slice(0, 60)}`).join('; '),
                `the user's own browser got these failures while recording — they are the app's normal behaviour, not something replay must fix (third-party host+path families folded across query variants)`);
        }
    }

    // TIER 2b — EVIDENCE from the RECORDING body: fire-and-forget telemetry
    // beacons (RUM/analytics like /enterprise/url/report, /domainreliability)
    // repeat the same endpoint many times, every recorded response is a
    // trivial/empty 2xx ack, and none mints a session cookie. They are noise —
    // fold them so a first-party POST beacon is not mistaken for a business
    // request and left to 401 the verdict. A one-off business POST never
    // matches (repetition gate). Operator protectedCalls still wins.
    if (runCfg.disableRecordedNoise !== false) {
        const beacons = detectRecordedNoiseBeacons(flat, {
            ...(runCfg.recordedNoise || {}),
            producerPaths: extractorProducerPaths(xml),
        });
        const beaconPaths = beacons.map(b => b.path);
        if (beaconPaths.length) {
            const dis = disableSamplersByPattern(xml, beaconPaths, {
                protect: sampler => matchesConfiguredPattern(`${sampler.name || ''} ${sampler.domain || ''}${sampler.path || ''}`, runCfg.protectedCalls),
            });
            xml = dis.xml; disabledCount += dis.disabled;
            if (dis.disabled) note('recorded-noise-beacons',
                `${dis.disabled} telemetry-beacon sampler(s) folded on recording evidence (repeated + trivial 2xx body + no session cookie)`,
                beacons.map(b => `${b.path} ×${b.count}`).slice(0, 6).join('; '),
                `fire-and-forget beacons produce nothing the flow consumes; folding them stops a first-party POST beacon from being protected and 401-ing the verdict`);
        }
    }

    // TIER 2 — EVIDENCE: duplicate redirect hops. The recording proves these
    // samplers re-execute a hop the parent's followed redirect chain already
    // performs; replaying them out of band re-fires single-use tokens and
    // trips the session (the /s/interceptor/authorize/-in-two-transactions
    // failure class). Safe to fold BY CONSTRUCTION — the hop still runs
    // inside the parent. Outranks "session-like path" priors; yields only to
    // an explicit operator protect.
    let duplicateHopLabels = [];
    if (dupHops.indexes.length) {
        const samplerIndex = indexSamplersForGenerate(xml);
        let folded = 0;
        const keptForSafety = [];
        for (const idx of dupHops.indexes) {
            const s = samplerIndex[idx];
            if (!s) continue;
            const hay = `${s.name} ${s.path || ''}`;
            if (matchesConfiguredPattern(hay, runCfg.protectedCalls)) continue; // operator protect wins
            // Even a proven hop is kept if it UNIQUELY generates a downstream
            // value (non-cookie; cookies are captured natively while following
            // the parent). Check 2 outranks the hop heuristic.
            const v = foldSafety.byIndex[idx];
            if (v && v.checks.producesDownstreamValue > 0) {
                keptForSafety.push(s.name);
                continue;
            }
            const flipped = flipEnabledAtPosition(xml, s);
            if (flipped.changed) { xml = flipped.xml; folded++; }
        }
        if (folded) note('duplicate-redirect-hops',
            `${folded} sampler(s) are recorded redirect hops the parent chain already executes`,
            dupHops.indexes.slice(0, 6).map(i => `entry ${i} ← ${dupHops.byIndex[i].via}`).join('; '),
            `folded (evidence tier): replaying a followed hop out of band re-fires single-use tokens and trips the session`);
        if (keptForSafety.length) note('duplicate-redirect-hops-kept',
            `${keptForSafety.length} redirect hop(s) kept enabled — they uniquely generate a downstream-consumed value`,
            keptForSafety.slice(0, 6).join(', '),
            `fold-safety Check 2 outranks the duplicate-hop heuristic`);
        disabledCount += folded;
    }

    // TIER 2d — EVIDENCE: repeat navigations. A second bare GET to the exact
    // URL an earlier kept sampler already hits (SSO bridge revisits like a
    // second GET /redirect/) mints nothing new per the recording; replayed out
    // of band it re-consumes a one-time grant and 500s. Fold the repeat — the
    // FIRST instance stays and produces everything. Folded labels merge into
    // duplicateHopLabels so the business guard exempts them like other hops.
    {
        const repeats = redirectHops.detectRepeatNavigations(flat);
        const repeatFolded = [];
        if (repeats.indexes.length) {
            const samplerIndex2 = indexSamplersForGenerate(xml);
            for (const idx of repeats.indexes) {
                if (dupHops.byIndex[idx]) continue; // already handled as a duplicate hop
                const s = samplerIndex2[idx];
                if (!s) continue;
                if (matchesConfiguredPattern(`${s.name} ${s.path || ''}`, runCfg.protectedCalls)) continue;
                const flipped = flipEnabledAtPosition(xml, s);
                if (flipped.changed) {
                    xml = flipped.xml;
                    disabledCount++;
                    repeatFolded.push(s.name);
                    dupHops.byIndex[idx] = repeats.byIndex[idx];
                    dupHops.indexes.push(idx);
                }
            }
            if (repeatFolded.length) note('repeat-navigation',
                `${repeatFolded.length} repeat navigation(s) folded — same URL as an earlier kept request, no new session material`,
                repeatFolded.slice(0, 6).join(', '),
                `an out-of-band bridge revisit re-consumes a one-time grant (the recorded 200 becomes a replay 500); the first instance still runs`);
        }
    }

    // Golden-script learning: a human-fixed WORKING script for this flow was
    // supplied (input/<flow>__golden.jmx). Merge its proven extractors,
    // enable/disable judgments, and literal→${var} substitutions. Runs after
    // the pattern disables (golden judgments win) and before dead-extractor
    // repair (which then heals anything a golden disable strands).
    let goldenApplied = null;
    let goldenDisables = [];
    if (opts.goldenXml) {
        try {
            const goldenDiff = require('./golden-diff');
            const deltas = goldenDiff.diffGoldenAgainstGenerated({ goldenXml: opts.goldenXml, generatedXml: xml });
            const res = goldenDiff.applyGoldenDeltas(xml, deltas);
            xml = res.xml;
            goldenApplied = { ...res.applied, notes: deltas.notes };
            goldenDisables = (deltas.toDisable || []).map(d => d.sampler);
            fs.writeFileSync(path.join(outDir, `${name}_golden_deltas.json`),
                JSON.stringify({ deltas, applied: res.applied }, null, 2));
            if (res.applied.extractors + res.applied.disabled + res.applied.enabled + res.applied.substitutions > 0) {
                note('golden',
                    `human-fixed working script supplied for this flow`,
                    `diffed model-level: ${deltas.extractorsToAdd.length} proven extractor(s) missing, ` +
                    `${deltas.toDisable.length} disposable / ${deltas.toEnable.length} must-stay-enabled sampler(s), ` +
                    `${deltas.substitutions.length} substitution(s)`,
                    `merged verbatim: +${res.applied.extractors} extractor(s), ${res.applied.disabled} disabled, ` +
                    `${res.applied.enabled} re-enabled, ${res.applied.substitutions} literal(s) -> \${var}`);
            }
        } catch (e) {
            note('golden', 'golden merge skipped (non-fatal)', e.message, 'generated script shipped without golden deltas');
        }
    }

    // Extractors stranded on now-disabled samplers can never run; their
    // ${var} consumers would send the literal brace string (URISyntaxException
    // in URLs). Restore the recorded literal at each consumer — evidence from
    // the consumer's own recorded request.
    const deadFix = repairDeadExtractorConsumers(xml, flat);
    xml = deadFix.xml;
    if (deadFix.restored.length) note('dead-extractors',
        `${deadFix.dead.length} extractor(s) sit under disabled sampler(s) and can never populate their variable`,
        deadFix.restored.map(r => `\${${r.var}} in "${r.sampler}"`).slice(0, 6).join('; '),
        `restored the recorded literal at ${deadFix.restored.length} consumer field(s) (recorded value beats a variable that cannot resolve)`);

    // JS-embedded challenge tokens (rotating CSRF name+value pairs echoed from
    // inline page script). The variance diff misses them when both recordings
    // sit inside one deployment window (identical values), so the engine ships
    // a stale literal and the server fails the login SILENTLY (200, no session
    // cookie). Evidence-based: the pair must appear adjacently in an earlier
    // response, and the derived regex must reproduce it before wiring.
    try {
        const chal = jsChallengeToken.correlateJsChallengeToken(xml, flat);
        if (chal.applied.length) {
            xml = chal.xml;
            note('js-challenge-token',
                `${chal.applied.length} inline-script challenge pair(s) correlated (rotating param NAME + VALUE)`,
                chal.applied.map(a => `${a.name} ← ${a.producerPath} → ${a.consumerPath} (${a.rewired} consumer arg(s))`).join('; '),
                `extracts both halves from the live page each run — a stale recorded challenge makes the login fail silently with 200 and no session cookie`);
        }
    } catch (e) { note('js-challenge-token', 'skipped (non-fatal)', e.message); }

    // Convergence pass — fold in the body/session correlations the engine's
    // pass misses. Uses the SECOND recording (variance) to find dynamics that
    // live in request bodies / <queryString> (GraphQL) — notably the
    // session-in-body class (sessionId:"Token <cookie>"). Layers cleanly: the
    // consumed-gate only touches values still LITERAL here (engine ${vars} are
    // skipped), each extractor is verified against the recorded producer before
    // wiring, and var names never clobber the engine's. Dual recordings only.
    let bodyCorrelated = 0;
    if (opts.secondaryEntries && opts.secondaryEntries.length) {
        try {
            const bc = correlateBodyDynamics(xml, entriesRaw, opts.secondaryEntries);
            if (bc.applied.length) {
                xml = bc.xml;
                bodyCorrelated = bc.applied.length;
                note('body-correlation',
                    `${bc.applied.length} body/session dynamic(s) the engine left literal`,
                    `variance vs the 2nd recording; each extractor verified against its recorded producer`,
                    `vars: ${bc.applied.map(a => a.var).slice(0, 8).join(', ')}`);
            }
        } catch (e) { note('body-correlation', 'skipped (non-fatal)', e.message); }
    }

    const gqlCsrf = propagateGraphqlCsrfTokens(xml);
    xml = gqlCsrf.xml;
    if (gqlCsrf.substitutions) note('graphql-auth-csrf',
        `${gqlCsrf.substitutions} downstream GraphQL X-CSRF-TOKEN header(s) rewired`,
        `preceding GraphQL auth/session sampler(s) select csrfToken in the response`,
        `emitted ${gqlCsrf.extractors} JSON extractor(s) and propagated the freshest csrfToken variable`);

    // Final hard safety gate for manual JMeter use. JMeter 5.6.3 bundles Groovy
    // 3.0.x, which cannot compile JSR223 scripts under Java 25
    // (Unsupported class file major version 69). The generated .jmx must be
    // runnable when a user opens it directly in JMeter, not only through --run.
    const allowJsr223 = runCfg.allowJsr223 === true;
    // Scenario pacing: pin the iteration rate to the objective with a native
    // Precise Throughput Timer (survives the java-safe strip).
    if (scenarioPlan && scenarioPlan.pacing) {
        const pt = scenario.insertPacingTimers(xml, scenarioPlan.pacing);
        if (pt.inserted) {
            xml = pt.xml;
            note('scenario-pacing',
                `pin the rate to ${scenarioPlan.objective.transactionsPerHour}/hour`,
                `without pacing, achieved load drifts with response times`,
                `inserted pacing anchor + PreciseThroughputTimer into ${pt.inserted} thread group(s)`);
        }
    }
    if (scenarioPlan) {
        fs.writeFileSync(path.join(outDir, `${name}_scenario.md`), scenario.renderScenarioMarkdown(name, scenarioPlan));
    }

    const javaSafe = allowJsr223 ? { changed: false, removed: [] } : sanitizeJavaUnsafeJmx(xml);
    if (javaSafe.changed) {
        xml = javaSafe.xml;
        fs.writeFileSync(
            path.join(outDir, name + '_java_safe_generate.json'),
            JSON.stringify({ jmxPath: name + '.jmx', removed: javaSafe.removed }, null, 2)
        );
        note('java-safe',
            javaSafe.removed.length + ' Groovy JSR223 pre/post processor(s) stripped from generated JMX',
            'JMeter 5.6.3 Groovy fails under Java 25 (class major 69)',
            'shipped ' + name + '.jmx without JSR223 so users can run it manually');
    } else if (allowJsr223) {
        note('java-safe',
            'JSR223 Java-safe stripping disabled by run.allowJsr223=true',
            'operator explicitly allowed Groovy helpers in generated JMX',
            'left JSR223 blocks intact; validate with a compatible JMeter/Java runtime');
    }

    const peRenamed = peNaming.renameHttpSamplerLabels(xml, peModel);
    xml = peRenamed.xml;
    if (peRenamed.renamed) note('pe-naming',
        `${peRenamed.renamed} HTTP sampler testname(s) rewritten with semantic prefixes`,
        `labels use SCxx_Txx_<request>-<step> format for PE spreadsheet readability`,
        `troubleshooting alignment remains available through ${name}_label_map.json`);

    // Re-validate after our edits so reported stats reflect what we ship.
    // The engine validator's look-back misses CSV/UDV-supplied variables, so
    // filter those out the same way the repair path does — stats.orphans must
    // mean "actually undefined at runtime", not "validator couldn't see it".
    vr = dryRunValidator.validate(xml, corrs);
    const finalDefined = knownDefinedVars(xml, params.map(p => p.variableName || p.name));
    vr = { ...vr, orphanReferences: (vr.orphanReferences || []).filter(o => !finalDefined.has(o.variable)) };

    const jmxPath = path.join(outDir, `${name}.jmx`);
    fs.writeFileSync(jmxPath, xml);

    // GATE 0 — verify what the script will actually SEND (rendered-request
    // check). Runs on the shipped XML + CSV so it sees exactly what JMeter
    // will: undefined ${var} that would transmit literally, and CSV column
    // shifts that would feed a variable a neighbouring column's value. These
    // are DATA DEFECTS — the triage layer must not mistake them for auth walls.
    let gate0 = { ok: true, findings: [] };
    try {
        gate0 = renderedRequestCheck.checkRenderedRequests({ xml, outDir });
        if (gate0.findings.length) {
            fs.writeFileSync(path.join(outDir, `${name}_gate0.json`), JSON.stringify(gate0, null, 2));
            note('gate0',
                `${gate0.findings.length} rendered-request defect(s) — the script would send wrong/literal values`,
                gate0.findings.slice(0, 5).map(f => `${f.kind}${f.variable ? ` (\${${f.variable}})` : ''}: ${f.message}`).join(' · '),
                `these are DATA defects (fixable), not auth/session walls — see ${name}_gate0.json`);
        }
    } catch (e) { note('gate0', 'rendered-request check skipped (non-fatal)', e.message); }

    // Duplicate-hop labels must reflect the FINAL sampler names (pe-naming
    // renames after the fold), or the guard/adjudicator exclusion sets match
    // nothing. Recompute from the shipped XML; include hops that were already
    // disabled by other passes — they are still duplicates to every consumer.
    if (dupHops.indexes.length) {
        const finalSamplerIndex = indexSamplersForGenerate(xml);
        duplicateHopLabels = dupHops.indexes
            .map(i => finalSamplerIndex[i] && finalSamplerIndex[i].name)
            .filter(Boolean);
    }

    const seniorPeDebrief = seniorPe.buildSeniorPeDebrief({
        name,
        entries: flat,
        pages,
        runCfg,
        correlations: corrs,
        parameterCandidates: candidates,
        ghosts,
        polling,
        plannedExtractors,
        stats: {
            correlations: corrs.length,
            parameterized: params.length,
            nativeExtractorsPlanned: plannedExtractors.length,
            pacingTimers: pacingInj.injected,
        },
    });
    fs.writeFileSync(path.join(outDir, `${name}_senior_pe_debrief.json`), JSON.stringify(seniorPeDebrief, null, 2));
    fs.writeFileSync(path.join(outDir, `${name}_senior_pe_debrief.md`), seniorPe.renderSeniorPeDebriefMarkdown(seniorPeDebrief));
    if (seniorPeDebrief.domainProfile && seniorPeDebrief.domainProfile.hasOperatorContext) {
        fs.writeFileSync(path.join(outDir, `${name}_domain_profile.json`), JSON.stringify(seniorPeDebrief.domainProfile, null, 2));
    }

    if (reasoning.length) {
        fs.writeFileSync(path.join(outDir, `${name}_reasoning.json`), JSON.stringify(reasoning, null, 2));
        fs.writeFileSync(path.join(outDir, `${name}_reasoning.md`), renderReasoningMarkdown(name, reasoning, {
            ingested: entriesRaw.length, kept: flat.length, csvFile,
            stats: {
                correlations: corrs.length, parameterized: params.length,
                ghostSynthesizers: ghostInj.injected, ghostsRefused: ghostInj.refused.length,
                whileControllers: wc.wrapped, assertions: assertInj.injected, pacing: pacingInj.injected,
                nativeExtractors: plannedExtractors.length, falseOrphansFiltered: filteredOut,
                skippedParameterCandidates,
                jsr223Stripped: javaSafe.removed.length,
                allowJsr223,
            },
        }));
    }

    return {
        jmxPath, flat, csvFile, candidates, ghosts, polling, correlations: corrs,
        plannedExtractors, reasoning, dualHarHints, loadProfile: loadProfileApplied, seniorPeDebrief,
        domainProfile: seniorPeDebrief.domainProfile || null,
        goldenDisables, goldenApplied,
        playbooksApplied: pbResult.applied,
        playbookDisables: pbResult.addedDisables,
        playbookProtects: pbResult.addedProtects || [],
        duplicateHopLabels,
        foldSafety: foldSafety.byIndex,
        gate0,
        effectiveLlmFlowNotes: runCfg.llmFlowNotes || [],
        scenario: scenarioPlan,
        uploadFiles: uploadPlan,
        nativeManagers,
        peNaming: peNaming.labelMapForArtifact(peModel),
        stats: {
            ingested: entriesRaw.length, kept: flat.length,
            correlations: corrs.length, parameterized: params.length,
            clientSideGhosts: ghosts.length, pollingLoops: polling.length,
            samplers: vr.totalSamplers, extractors: vr.totalExtractors, orphans: vr.orphanReferences.length,
            nativeExtractorsPlanned: plannedExtractors.length,
            falseOrphansFiltered: filteredOut,
            skippedParameterCandidates,
            hostRewriteCount,
            whileControllers: wc.wrapped,
            ghostSynthesizers: ghostInj.injected,
            ghostsRefused: ghostInj.refused.length,
            jsr223Stripped: javaSafe.removed.length,
            allowJsr223,
            assertions: assertInj.injected,
            pacingTimers: pacingInj.injected,
            uploadFiles: uploadPlan.required.length,
            stagedUploadFiles: uploadPlan.matched.length,
            missingUploadFiles: uploadPlan.missing.length,
            nativeManagersApplied: nativeManagers.applied.length,
            bodyCorrelations: bodyCorrelated,
            graphqlCsrfHeaderRepairs: gqlCsrf.substitutions,
            formCorrelations: formCorr.wired.length,
            gate0Findings: gate0.findings.length,
            gate0CsvShift: gate0.findings.filter(f => f.kind === 'csv-column-shift').length,
            dateShifts: dateShiftsApplied,
            duplicateHops: duplicateHopLabels.length,
            foldSafetyVetoes: foldSafetyVetoes.length,
            goldenApplied,
            outcomeProbe: probe ? { probeLabel: probe.probeLabel, injected: probeInjected } : null,
            loadProfile: loadProfileApplied,
        },
    };
}

/** Render the structured reasoning trace as a senior-engineer-friendly Markdown doc. */
function renderReasoningMarkdown(name, entries, header) {
    const lines = [];
    lines.push(`# Reasoning trace — ${name}`);
    lines.push('');
    lines.push(`Generated ${new Date().toISOString()}.`);
    lines.push('');
    lines.push(`Input: ${header.ingested} entries ingested, ${header.kept} kept after filter.`);
    lines.push(`Highlights: ${header.stats.correlations} correlations · ${header.stats.parameterized} parameterized · ` +
        `${header.stats.nativeExtractors} native extractor(s) · ${header.stats.ghostSynthesizers} ghost synth · ` +
        `${header.stats.whileControllers} polling loop(s) wrapped · ${header.stats.assertions} assertion(s) · ${header.stats.pacing} pacing timer(s)`);
    if (header.stats.falseOrphansFiltered) {
        lines.push('');
        lines.push(`> Skipped ${header.stats.falseOrphansFiltered} false-orphan injection(s) — those variables are supplied by the CSV Data Set / UDV.`);
    }
    lines.push('');
    lines.push('## Steps');
    lines.push('');
    const byPhase = new Map();
    for (const e of entries) {
        const list = byPhase.get(e.phase) || [];
        list.push(e); byPhase.set(e.phase, list);
    }
    for (const [phase, items] of byPhase.entries()) {
        lines.push(`### ${phase}`);
        for (const it of items) {
            lines.push(`- **Hypothesis**: ${it.hypothesis}`);
            lines.push(`  - Evidence: ${it.evidence}`);
            lines.push(`  - Action: ${it.action}`);
        }
        lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('Open `' + name + '_report.html` for the executable summary; `' + name + '.jmx` is the generated script. Validation status is shown in the run log/report.');
    return lines.join('\n');
}

function uploadSearchDirs(opts = {}, runCfg = {}) {
    const root = path.join(__dirname, '..');
    const dirs = [
        ...(Array.isArray(opts.uploadSearchDirs) ? opts.uploadSearchDirs : []),
        ...(Array.isArray(runCfg.uploadSearchDirs) ? runCfg.uploadSearchDirs : []),
        path.join(root, 'input'),
        path.join(root, 'bin'),
    ];
    return dirs.map(dir => path.isAbsolute(dir) ? dir : path.join(root, dir));
}

/** Best-effort lookup of a variable's recorded value, used to seed extractor search. */
function lookupValueForVar(flat, varName, params) {
    const fromParam = (params || []).find(p => (p.variableName || p.name) === varName);
    if (fromParam && fromParam.originalValue) return String(fromParam.originalValue);
    // Try the value seen in any request field with this name (occurrence #1).
    for (const e of flat || []) {
        const req = e.request || {};
        for (const q of req.queryString || []) if (q.name === varName && q.value) return String(q.value);
        const post = req.postData;
        if (post) {
            for (const p of post.params || []) if (p.name === varName && p.value) return String(p.value);
            if (typeof post.text === 'string') {
                const m = post.text.match(new RegExp(`(?:^|[?&])${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^&\\s]+)`));
                if (m) try { return decodeURIComponent(m[1]); } catch { return m[1]; }
            }
        }
        for (const h of req.headers || []) if (h.name === varName && h.value) return String(h.value);
    }
    return '';
}

module.exports = { generate, _internal: { repairStaticOauthConstants, filterBareOauthStateNonceCorrelations, filterParameterCandidates, detectAndRevertParameterCorruption, detectRecordedNoiseBeacons, detectPolling } };
