'use strict';
/**
 * js-challenge-token.js — correlate a login/CSRF challenge that a page embeds
 * in inline JavaScript and the client echoes back as a form parameter.
 *
 * The class (seen live on WebPT EMR, but the detection is generic): the launch
 * page responds with
 *     window.lkILUOpHc6Challenge = 'CNzyD6z$yKbQY=...';
 * and the login POST sends  lkILUOpHc6=CNzyD6z$yKbQY=...  — where BOTH the
 * obfuscated parameter NAME and the VALUE rotate (per deploy/session). The
 * dual-recording variance diff cannot catch it when both recordings were taken
 * inside one deployment window (identical values), so the engine ships the
 * recorded literal; on replay the server fails the login SILENTLY — 200, but
 * no session cookie is minted — and everything downstream collapses.
 *
 * Detection is pure evidence, no path/vendor knowledge:
 *   a POST parameter's NAME and VALUE both appear ADJACENTLY (name within a
 *   short window before the value) in an EARLIER response body.
 * The extraction regex is then built from the recording's own context around
 * the pair, with the name and value as capture groups, and PROVEN by executing
 * it against the recorded producer body before anything is wired. Consumers
 * are rewired to ${var} for both the parameter name and value — JMeter
 * evaluates variables in argument names at runtime, so a rotating NAME works.
 */

const NAME_WINDOW = 300;     // name must appear within this many chars before the value
const MID_MAX = 60;          // max literal context between name and value
const MIN_VALUE_LEN = 16;    // short values are too ambiguous to trust
const COMMON_PARAM_RE = /^(userName|username|password|email|rememberMe|token|state|code|nonce)$/i;

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paramsOf(entry) {
    const pd = entry && entry.request && entry.request.postData;
    if (!pd) return [];
    if (Array.isArray(pd.params) && pd.params.length) {
        return pd.params.map(p => ({ name: String(p.name || ''), value: String(p.value || '') }));
    }
    const text = String(pd.text || '');
    if (!text || text.includes('{')) return []; // json bodies handled elsewhere
    return text.split('&').map(kv => {
        const i = kv.indexOf('=');
        if (i < 0) return { name: kv, value: '' };
        try { return { name: decodeURIComponent(kv.slice(0, i)), value: decodeURIComponent(kv.slice(i + 1)) }; }
        catch { return { name: kv.slice(0, i), value: kv.slice(i + 1) }; }
    });
}

function bodyOf(entry) {
    return String((entry && entry.response && entry.response.content && entry.response.content.text) || '');
}

function pathWithQuery(url) {
    try { const u = new URL(url); return u.pathname + (u.search || ''); }
    catch { return String(url || ''); }
}

/** Find js-embedded challenge params: [{producerIndex, producerPath, consumerPath, name, value, regex}] */
function detectJsChallengeTokens(flat = []) {
    const found = [];
    const seen = new Set();
    for (let ci = 0; ci < flat.length; ci++) {
        const entry = flat[ci];
        if (!entry || !/POST|PUT/i.test((entry.request && entry.request.method) || '')) continue;
        for (const p of paramsOf(entry)) {
            const name = p.name, value = p.value;
            if (!name || value.length < MIN_VALUE_LEN) continue;
            if (COMMON_PARAM_RE.test(name)) continue;
            if (value.includes('${')) continue;
            if (seen.has(name + '=' + value)) continue;
            for (let pi = 0; pi < ci; pi++) {
                const body = bodyOf(flat[pi]);
                if (!body) continue;
                const at = body.indexOf(value);
                if (at < 0) continue;
                const windowStart = Math.max(0, at - NAME_WINDOW);
                const nameAt = body.lastIndexOf(name, at);
                if (nameAt < windowStart || nameAt < 0) continue;
                const mid = body.slice(nameAt + name.length, at);
                if (mid.length > MID_MAX) continue;
                const post = body[at + value.length] || '';
                if (!post) continue;
                const pre = body.slice(Math.max(0, nameAt - 12), nameAt);
                const regexStr = escRe(pre) + '([A-Za-z0-9_$-]{2,64})' + escRe(mid) +
                    '([^' + escRe(post) + ']+)' + escRe(post);
                let proof = null;
                try { proof = new RegExp(regexStr).exec(body); } catch { proof = null; }
                if (!proof || proof[1] !== name || proof[2] !== value) continue; // regex must reproduce the pair
                found.push({
                    producerIndex: pi,
                    producerPath: pathWithQuery(flat[pi].request && flat[pi].request.url),
                    producerMethod: String((flat[pi].request && flat[pi].request.method) || 'GET').toUpperCase(),
                    consumerPath: pathWithQuery(entry.request && entry.request.url),
                    name, value, regex: regexStr,
                });
                seen.add(name + '=' + value);
                break;
            }
        }
    }
    return found;
}

function extractorXml(refname, regex, group, label) {
    return [
        `<RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="${xmlEsc(label)}" enabled="true">`,
        `  <stringProp name="RegexExtractor.useHeaders">false</stringProp>`,
        `  <stringProp name="RegexExtractor.refname">${xmlEsc(refname)}</stringProp>`,
        `  <stringProp name="RegexExtractor.regex">${xmlEsc(regex)}</stringProp>`,
        `  <stringProp name="RegexExtractor.template">$${group}$</stringProp>`,
        `  <stringProp name="RegexExtractor.default">${xmlEsc(refname.toUpperCase())}_NOT_FOUND</stringProp>`,
        `  <stringProp name="RegexExtractor.match_number">1</stringProp>`,
        `</RegexExtractor>`,
        `<hashTree/>`,
    ].join('\n');
}

/**
 * Wire detected challenge tokens into the rendered JMX: attach name+value
 * extractors under the producer sampler, rewrite every consumer argument
 * (name attr, Argument.name, Argument.value) to the ${vars}.
 */
function correlateJsChallengeToken(xml, flat = []) {
    const tokens = detectJsChallengeTokens(flat);
    const applied = [];
    const wired = [];
    let out = String(xml || '');
    let seq = 0;
    for (const t of tokens) {
        const ref = `js_challenge_${++seq}`;
        const escName = xmlEsc(t.name), escValue = xmlEsc(t.value);
        // 1. Rewire consumers FIRST, on a candidate copy. Both the argument NAME
        //    and the recorded literal VALUE must match — a field the pipeline
        //    already parameterized (Argument.value = ${var}) is left alone, so
        //    this can never half-rewire a CSV/date-shifted parameter.
        let rewired = 0;
        const candidate = out.replace(/<elementProp name="([^"]*)" elementType="HTTPArgument">([\s\S]*?)<\/elementProp>/g, (whole, argName, inner) => {
            if (argName !== escName) return whole;
            if (!inner.includes(`<stringProp name="Argument.value">${escValue}</stringProp>`)) return whole;
            rewired++;
            return whole
                .replace(`<elementProp name="${escName}"`, `<elementProp name="\${${ref}_name}"`)
                .replace(`<stringProp name="Argument.name">${escName}</stringProp>`, `<stringProp name="Argument.name">\${${ref}_name}</stringProp>`)
                .replace(`<stringProp name="Argument.value">${escValue}</stringProp>`, `<stringProp name="Argument.value">\${${ref}_value}</stringProp>`);
        });
        if (!rewired) { seq--; continue; } // nothing consumed the literal — no extractors, no change
        // 2. Attach both extractors under the producer sampler (first enabled
        //    sampler with the producer's method+path); commit only if found.
        const blockRe = /<HTTPSamplerProxy\b([^>]*)>([\s\S]*?)<\/HTTPSamplerProxy>\s*<hashTree>/g;
        let m, committed = false;
        while ((m = blockRe.exec(candidate)) !== null) {
            const attrs = m[1] || '', inner = m[2] || '';
            if (/enabled="false"/.test(attrs)) continue;
            const path = (inner.match(/<stringProp name="HTTPSampler\.path">([^<]*)<\/stringProp>/) || [])[1] || '';
            const method = (inner.match(/<stringProp name="HTTPSampler\.method">([^<]*)<\/stringProp>/) || [])[1] || '';
            if (method.toUpperCase() !== t.producerMethod) continue;
            if (path !== xmlEsc(t.producerPath) && path !== t.producerPath) continue;
            const insertAt = m.index + m[0].length;
            const block = '\n' +
                extractorXml(`${ref}_name`, t.regex, 1, `Extract challenge name (${t.name})`) + '\n' +
                extractorXml(`${ref}_value`, t.regex, 2, `Extract challenge value (${t.name})`) + '\n';
            out = candidate.slice(0, insertAt) + block + candidate.slice(insertAt);
            committed = true;
            break;
        }
        if (!committed) { seq--; continue; }
        applied.push({ name: t.name, producerPath: t.producerPath, consumerPath: t.consumerPath, rewired, ref });
        // Carry the proven regex + recorded value so a LIVE probe can later ask
        // the real page whether this value actually rotates (evidence that the
        // correlation is required) without re-deriving anything.
        wired.push({ name: t.name, value: t.value, regex: t.regex, producerPath: t.producerPath, ref });
    }
    return { xml: out, applied, tokens: wired };
}

module.exports = { correlateJsChallengeToken, _internal: { detectJsChallengeTokens } };
