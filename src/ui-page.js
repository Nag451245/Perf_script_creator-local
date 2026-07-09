'use strict';

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>PerfScript Agent Launcher</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#070b12;--panel:#0f1724;--panel2:#141f31;--card:#101a2a;--ink:#edf4ff;--mut:#91a0b8;--line:#243149;--line2:#31415e;--acc:#5aa9ff;--acc2:#8b5cf6;--ok:#31d48a;--warn:#f7b955;--bad:#ff6b78;--shadow:0 24px 70px rgba(0,0,0,.35)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;font:14px/1.45 Inter,Segoe UI,Roboto,Arial,sans-serif;background:radial-gradient(circle at top left,rgba(90,169,255,.20),transparent 34%),linear-gradient(135deg,#070b12 0%,#0b1120 44%,#111827 100%);color:var(--ink)}
button,input,select,textarea{font:inherit}button{border:0;border-radius:12px;padding:10px 14px;font-weight:750;cursor:pointer;transition:.15s ease transform,.15s ease opacity,.15s ease background}button:hover{transform:translateY(-1px)}button:disabled{opacity:.45;cursor:not-allowed;transform:none}.primary{background:linear-gradient(135deg,var(--acc),var(--acc2));color:white}.secondary{background:#22304a;color:var(--ink)}.ghost{background:transparent;color:var(--mut);border:1px solid var(--line2)}.danger{background:#4a1d2a;color:#ffc3ca}.okBtn{background:#163b2d;color:#a8ffd7}
.shell{display:grid;grid-template-columns:minmax(390px,470px) minmax(0,1fr);gap:18px;min-height:100vh;padding:18px}.left,.right{background:rgba(15,23,36,.84);border:1px solid rgba(148,163,184,.18);border-radius:24px;box-shadow:var(--shadow);overflow:hidden;backdrop-filter:blur(14px)}.left{display:flex;flex-direction:column}.right{display:grid;grid-template-rows:auto minmax(220px,1fr) auto auto}
.chatBar{border-top:1px solid var(--line);padding:12px 18px;background:rgba(7,11,18,.35)}.chat{max-height:190px;min-height:64px;overflow:auto;border:1px solid var(--line);border-radius:14px;background:#0a0f1c;padding:10px;display:grid;gap:6px}.chatEmpty{color:var(--mut);font-size:12px;text-align:center;padding:8px}.msg{max-width:86%;padding:8px 11px;border-radius:12px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.msg.agent{background:#132036;border:1px solid #24344f;justify-self:start}.msg.you{background:linear-gradient(135deg,rgba(90,169,255,.25),rgba(139,92,246,.22));border:1px solid #3d548a;justify-self:end}
.brand{padding:22px 22px 16px;border-bottom:1px solid var(--line);background:linear-gradient(135deg,rgba(90,169,255,.14),rgba(139,92,246,.08))}.brand h1{margin:0;font-size:22px;letter-spacing:-.02em}.brand p{margin:7px 0 0;color:var(--mut)}.content{padding:16px 18px;overflow:auto}.section{border:1px solid var(--line);background:rgba(16,26,42,.82);border-radius:18px;padding:14px;margin-bottom:14px}.section h2{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#a9b7cf}.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.row.between{justify-content:space-between}.stack{display:grid;gap:10px}.mut{color:var(--mut)}.tiny{font-size:12px}.pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 9px;font-size:12px;background:#1b2940;color:#b8c5db}.pill.ok{background:rgba(49,212,138,.14);color:var(--ok)}.pill.warn{background:rgba(247,185,85,.14);color:var(--warn)}.pill.bad{background:rgba(255,107,120,.14);color:#ff9ea8}
.drop{border:1px dashed var(--line2);border-radius:16px;padding:16px;text-align:center;color:var(--mut);background:rgba(7,11,18,.34);cursor:pointer}.drop.hi{border-color:var(--acc);color:var(--ink);background:rgba(90,169,255,.08)}
.unit{display:grid;grid-template-columns:auto 1fr;gap:11px;border:1px solid var(--line);border-radius:15px;padding:11px;background:#0b1321;margin-bottom:9px}.unit input{margin-top:3px}.unit strong{display:block}.meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.files{margin-top:6px;color:var(--mut);font:12px/1.45 ui-monospace,Consolas,monospace;word-break:break-all}.issue{border-left:3px solid var(--warn);padding:7px 9px;background:rgba(247,185,85,.08);border-radius:8px;margin-top:6px;color:#ffd892}
label{display:grid;gap:5px;color:var(--mut);font-size:12px}input,select,textarea{width:100%;border:1px solid var(--line2);border-radius:11px;background:#090f1b;color:var(--ink);padding:9px 10px}textarea{resize:vertical;min-height:56px}.two{display:grid;grid-template-columns:1fr 1fr;gap:9px}.three{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.topbar{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;align-items:center;background:rgba(7,11,18,.35)}.topbar h2{margin:0;font-size:18px}.statusLine{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.progress{height:8px;background:#09101d;border:1px solid var(--line);border-radius:999px;overflow:hidden;margin-top:9px}.progress i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--ok));transition:width .35s ease}.progress.err i{background:var(--bad)}
.logTools{display:flex;gap:8px;align-items:center}.logWrap{padding:16px 18px;min-height:0}.log{height:100%;min-height:360px;border:1px solid var(--line);border-radius:18px;background:#050914;color:#cdd8ec;padding:14px;overflow:auto;white-space:pre-wrap;font:12.5px/1.55 ui-monospace,Consolas,monospace}.results{border-top:1px solid var(--line);padding:14px 18px;max-height:310px;overflow:auto}.result{border:1px solid var(--line);background:#0b1321;border-radius:16px;padding:12px;margin-bottom:10px}.result h3{margin:0;font-size:15px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}a.action{display:inline-flex;align-items:center;border-radius:10px;padding:8px 11px;background:#21304a;color:var(--ink);text-decoration:none;font-weight:700}.empty{padding:14px;border:1px dashed var(--line2);border-radius:14px;color:var(--mut);text-align:center}
@media(max-width:980px){.shell{grid-template-columns:1fr}.right{min-height:720px}.two,.three{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
<aside class="left">
  <div class="brand">
    <h1>PerfScript Agent Launcher</h1>
    <p>One launcher for HAR, JMX, XML/JTL sidecars, validation, agent repair, rerun, and live logs.</p>
  </div>
  <div class="content">
    <div class="section">
      <div class="row between"><h2>Input Scripts</h2><span id="input-count" class="pill">0 scripts</span></div>
      <div id="drop" class="drop">Drop HAR, JMX, XML, or JTL files here, or click to browse</div>
      <input id="file" type="file" multiple style="display:none">
      <div class="row" style="margin:10px 0">
        <button id="select-all" class="ghost" type="button">Select all</button>
        <button id="select-none" class="ghost" type="button">Clear</button>
      </div>
      <div id="units"></div>
      <div id="input-issues"></div>
    </div>

    <div class="section">
      <h2>Run Control</h2>
      <div class="stack">
        <label>Run mode
          <select id="mode">
            <option value="agent">Senior AI Agent</option>
            <option value="senior-agent">Mature PE Agent</option>
            <option value="run">Generate + Validate</option>
            <option value="generate">Generate only</option>
            <option value="agent-watch">Watch input folder</option>
          </select>
        </label>
        <div class="three">
          <label>Fix iterations
            <select id="iterations">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3" selected>3 (default)</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6 (max)</option>
            </select>
          </label>
          <label>Retry failed<input id="retry" type="number" min="1" placeholder="3"></label>
          <label>Gemini Pro<select id="gemini-pro"><option value="">No</option><option value="1">Yes</option></select></label>
        </div>
        <div class="row">
          <button id="run-selected" class="primary" type="button">Run selected</button>
          <button id="rerun-last" class="secondary" type="button">Rerun last</button>
          <button id="force-run" class="ghost" type="button">Force rerun selected</button>
          <button id="stop" class="danger" type="button" disabled>Stop</button>
        </div>
        <div id="run-hint" class="tiny mut">Select one or more logical scripts. Multi-select runs them sequentially in one agent pass.</div>
      </div>
    </div>

    <div class="section">
      <h2>Environment</h2>
      <div class="stack">
        <label>Target URL<input id="cfg-target" placeholder="https://stage.example.com"></label>
        <div class="two">
          <label>Username<input id="cfg-user" placeholder="test user"></label>
          <label>Password<input id="cfg-pass" type="password" placeholder="unchanged"></label>
        </div>
        <div class="three">
          <label>Users<input id="cfg-users" type="number" min="1"></label>
          <label>Ramp-up sec<input id="cfg-ramp" type="number" min="0"></label>
          <label>Hold sec<input id="cfg-hold" type="number" min="0"></label>
        </div>
        <label>Business objective<input id="cfg-objective" placeholder="capacity, soak, release certification"></label>
        <label>Tech stack<input id="cfg-stack" placeholder="React, Spring Boot, OAuth"></label>
        <label>Domain notes<textarea id="cfg-domain" placeholder="business rules, test data, cleanup needs"></textarea></label>
        <div class="two">
          <label>p95 SLO ms<input id="cfg-p95" type="number" min="0"></label>
          <label>Error %<input id="cfg-error" type="number" min="0"></label>
        </div>
        <div class="row"><button id="cfg-save" class="secondary" type="button">Save settings</button><span id="cfg-status" class="tiny mut"></span></div>
      </div>
    </div>
  </div>
</aside>

<main class="right">
  <div class="topbar">
    <div>
      <h2 id="phase">Idle</h2>
      <div class="statusLine"><span id="busy-pill" class="pill">Ready</span><span id="selected-pill" class="pill">0 selected</span><span id="elapsed" class="tiny mut"></span></div>
      <div id="progress" class="progress"><i></i></div>
    </div>
    <div class="logTools">
      <button id="copy-log" class="ghost" type="button">Copy log</button>
      <button id="clear-log" class="ghost" type="button">Clear</button>
    </div>
  </div>
  <div class="logWrap"><pre id="log" class="log">Idle. Add or select scripts, then run the agent.</pre></div>
  <div class="chatBar">
    <div class="row between" style="margin-bottom:6px">
      <h2 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#a9b7cf">Steer the agent</h2>
      <span id="chat-hint" class="tiny mut">protect &lt;name&gt; · disable &lt;name&gt; · free-text guidance · questions end with ?</span>
    </div>
    <div id="chat" class="chat"><div class="chatEmpty">Agent chat appears here during a run. Your messages change its next decision.</div></div>
    <div class="row" style="margin-top:8px">
      <input id="chat-input" placeholder='e.g. "protect POST /tasks" or "the /export download is business-critical, do not fold it"' style="flex:1">
      <button id="chat-send" class="primary" type="button" disabled>Send</button>
    </div>
  </div>
  <div class="results">
    <div class="row between"><h2 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#a9b7cf">Results</h2><button id="refresh" class="ghost" type="button">Refresh</button></div>
    <div id="outputs" style="margin-top:10px"></div>
  </div>
</main>
</div>

<script>
var currentRunId=null,poll=null,lastState=null,startedAt=0,logText='';
function q(s){return document.querySelector(s)}
function qa(s){return Array.prototype.slice.call(document.querySelectorAll(s))}
function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
async function j(url,opt){var r=await fetch(url,opt||{});var d=await r.json();if(!r.ok)throw new Error(d.error||r.statusText);return d}
function selectedInputs(){return qa('.unit-check:checked').map(function(x){return x.value})}
function updateSelectedPill(){q('#selected-pill').textContent=selectedInputs().length+' selected'}
function phaseOf(txt){
 if(/Finished|DONE|verdict=|report\\.html|Done\\./i.test(txt))return{pct:100,label:'Finished'};
 if(/adjudicat|fold probe|re-verifying|LLM|round/i.test(txt))return{pct:86,label:'Agent repairing and verifying'};
 if(/running bounded feedback loop|jmeter=|target=/i.test(txt))return{pct:68,label:'Running JMeter validation'};
 if(/generated .*\\.jmx|samplers,/i.test(txt))return{pct:52,label:'Generated JMX and correlations'};
 if(/wrote recording|scrubbed|parsed \\d+ entries/i.test(txt))return{pct:28,label:'Reading recordings'};
 return{pct:10,label:'Starting'};
}
async function refresh(){
 var s=await j('/api/state');lastState=s;
 renderUnits(s.inputUnits||[]);renderIssues(s.inputIssues||[]);renderOutputs(s.outputs||[]);
 q('#input-count').textContent=(s.inputUnits||[]).length+' scripts';
 q('#busy-pill').textContent=s.busy?'Running':'Ready';q('#busy-pill').className='pill '+(s.busy?'warn':'ok');
 q('#stop').disabled=!s.busy;q('#run-selected').disabled=s.busy;q('#force-run').disabled=s.busy;q('#rerun-last').disabled=s.busy||!s.lastRun;
 if(s.activeRun&&!currentRunId){startPolling(s.activeRun.id,false)}
 updateSelectedPill();return s;
}
function renderUnits(units){
 if(!units.length){q('#units').innerHTML='<div class="empty">No runnable HAR/JMX scripts found in input. Drop files above.</div>';return}
 q('#units').innerHTML=units.map(function(u){
  var warns=(u.warnings||[]).map(function(w){return '<div class="issue">'+esc(w.message)+'</div>'}).join('');
  var files=(u.files||[]).map(function(f){return esc(f.role+': '+f.name)}).join('<br>');
  return '<label class="unit"><input class="unit-check" type="checkbox" value="'+esc(u.id)+'"><span><strong>'+esc(u.name)+'</strong><span class="meta"><span class="pill">'+esc(u.kind)+'</span><span class="pill">'+(u.requestCount||0)+' requests</span><span class="pill">'+esc((u.hosts||[]).join(', ')||'no host')+'</span></span><div class="files">'+files+'</div>'+warns+'</span></label>';
 }).join('');
 qa('.unit-check').forEach(function(x){x.onchange=updateSelectedPill});
}
function renderIssues(issues){
 q('#input-issues').innerHTML=(issues||[]).filter(function(i){return i.severity==='error'||i.severity==='warning'}).slice(0,8).map(function(i){return '<div class="issue">'+esc(i.severity.toUpperCase()+': '+i.message)+'</div>'}).join('');
}
function renderOutputs(outputs){
 if(!outputs.length){q('#outputs').innerHTML='<div class="empty">No output yet. Completed runs will appear here.</div>';return}
 q('#outputs').innerHTML=outputs.map(function(o){
  var cls=o.verdict==='GREEN'?'ok':(o.verdict==='needs attention'?'warn':'');
  var summary=o.kind==='validated'?'<div class="meta"><span class="pill ok">'+(o.passed||0)+' passed</span><span class="pill '+((o.failed||0)?'bad':'')+'">'+(o.failed||0)+' failed</span><span class="pill">'+(o.total||0)+' app requests</span></div>':'<div class="meta"><span class="pill">'+(o.samplers||0)+' samplers</span><span class="pill ok">'+(o.correlations||0)+' correlations</span></div>';
  var actions='';
  if(o.report)actions+='<a class="action" target="_blank" href="/out/'+encodeURIComponent(o.name)+'/'+encodeURIComponent(o.report)+'">Open report</a>';
  if(o.jmx)actions+='<a class="action" href="/out/'+encodeURIComponent(o.name)+'/'+encodeURIComponent(o.jmx)+'">Download JMX</a>';
  actions+='<button class="ghost" type="button" data-name="'+esc(o.name)+'" onclick="rerunName(this.dataset.name)">Rerun this</button>';
  return '<div class="result"><div class="row between"><h3>'+esc(o.name)+'</h3><span class="pill '+cls+'">'+esc(o.verdict||'generated')+'</span></div>'+summary+'<div class="actions">'+actions+'</div></div>';
 }).join('');
}
function requestBody(force){
 return JSON.stringify({mode:q('#mode').value,selectedInputs:selectedInputs(),force:!!force,iterations:q('#iterations').value,retryFailed:q('#retry').value,geminiPro:q('#gemini-pro').value==='1'});
}
async function saveCfg(quiet){
 await fetch('/api/config',{method:'POST',body:JSON.stringify({targetBaseUrl:q('#cfg-target').value,username:q('#cfg-user').value,password:q('#cfg-pass').value,loadProfile:{users:q('#cfg-users').value,rampUpSec:q('#cfg-ramp').value,holdSec:q('#cfg-hold').value},seniorMode:q('#mode').value==='senior-agent'?'mature':'strong',testObjective:q('#cfg-objective').value,techStack:q('#cfg-stack').value,domainNotes:q('#cfg-domain').value,slo:{p95Ms:q('#cfg-p95').value,errorRatePct:q('#cfg-error').value}})});
 q('#cfg-pass').value='';if(!quiet){q('#cfg-status').textContent='Saved';setTimeout(function(){q('#cfg-status').textContent=''},1800)}loadCfg();
}
async function loadCfg(){var c=await j('/api/config');q('#cfg-target').value=c.targetBaseUrl||'';q('#cfg-user').value=c.username||'';q('#cfg-pass').placeholder=c.hasPassword?'saved - unchanged':'password';q('#cfg-users').value=c.loadProfile.users||'';q('#cfg-ramp').value=c.loadProfile.rampUpSec||'';q('#cfg-hold').value=c.loadProfile.holdSec||'';q('#cfg-objective').value=c.testObjective||'';q('#cfg-stack').value=c.techStack||'';q('#cfg-domain').value=c.domainNotes||'';q('#cfg-p95').value=(c.slo&&c.slo.p95Ms)||'';q('#cfg-error').value=(c.slo&&c.slo.errorRatePct)||''}
async function run(force){await saveCfg(true);var d=await j('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:requestBody(force)});logText='';q('#log').textContent='';startPolling(d.id,true);refresh()}
async function rerunLast(){var d=await j('/api/rerun',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});logText='';q('#log').textContent='';startPolling(d.id,true);refresh()}
async function rerunName(name){var d=await j('/api/rerun',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selectedInputs:[name]})});logText='';q('#log').textContent='';startPolling(d.id,true);refresh()}
function addChat(role,text){var box=q('#chat');var empty=box.querySelector('.chatEmpty');if(empty)empty.remove();var el=document.createElement('div');el.className='msg '+role;el.textContent=text;box.appendChild(el);box.scrollTop=box.scrollHeight}
function absorbChatLines(lines){lines.forEach(function(line){var m=line.match(/^\\[chat\\]\\s+(you|agent):\\s*([\\s\\S]*)$/);if(m)addChat(m[1],m[2])})}
function setChatEnabled(on){q('#chat-send').disabled=!on;q('#chat-input').disabled=!on;q('#chat-input').placeholder=on?'e.g. "protect POST /tasks" or free-text guidance for the next fix round':'Chat is live only while a run is active'}
async function sendChat(){var t=q('#chat-input').value.trim();if(!t)return;q('#chat-input').value='';try{await j('/api/steer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})})}catch(e){addChat('agent','(not delivered: '+e.message+')')}}
function startPolling(id,reset){currentRunId=id;startedAt=Date.now();var since=0;if(reset){q('#progress i').style.width='5%';q('#chat').innerHTML='<div class="chatEmpty">Agent chat appears here during a run. Your messages change its next decision.</div>'}setChatEnabled(true);clearInterval(poll);poll=setInterval(async function(){var d=await j('/api/log?id='+id+'&since='+since);if(d.lines&&d.lines.length){since=d.total;absorbChatLines(d.lines);logText+=d.lines.join('\\n')+'\\n';q('#log').textContent=logText;q('#log').scrollTop=q('#log').scrollHeight;var ph=phaseOf(logText);q('#phase').textContent=ph.label;q('#progress i').style.width=ph.pct+'%'}if(startedAt)q('#elapsed').textContent=Math.floor((Date.now()-startedAt)/1000)+'s elapsed';if(d.done){clearInterval(poll);poll=null;currentRunId=null;setChatEnabled(false);q('#progress').className='progress'+(d.code===0?'':' err');q('#progress i').style.width='100%';q('#phase').textContent=d.code===0?'Finished':'Finished with errors (exit '+d.code+')';refresh()}},700)}
async function upload(files){for(var i=0;i<files.length;i++){var f=files[i];await fetch('/api/upload?name='+encodeURIComponent(f.name),{method:'POST',body:await f.arrayBuffer()})}refresh()}
q('#run-selected').onclick=function(){run(false).catch(function(e){alert(e.message)})};q('#force-run').onclick=function(){run(true).catch(function(e){alert(e.message)})};q('#rerun-last').onclick=function(){rerunLast().catch(function(e){alert(e.message)})};q('#stop').onclick=async function(){await fetch('/api/cancel',{method:'POST'});q('#phase').textContent='Stopping run'};q('#refresh').onclick=refresh;q('#cfg-save').onclick=function(){saveCfg(false)};q('#select-all').onclick=function(){qa('.unit-check').forEach(function(x){x.checked=true});updateSelectedPill()};q('#select-none').onclick=function(){qa('.unit-check').forEach(function(x){x.checked=false});updateSelectedPill()};q('#copy-log').onclick=function(){navigator.clipboard&&navigator.clipboard.writeText(q('#log').textContent)};q('#clear-log').onclick=function(){logText='';q('#log').textContent=''};
q('#chat-send').onclick=function(){sendChat()};q('#chat-input').onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();sendChat()}};
var drop=q('#drop'),file=q('#file');drop.onclick=function(){file.click()};file.onchange=function(){upload(file.files)};drop.ondragover=function(e){e.preventDefault();drop.classList.add('hi')};drop.ondragleave=function(){drop.classList.remove('hi')};drop.ondrop=function(e){e.preventDefault();drop.classList.remove('hi');upload(e.dataTransfer.files)};
refresh();loadCfg();setInterval(function(){if(!poll)refresh()},4000);
</script>
</body>
</html>`;

module.exports = { PAGE };
