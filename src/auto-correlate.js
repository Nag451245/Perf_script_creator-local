'use strict';
/**
 * auto-correlate.js — the agent's correlation engine, per ~/.claude/skills/
 * jmeter-correlation. Given two recordings of the same flow (variance pair) and
 * the JMX to fix, it:
 *   1. IDENTIFIES dynamics by variance (value differs run1 vs run2), req + resp.
 *   2. CLASSIFIES each by WHERE it is produced and derives the right extractor
 *      (JSON / CSS-hidden-field / Set-Cookie+header regex / Location regex).
 *   3. Handles the special CONSUMED-AS classes:
 *        - cookie value reused in a body  (sessionId = "Token <sess-cookie>")
 *        - client-generated (no producer) → synthesize (UUID/time/PKCE/state).
 *   4. EMITS the extractor after its producer sampler and substitutes ${var}
 *      at every consumer.
 *
 * Pure string/JMX surgery; no app-specific hardcoding — the field NAME and
 * location come from the recordings, so it generalizes to any app.
 */
const { injectAfterSampler } = require('./extractors');

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escXml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NOISE_NAME = /^(content-length|user-agent|host|cache-control|accept|accept-.*|sec-.*|upgrade-insecure-requests|connection|referer|origin|x-goog.*|priority|pragma|dnt|te|date|content-type|x-client-data|cookie)$/i;
const THIRDPARTY = /dynatrace|pendo|gvt2|beacons|googleapis|gstatic|safebrowsing|ruxit|newrelic|nr-data/i;

function reqResBlob(e) {
    return [
        e.request && e.request.url,
        e.request && e.request.postData && e.request.postData.text,
        (e.request && e.request.headers || []).map(h => `${h.name}=${h.value}`).join('|'),
        e.response && e.response.content && e.response.content.text,
        (e.response && e.response.headers || []).map(h => `${h.name}=${h.value}`).join('|'),
    ].join(' ');
}

/** Identify dynamics: named values present in run1 but absent from run2 (and v/v). */
function identifyDynamics(e1, e2) {
    const r2 = e1.length && e2.length ? e2.map(reqResBlob).join('\n') : '';
    const named = new Map();
    const add = (name, val) => {
        if (!name || !val || val.length < 10) return;
        if (NOISE_NAME.test(name)) return;
        if (!/[0-9]/.test(val) || !/[A-Za-z]/.test(val)) return;
        const k = `${name}::${val}`;
        if (!named.has(k)) named.set(k, { name, value: val });
    };
    for (const e of e1) {
        const url = (e.request && e.request.url) || '';
        if (THIRDPARTY.test(url)) continue;
        try { const u = new URL(url); for (const [k, v] of u.searchParams) add(k, v); } catch { /* */ }
        const body = (e.request && e.request.postData && e.request.postData.text) || '';
        for (const m of body.matchAll(/"(\w+)"\s*:\s*"([^"]{10,})"/g)) add(m[1], m[2]);
        for (const m of body.matchAll(/(\w+)=([^&\s"]{10,})/g)) add(m[1], decodeURIComponent(m[2]));
        for (const h of (e.request && e.request.headers) || []) add(h.name, h.value);
        const resp = (e.response && e.response.content && e.response.content.text) || '';
        for (const m of resp.matchAll(/"(\w+)"\s*:\s*"([^"]{10,})"/g)) add(m[1], m[2]);
        for (const m of resp.matchAll(/name="(\w+)"\s+value="([^"]{10,})"/g)) add(m[1], m[2]);
    }
    // dynamic = value not present anywhere in run2 (session-specific); dedupe by name+value
    const out = [];
    for (const d of named.values()) if (!r2.includes(d.value)) out.push(d);
    return out;
}

/**
 * Classify a value by WHERE it is produced in a response → derive an extractor.
 * Returns { producerUrl, kind, refName, expr, attr?, useHeaders?, prefix? } or
 * { kind:'synthesize' } when no server produces it (client-generated).
 */
function deriveExtractor(value, entries, varName) {
    for (const e of entries) {
        const r = e.response || {};
        const body = (r.content && r.content.text) || '';
        const hdrs = (r.headers || []).map(h => `${h.name}: ${h.value}`).join('\n');
        const url = (e.request && e.request.url) || '';

        // Set-Cookie (or any response header) — RegexExtractor useHeaders.
        let m = hdrs.match(new RegExp('([\\w.-]+)=' + escRe(value)));        // Set-Cookie: NAME=VALUE
        if (m) return { producerUrl: url, kind: 'regex', useHeaders: true, refName: varName, expr: `${escRe(m[1])}=([^;\\s]+)` };
        m = hdrs.match(new RegExp('([\\w-]+):\\s*' + escRe(value)));          // Header: VALUE
        if (m) return { producerUrl: url, kind: 'regex', useHeaders: true, refName: varName, expr: `${escRe(m[1])}:\\s*([^\\r\\n;]+)` };

        // HTML hidden field — CSS/JQuery extractor.
        m = body.match(new RegExp('<input[^>]*name="([^"]+)"[^>]*value="' + escRe(value)))
            || body.match(new RegExp('value="' + escRe(value) + '"[^>]*name="([^"]+)"'));
        if (m) return { producerUrl: url, kind: 'css', refName: varName, expr: `input[name="${m[1]}"]`, attr: 'value' };

        // JSON field — JSON Extractor.
        m = body.match(new RegExp('"(\\w+)"\\s*:\\s*"' + escRe(value)));
        if (m) return { producerUrl: url, kind: 'json', refName: varName, expr: `$..${m[1]}` };

        // Redirect Location / URL param — RegexExtractor.
        m = (hdrs + '\n' + body).match(new RegExp('[?&](\\w+)=' + escRe(value)));
        if (m) return { producerUrl: url, kind: 'regex', useHeaders: /location/i.test(hdrs), refName: varName, expr: `${escRe(m[1])}=([^&"\\s]+)` };
    }
    return { kind: 'synthesize', refName: varName };
}

function extractorXml(d) {
    const def = `${d.refName}_NOTFOUND`;
    if (d.kind === 'css') {
        return `
            <HtmlExtractor guiclass="HtmlExtractorGui" testclass="HtmlExtractor" testname="Extract ${escXml(d.refName)} (CSS)" enabled="true">
              <stringProp name="HtmlExtractor.refname">${escXml(d.refName)}</stringProp>
              <stringProp name="HtmlExtractor.expr">${escXml(d.expr)}</stringProp>
              <stringProp name="HtmlExtractor.attribute">${escXml(d.attr || 'value')}</stringProp>
              <stringProp name="HtmlExtractor.default">${escXml(def)}</stringProp>
              <stringProp name="HtmlExtractor.match_number">1</stringProp>
              <stringProp name="Sample.scope">all</stringProp>
            </HtmlExtractor>
            <hashTree/>`;
    }
    if (d.kind === 'json') {
        return `
            <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="Extract ${escXml(d.refName)} (JSON)" enabled="true">
              <stringProp name="JSONPostProcessor.referenceNames">${escXml(d.refName)}</stringProp>
              <stringProp name="JSONPostProcessor.jsonPathExprs">${escXml(d.expr)}</stringProp>
              <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
              <stringProp name="JSONPostProcessor.defaultValues">${escXml(def)}</stringProp>
            </JSONPostProcessor>
            <hashTree/>`;
    }
    // regex (incl. useHeaders for Set-Cookie / headers / Location)
    return `
            <RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="Extract ${escXml(d.refName)} (regex)" enabled="true">
              <stringProp name="RegexExtractor.useHeaders">${d.useHeaders ? 'true' : 'false'}</stringProp>
              <stringProp name="RegexExtractor.refname">${escXml(d.refName)}</stringProp>
              <stringProp name="RegexExtractor.regex">${escXml(d.expr)}</stringProp>
              <stringProp name="RegexExtractor.template">$1$</stringProp>
              <stringProp name="RegexExtractor.match_number">1</stringProp>
              <stringProp name="RegexExtractor.default">${escXml(def)}</stringProp>
              <stringProp name="Sample.scope">all</stringProp>
            </RegexExtractor>
            <hashTree/>`;
}

/**
 * VERIFY the derived extractor actually captures the recorded value from the
 * recorded producer response. If it doesn't, we must NOT wire it — substituting
 * ${var} for a non-matching extractor injects the DEFAULT (e.g. state_NOTFOUND)
 * into the request and breaks it (this is exactly what degraded login). Only
 * verified extractors get applied; everything else is left as the input had it.
 */
function verifyExtractor(der, value, entries) {
    const e = entries.find(x => (x.request && x.request.url) === der.producerUrl)
        || entries.find(x => pathOf(x.request && x.request.url) === pathOf(der.producerUrl));
    if (!e) return false;
    const r = e.response || {};
    const body = (r.content && r.content.text) || '';
    const hdrs = (r.headers || []).map(h => `${h.name}: ${h.value}`).join('\n');
    try {
        if (der.kind === 'regex') {
            const hay = der.useHeaders ? hdrs : (body + '\n' + hdrs);
            const m = hay.match(new RegExp(der.expr));
            return !!(m && m[1] === value);
        }
        if (der.kind === 'css') {
            const nameM = der.expr.match(/\[name="([^"]+)"\]/);
            if (!nameM) return false;
            const name = nameM[1];
            const m = body.match(new RegExp('name="' + escRe(name) + '"[^>]*value="([^"]*)"'))
                || body.match(new RegExp('value="([^"]*)"[^>]*name="' + escRe(name) + '"'));
            return !!(m && m[1] === value);
        }
        if (der.kind === 'json') {
            const key = der.expr.replace('$..', '');
            const m = body.match(new RegExp('"' + escRe(key) + '"\\s*:\\s*"([^"]*)"'));
            return !!(m && m[1] === value);
        }
    } catch { return false; }
    return false;
}

// A response-capture regex for a rolling-token updater, derived from the extractor.
function rollingPattern(der) {
    if (der.kind === 'json') { const key = der.expr.replace('$..', ''); return `"${key}"\\s*:\\s*"([^"]+)"`; }
    if (der.kind === 'css') { const nm = (der.expr.match(/\[name="([^"]+)"\]/) || [])[1]; return nm ? `name="${nm}"[^>]*value="([^"]+)"` : null; }
    if (der.kind === 'regex') return der.expr;
    return null;
}

// Inject a THREAD-SCOPE JSR223 PostProcessor that refreshes a rotating token's
// var from ANY response that contains it (conditional — never clobbers on miss).
// This is the correct JMeter pattern for a rotating CSRF/token: one updater at
// thread scope runs after every sampler, so the var is always the latest issued.
function injectThreadScopePostProc(xml, varName, pattern) {
    const script = `def s=prev.getResponseDataAsString(); def m=(s=~/${pattern}/); if(m.find()){ vars.put("${varName}", m.group(1)); }`;
    const block = `
      <JSR223PostProcessor guiclass="TestBeanGUI" testclass="JSR223PostProcessor" testname="Roll ${escXml(varName)} (rotating token)" enabled="true">
        <stringProp name="cacheKey">true</stringProp>
        <stringProp name="filename"></stringProp>
        <stringProp name="parameters"></stringProp>
        <stringProp name="script">${escXml(script)}</stringProp>
        <stringProp name="scriptLanguage">groovy</stringProp>
      </JSR223PostProcessor>
      <hashTree/>`;
    const m = xml.match(/<\/ThreadGroup>\s*<hashTree>/);
    if (!m) return xml;
    const at = m.index + m[0].length;
    return xml.slice(0, at) + block + xml.slice(at);
}

// Index JMX samplers with their domain+path so we can match a producer entry.
function indexJmxSamplers(xml) {
    const out = [];
    const re = /<HTTPSamplerProxy\b[^>]*testname="([^"]*)"[^>]*>([\s\S]*?)<\/HTTPSamplerProxy>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const inner = m[2];
        const dom = (inner.match(/<stringProp name="HTTPSampler\.domain">([^<]*)</) || [])[1] || '';
        const pth = (inner.match(/<stringProp name="HTTPSampler\.path">([^<]*)</) || [])[1] || '';
        out.push({ name: m[1], domain: dom, path: pth, start: m.index, end: re.lastIndex });
    }
    return out;
}

function pathOf(u) { try { return new URL(u).pathname; } catch { return (u || '').split('?')[0]; } }

/**
 * Correlate the JMX: for each dynamic, inject its extractor after the producer
 * sampler and replace the recorded value with ${var} everywhere it's consumed.
 * @returns {{ xml, applied:Array, synthesize:Array }}
 */
function correlateJmx(jmxXml, dynamics, entries) {
    let xml = jmxXml;
    const applied = [];
    const synthesize = [];
    let n = 0;

    // GATE: only correlate values that are actually CONSUMED in a request — i.e.
    // the value appears in the JMX (a later request sends it). A value that only
    // appears in responses (per-user data: email, createdAt, task ids) differs
    // between recordings but is NOT a correlation target. This is the line
    // between "dynamic value to correlate" and "response data to ignore".
    dynamics = dynamics.filter(d => jmxXml.includes(d.value));

    // Stable var name per (name,value) to avoid collisions across distinct values.
    const varFor = new Map();
    const nameVar = (name, value) => {
        const k = `${name}::${value}`;
        if (varFor.has(k)) return varFor.get(k);
        let v = name.replace(/[^A-Za-z0-9_]/g, '_');
        const used = new Set(varFor.values());
        if (used.has(v)) { let i = 2; while (used.has(`${v}_${i}`)) i++; v = `${v}_${i}`; }
        varFor.set(k, v); return v;
    };

    // Var name from the extractor's SOURCE field (so x-csrf-token / X-CSRF-TOKEN /
    // csrfToken all collapse to one var when they read the same response field).
    const varNameFromDer = (der) => {
        if (der.kind === 'json') return der.expr.replace('$..', '').replace(/[^A-Za-z0-9_]/g, '_');
        if (der.kind === 'css') return ((der.expr.match(/\[name="([^"]+)"\]/) || [])[1] || 'v').replace(/[^A-Za-z0-9_]/g, '_');
        return ((der.expr.match(/^([\w-]+)[=:]/) || [])[1] || 'v').replace(/[^A-Za-z0-9_]/g, '_');
    };

    // Build VERIFIED plans grouped by EXTRACTOR IDENTITY (same source field), not
    // by request param name. This merges a value that appears under several names
    // (csrfToken in a JSON response, x-csrf-token in a header) into ONE var. A
    // group with MULTIPLE distinct values = a ROTATING token (fresh each response).
    const byExtractor = new Map(); // key -> { der, values:Set, varName }
    for (const d of dynamics) {
        const der = deriveExtractor(d.value, entries, '');
        if (der.kind === 'synthesize') { synthesize.push({ name: d.name, value: d.value, reason: 'client-generated' }); continue; }
        if (!verifyExtractor(der, d.value, entries)) { synthesize.push({ name: d.name, value: d.value, reason: 'extractor-unverified' }); continue; }
        const key = `${der.kind}|${der.expr}|${der.useHeaders ? 1 : 0}`;
        if (!byExtractor.has(key)) byExtractor.set(key, { der, values: new Set(), varName: varNameFromDer(der) });
        byExtractor.get(key).values.add(d.value);
    }
    const byName = byExtractor; // (grouped by extractor; iterate the same way)

    // value -> var map for substitution (all values of a name map to its one var).
    const valToVar = new Map();
    for (const [, g] of byName) for (const v of g.values) valToVar.set(v, g.varName);

    for (const [name, g] of byName) {
        if (g.values.size > 1) {
            // ROTATING: one thread-scope updater (always-latest), no per-producer extractor.
            const pat = rollingPattern(g.der);
            if (pat) {
                xml = injectThreadScopePostProc(xml, g.varName, pat);
                applied.push({ name, var: g.varName, kind: g.der.kind, mode: 'rolling', values: g.values.size });
                continue;
            }
        }
        // ONE-SHOT: inject the extractor into its producer sampler's hashTree.
        const samplers = indexJmxSamplers(xml);
        const prodPath = pathOf(g.der.producerUrl);
        const order = samplers.findIndex(s => s.path && (s.path.split('?')[0] === prodPath || s.path.startsWith(prodPath)));
        if (order < 0) continue;
        const next = injectAfterSampler(xml, order, extractorXml({ ...g.der, refName: g.varName }));
        if (next && next !== xml) { xml = next; applied.push({ name, var: g.varName, kind: g.der.kind, mode: 'oneshot' }); }
    }

    // Substitute every recorded value with its ${var} — SCOPED to request fields
    // (HTTPSamplerProxy + HeaderManager) so we don't corrupt extractors/structure.
    const applyScoped = (block) => {
        let b = block;
        for (const [v, vr] of valToVar) { if (b.includes(v)) { b = b.split(v).join('${' + vr + '}'); n++; } }
        return b;
    };
    xml = xml
        .replace(/<HTTPSamplerProxy[\s\S]*?<\/HTTPSamplerProxy>/g, applyScoped)
        .replace(/<HeaderManager[\s\S]*?<\/HeaderManager>/g, applyScoped);
    return { xml, applied, synthesize, substitutions: n };
}

module.exports = { identifyDynamics, deriveExtractor, correlateJmx, _internal: { indexJmxSamplers, extractorXml } };
