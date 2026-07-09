'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { validateLlmPatches } = require('./llm-patcher');

const SCHEMA_VERSION = 1;
const DEFAULT_CONFIDENCE = 0.9;
const MAX_LESSONS = 500;
const SECRET_KEYS = /\b(password|passwd|pwd|secret|token|bearer|authorization|cookie|set-cookie|csrf|xsrf|session|apikey|api_key|access[_-]?key|auth[_-]?code|id[_-]?token|refresh[_-]?token)\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/ig;
const COOKIE_RE = /\b(?:Cookie|Set-Cookie|Authorization)\s*:\s*[^\r\n]+/ig;
const LONG_TOKEN_RE = /\b[A-Za-z0-9._~+/=-]{16,}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/ig;

function defaultStorePath(rootDir = process.cwd()) {
    return path.join(rootDir, 'memory', 'verified-lessons.json');
}

function loadLessons(storePath = defaultStorePath()) {
    if (!fs.existsSync(storePath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^﻿/, ''));
        const lessons = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.lessons) ? parsed.lessons : []);
        return lessons.map(sanitizeLesson).filter(Boolean);
    } catch {
        return [];
    }
}

function writeLessons(storePath, lessons) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const clean = (lessons || []).map(sanitizeLesson).filter(Boolean).slice(-MAX_LESSONS);
    fs.writeFileSync(storePath, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        lessons: clean,
    }, null, 2));
    return clean;
}

function redactSensitive(value) {
    if (value == null) return value;
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map(redactSensitive);
    if (typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            out[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : redactSensitive(val);
        }
        return out;
    }

    let s = String(value);
    s = s.replace(COOKIE_RE, '[REDACTED_HEADER]');
    s = s.replace(BEARER_RE, 'Bearer [REDACTED]');
    s = s.replace(EMAIL_RE, '[REDACTED_EMAIL]');
    s = s.replace(UUID_RE, ':uuid');

    try {
        const u = new URL(s);
        const params = new URLSearchParams();
        for (const [key, val] of u.searchParams.entries()) {
            params.set(key, SECRET_KEYS.test(key) ? '[REDACTED]' : redactScalar(val));
        }
        u.search = params.toString();
        s = u.toString();
    } catch {
        s = redactScalar(s);
    }

    return redactLongTokens(s);
}

function redactScalar(value) {
    return redactLongTokens(String(value)
        .replace(EMAIL_RE, '[REDACTED_EMAIL]')
        .replace(UUID_RE, ':uuid'));
}

function redactLongTokens(value) {
    return String(value).replace(LONG_TOKEN_RE, token => isLikelySecretToken(token) ? '[REDACTED_TOKEN]' : token);
}

function isLikelySecretToken(token) {
    const s = String(token || '');
    if (s.length < 16) return false;
    if (/[._~+/=-]/.test(s)) return true;
    return /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function normalizePattern(value) {
    const raw = String(value || '');
    let subject = raw;
    try {
        const u = new URL(raw);
        subject = `${u.pathname || '/'}`;
    } catch {
        const match = raw.match(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i);
        if (match) subject = match[1];
    }

    subject = subject.split('?')[0].replace(/\\/g, '/');
    subject = subject.replace(/^(?:Step\s+\d+\s*-\s*)?/i, '');
    subject = subject.replace(/^\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s*/i, (_m, method) => `${method.toUpperCase()} `);

    const methodMatch = subject.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/);
    const method = methodMatch ? `${methodMatch[1]} ` : '';
    const pathOnly = methodMatch ? methodMatch[2] : subject;
    const parts = pathOnly.split('/').filter(Boolean);
    const normalized = parts.map((segment, index) => normalizeSegment(segment, index)).join('/');
    return `${method}/${normalized}`.replace(/\/$/, '') || '/';
}

function normalizeSegment(segment, index) {
    const s = decodeURIComponent(String(segment || '')).trim();
    if (!s) return s;
    if (/^\d+$/.test(s)) return ':num';
    if (isUuid(s)) return ':uuid';
    if (index > 0) return ':segment';
    if (/^[0-9a-f]{4,}$/i.test(s)) return ':hex';
    if (/[A-Za-z0-9._~+=-]{8,}/.test(s) && /\d/.test(s)) return ':id';
    return index === 0 ? s.toLowerCase() : ':segment';
}

function findMatchingLessons({ storePath = defaultStorePath(), failures = [], minConfidence = 0.85, stackFingerprint = [] } = {}) {
    const lessons = loadLessons(storePath).filter(l => Number(l.confidence || 0) >= minConfidence);
    const failureList = normalizeFailures(failures);
    const currentStacks = new Set((stackFingerprint || []).map(s => String(s && s.stack || s)));
    const matches = [];
    for (const failure of failureList) {
        const failurePattern = normalizePattern(failure.samplerName || failure.label || failure.name || failure.url || '');
        for (const lesson of lessons) {
            const lessonPattern = lesson.contextPattern && lesson.contextPattern.samplerPattern;
            if (!lessonPattern || lessonPattern !== failurePattern) continue;
            const fix = adaptFixForFailure(lesson.fix, failure);
            const gate = validateLlmPatches([fix]);
            if (!gate.accepted.length) continue;
            const stackOverlap = (lesson.stackFingerprint || []).filter(s => currentStacks.has(s)).length;
            matches.push({
                lessonId: lesson.id,
                confidence: lesson.confidence,
                flowName: lesson.flowName,
                symptom: lesson.symptom,
                contextPattern: lesson.contextPattern,
                stackOverlap,
                fix: gate.accepted[0],
                failure,
            });
        }
    }
    // Same-stack experience first: an Auth0+GraphQL lesson outranks a generic
    // one when this recording fingerprints as Auth0+GraphQL.
    return dedupeMatches(matches).sort((a, b) =>
        (b.stackOverlap - a.stackOverlap) || (Number(b.confidence) - Number(a.confidence)));
}

function learnFromRun({ storePath = defaultStorePath(), flowName = '', sourceRun = '', appHost = '', result = {}, fixes = [], stackFingerprint = [] } = {}) {
    if (!result || result.success !== true) return { learned: [], skipped: [{ reason: 'run_not_green' }] };
    const safeFixes = sanitizeFixes(fixes);
    if (!safeFixes.length) return { learned: [], skipped: [{ reason: 'no_safe_fixes' }] };

    const existing = loadLessons(storePath);
    const bySignature = new Map(existing.map(lesson => [lesson.signature, lesson]));
    const learned = [];
    for (const fix of safeFixes) {
        const lesson = buildLesson({ flowName, sourceRun, appHost, result, fix, stackFingerprint });
        if (!lesson) continue;
        const current = bySignature.get(lesson.signature);
        if (current) {
            current.confidence = Math.min(0.99, Number(current.confidence || DEFAULT_CONFIDENCE) + 0.05);
            current.successCount = Number(current.successCount || 1) + 1;
            current.lastVerifiedAt = lesson.lastVerifiedAt;
            current.verification = lesson.verification;
            learned.push(current);
        } else {
            bySignature.set(lesson.signature, lesson);
            learned.push(lesson);
        }
    }
    writeLessons(storePath, Array.from(bySignature.values()));
    return { learned: learned.map(publicLesson), skipped: [] };
}

function exportLessons({ storePath = defaultStorePath(), exportPath } = {}) {
    if (!exportPath) throw new Error('exportPath is required');
    const lessons = loadLessons(storePath).map(publicLesson);
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    fs.writeFileSync(exportPath, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        lessons,
    }, null, 2));
    return { exportPath, count: lessons.length };
}

function importLessons({ storePath = defaultStorePath(), importPath } = {}) {
    if (!importPath) throw new Error('importPath is required');
    const parsed = JSON.parse(fs.readFileSync(importPath, 'utf8').replace(/^﻿/, ''));
    const incoming = (Array.isArray(parsed) ? parsed : parsed.lessons || [])
        .map(sanitizeLesson)
        .filter(Boolean);
    const existing = loadLessons(storePath);
    const bySignature = new Map(existing.map(lesson => [lesson.signature, lesson]));
    let imported = 0;
    for (const lesson of incoming) {
        if (!bySignature.has(lesson.signature)) imported++;
        bySignature.set(lesson.signature, mergeLesson(bySignature.get(lesson.signature), lesson));
    }
    writeLessons(storePath, Array.from(bySignature.values()));
    return { importPath, storePath, imported, total: bySignature.size };
}

function buildLesson({ flowName, sourceRun, appHost, result, fix, stackFingerprint = [] }) {
    const contextPattern = {
        samplerPattern: normalizePattern(fix.sampler || '*'),
        fixKind: fix.kind,
    };
    const signature = sha256(JSON.stringify({ contextPattern, fix: signatureFix(fix) })).slice(0, 24);
    const now = new Date().toISOString();
    return sanitizeLesson({
        id: `vls_${signature}`,
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        lastVerifiedAt: now,
        sourceRun: redactSensitive(sourceRun),
        appHostHash: appHost ? sha256(String(appHost)).slice(0, 16) : null,
        // Experience compounds across APPS with the same stack, not just the
        // same host: an Auth0+GraphQL lesson helps the next Auth0 customer.
        stackFingerprint: (stackFingerprint || []).map(s => String(s && s.stack || s)).filter(Boolean).slice(0, 8),
        flowName: redactSensitive(flowName || 'unknown'),
        symptom: {
            failureCategory: fix.kind,
            samplerPattern: contextPattern.samplerPattern,
        },
        contextPattern,
        fix,
        verification: verificationSummary(result),
        confidence: DEFAULT_CONFIDENCE,
        successCount: 1,
        scope: appHost ? 'host' : 'generic',
        signature,
    });
}

function sanitizeLesson(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const safeFixes = sanitizeFixes([raw.fix]);
    if (!safeFixes.length) return null;
    const fix = safeFixes[0];
    const contextPattern = redactSensitive(raw.contextPattern || {});
    if (!contextPattern.samplerPattern) contextPattern.samplerPattern = normalizePattern(fix.sampler || '*');
    const signature = raw.signature || sha256(JSON.stringify({ contextPattern, fix: signatureFix(fix) })).slice(0, 24);
    return {
        id: String(raw.id || `vls_${signature}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80),
        schemaVersion: SCHEMA_VERSION,
        createdAt: raw.createdAt || new Date().toISOString(),
        lastVerifiedAt: raw.lastVerifiedAt || raw.createdAt || new Date().toISOString(),
        sourceRun: redactSensitive(raw.sourceRun || ''),
        appHostHash: raw.appHostHash ? String(raw.appHostHash).replace(/[^a-f0-9]/ig, '').slice(0, 32) : null,
        stackFingerprint: Array.isArray(raw.stackFingerprint)
            ? raw.stackFingerprint.map(s => String(s).slice(0, 60)).slice(0, 8)
            : [],
        flowName: redactSensitive(raw.flowName || 'unknown'),
        symptom: redactSensitive(raw.symptom || {}),
        contextPattern,
        fix,
        verification: redactSensitive(raw.verification || {}),
        confidence: clampNumber(raw.confidence, 0, 0.99, DEFAULT_CONFIDENCE),
        successCount: Math.max(1, Number(raw.successCount) || 1),
        scope: ['host', 'app', 'generic'].includes(raw.scope) ? raw.scope : 'generic',
        signature,
    };
}

function sanitizeFixes(fixes) {
    const validation = validateLlmPatches(Array.isArray(fixes) ? fixes : []);
    return validation.accepted
        .map(fix => {
            const safe = redactSensitive(fix);
            if (safe.kind === 'replaceValueWithVar' && safe.value) {
                safe.value = '[REDACTED_VALUE]';
            }
            return safe;
        })
        .map(fix => validateLlmPatches([fix]).accepted[0])
        .filter(Boolean);
}

function adaptFixForFailure(fix, failure) {
    const next = { ...fix };
    if (next.sampler && next.sampler !== '*') {
        next.sampler = failure.samplerName || failure.label || failure.name || next.sampler;
    }
    return next;
}

function normalizeFailures(failures) {
    if (Array.isArray(failures)) return failures.filter(Boolean);
    if (failures && Array.isArray(failures.samples)) {
        return failures.samples.filter(s => s && s.success === false && !s.isTransaction);
    }
    return [];
}

function dedupeMatches(matches) {
    const seen = new Set();
    const out = [];
    for (const match of matches) {
        const key = `${match.lessonId}:${JSON.stringify(match.fix)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(match);
    }
    return out.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
}

function mergeLesson(current, incoming) {
    if (!current) return incoming;
    return {
        ...current,
        ...incoming,
        confidence: Math.max(Number(current.confidence || 0), Number(incoming.confidence || 0)),
        successCount: Math.max(Number(current.successCount || 1), Number(incoming.successCount || 1)),
        createdAt: current.createdAt || incoming.createdAt,
    };
}

function publicLesson(lesson) {
    return sanitizeLesson(lesson);
}

function signatureFix(fix) {
    const copy = { ...fix };
    if (copy.sampler) copy.sampler = normalizePattern(copy.sampler);
    if (copy.value) copy.value = redactSensitive(copy.value);
    return copy;
}

function verificationSummary(result) {
    const samples = (result.samples || []).filter(s => !s.isTransaction);
    const passed = samples.filter(s => s.success).length;
    return {
        passedRequests: passed,
        totalRequests: samples.length,
        iterationsRun: result.iterationsRun || 0,
        recoveredFromJtl: !!result.recoveredFromJtl,
    };
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
    defaultStorePath,
    loadLessons,
    writeLessons,
    redactSensitive,
    normalizePattern,
    findMatchingLessons,
    learnFromRun,
    exportLessons,
    importLessons,
    _internal: {
        sanitizeFixes,
        sanitizeLesson,
        buildLesson,
        verificationSummary,
    },
};
