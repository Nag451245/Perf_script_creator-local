'use strict';
/**
 * outcome-probe.js — verify the business OUTCOME, not just the conversation.
 *
 * The last false-green a status-and-shape verdict can't catch: every request
 * 200s but the task was never actually created. A senior's final check is to
 * look at the app afterwards. The recording already contains that look: some
 * later read request's response ECHOES the distinctive value the business
 * mutation submitted (the created task's title shows up in the task table).
 *
 * This module finds that echo pair — (mutating request submits V) →
 * (later response contains V) — entirely from recorded evidence, and injects
 * a ResponseAssertion on the echoing sampler. If the submitted field was
 * parameterized, the assertion uses ${var} so it tracks the runtime value.
 */
const { _internal: { goalTermsFor } } = require('./business-guard');

const MUTATING = /^(POST|PUT|PATCH)$/i;

/**
 * @returns {null | { mutatingIndex, mutatingLabel, probeIndex, probeLabel, text, isVariable }}
 */
function planOutcomeProbe({ entries = [], flowName = '', params = [], runCfg = {} } = {}) {
    const goalTerms = goalTermsFor(flowName, runCfg);
    const paramByValue = new Map(
        (params || [])
            .filter(p => p.originalValue && String(p.originalValue).length >= 6)
            .map(p => [String(p.originalValue), p.variableName || p.name])
    );

    // Business mutation: prefer goal-term matches, else the LAST first-party mutation.
    const candidates = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const method = (e.request && e.request.method) || 'GET';
        if (!MUTATING.test(method)) continue;
        const hay = `${e.request.url} ${(e.request.postData && e.request.postData.text) || ''}`.toLowerCase();
        const goalHit = goalTerms.length && goalTerms.every(t => hay.includes(t));
        candidates.push({ index: i, goalHit });
    }
    if (!candidates.length) return null;
    const ordered = [...candidates.filter(c => c.goalHit), ...candidates.filter(c => !c.goalHit).reverse()];

    for (const cand of ordered) {
        const e = entries[cand.index];
        for (const value of submittedValues(e)) {
            // Distinctive = never seen in any response BEFORE the mutation.
            let seenBefore = false;
            for (let j = 0; j < cand.index && !seenBefore; j++) {
                if (responseBody(entries[j]).includes(value)) seenBefore = true;
            }
            if (seenBefore) continue;
            for (let j = cand.index + 1; j < entries.length; j++) {
                if (!responseBody(entries[j]).includes(value)) continue;
                const varName = paramByValue.get(value);
                return {
                    mutatingIndex: cand.index,
                    mutatingLabel: label(entries[cand.index], cand.index),
                    probeIndex: j,
                    probeLabel: label(entries[j], j),
                    text: varName ? '${' + varName + '}' : value,
                    isVariable: !!varName,
                };
            }
        }
    }
    return null;
}

/** Candidate distinctive values the mutation submitted (JSON leaves + form fields). */
function submittedValues(entry) {
    const out = [];
    const post = entry.request && entry.request.postData;
    if (!post) return out;
    const push = (v) => {
        const s = String(v == null ? '' : v).trim();
        if (s.length < 6 || s.length > 120) return;
        if (/^[\d.:-]+$/.test(s)) return;              // timestamps/ids — too churny
        if (/^(true|false|null)$/i.test(s)) return;
        if (s.includes('<') || s.includes('${')) return;
        out.push(s);
    };
    for (const p of post.params || []) push(p.value);
    const text = post.text || '';
    if (text.startsWith('{') || text.startsWith('[')) {
        try { walkJson(JSON.parse(text), push); } catch { /* not JSON */ }
    }
    // Longest first — most distinctive.
    return [...new Set(out)].sort((a, b) => b.length - a.length).slice(0, 12);
}

function walkJson(node, visit, depth = 0) {
    if (depth > 6 || node == null) return;
    if (typeof node === 'string') { visit(node); return; }
    if (Array.isArray(node)) { for (const v of node) walkJson(v, visit, depth + 1); return; }
    if (typeof node === 'object') { for (const v of Object.values(node)) walkJson(v, visit, depth + 1); }
}

function responseBody(entry) {
    return (entry && entry.response && entry.response.content && entry.response.content.text) || '';
}

function label(entry, index) {
    let p = '';
    try { p = new URL(entry.request.url).pathname; } catch { /* keep empty */ }
    return `Step ${String(index + 1).padStart(2, '0')} - ${(entry.request && entry.request.method) || 'GET'} ${p}`;
}

/**
 * Inject the probe assertion into the probe sampler's hashTree. The sampler
 * is addressed by ORDER (flat-entry index == sampler order), not by name —
 * GraphQL samplers carry operation names, not METHOD /path labels.
 */
function injectOutcomeProbe(xml, probe) {
    if (!probe) return { xml, injected: 0 };
    const { injectAfterSampler } = require('./extractors');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const block = `
            <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="OUTCOME PROBE: business result visible" enabled="true">
              <collectionProp name="Asserion.test_strings">
                <stringProp name="outcome_probe_0">${esc(probe.text)}</stringProp>
              </collectionProp>
              <stringProp name="Assertion.custom_message">Business outcome missing: the value submitted by "${esc(probe.mutatingLabel)}" never appeared in this response — the flow "passed" without doing its job.</stringProp>
              <stringProp name="Assertion.test_field">Assertion.response_data</stringProp>
              <boolProp name="Assertion.assume_success">false</boolProp>
              <intProp name="Assertion.test_type">16</intProp>
            </ResponseAssertion>
            <hashTree/>`;
    const next = injectAfterSampler(xml, probe.probeIndex, block);
    return { xml: next, injected: next === xml ? 0 : 1 };
}

module.exports = { planOutcomeProbe, injectOutcomeProbe, _internal: { submittedValues } };
