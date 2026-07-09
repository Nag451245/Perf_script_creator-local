'use strict';

const fs = require('fs');
const path = require('path');

function detectUploadFiles(entries = []) {
    const uploads = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] || {};
        const req = entry.request || {};
        const post = req.postData || {};
        const contentType = [
            post.mimeType,
            ...(req.headers || []).filter(h => /^content-type$/i.test(h.name || '')).map(h => h.value),
        ].join(' ');
        const isMultipart = /multipart\/form-data/i.test(contentType);
        const parsedFileParams = (post.params || []).filter(p => p && p.fileName);
        const fileParams = parsedFileParams.length ? parsedFileParams : rawMultipartFileParams(post);
        if (!isMultipart && !fileParams.length) continue;
        for (const param of fileParams) {
            uploads.push({
                index: i,
                samplerLabel: samplerLabel(entry, i),
                url: req.url || '',
                fieldName: param.name || 'file',
                fileName: path.basename(String(param.fileName || '')),
                contentType: param.contentType || 'application/octet-stream',
            });
        }
    }
    return uploads.filter(u => u.fileName);
}

function resolveAndStageUploads({ entries = [], searchDirs = [], outDir, subdir = 'test_files' } = {}) {
    const required = dedupeUploads(detectUploadFiles(entries));
    const matched = [];
    const missing = [];
    const fileMappings = {};
    if (!required.length) return { required, matched, missing, fileMappings };

    const candidates = indexCandidateFiles(searchDirs);
    const stageDir = outDir ? path.join(outDir, subdir) : null;
    for (const upload of required) {
        const exact = candidates.byName.get(upload.fileName.toLowerCase()) || null;
        const compatible = exact ? { file: exact } : findCompatibleCandidate(upload, candidates.files, candidates.ranks);
        const found = compatible.file || null;
        const stagedName = found ? path.basename(found) : upload.fileName;
        const packagedPath = `${subdir}/${stagedName}`.replace(/\\/g, '/');
        if (found && stageDir) {
            fs.mkdirSync(stageDir, { recursive: true });
            fs.copyFileSync(found, path.join(stageDir, stagedName));
            fileMappings[upload.fileName] = packagedPath;
            fileMappings[stagedName] = packagedPath;
            matched.push({ ...upload, stagedName, sourcePath: found, packagedPath });
        } else {
            missing.push({
                ...upload,
                packagedPath,
                reason: compatible.reason || 'not-found',
                candidateNames: compatible.candidates ? compatible.candidates.map(f => path.basename(f)) : undefined,
            });
        }
    }
    return { required, matched, missing, fileMappings };
}

function applyResolvedUploadsToEntries(entries = [], plan = {}) {
    const matchedByKey = new Map((plan.matched || []).map(upload => [uploadKey(upload), upload]));
    const unresolvedKeys = new Set((plan.missing || []).map(uploadKey));
    for (const upload of plan.required || []) {
        const entry = entries[upload.index];
        const req = entry && entry.request;
        if (!req) continue;
        req.postData = req.postData || {};
        const post = req.postData;
        post.params = Array.isArray(post.params) ? post.params : [];
        const key = uploadKey(upload);
        const matched = matchedByKey.get(key);
        if (!matched && unresolvedKeys.has(key)) {
            post.params = post.params.filter(p => !sameUploadParam(p, upload));
            continue;
        }
        if (!matched) continue;
        const stagedName = matched.stagedName || upload.fileName;
        const existing = post.params.find(p => sameUploadParam(p, upload));
        if (existing) {
            existing.fileName = stagedName;
            existing.contentType = existing.contentType || matched.contentType || upload.contentType || 'application/octet-stream';
            continue;
        }
        post.params.push({
            name: upload.fieldName || 'file',
            fileName: stagedName,
            contentType: matched.contentType || upload.contentType || 'application/octet-stream',
        });
    }
    return entries;
}

function applyDetectedUploadsToEntries(entries = [], uploads = []) {
    return applyResolvedUploadsToEntries(entries, { required: uploads, matched: uploads, missing: [] });
}

function dedupeUploads(uploads) {
    const seen = new Set();
    const out = [];
    for (const upload of uploads) {
        const key = `${upload.fileName}\0${upload.fieldName}\0${upload.samplerLabel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(upload);
    }
    return out;
}

function uploadKey(upload) {
    return `${upload.index}\0${upload.fieldName || 'file'}\0${upload.fileName}`;
}

function sameUploadParam(param, upload) {
    return param &&
        param.fileName === upload.fileName &&
        (param.name || 'file') === (upload.fieldName || 'file');
}

function rawMultipartFileParams(post = {}) {
    if (!/multipart\/form-data/i.test(String(post.mimeType || ''))) return [];
    const text = String(post.text || '');
    if (!text || !/filename\*?=/i.test(text)) return [];
    const blocks = text.match(/Content-Disposition:[\s\S]*?(?=\r?\n\r?\n)/gi) || [];
    const out = [];
    for (const block of blocks) {
        const filename = dispositionValue(block, 'filename');
        if (!filename) continue;
        out.push({
            name: dispositionValue(block, 'name') || 'file',
            fileName: path.basename(filename),
            contentType: contentTypeFromPartHeaders(block) || 'application/octet-stream',
        });
    }
    return out;
}

function dispositionValue(block, key) {
    const re = new RegExp(`${key}\\*?=(?:UTF-8''([^;\\r\\n]+)|"([^"]+)"|([^;\\r\\n]+))`, 'i');
    const match = String(block || '').match(re);
    if (!match) return '';
    const raw = (match[1] || match[2] || match[3] || '').trim();
    try { return decodeURIComponent(raw); }
    catch { return raw; }
}

function contentTypeFromPartHeaders(block) {
    const match = String(block || '').match(/Content-Type:\s*([^\r\n]+)/i);
    return match ? match[1].trim() : '';
}

function indexCandidateFiles(searchDirs) {
    const byName = new Map();
    const files = [];
    const ranks = new Map();
    (searchDirs || []).forEach((dir, rank) => {
        walk(dir, file => {
            if (!isSupportCandidate(file)) return;
            const base = path.basename(file).toLowerCase();
            if (!byName.has(base)) byName.set(base, file);
            files.push(file);
            if (!ranks.has(file)) ranks.set(file, rank);
        });
    });
    return { byName, files, ranks };
}

function findCompatibleCandidate(upload, files, ranks = new Map()) {
    const wantedExt = path.extname(upload.fileName).toLowerCase();
    const byExt = wantedExt ? files.filter(f => path.extname(f).toLowerCase() === wantedExt) : [];
    const extPick = pickUniqueHighestPriority(byExt, ranks);
    if (extPick.file || extPick.ambiguous) return extPick.file ? extPick : { reason: 'ambiguous-compatible-file', candidates: extPick.candidates };
    const mimeExt = extensionForMime(upload.contentType);
    const byMime = mimeExt ? files.filter(f => path.extname(f).toLowerCase() === mimeExt) : [];
    const mimePick = pickUniqueHighestPriority(byMime, ranks);
    if (mimePick.file || mimePick.ambiguous) return mimePick.file ? mimePick : { reason: 'ambiguous-compatible-file', candidates: mimePick.candidates };
    return !wantedExt && !mimeExt && files.length === 1 ? { file: files[0] } : { reason: 'not-found' };
}

function pickUniqueHighestPriority(files, ranks = new Map()) {
    if (!files.length) return {};
    const minRank = Math.min(...files.map(f => ranks.has(f) ? ranks.get(f) : Number.MAX_SAFE_INTEGER));
    const candidates = files.filter(f => (ranks.has(f) ? ranks.get(f) : Number.MAX_SAFE_INTEGER) === minRank);
    if (candidates.length === 1) return { file: candidates[0] };
    return { ambiguous: true, candidates };
}

function isSupportCandidate(file) {
    return !/\.(har|jmx|xml|jtl|json|cmd|bat|ps1|js|mjs|cjs)$/i.test(file);
}

function extensionForMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('pdf')) return '.pdf';
    if (m.includes('wordprocessingml') || m.includes('msword')) return '.docx';
    if (m.includes('spreadsheetml') || m.includes('excel')) return '.xlsx';
    if (m.includes('png')) return '.png';
    if (m.includes('jpeg')) return '.jpg';
    if (m.includes('text/plain')) return '.txt';
    return '';
}

function walk(dir, visit, depth = 0) {
    if (!dir || depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, visit, depth + 1);
        else if (entry.isFile()) visit(full);
    }
}

function samplerLabel(entry, index) {
    const method = String(entry && entry.request && entry.request.method || 'GET').toUpperCase();
    let p = '/';
    try { p = new URL(entry.request.url).pathname || '/'; } catch { /* keep / */ }
    return `Step ${String(index + 1).padStart(2, '0')} - ${method} ${p}`;
}

module.exports = {
    detectUploadFiles,
    resolveAndStageUploads,
    applyResolvedUploadsToEntries,
    applyDetectedUploadsToEntries,
    _internal: { dedupeUploads, indexCandidateFiles, findCompatibleCandidate, rawMultipartFileParams, samplerLabel, uploadKey },
};
