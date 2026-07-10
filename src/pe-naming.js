'use strict';

const DEFAULT_SCENARIO_CODE = 'SC01';

const SEGMENTS = {
    launch: { name: 'launch', semantic: 'TX01_AuthAndSession' },
    login: { name: 'Login', semantic: 'TX01_AuthAndSession' },
    auth: { name: 'AuthAndSession', semantic: 'TX01_AuthAndSession' },
    clinic: { name: 'ClinicContext', semantic: 'TX02_ClinicContext' },
    search: { name: 'Search', semantic: 'TX03_PatientSearch' },
    chart: { name: 'PatientChart', semantic: 'TX04_PatientChart' },
    upload: { name: 'DocumentUpload', semantic: 'TX05_DocumentUpload' },
    delete: { name: 'DocumentDelete', semantic: 'TX06_DocumentDelete' },
    general: { name: 'General', semantic: 'TX00_General' },
};

function buildPeNamingModel({ entries = [], flowName = '', pages = [], scenarioCode = DEFAULT_SCENARIO_CODE, transactionNames = [] } = {}) {
    const flowPrefix = normalizeFlowName(flowName);
    const pageById = new Map((pages || []).map(page => [page.id, page]));
    const groupPlan = buildGroupPlan(entries, pageById);
    const txByKey = new Map();
    const overrides = normalizeTransactionNames(transactionNames);
    const groups = [];
    const labelByIndex = new Map();
    const requests = [];

    for (const group of groupPlan) {
        const tx = transactionForGroup(group, txByKey, scenarioCode, flowPrefix, overrides);
        groups.push({
            name: tx.transactionLabel,
            type: 'transaction',
            entries: group.entries,
            transactionCode: tx.transactionCode,
            transactionName: tx.transactionName,
            transactionLabel: tx.transactionLabel,
            semanticTransactionLabel: tx.semanticTransactionLabel,
        });
        for (const item of group.entries) {
            const index = entries.indexOf(item);
            const method = methodOf(item);
            const requestPath = pathOf(item);
            const stepNumber = index + 1;
            const peLabel = `${scenarioCode}_${tx.transactionCode}_${normalizeRequestName(requestPath, method)}-${String(stepNumber).padStart(3, '0')}`;
            const originalLabel = samplerLabel(item, index);
            const row = {
                originalLabel,
                peLabel,
                transactionCode: tx.transactionCode,
                transactionName: tx.transactionName,
                transactionLabel: tx.transactionLabel,
                semanticTransactionLabel: tx.semanticTransactionLabel,
                originalEntryIndex: index,
                stepNumber,
                method,
                path: requestPath,
                url: item && item.request && item.request.url || '',
            };
            labelByIndex.set(index, row);
            requests.push(row);
        }
    }

    return {
        scenarioCode,
        flowPrefix,
        groups,
        requests: requests.sort((a, b) => a.originalEntryIndex - b.originalEntryIndex),
        labelByIndex,
    };
}

function buildGroupPlan(entries, pageById) {
    const groups = [];
    let current = null;
    for (const entry of entries || []) {
        const segment = segmentForEntry(entry);
        const page = pageById.get(entry && entry.pageref);
        const groupKey = page ? `page:${page.id || page.title || groups.length}` : segment.key;
        const groupName = page ? normalizeSegmentName(page.title || segment.name) : segment.name;
        if (!current || current.key !== groupKey) {
            current = {
                key: groupKey,
                segmentKey: segment.key,
                name: groupName,
                semanticTransactionLabel: segment.semantic,
                entries: [],
            };
            groups.push(current);
        }
        current.entries.push(entry);
    }
    return groups.length ? groups : [{ key: 'general', segmentKey: 'general', name: SEGMENTS.general.name, semanticTransactionLabel: SEGMENTS.general.semantic, entries: [] }];
}

function transactionForGroup(group, txByKey, scenarioCode, flowPrefix, overrides = []) {
    const key = group.key || 'general';
    if (!txByKey.has(key)) {
        const index = txByKey.size;
        const code = `T${String(index + 1).padStart(2, '0')}`;
        const txName = overrides[index] || `${flowPrefix}_${group.name || SEGMENTS.general.name}`;
        txByKey.set(key, {
            transactionCode: code,
            transactionName: txName,
            transactionLabel: `${scenarioCode}_${code}_${txName}`,
            semanticTransactionLabel: group.semanticTransactionLabel || SEGMENTS.general.semantic,
        });
    }
    return txByKey.get(key);
}

function normalizeTransactionNames(value) {
    const raw = Array.isArray(value)
        ? value
        : String(value || '').split(/\r?\n|[,;]+/);
    return raw
        .map(normalizeSegmentName)
        .filter(Boolean);
}

function segmentForEntry(entry = {}) {
    const method = methodOf(entry);
    const requestPath = pathOf(entry && entry.request && entry.request.url);
    const hay = `${method} ${requestPath}`.toLowerCase();
    if (/\/authorization\/?$|\/dashboard(?:\.php)?(?:\/|$)|\/menu(?:\/|$)|\/home(?:\/|$)/i.test(requestPath)) return segment('launch');
    if (/\/(?:u\/login|user\/login|login|authenticate|password)(?:\/|$)|\/authorize(?:\/resume)?|\/callback|\/oauth|\/saml|\/sso/i.test(requestPath)) return segment('login');
    if (/patient.*search|\/search(?:\/|$)|findpatient|patientlist/i.test(hay)) return segment('search');
    if (/patientchart|chart\.php|patient\/chart/i.test(hay)) return segment('chart');
    if (/delete|remove/i.test(hay)) return segment('delete');
    if (/upload|temporal-file|document|edoc|file\/save|multipart/i.test(hay)) return segment('upload');
    if (/clinic|practice|facility|scheduler\/index\/data|context/i.test(hay)) return segment('clinic');
    if (/jwt|cookie|session|interceptor|iam|csrf|token/i.test(hay)) return segment('auth');
    return segment('general');
}

function segment(key) {
    return { key, ...SEGMENTS[key] };
}

function renameHttpSamplerLabels(xml, namingModel) {
    let index = 0;
    let renamed = 0;
    const out = String(xml || '').replace(/<HTTPSamplerProxy\b([^>]*)>/g, (match, attrs) => {
        const row = namingModel && namingModel.labelByIndex && namingModel.labelByIndex.get(index);
        index++;
        if (!row || !row.peLabel) return match;
        renamed++;
        const escaped = escapeXmlAttr(row.peLabel);
        if (/\btestname="[^"]*"/.test(attrs)) {
            return `<HTTPSamplerProxy${attrs.replace(/\btestname="[^"]*"/, `testname="${escaped}"`)}>`;
        }
        return `<HTTPSamplerProxy${attrs} testname="${escaped}">`;
    });
    return { xml: out, renamed };
}

function labelMapForArtifact(namingModel) {
    const txByLabel = new Map();
    for (const group of namingModel.groups) {
        const key = group.transactionLabel;
        if (!txByLabel.has(key)) {
            txByLabel.set(key, {
                transactionCode: group.transactionCode,
                transactionName: group.transactionName,
                transactionLabel: group.transactionLabel,
                semanticTransactionLabel: group.semanticTransactionLabel,
                requestCount: 0,
                groupCount: 0,
            });
        }
        const row = txByLabel.get(key);
        row.requestCount += group.entries.length;
        row.groupCount += 1;
    }
    return {
        scenarioCode: namingModel.scenarioCode,
        flowPrefix: namingModel.flowPrefix,
        transactions: [...txByLabel.values()],
        requests: namingModel.requests,
    };
}

function stepNumberFromLabel(label) {
    const text = String(label || '').trim();
    const step = /(?:^|\b)Step\s+0*(\d+)\b/i.exec(text);
    if (step) return Number(step[1]);
    const suffix = /-(\d{3,6})(?:\s|$)/.exec(text);
    return suffix ? Number(suffix[1]) : 0;
}

function samplerLabel(entry, index) {
    return `Step ${String(index + 1).padStart(2, '0')} - ${methodOf(entry)} ${pathOf(entry && entry.request && entry.request.url)}`;
}

function normalizeFlowName(flowName) {
    const text = String(flowName || 'Flow')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim();
    const words = (text || 'Flow').split(/\s+/).filter(Boolean);
    return words.map(titleWord).join('_');
}

function normalizeSegmentName(name) {
    return String(name || SEGMENTS.general.name)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(titleWord)
        .join('_') || SEGMENTS.general.name;
}

function normalizeRequestName(requestPath, method = 'GET') {
    const pathValue = String(requestPath || '/').split('?')[0] || '/';
    const normalized = pathValue
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9/_.$-]/g, '_')
        .replace(/_+/g, '_');
    return normalized === '/' ? `${String(method || 'GET').toUpperCase()}_/` : normalized;
}

function methodOf(entry) {
    return String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
}

function pathOf(input) {
    const value = typeof input === 'string' ? input : input && input.request && input.request.url;
    try { return new URL(value || '').pathname || '/'; }
    catch { return String(value || '/').split('?')[0] || '/'; }
}

function titleWord(value) {
    const text = String(value || '');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function escapeXmlAttr(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

module.exports = {
    buildPeNamingModel,
    labelMapForArtifact,
    renameHttpSamplerLabels,
    stepNumberFromLabel,
    _internal: {
        normalizeFlowName,
        normalizeTransactionNames,
        normalizeRequestName,
        segmentForEntry,
        samplerLabel,
    },
};
