'use strict';

const { _internal: { samplerLabel } } = require('./value-flow-decisions');

const AUTH_PATH_RE = /(?:^|\/)(?:login|logout|auth(?:orize|entication)?|token|session|signin|sign-in|sso|oauth|oidc)(?:\/|$|\?)/i;
const UNSAFE_MUTATION_RE = /(?:^|\/)(?:create|update|delete|remove|order|orders|payment|payments|checkout|purchase|transfer|submit)(?:\/|$|\?)/i;

function planReplayDependencies({
    entries = [],
    targetIndexes = [],
    correlationLedger = null,
    enabledBySampler = new Map(),
} = {}) {
    const targets = [...new Set((targetIndexes || []).map(Number).filter(index => Number.isInteger(index) && entries[index]))].sort((a, b) => a - b);
    const required = new Set(targets);
    const reasons = [];
    const blockedRequirements = [];
    const ledgerEntries = Array.isArray(correlationLedger && correlationLedger.entries) ? correlationLedger.entries : [];
    let needsFlowEntry = false;

    const linksByConsumer = new Map();
    const producerRoles = new Map();
    for (const item of ledgerEntries) {
        for (const link of item.consumerLinks || []) {
            if (!Number.isInteger(link.consumerIndex) || !Number.isInteger(link.producerIndex)) continue;
            const list = linksByConsumer.get(link.consumerIndex) || [];
            list.push({ producerIndex: link.producerIndex, name: item.name, role: item.role, reason: item.reason });
            linksByConsumer.set(link.consumerIndex, list);
            const roles = producerRoles.get(link.producerIndex) || new Set();
            roles.add(item.role);
            producerRoles.set(link.producerIndex, roles);
        }
        if (item.role === 'unresolved' && (item.consumerIndexes || []).some(index => targets.includes(index))) {
            needsFlowEntry = true;
            reasons.push({ kind: 'unresolved_state', indexes: item.consumerIndexes || [], name: item.name, reason: item.reason });
        }
    }

    for (const target of targets) {
        if (hasNativeStateConsumer(entries[target]) || mayNeedSessionForMutation(entries, target)) {
            const authIndexes = precedingNativeAuth(entries, target);
            if (authIndexes.length) {
                for (const index of authIndexes) required.add(index);
                reasons.push({ kind: 'native_session_state', targetIndex: target, indexes: authIndexes });
            }
        }
    }

    const queue = [...required];
    while (queue.length) {
        const consumerIndex = queue.pop();
        for (const link of linksByConsumer.get(consumerIndex) || []) {
            if (link.producerIndex >= consumerIndex || required.has(link.producerIndex)) continue;
            required.add(link.producerIndex);
            queue.push(link.producerIndex);
            reasons.push({ kind: 'exact_producer', consumerIndex, producerIndex: link.producerIndex, name: link.name, role: link.role });
        }
    }

    if (needsFlowEntry && targets.length) {
        const end = Math.max(...targets);
        for (let index = 0; index <= end; index++) required.add(index);
        reasons.push({ kind: 'flow_entry_fallback', start: 0, end, reason: 'unresolved auth/session state cannot be isolated' });
    }

    const indexes = [...required].sort((a, b) => a - b);
    const safeIndexes = [];
    for (const index of indexes) {
        const isTarget = targets.includes(index);
        const risk = mutationRisk(entries[index], producerRoles.get(index));
        if (!isTarget && risk) {
            blockedRequirements.push({
                kind: 'unsafe_mutating_prerequisite',
                index,
                risk: risk.risk,
                reason: risk.reason,
            });
            continue;
        }
        if (!isEnabled(entries[index], index, enabledBySampler)) {
            blockedRequirements.push({
                kind: 'required_disabled_producer',
                index,
                reason: 'A required producer is disabled in the patched JMX.',
            });
            safeIndexes.push(index);
            continue;
        }
        safeIndexes.push(index);
    }

    return {
        indexes: safeIndexes,
        start: safeIndexes.length ? safeIndexes[0] : null,
        end: safeIndexes.length ? safeIndexes[safeIndexes.length - 1] : null,
        reasons,
        requiredProducers: safeIndexes.filter(index => !targets.includes(index)),
        targetIndexes: targets,
        blocked: blockedRequirements.length > 0,
        blockedRequirements,
        status: blockedRequirements.length ? 'UNVERIFIED' : 'PLANNED',
    };
}

function hasNativeStateConsumer(entry) {
    return (entry && entry.request && (entry.request.headers || []) || [])
        .some(header => /^(cookie|authorization)$/i.test(String(header.name || '')));
}

function mayNeedSessionForMutation(entries, target) {
    const method = String(entries[target] && entries[target].request && entries[target].request.method || 'GET').toUpperCase();
    return method !== 'GET' && precedingNativeAuth(entries, target).length > 0;
}

function precedingNativeAuth(entries, target) {
    const auth = [];
    let found = false;
    for (let index = target - 1; index >= 0; index--) {
        if (isAuthPrerequisite(entries[index])) {
            auth.push(index);
            found = true;
        } else if (found) {
            break;
        }
    }
    return auth.reverse();
}

function isAuthPrerequisite(entry) {
    const request = entry && entry.request || {};
    const responseHeaders = entry && entry.response && entry.response.headers || [];
    const url = String(request.url || '');
    return AUTH_PATH_RE.test(url)
        || responseHeaders.some(header => /^set-cookie$/i.test(String(header.name || '')))
        || (String(request.method || '').toUpperCase() === 'POST' && /(?:token|session|auth|login)/i.test(url));
}

function mutationRisk(entry, producerRoles = new Set()) {
    const request = entry && entry.request || {};
    const method = String(request.method || 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
    if (isAuthPrerequisite(entry)) return null;
    const url = String(request.url || '');
    if (UNSAFE_MUTATION_RE.test(url)) return { risk: 'business_mutation', reason: 'Business mutation requires full JMeter verification and is not automatically replayed.' };
    if (producerRoles.has('server-issued-correlation')) return null;
    return { risk: 'unknown_state_mutation', reason: 'Unknown state-changing prerequisite is blocked until full JMeter verification.' };
}

function isUnsafeBusinessMutation(entry) {
    return !!mutationRisk(entry);
}

function isEnabled(entry, index, enabledBySampler) {
    if (!(enabledBySampler instanceof Map)) return true;
    const label = samplerLabel(entry, index);
    const raw = `${entry && entry.request && entry.request.method || 'GET'} ${entry && entry.request && entry.request.url || ''}`;
    const value = enabledBySampler.has(label) ? enabledBySampler.get(label)
        : enabledBySampler.has(raw) ? enabledBySampler.get(raw)
            : enabledBySampler.has(index) ? enabledBySampler.get(index) : true;
    return value !== false;
}

module.exports = {
    planReplayDependencies,
    _internal: { isAuthPrerequisite, isUnsafeBusinessMutation, mutationRisk, hasNativeStateConsumer, mayNeedSessionForMutation, isEnabled },
};
