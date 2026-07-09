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
const seniorPe = require('./senior-pe');
const playbooks = require('./playbooks');
const scenario = require('./scenario');
const outcomeProbe = require('./outcome-probe');
const uploadFiles = require('./upload-files');
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
        try { p = new URL(e.request.url).pathname; } catch { /* keep raw */ }
        const method = (e.request?.method || 'GET').toUpperCase();
        const fp = bodyFingerprint(e);
        return `${method} ${p}${fp ? ' :: ' + fp : ''}`;
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
    '/authorize/resume',
    '/oauth/token',
    '/logout',
    '/v2/logout',
];

const AUTH_SESSION_DISABLE_PROTECT_RE = /\/(?:u\/login(?:\/|\?|$)|user\/login(?:\/|\?|$)|authorization(?:\/|\?|$)|user\/iam\/save(?:\/|\?|$)|jwt\/v2\/create-cookie(?:\/|\?|$)|s\/interceptor\/authorize(?:\/|\?|$)|iam\/callback(?:\/|\?|$))/i;
const AUTH_HOST_RE = /(?:^|[.-])(?:login|auth|sso|iam)(?:[.-]|$)|webpt|stage|stg/i;
const SAFE_DISABLE_NOISE_RE = /ohttp|safebrowsing|domainreliability|beacon|gstatic|launchdarkly|\/sdk\/evalx|\/avatar\/|\/_next\/data\//i;
const MUTATING_METHOD_RE = /^(POST|PUT|PATCH|DELETE)$/i;

function filterParameterCandidates(candidates, policy = {}) {
    const include = toLowerList(policy.includeNames);
    const exclude = toLowerList(policy.excludeNames);
    return (candidates || []).filter(c => {
        if (isGraphqlOperationDocument(c)) return false;
        const name = String(c.name || '').toLowerCase();
        if (include.length && !include.some(term => name.includes(term))) return false;
        if (exclude.length && exclude.some(term => name.includes(term))) return false;
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

function shouldProtectDisableTarget(sampler = {}, runCfg = {}) {
    if (runCfg.allowUnsafeDisableProtected === true) return false;
    const hay = `${sampler.name || ''} ${sampler.domain || ''}${sampler.path || ''}`;
    if (SAFE_DISABLE_NOISE_RE.test(hay)) return false;
    if (matchesConfiguredPattern(hay, runCfg.protectedCalls)) return true;
    if (AUTH_SESSION_DISABLE_PROTECT_RE.test(sampler.path || '')) return true;
    if (MUTATING_METHOD_RE.test(sampler.method || methodFromSamplerName(sampler.name)) && /^\/?$/.test(String(sampler.path || '/'))) return true;
    if (MUTATING_METHOD_RE.test(sampler.method || methodFromSamplerName(sampler.name)) && AUTH_HOST_RE.test(sampler.domain || '')) return true;
    if (/GraphQL mutation/i.test(sampler.name || '') && /(login|authenticate|verify|token|session)/i.test(hay)) return true;
    return false;
}

function matchesConfiguredPattern(hay, patterns) {
    return Array.isArray(patterns) && patterns.some(p => p && String(hay || '').includes(String(p)));
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
    const filter = new FilterEngine();
    const bgAuth = filter.detectBackgroundAuthIndices(entriesRaw);
    const flat = [];
    entriesRaw.forEach((e, i) => {
        const u = e.request?.url || '';
        if (bgAuth.has(i)) return;
        if (filter.isTunnelRequest(e) || filter.isStaticAsset(u) || filter.isExcludedPath(u) ||
            filter.isAnalyticsDomain(u) || filter.isBrowserNoise(u)) return;
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

    // 3. Group into transactions by pageref.
    const order = []; const gbp = new Map();
    const pageById = new Map((pages || []).map(p => [p.id, p]));
    for (const e of flat) {
        const pid = e.pageref || '__u';
        if (!gbp.has(pid)) { gbp.set(pid, []); order.push(pid); }
        gbp.get(pid).push(e);
    }
    const groups = order.map(pid => ({ name: (pageById.get(pid)?.title) || 'Transaction', type: 'transaction', entries: gbp.get(pid) }));

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
    const candidates = filterParameterCandidates(rawCandidates, runCfg.parameterization || {});
    const skippedParameterCandidates = rawCandidates.length - candidates.length;
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
        fs.writeFileSync(path.join(outDir, csvFile),
            synthesizeCsv(candidates.map(c => ({ name: c.name, sample: c.value })),
                Math.max(dataRows, (scenarioPlan && scenarioPlan.uniqueRows) || 0)));
        fs.writeFileSync(path.join(outDir, `${name}_parameters.json`), JSON.stringify(candidates, null, 2));
        params = candidates.map(c => ({
            variableName: c.name, name: c.name,
            originalValue: c.value, value: c.value,
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

    // runCfg.mineAssertions === false is the replanner's "assertion relief"
    // strategy: regenerate without mined text assertions to separate "text
    // drifted" from "flow broken" (outcome probe + business guard remain).
    const assertInj = runCfg.mineAssertions === false
        ? { xml, injected: 0 }
        : injectAssertionsFromMined(xml, flat, corrs.map(c => c.value).filter(Boolean));
    xml = assertInj.xml;
    if (assertInj.injected) note('assertions',
        `${assertInj.injected} sampler(s) had stable response text to assert on`,
        `mined HTML titles / JSON status keys / page headings from recording`,
        `injected ResponseAssertion (substring, OR) per sampler`);
    if (runCfg.mineAssertions === false) note('assertions',
        'mined text assertions disabled for this attempt',
        'replan strategy: separate assertion strictness from real flow breakage',
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
    const disablePatterns = [
        ...((runCfg && runCfg.disableDefaultNoise === false) ? [] : DEFAULT_DISABLE_PATTERNS),
        ...((runCfg && runCfg.disableCalls) || []),
    ];
    if (disablePatterns.length) {
        const dis = disableSamplersByPattern(xml, disablePatterns, {
            protect: sampler => shouldProtectDisableTarget(sampler, runCfg),
        });
        xml = dis.xml; disabledCount = dis.disabled;
        if (dis.disabled) note('disable-calls',
            `${dis.disabled} browser/OIDC/noise sampler(s) disabled`,
            `matched: ${dis.hits.slice(0, 8).join(', ')}`,
            `set enabled=false so JMeter skips non-business / un-replayable plumbing`);
        if (dis.skippedProtected && dis.skippedProtected.length) note('disable-calls-protected',
            `${dis.skippedProtected.length} disable match(es) blocked because they are auth/session producers`,
            `kept enabled: ${dis.skippedProtected.slice(0, 8).join(', ')}`,
            `protected producers must execute; set run.allowUnsafeDisableProtected=true only for a deliberate expert override`);
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

    // Re-validate after our edits so reported stats reflect what we ship.
    // The engine validator's look-back misses CSV/UDV-supplied variables, so
    // filter those out the same way the repair path does — stats.orphans must
    // mean "actually undefined at runtime", not "validator couldn't see it".
    vr = dryRunValidator.validate(xml, corrs);
    const finalDefined = knownDefinedVars(xml, params.map(p => p.variableName || p.name));
    vr = { ...vr, orphanReferences: (vr.orphanReferences || []).filter(o => !finalDefined.has(o.variable)) };

    const jmxPath = path.join(outDir, `${name}.jmx`);
    fs.writeFileSync(jmxPath, xml);

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
        effectiveLlmFlowNotes: runCfg.llmFlowNotes || [],
        scenario: scenarioPlan,
        uploadFiles: uploadPlan,
        nativeManagers,
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

module.exports = { generate, _internal: { repairStaticOauthConstants, filterBareOauthStateNonceCorrelations, filterParameterCandidates } };
