'use strict';
/**
 * flow-understanding.js — before doing anything, say what the agent SEES.
 *
 * A senior engineer opens a recording and, within a minute, can tell you what
 * the flow does, what stack it runs on, where the login is, and what the
 * business action is. This module produces that read-through from the
 * recording alone and prints it up front, so the operator can sanity-check
 * the agent's comprehension before a single sampler is generated — and catch
 * "you misread the flow" instantly instead of after a failed run.
 *
 * Pure summary over senior-pe internals + playbook matching; no side effects.
 */
const seniorPe = require('./senior-pe');
const playbooks = require('./playbooks');

/**
 * @returns {{ lines: string[], summary: object }}
 *   lines — ready-to-log, human-readable understanding.
 */
function summarizeFlow({ entries = [], pages = [], runCfg = {} } = {}) {
    const flow = seniorPe._internal.reconstructFlow(entries, pages);
    const fingerprint = seniorPe._internal.fingerprintStack(entries);
    const managers = seniorPe._internal.auditNativeManagers(entries);
    const hosts = topHosts(entries);
    const businessAction = inferBusinessAction(entries);
    const authStyle = inferAuthStyle(entries, fingerprint);
    const dataInputs = inferDataInputs(entries);
    const pbResult = playbooks.applyPlaybooks({ entries, fingerprintSignals: fingerprint.signals || [], runCfg });

    const lines = [];
    lines.push('── Flow understanding ──────────────────────────────');
    lines.push(`Business flow: ${conciseNarrative(flow)}`);
    if (businessAction) lines.push(`Primary business action: ${businessAction}`);
    lines.push(`Application host(s): ${hosts.primary}${hosts.thirdParty.length ? ` · third-party: ${hosts.thirdParty.slice(0, 4).join(', ')}` : ''}`);
    lines.push(`Auth / session: ${authStyle}`);
    if (fingerprint.signals && fingerprint.signals.length) {
        lines.push(`Tech stack detected: ${fingerprint.signals.map(s => s.stack).join(', ')}`);
    }
    if (managers.length) {
        lines.push(`Native managers advised: ${managers.map(m => `${m.manager} (${m.decision})`).join(', ')}`);
    }
    if (dataInputs.length) {
        lines.push(`User-input data to parameterize: ${dataInputs.slice(0, 8).join(', ')}`);
    }
    if (pbResult.applied.length) {
        lines.push(`Playbooks matched: ${pbResult.applied.map(p => p.id).join(', ')}`);
        for (const p of pbResult.applied) {
            for (const e of (p.expectations || []).slice(0, 2)) lines.push(`  • ${p.id}: ${e}`);
        }
    }
    if (runCfg.testObjective) lines.push(`Stated objective: ${runCfg.testObjective}`);
    if (Array.isArray(runCfg.domainNotes) && runCfg.domainNotes.length) {
        lines.push(`Operator domain notes: ${runCfg.domainNotes.join(' · ')}`);
    } else if (typeof runCfg.domainNotes === 'string' && runCfg.domainNotes.trim()) {
        lines.push(`Operator domain notes: ${runCfg.domainNotes.trim()}`);
    }
    lines.push('────────────────────────────────────────────────────');

    return {
        lines,
        summary: {
            narrative: flow.narrative,
            businessAction,
            authStyle,
            hosts,
            stack: (fingerprint.signals || []).map(s => s.stack),
            playbooks: pbResult.applied.map(p => p.id),
            dataInputs,
        },
    };
}

/**
 * The raw narrative alternates "navigate/read -> authenticate" dozens of times
 * on a long flow — noise. Collapse to the DISTINCT business phases in order of
 * first appearance, which reads like a real flow summary.
 */
function conciseNarrative(flow) {
    const seen = new Set();
    const phases = [];
    for (const s of flow.businessSteps || []) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        phases.push(s.name);
    }
    if (!phases.length) return flow.narrative;
    if (phases.length > 9) return phases.slice(0, 9).join(' → ') + ` → … (${phases.length} distinct phases)`;
    return phases.join(' → ');
}

function topHosts(entries) {
    const counts = new Map();
    for (const e of entries) {
        try { const h = new URL(e.request.url).hostname; counts.set(h, (counts.get(h) || 0) + 1); } catch { /* skip */ }
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
    const THIRD = /dynatrace|pendo|googleapis|gstatic|launchdarkly|newrelic|nr-data|ruxit|gravatar|safebrowsing|doubleclick|segment|amplitude|analytics/i;
    const firstParty = sorted.filter(h => !THIRD.test(h));
    const thirdParty = sorted.filter(h => THIRD.test(h));
    return { primary: firstParty[0] || sorted[0] || 'unknown', firstParty, thirdParty };
}

function inferBusinessAction(entries) {
    const MUT = /^(POST|PUT|PATCH|DELETE)$/i;
    const VERB = /\/(create|save|submit|upload|print|export|update|delete|tasks?|order|checkout|book|schedule|authorize)/i;
    const candidates = [];
    for (const e of entries) {
        const method = String(e.request && e.request.method || 'GET').toUpperCase();
        if (!MUT.test(method)) continue;
        let p = ''; try { p = new URL(e.request.url).pathname; } catch { /* skip */ }
        const gql = graphqlOp(e);
        if (gql) candidates.push(`GraphQL ${gql}`);
        else if (VERB.test(p)) candidates.push(`${method} ${p}`);
    }
    return candidates.length ? candidates[candidates.length - 1] : null;
}

function graphqlOp(entry) {
    const body = entry.request && entry.request.postData && entry.request.postData.text || '';
    if (!/graphql/i.test(entry.request && entry.request.url || '') && !/operationName|"query"/.test(body)) return null;
    const m = body.match(/"operationName"\s*:\s*"([^"]+)"/);
    if (m) return `mutation/query ${m[1]}`;
    const q = body.match(/\b(mutation|query)\s+(\w+)/);
    return q ? `${q[1]} ${q[2]}` : 'operation';
}

function inferAuthStyle(entries, fingerprint) {
    const sig = (fingerprint.signals || []).map(s => s.stack).join(' ');
    const hasLogin = entries.some(e => /login|signin|authenticate|identifier|password/i.test(e.request && e.request.url || ''));
    const styles = [];
    if (/SAML/i.test(sig)) styles.push('SAML SSO');
    if (/OAuth|OIDC/i.test(sig)) styles.push('OAuth/OIDC');
    if (entries.some(e => /auth0/i.test(e.request && e.request.url || ''))) styles.push('Auth0');
    if (entries.some(e => (e.response && e.response.headers || []).some(h => /^set-cookie$/i.test(h.name) && /sess|jsessionid|phpsessid|idem|iam/i.test(h.value)))) styles.push('session cookie');
    if (!styles.length && hasLogin) styles.push('form login');
    return styles.length ? styles.join(' + ') : 'none detected (public flow or token in headers)';
}

function inferDataInputs(entries) {
    const names = new Set();
    for (const e of entries) {
        const params = e.request && e.request.postData && e.request.postData.params || [];
        for (const p of params) {
            const n = String(p.name || '');
            if (/user|email|name|date|qty|amount|title|desc|search|query|zip|phone|address/i.test(n) && !/token|csrf|state|nonce/i.test(n)) names.add(n);
        }
    }
    return [...names];
}

module.exports = { summarizeFlow };
