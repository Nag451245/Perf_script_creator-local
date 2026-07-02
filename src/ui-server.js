'use strict';
/**
 * ui-server.js — a tiny, dependency-free local web UI over the same pipeline as
 * index.js. It does NOT reimplement any logic: it spawns `node index.js [--run]`
 * (the exact CLI) and streams its log, then links the generated report.html / .jmx
 * from output/. Start it with `node src/ui-server.js` (or perfscript-ui.cmd).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(ROOT, 'input');
const OUTPUT = path.join(ROOT, 'output');
const PORT = Number(process.env.PERFSCRIPT_UI_PORT) || 7070;

fs.mkdirSync(INPUT, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });

// In-memory run registry: id -> { mode, lines:[], done, code, startedAt }
const runs = new Map();
let runSeq = 0;
let activeChild = null;

function listInputs() {
    return fs.readdirSync(INPUT)
        .filter(f => /\.(har|jmx|xml|jtl)$/i.test(f))
        .map(f => ({ name: f, size: fs.statSync(path.join(INPUT, f)).size }));
}

function listOutputs() {
    if (!fs.existsSync(OUTPUT)) return [];
    return fs.readdirSync(OUTPUT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
            const dir = path.join(OUTPUT, d.name);
            const files = fs.readdirSync(dir);
            const report = files.find(f => /_report\.html$/i.test(f));
            const jmx = files.find(f => /\.jmx$/i.test(f) && !/recording/i.test(f)) || files.find(f => /\.jmx$/i.test(f));
            let verdict = '';
            const rj = files.find(f => /_report\.json$/i.test(f));
            if (rj) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, rj), 'utf8')); verdict = j.success === true ? 'GREEN' : (j.success === false ? 'needs attention' : (j.verdict || '')); } catch { /**/ } }
            return { name: d.name, report, jmx, verdict, mtime: fs.statSync(dir).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

function send(res, code, body, headers = {}) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers));
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Serve a file from output/ safely (no path escape).
function serveOutputFile(res, rel) {
    const full = path.normalize(path.join(OUTPUT, rel));
    if (!full.startsWith(OUTPUT)) return send(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { error: 'not found' });
    const ext = path.extname(full).toLowerCase();
    const type = ext === '.html' ? 'text/html' : ext === '.jmx' || ext === '.xml' ? 'application/xml' : ext === '.json' ? 'application/json' : 'text/plain';
    const disp = (ext === '.jmx') ? { 'Content-Disposition': `attachment; filename="${path.basename(full)}"` } : {};
    res.writeHead(200, Object.assign({ 'Content-Type': `${type}; charset=utf-8` }, disp));
    fs.createReadStream(full).pipe(res);
}

function startRun(mode) {
    if (activeChild) return { error: 'A run is already in progress.' };
    const id = ++runSeq;
    const flags = mode === 'run' ? ['--run'] : [];
    const rec = { id, mode, lines: [], done: false, code: null, startedAt: Date.now() };
    runs.set(id, rec);
    const child = spawn(process.execPath, [path.join(ROOT, 'index.js'), ...flags], { cwd: ROOT });
    activeChild = child;
    const onData = (buf) => String(buf).split(/\r?\n/).forEach(l => { if (l !== '') rec.lines.push(l); });
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => { rec.done = true; rec.code = code; activeChild = null; });
    child.on('error', (e) => { rec.lines.push(`spawn error: ${e.message}`); rec.done = true; rec.code = -1; activeChild = null; });
    return { id };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const p = u.pathname;
    try {
        if (p === '/' && req.method === 'GET') return send(res, 200, PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
        if (p === '/api/state' && req.method === 'GET') return send(res, 200, { inputs: listInputs(), outputs: listOutputs(), busy: !!activeChild });
        if (p === '/api/run' && req.method === 'POST') { const r = startRun(u.searchParams.get('mode') || 'generate'); return send(res, r.error ? 409 : 200, r); }
        if (p === '/api/log' && req.method === 'GET') {
            const id = Number(u.searchParams.get('id')); const since = Number(u.searchParams.get('since')) || 0;
            const rec = runs.get(id); if (!rec) return send(res, 404, { error: 'no such run' });
            return send(res, 200, { lines: rec.lines.slice(since), total: rec.lines.length, done: rec.done, code: rec.code });
        }
        if (p === '/api/upload' && req.method === 'POST') {
            const name = path.basename(u.searchParams.get('name') || '');
            if (!name || !/\.(har|jmx|xml|jtl)$/i.test(name)) return send(res, 400, { error: 'name must end in .har/.jmx/.xml/.jtl' });
            const body = await readBody(req);
            fs.writeFileSync(path.join(INPUT, name), body);
            return send(res, 200, { ok: true, name, size: body.length });
        }
        if (p === '/api/input' && req.method === 'DELETE') {
            const name = path.basename(u.searchParams.get('name') || '');
            const f = path.join(INPUT, name);
            if (fs.existsSync(f)) fs.unlinkSync(f);
            return send(res, 200, { ok: true });
        }
        if (p === '/file' && req.method === 'GET') return serveOutputFile(res, u.searchParams.get('path') || '');
        return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 500, { error: e.message }); }
});

server.listen(PORT, () => {
    process.stdout.write(`perfscript UI running →  http://localhost:${PORT}\n(input: ${INPUT})\nClose this window to stop the UI.\n`);
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>PerfScript</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1420;--card:#182031;--ink:#e7ecf5;--mut:#93a1bd;--acc:#4f9dff;--ok:#39d98a;--warn:#ffb454;--line:#26314a}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
header h1{font-size:18px;margin:0;font-weight:650}header .sub{color:var(--mut);font-size:13px}
.wrap{max-width:1000px;margin:0 auto;padding:22px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card h2{font-size:14px;margin:0 0 12px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
button{font:inherit;border:0;border-radius:9px;padding:10px 16px;cursor:pointer;font-weight:600}
.primary{background:var(--acc);color:#04101f}.ghost{background:#223050;color:var(--ink)}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
li:last-child{border:0}.mut{color:var(--mut)}a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.tag{font-size:12px;padding:2px 8px;border-radius:20px;background:#223050;color:var(--mut)}
.tag.ok{background:rgba(57,217,138,.15);color:var(--ok)}.tag.warn{background:rgba(255,180,84,.15);color:var(--warn)}
#log{background:#0a0f1a;border:1px solid var(--line);border-radius:10px;padding:12px;height:280px;overflow:auto;font:12.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;color:#c8d3ea}
.drop{border:1.5px dashed var(--line);border-radius:10px;padding:18px;text-align:center;color:var(--mut);cursor:pointer}
.drop.hi{border-color:var(--acc);color:var(--ink)}
.full{grid-column:1/3}.x{color:#ff6b6b;cursor:pointer;font-size:12px}
</style></head><body>
<header><h1>⚡ PerfScript</h1><span class="sub">local JMeter script generator · correlate & validate</span></header>
<div class="wrap">
 <div class="grid">
  <div class="card">
   <h2>1 · Recordings (input)</h2>
   <div id="drop" class="drop">Drop .har / .jmx / .xml here — or click to browse</div>
   <input id="file" type="file" multiple accept=".har,.jmx,.xml,.jtl" style="display:none">
   <ul id="inputs"></ul>
  </div>
  <div class="card">
   <h2>2 · Run</h2>
   <div class="row">
    <button id="gen" class="primary">Generate</button>
    <button id="run" class="ghost">Generate + Validate (JMeter)</button>
   </div>
   <p class="mut" style="font-size:13px">Generate = correlate &amp; build the .jmx. Validate = also execute it with local JMeter and report pass/fail.</p>
   <div id="status" class="mut"></div>
  </div>
  <div class="card full">
   <h2>Live log</h2>
   <div id="log">Idle. Add recordings, then press Generate.</div>
  </div>
  <div class="card full">
   <h2>3 · Results (output)</h2>
   <ul id="outputs"></ul>
  </div>
 </div>
</div>
<script>
const $=s=>document.querySelector(s), logEl=$('#log');
let poll=null;
async function j(u,o){const r=await fetch(u,o);return r.json()}
function esc(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function refresh(){
 const s=await j('/api/state');
 $('#inputs').innerHTML=s.inputs.length?s.inputs.map(f=>\`<li><span>\${esc(f.name)} <span class="mut">\${(f.size/1024|0)} KB</span></span><span class="x" onclick="del('\${esc(f.name)}')">remove</span></li>\`).join(''):'<li class="mut">No recordings yet.</li>';
 $('#outputs').innerHTML=s.outputs.length?s.outputs.map(o=>{
   const t=o.verdict==='GREEN'?'<span class="tag ok">GREEN</span>':o.verdict?\`<span class="tag warn">\${esc(o.verdict)}</span>\`:'<span class="tag">generated</span>';
   const links=[o.jmx?\`<a href="/file?path=\${encodeURIComponent(o.name+'/'+o.jmx)}">.jmx</a>\`:'',o.report?\`<a href="/file?path=\${encodeURIComponent(o.name+'/'+o.report)}" target="_blank">report</a>\`:''].filter(Boolean).join(' · ');
   return \`<li><span>\${esc(o.name)} \${t}</span><span>\${links}</span></li>\`;
 }).join(''):'<li class="mut">No results yet.</li>';
 $('#gen').disabled=$('#run').disabled=s.busy;
 return s;
}
async function start(mode){
 const r=await j('/api/run?mode='+mode,{method:'POST'});
 if(r.error){$('#status').textContent=r.error;return}
 logEl.textContent='';$('#status').textContent='Running ('+mode+')…';
 let since=0;const id=r.id;
 clearInterval(poll);
 poll=setInterval(async()=>{
  const d=await j('/api/log?id='+id+'&since='+since);
  if(d.lines&&d.lines.length){since=d.total;logEl.textContent+=d.lines.join('\\n')+'\\n';logEl.scrollTop=logEl.scrollHeight}
  if(d.done){clearInterval(poll);$('#status').textContent='Finished (exit '+d.code+').';refresh()}
 },600);
}
$('#gen').onclick=()=>start('generate');
$('#run').onclick=()=>start('run');
async function del(n){await fetch('/api/input?name='+encodeURIComponent(n),{method:'DELETE'});refresh()}
async function upload(files){for(const f of files){await fetch('/api/upload?name='+encodeURIComponent(f.name),{method:'POST',body:await f.arrayBuffer()})}refresh()}
const drop=$('#drop'),file=$('#file');
drop.onclick=()=>file.click();file.onchange=()=>upload(file.files);
drop.ondragover=e=>{e.preventDefault();drop.classList.add('hi')};
drop.ondragleave=()=>drop.classList.remove('hi');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('hi');upload(e.dataTransfer.files)};
refresh();setInterval(()=>{if(!poll)refresh()},4000);
</script></body></html>`;
