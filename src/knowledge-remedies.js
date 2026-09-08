'use strict';
/**
 * knowledge-remedies.js — knowledge that FIXES, not just warns.
 *
 * The knowledge base recognises a stale ASP.NET __VIEWSTATE, a JSF ViewState,
 * a SAML assertion, a CSRF token — and then only tells you about it. That is
 * a checklist, not an engineer. This turns a recognised issue into a repair.
 *
 * The whole catalogue collapses to ONE action, which is why this is worth
 * doing as data rather than five more modules: every one of those issues is
 * "a request sends a value as a recorded literal, and an earlier response
 * produced it". Extract it there, use it here. A new framework someone adds
 * to the knowledge file gets fixed with no code change at all.
 *
 * WHY THIS IS SAFE TO LET NEAR A SCRIPT — the rule stays "knowledge proposes,
 * EVIDENCE disposes", so a remedy may only run when:
 *   1. the entry's `when` conditions actually matched this script;
 *   2. a PRODUCER for the exact value exists in the recording; and
 *   3. planExtractor PROVES its extractor reproduces that value when run
 *      against the recorded response — an unproven extractor is discarded,
 *      never shipped hopefully.
 * Substitution is position-aware (never before the producer runs), never
 * touches a value already correlated, and every repair is reported with the
 * evidence behind it. One config flag disables the lot.
 */

const ENTITY_LIKE_RE = /^[A-Za-z0-9_\-+/=%.]+$/;

function paramsOf(entry) {
    const pd = (entry && entry.request && entry.request.postData) || null;
    if (!pd) return [];
    if (Array.isArray(pd.params) && pd.params.length) {
        return pd.params.map(p => ({ name: String(p.name || ''), value: String(p.value == null ? '' : p.value) }));
    }
    const text = String(pd.text || '');
    if (!text || text.trim().startsWith('{')) return [];
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

/** A JMeter-safe variable name derived from the parameter's own name. */
function varNameFor(paramName, taken) {
    let base = String(paramName || 'value').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '') || 'value';
    if (/^\d/.test(base)) base = `v_${base}`;
    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base}_${n++}`;
    taken.add(name);
    return name;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Find repairs for one `correlateParam` remedy: every request parameter whose
 * name matches, whose value is still a recorded literal, and for which a
 * producing response exists earlier in the flow.
 */
function planCorrelations({ entries = [], namePattern = '', minLength = 8, planExtractor, taken = new Set() } = {}) {
    let re;
    try { re = new RegExp(namePattern, 'i'); } catch { return []; }
    const plans = [];
    const seen = new Set();
    for (let ci = 0; ci < entries.length; ci++) {
        for (const p of paramsOf(entries[ci])) {
            const value = p.value;
            if (!p.name || !re.test(p.name)) continue;
            if (value.length < minLength || value.includes('${')) continue;
            if (!ENTITY_LIKE_RE.test(value)) continue;
            if (seen.has(p.name + '=' + value)) continue;
            // A producer must exist BEFORE the consumer — otherwise the value
            // is client-side or arrives later, and no extractor can help.
            let producerIndex = -1;
            for (let pi = 0; pi < ci; pi++) {
                if (bodyOf(entries[pi]).includes(value)) { producerIndex = pi; break; }
            }
            if (producerIndex < 0) continue;
            const varName = varNameFor(p.name, taken);
            // planExtractor PROVES the extractor against the recorded response.
            const plan = planExtractor(varName, [{ name: varName, value }], entries, ci);
            if (!plan) { taken.delete(varName); continue; }
            seen.add(p.name + '=' + value);
            plans.push({ param: p.name, varName, value, producerIndex, consumerIndex: ci, plan });
        }
    }
    return plans;
}

/**
 * Apply the proven correlations to the rendered script: attach each extractor
 * under its producer, then replace the literal with ${var} — but only in
 * samplers that run AFTER the producer, since a variable cannot be referenced
 * before it exists.
 */
function applyCorrelations(xml, plans = [], { injectAfterSampler } = {}) {
    let out = String(xml || '');
    const applied = [];
    for (const p of plans) {
        const before = out;
        out = injectAfterSampler(out, p.plan.sourceOrder, p.plan.block);
        const bounded = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(xmlEsc(p.value))}(?![A-Za-z0-9_])`, 'g');
        let order = -1;
        let substituted = 0;
        out = out.replace(/<HTTPSamplerProxy\b[\s\S]*?<\/HTTPSamplerProxy>/g, (block) => {
            order++;
            if (order <= p.plan.sourceOrder) return block;
            return block.replace(/(<stringProp name="(?:Argument\.value|HTTPSampler\.path|Header\.value)">)([^<]*)(<\/stringProp>)/g,
                (_m, open, content, close) => {
                    const next = content.replace(bounded, () => { substituted++; return '${' + p.varName + '}'; });
                    return open + next + close;
                });
        });
        if (!substituted) { out = before; continue; }   // nothing to fix => change nothing
        applied.push({ param: p.param, varName: p.varName, substituted, source: p.plan.sourceLabel });
    }
    return { xml: out, applied };
}

/**
 * Run every matched knowledge finding that carries a `fix`.
 * @returns {{xml, applied: Array, notes: Array}}
 */
function applyKnowledgeRemedies(xml, { entries = [], findings = [], knowledge = [], planExtractor, injectAfterSampler, taken = new Set() } = {}) {
    if (!planExtractor || !injectAfterSampler) return { xml, applied: [], notes: [] };
    const byId = new Map((knowledge || []).map(e => [e.id, e]));
    let out = String(xml || '');
    const applied = [];
    const notes = [];
    for (const finding of findings || []) {
        const entry = byId.get(finding.id);
        const fix = entry && entry.fix;
        if (!fix || fix.action !== 'correlateParam') continue;
        const plans = planCorrelations({
            entries, namePattern: fix.namePattern, minLength: fix.minLength || 8, planExtractor, taken,
        });
        if (!plans.length) {
            notes.push(`${finding.id}: recognised, but no provable producer for it in this recording — left for a human`);
            continue;
        }
        const res = applyCorrelations(out, plans, { injectAfterSampler });
        out = res.xml;
        for (const a of res.applied) applied.push({ ...a, knowledgeId: finding.id, title: finding.title });
    }
    return { xml: out, applied, notes };
}

module.exports = { applyKnowledgeRemedies, _internal: { planCorrelations, applyCorrelations, varNameFor } };
