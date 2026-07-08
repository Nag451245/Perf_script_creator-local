'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function archiveSuccessfulRun({ outputRoot, outDir, name, keepOriginals = true, archiveDir } = {}) {
    if (!outputRoot) throw new Error('outputRoot is required');
    if (!outDir) throw new Error('outDir is required');
    const targetDir = archiveDir || path.join(outputRoot, 'successful');
    const safeName = String(name || path.basename(outDir)).replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60) || 'run';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = path.join(targetDir, `${safeName}_${stamp}.zip`);

    try {
        fs.mkdirSync(targetDir, { recursive: true });
        const files = listFiles(outDir)
            .filter(file => path.resolve(file) !== path.resolve(zipPath))
            .map(file => ({
                absolute: file,
                relative: toZipPath(path.relative(outDir, file)),
            }))
            .filter(f => f.relative);
        if (!files.length) return { ok: false, error: 'no files to archive', zipPath, files: [] };

        const zip = buildZip(files);
        fs.writeFileSync(zipPath, zip);
        if (!keepOriginals) removeFiles(files.map(f => f.absolute));
        return { ok: true, zipPath, files: files.map(f => f.relative), keptOriginals: !!keepOriginals };
    } catch (e) {
        return { ok: false, error: e.message, zipPath, files: [] };
    }
}

function listFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

function buildZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
        const data = fs.readFileSync(file.absolute);
        const compressed = zlib.deflateRawSync(data);
        const crc = crc32(data);
        const name = Buffer.from(file.relative, 'utf8');
        const stat = fs.statSync(file.absolute);
        const dos = dosDateTime(stat.mtime);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(8, 8);
        localHeader.writeUInt16LE(dos.time, 10);
        localHeader.writeUInt16LE(dos.date, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(compressed.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);
        localParts.push(localHeader, name, compressed);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(8, 10);
        centralHeader.writeUInt16LE(dos.time, 12);
        centralHeader.writeUInt16LE(dos.date, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(compressed.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(name.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(offset, 42);
        centralParts.push(centralHeader, name);

        offset += localHeader.length + name.length + compressed.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, ...centralParts, end]);
}

function dosDateTime(date) {
    const d = date instanceof Date ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function toZipPath(file) {
    return String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function removeFiles(files) {
    for (const file of files) {
        try { fs.unlinkSync(file); } catch { /* best effort cleanup */ }
    }
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

module.exports = {
    archiveSuccessfulRun,
    _internal: { listFiles, buildZip, crc32, dosDateTime, toZipPath },
};
