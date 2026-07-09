'use strict';
/**
 * ui-server.js — a tiny, dependency-free local web UI over the same pipeline as
 * index.js. It does NOT reimplement any logic: it spawns `node index.js`
 * with the selected mode (`--run` / `--agent`) and streams its log, then links
 * the generated report.html / .jmx from output/. Start it with
 * `node src/ui-server.js` (or perfscript-ui.cmd).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { flagsForRunMode } = require('./ui-run-mode');
const uiConfig = require('./ui-config');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(ROOT, 'input');
const OUTPUT = path.join(ROOT, 'output');
const CONFIG_PATH = path.join(ROOT, 'perfscript.config.json');
const START_PORT = Number(process.env.PERFSCRIPT_UI_PORT) || 7070;

fs.mkdirSync(INPUT, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });

// ── config (perfscript.config.json) — read/write only the run-relevant subset,
// preserving everything else (jmeterHome, javaHome, gemini key, …).
function readConfig() { return uiConfig.readConfigFromPath(CONFIG_PATH); }
function readConfigForUi() {
    return uiConfig.readConfigForUiPath(CONFIG_PATH);
}
function writeConfigFromUi(body) {
    return uiConfig.writeConfigFromUiPath(CONFIG_PATH, body);
}

// In-memory run registry: id -> { mode, lines:[], done, code, startedAt }
const runs = new Map();
let runSeq = 0;
let activeChild = null;

function listInputs() {
    return fs.readdirSync(INPUT)
        .filter(f => !f.startsWith('.'))
        .map(f => ({ name: f, size: fs.statSync(path.join(INPUT, f)).size }));
}

const THIRD_PARTY = /dynatrace|pendo|gvt2|beacons|googleapis|gstatic|safebrowsing|launchdarkly|newrelic|nr-data|ruxit|gravatar|\/bf\?|\/rb_|domainreliability|ohttp_gateway/i;

function listOutputs() {
    if (!fs.existsSync(OUTPUT)) return [];
    return fs.readdirSync(OUTPUT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
            const dir = path.join(OUTPUT, d.name);
            const files = fs.readdirSync(dir);
            const report = files.find(f => /_report\.html$/i.test(f));
            const jmx = files.find(f => /\.jmx$/i.test(f) && !/recording/i.test(f)) || files.find(f => /\.jmx$/i.test(f));
            const o = { name: d.name, report, jmx, verdict: '', kind: 'generated', mtime: fs.statSync(dir).mtimeMs };
            const rjName = files.find(f => /_report\.json$/i.test(f));
            if (rjName) {
                try {
                    const j = JSON.parse(fs.readFileSync(path.join(dir, rjName), 'utf8'));
                    if (Array.isArray(j.samples)) {
                        // Validate run — report pass/fail (excluding transactions + 3rd-party noise).
                        const reqs = j.samples.filter(s => !s.isTransaction);
                        const app = reqs.filter(s => !THIRD_PARTY.test(s.url || s.label || ''));
                        o.kind = 'validated';
                        o.total = app.length;
                        o.passed = app.filter(s => s.success === true).length;
                        o.failed = app.filter(s => s.success === false).length;
                        o.verdict = j.success === true ? 'GREEN' : 'needs attention';
                        o.failedTop = app.filter(s => s.success === false).slice(0, 12)
                            .map(s => ({ label: (s.label || s.name || '').slice(0, 48), code: s.responseCode || '' }));
                    } else {
                        // Generate-only — surface build stats.
                        o.verdict = 'generated';
                        o.samplers = j.samplers; o.correlations = j.correlations;
                        o.bodyCorrelations = j.bodyCorrelations; o.parameterized = j.parameterized;
                    }
                } catch { /* ignore malformed */ }
            }
            return o;
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
    const flags = flagsForRunMode(mode);
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
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
        if (p === '/' && req.method === 'GET') return send(res, 200, PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
        if (p === '/api/state' && req.method === 'GET') return send(res, 200, { inputs: listInputs(), outputs: listOutputs(), busy: !!activeChild });
        if (p === '/api/config' && req.method === 'GET') return send(res, 200, readConfigForUi());
        if (p === '/api/config' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, writeConfigFromUi(JSON.parse(b.toString() || '{}'))); }
        if (p === '/api/run' && req.method === 'POST') { const r = startRun(u.searchParams.get('mode') || 'generate'); return send(res, r.error ? 409 : 200, r); }
        if (p === '/api/cancel' && req.method === 'POST') { if (activeChild) { activeChild.kill(); return send(res, 200, { ok: true }); } return send(res, 200, { ok: false, error: 'no active run' }); }
        if (p.startsWith('/out/') && req.method === 'GET') return serveOutputFile(res, decodeURIComponent(p.slice('/out/'.length)));
        if (p === '/api/log' && req.method === 'GET') {
            const id = Number(u.searchParams.get('id')); const since = Number(u.searchParams.get('since')) || 0;
            const rec = runs.get(id); if (!rec) return send(res, 404, { error: 'no such run' });
            return send(res, 200, { lines: rec.lines.slice(since), total: rec.lines.length, done: rec.done, code: rec.code });
        }
        if (p === '/api/upload' && req.method === 'POST') {
            const name = path.basename(u.searchParams.get('name') || '');
            if (!name || /\.(exe|cmd|bat|ps1|js|mjs|cjs)$/i.test(name)) return send(res, 400, { error: 'unsupported or unsafe file type' });
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

// Port fallback: if START_PORT is taken, try the next few before giving up.
function listenWithFallback(port, attemptsLeft) {
    server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attemptsLeft > 0) {
            process.stdout.write(`port ${port} in use, trying ${port + 1}…\n`);
            listenWithFallback(port + 1, attemptsLeft - 1);
        } else {
            process.stderr.write(`UI server failed to start: ${e.message}\n`);
            process.exit(1);
        }
    });
    server.listen(port, () => {
        process.stdout.write(`\nperfscript UI running →  http://localhost:${port}\n(input: ${INPUT})\nClose this window to stop the UI.\n`);
    });
}
listenWithFallback(START_PORT, 10);

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
.danger{background:#5a2330;color:#ffb4b4}
button:disabled{opacity:.5;cursor:not-allowed}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mut)}
input{font:inherit;background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink);min-width:180px}
input.sm{min-width:80px;width:80px}code{background:#0e1524;padding:1px 5px;border-radius:5px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
li:last-child{border:0}.mut{color:var(--mut)}a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.tag{font-size:12px;padding:2px 8px;border-radius:20px;background:#223050;color:var(--mut)}
.tag.ok{background:rgba(57,217,138,.15);color:var(--ok)}.tag.warn{background:rgba(255,180,84,.15);color:var(--warn)}
.bar{height:9px;background:#0e1524;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:12px 0 6px;display:none}
.bar.on{display:block}
.bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--ok));transition:width .5s ease;border-radius:6px}
.bar.indet>i{width:38%;animation:slide 1.1s infinite ease-in-out}
.bar.err>i{background:#ff6b6b}
@keyframes slide{0%{margin-left:-38%}100%{margin-left:100%}}
.phase{font-size:13px;color:var(--ink);font-weight:600}.elapsed{color:var(--mut);font-size:12px;margin-left:8px}
.sum{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0}
.pill{font-size:12px;padding:2px 9px;border-radius:20px;background:#223050;color:var(--mut)}
.pill.ok{background:rgba(57,217,138,.15);color:var(--ok)}.pill.bad{background:rgba(255,107,107,.16);color:#ff8a8a}
.fails{margin:6px 0 0;max-height:150px;overflow:auto}
.fails div{font:12px ui-monospace,Consolas,monospace;color:#ffb0b0;padding:3px 0;border-bottom:1px solid var(--line)}
.acts{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.dl{background:var(--ok);color:#04140c;padding:7px 13px;border-radius:8px;font-weight:600;font-size:13px;text-decoration:none}
.open{background:#223050;color:var(--ink);padding:7px 13px;border-radius:8px;font-size:13px;text-decoration:none}
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
   <input id="file" type="file" multiple style="display:none">
   <ul id="inputs"></ul>
  </div>
  <div class="card">
   <h2>2 · Run</h2>
   <div class="row">
    <button id="gen" class="primary">Generate</button>
    <button id="run" class="ghost">Generate + Validate (JMeter)</button>
    <button id="agent" class="ghost">Senior AI Agent (one-shot)</button>
    <button id="senior-agent" class="ghost">Mature PE Agent</button>
    <button id="agent-watch" class="ghost">Start Watch Agent</button>
    <button id="cancel" class="danger" style="display:none">Cancel</button>
   </div>
   <div id="bar" class="bar"><i></i></div>
   <div><span id="phase" class="phase"></span><span id="elapsed" class="elapsed"></span></div>
   <p class="mut" style="font-size:13px">Generate = correlate &amp; build the .jmx. Validate = also execute it with local JMeter and report pass/fail. Senior AI Agent (one-shot) = Validate plus bounded OpenAI/Gemini diagnosis, safe JSON patching, and re-verification. Start Watch Agent = the same agent in folder-watch mode, like <code>START_AGENT.cmd</code>; stop it with Cancel. Settings are saved automatically before each run. The final <code>.jmx</code> is always saved to <code>output\\&lt;name&gt;\\</code>.</p>
   <div id="status" class="mut"></div>
  </div>
  <div class="card full">
   <h2>Settings <span class="mut" style="text-transform:none;letter-spacing:0">— used by Validate and Agent</span></h2>
   <div class="row">
    <label>Target URL<input id="cfg-target" placeholder="https://stage.example.com"></label>
    <label>Username<input id="cfg-user" placeholder="test user"></label>
    <label>Password<input id="cfg-pass" type="password" placeholder="(unchanged)"></label>
   </div>
   <div class="row">
    <label>Users<input id="cfg-users" type="number" min="1" class="sm"></label>
    <label>Ramp-up (s)<input id="cfg-ramp" type="number" min="0" class="sm"></label>
    <label>Hold (s)<input id="cfg-hold" type="number" min="0" class="sm"></label>
    <label>Senior mode<select id="cfg-senior" style="font:inherit;background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink)"><option value="strong">strong</option><option value="mature">mature</option><option value="off">off</option></select></label>
   </div>
   <div class="row">
    <label>Business objective<input id="cfg-objective" placeholder="checkout capacity / soak / certification"></label>
    <label>Tech stack<input id="cfg-stack" placeholder="React, Spring Boot, OAuth"></label>
   </div>
   <div class="row">
    <label>Domain notes<input id="cfg-domain" placeholder="business rules, cleanup, data dependencies"></label>
    <label>p95 SLO (ms)<input id="cfg-p95" type="number" min="0" class="sm"></label>
    <label>Error %<input id="cfg-error" type="number" min="0" class="sm"></label>
    <button id="cfg-save" class="ghost">Save settings</button>
    <span id="cfg-status" class="mut"></span>
   </div>
   <p class="mut" style="font-size:12.5px">Saved to <code>perfscript.config.json</code>. The password is write-only — never shown back.</p>
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
   const t=o.verdict==='GREEN'?'<span class="tag ok">GREEN</span>':o.verdict==='needs attention'?'<span class="tag warn">needs attention</span>':'<span class="tag">generated</span>';
   let summary='';
   if(o.kind==='validated'){
     const pct=o.total?Math.round(o.passed/o.total*100):0;
     summary=\`<div class="sum"><span class="pill ok">\${o.passed} passed</span><span class="pill \${o.failed?'bad':''}">\${o.failed} failed</span><span class="pill">\${pct}% of \${o.total} app requests</span></div>\`;
     if(o.failedTop&&o.failedTop.length){
       summary+=\`<div class="fails"><div class="mut" style="border:0">What failed / needs fixing:</div>\${o.failedTop.map(f=>\`<div>\${esc(String(f.code||'ERR'))}  \${esc(f.label)}</div>\`).join('')}</div>\`;
     }
   } else {
     summary=\`<div class="sum"><span class="pill">\${o.samplers||0} samplers</span><span class="pill ok">\${o.correlations||0} correlations\${o.bodyCorrelations?' (+'+o.bodyCorrelations+' body/session)':''}</span><span class="pill">\${o.parameterized||0} parameterized</span></div>\`;
   }
   const acts=[o.jmx?\`<a class="dl" href="/out/\${encodeURIComponent(o.name)}/\${encodeURIComponent(o.jmx)}">⬇ Download .jmx</a>\`:'',o.report?\`<a class="open" href="/out/\${encodeURIComponent(o.name)}/\${encodeURIComponent(o.report)}" target="_blank">Open report</a>\`:''].filter(Boolean).join('');
   return \`<li style="flex-direction:column;align-items:stretch;gap:2px"><div class="row" style="justify-content:space-between"><b>\${esc(o.name)}</b> \${t}</div>\${summary}<div class="acts">\${acts}</div><div class="mut" style="font-size:12px">saved to output\\\\\${esc(o.name)}\\\\</div></li>\`;
 }).join(''):'<li class="mut">No results yet.</li>';
$('#gen').disabled=$('#run').disabled=$('#agent').disabled=$('#senior-agent').disabled=$('#agent-watch').disabled=s.busy;
 $('#cancel').style.display=s.busy?'':'none';
 return s;
}
// Map the streamed log to a rough progress % + human phase label.
function phaseOf(txt){
 const has=r=>r.test(txt);
 if(has(/DONE —|verdict=|report\\.html|Done\\./)) return {pct:100,label:'Finished'};
 if(has(/\\[iter\\]|re-verifying|LLM/)) return {pct:85,label:'Validating (auto-fix loop)…'};
 if(has(/running bounded feedback loop|target=|stripped .* listener|jmeter=/)) return {pct:70,label:'Running in JMeter…'};
 if(has(/generated .*\\.jmx|samplers,/)) return {pct:55,label:'Built the .jmx — correlating…'};
 if(has(/wrote recording|scrubbed/)) return {pct:35,label:'Extracting values…'};
 if(has(/parsed \\d+ entries|mode=/)) return {pct:20,label:'Parsing recordings…'};
 return {pct:8,label:'Starting…'};
}
async function loadCfg(){
 const c=await j('/api/config');
 $('#cfg-target').value=c.targetBaseUrl||'';$('#cfg-user').value=c.username||'';
 $('#cfg-pass').placeholder=c.hasPassword?'(saved — unchanged)':'password';
 $('#cfg-users').value=c.loadProfile.users||'';$('#cfg-ramp').value=c.loadProfile.rampUpSec||'';$('#cfg-hold').value=c.loadProfile.holdSec||'';
 $('#cfg-senior').value=c.seniorMode||'strong';
 $('#cfg-objective').value=c.testObjective||'';$('#cfg-stack').value=c.techStack||'';$('#cfg-domain').value=c.domainNotes||'';
 $('#cfg-p95').value=(c.slo&&c.slo.p95Ms)||'';$('#cfg-error').value=(c.slo&&c.slo.errorRatePct)||'';
}
function cfgBody(){
 return {targetBaseUrl:$('#cfg-target').value,username:$('#cfg-user').value,password:$('#cfg-pass').value,
   loadProfile:{users:$('#cfg-users').value,rampUpSec:$('#cfg-ramp').value,holdSec:$('#cfg-hold').value},
   seniorMode:$('#cfg-senior').value,testObjective:$('#cfg-objective').value,techStack:$('#cfg-stack').value,
   domainNotes:$('#cfg-domain').value,slo:{p95Ms:$('#cfg-p95').value,errorRatePct:$('#cfg-error').value}};
}
async function saveCfg(quiet=false){
 await fetch('/api/config',{method:'POST',body:JSON.stringify(cfgBody())});
 $('#cfg-pass').value='';
 if(!quiet){$('#cfg-status').textContent='Saved.';setTimeout(()=>$('#cfg-status').textContent='',2500)}
 loadCfg();
}
$('#cfg-save').onclick=()=>saveCfg(false);
$('#cancel').onclick=async()=>{await fetch('/api/cancel',{method:'POST'});$('#status').textContent='Cancelling…'};
async function start(mode){
 await saveCfg(true);
 const r=await j('/api/run?mode='+mode,{method:'POST'});
 if(r.error){$('#status').textContent=r.error;return}
 logEl.textContent='';$('#status').textContent='';
 const bar=$('#bar'),fill=bar.querySelector('i'),phaseEl=$('#phase'),elEl=$('#elapsed');
 bar.className='bar on indet';fill.style.width='8%';phaseEl.textContent='Starting…';
 const t0=Date.now();let acc='';const id=r.id;let since=0;let lastRefresh=0;
 const tick=setInterval(()=>{if(phaseEl.textContent.indexOf('Finished')<0)elEl.textContent=((Date.now()-t0)/1000|0)+'s elapsed'},1000);
 clearInterval(poll);
 poll=setInterval(async()=>{
  const d=await j('/api/log?id='+id+'&since='+since);
  if(d.lines&&d.lines.length){since=d.total;acc+=d.lines.join('\\n')+'\\n';logEl.textContent=acc;logEl.scrollTop=logEl.scrollHeight;
    const ph=phaseOf(acc);fill.style.width=Math.max(8,ph.pct)+'%';phaseEl.textContent=ph.label;
    if(ph.pct>=20)bar.classList.remove('indet');}
  if(Date.now()-lastRefresh>4000){lastRefresh=Date.now();refresh()}
  if(d.done){clearInterval(poll);poll=null;clearInterval(tick);
    const ok=d.code===0;fill.style.width='100%';bar.className='bar on'+(ok?'':' err');
    phaseEl.textContent=ok?'Finished ✓ — see Results below':'Finished with errors (exit '+d.code+')';
    setTimeout(()=>{bar.className='bar'},3000);refresh()}
 },600);
}
$('#gen').onclick=()=>start('generate');
$('#run').onclick=()=>start('run');
$('#agent').onclick=()=>start('agent');
$('#senior-agent').onclick=()=>start('senior-agent');
$('#agent-watch').onclick=()=>start('agent-watch');
async function del(n){await fetch('/api/input?name='+encodeURIComponent(n),{method:'DELETE'});refresh()}
async function upload(files){for(const f of files){await fetch('/api/upload?name='+encodeURIComponent(f.name),{method:'POST',body:await f.arrayBuffer()})}refresh()}
const drop=$('#drop'),file=$('#file');
drop.onclick=()=>file.click();file.onchange=()=>upload(file.files);
drop.ondragover=e=>{e.preventDefault();drop.classList.add('hi')};
drop.ondragleave=()=>drop.classList.remove('hi');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('hi');upload(e.dataTransfer.files)};
refresh();loadCfg();setInterval(()=>{if(!poll)refresh()},4000);
</script></body></html>`;
