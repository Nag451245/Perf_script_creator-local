'use strict';

const fs = require('fs');

function readConfigFromPath(configPath) {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '')); }
    catch { return {}; }
}

function writeConfigToPath(configPath, config) {
    fs.writeFileSync(configPath, JSON.stringify(config || {}, null, 2));
}

function readConfigForUiPath(configPath) {
    return readConfigForUiObject(readConfigFromPath(configPath));
}

function writeConfigFromUiPath(configPath, body) {
    const updated = writeConfigFromUiObject(readConfigFromPath(configPath), body);
    writeConfigToPath(configPath, updated);
    return { ok: true };
}

function readConfigForUiObject(config = {}) {
    const run = config.run || {};
    const lp = run.loadProfile || {};
    const agent = config.agent || {};
    const slo = run.slo || {};
    return {
        targetBaseUrl: run.targetBaseUrlOverride || '',
        username: (run.credentials && run.credentials.username) || '',
        hasPassword: !!(run.credentials && run.credentials.password),
        loadProfile: { users: lp.users || '', rampUpSec: lp.rampUpSec || '', holdSec: lp.holdSec || '' },
        testObjective: run.testObjective || '',
        techStack: listToText(run.techStack),
        domainNotes: listToText(run.domainNotes),
        slo: { p95Ms: slo.p95Ms || '', errorRatePct: slo.errorRatePct || '' },
        seniorMode: agent.seniorMode || 'strong',
        jmeterHome: config.jmeterHome || '',
        javaHome: config.javaHome || '',
    };
}

function writeConfigFromUiObject(config = {}, body = {}) {
    const c = clone(config);
    c.run = c.run || {};
    c.agent = c.agent || {};
    if (typeof body.targetBaseUrl === 'string') c.run.targetBaseUrlOverride = body.targetBaseUrl.trim();
    if (typeof body.username === 'string' || typeof body.password === 'string') {
        c.run.credentials = c.run.credentials || {};
        if (typeof body.username === 'string') c.run.credentials.username = body.username;
        if (typeof body.password === 'string' && body.password !== '') c.run.credentials.password = body.password;
    }
    const lp = body.loadProfile || {};
    const prof = {};
    putInt(prof, 'users', lp.users);
    putInt(prof, 'rampUpSec', lp.rampUpSec);
    putInt(prof, 'holdSec', lp.holdSec);
    if (Object.keys(prof).length) c.run.loadProfile = prof; else delete c.run.loadProfile;

    if (typeof body.testObjective === 'string') c.run.testObjective = body.testObjective.trim();
    if (body.techStack != null) c.run.techStack = textToList(body.techStack);
    if (body.domainNotes != null) c.run.domainNotes = textToList(body.domainNotes, { splitComma: false });
    if (body.slo && typeof body.slo === 'object') {
        const slo = {};
        putNumber(slo, 'p95Ms', body.slo.p95Ms);
        putNumber(slo, 'errorRatePct', body.slo.errorRatePct);
        if (Object.keys(slo).length) c.run.slo = slo; else delete c.run.slo;
    }
    if (typeof body.seniorMode === 'string') c.agent.seniorMode = normalizeSeniorMode(body.seniorMode);
    return c;
}

function textToList(value, { splitComma = true } = {}) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    const raw = String(value || '').trim();
    if (!raw) return [];
    const parts = splitComma ? raw.split(/[,;\n]+|\s+\+\s+/) : raw.split(/\n+/);
    return parts.map(v => v.trim()).filter(Boolean);
}

function listToText(value) {
    if (Array.isArray(value)) return value.join(', ');
    return String(value || '');
}

function putInt(obj, key, value) {
    if (value === '' || value == null) return;
    const n = Math.max(0, parseInt(value, 10) || 0);
    obj[key] = n;
}

function putNumber(obj, key, value) {
    if (value === '' || value == null) return;
    const n = Number(value);
    if (Number.isFinite(n)) obj[key] = n;
}

function normalizeSeniorMode(value) {
    return ['off', 'strong', 'mature'].includes(value) ? value : 'strong';
}

function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

module.exports = {
    readConfigFromPath,
    writeConfigToPath,
    readConfigForUiPath,
    writeConfigFromUiPath,
    readConfigForUiObject,
    writeConfigFromUiObject,
    _internal: { textToList, listToText, normalizeSeniorMode },
};
