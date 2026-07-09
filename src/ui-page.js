'use strict';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PerfScript Studio</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{
  --bg:#0b0e14; --bg2:#0f131c; --surface:#131926; --surface2:#171f2e; --raise:#1c2536;
  --ink:#e8edf6; --ink2:#aeb9cc; --mut:#6f7d95; --line:#232d40; --line2:#2c3850;
  --brand:#4f7cff; --brand2:#7c5cff; --accent:#22d3a6; --ok:#2fd08a; --warn:#f3b64b; --bad:#ff6a7a;
  --radius:14px; --radius-sm:10px; --shadow:0 1px 0 rgba(255,255,255,.03),0 12px 34px rgba(0,0,0,.38);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif;color:var(--ink);
  background:radial-gradient(1200px 600px at -10% -10%,rgba(79,124,255,.10),transparent 55%),radial-gradient(900px 500px at 110% 0%,rgba(124,92,255,.08),transparent 50%),var(--bg);
  -webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit;color:inherit}
button{border:0;border-radius:var(--radius-sm);padding:9px 14px;font-weight:600;cursor:pointer;letter-spacing:.01em;transition:background .15s,border-color .15s,opacity .15s,transform .06s}
button:active{transform:translateY(1px)}
button:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;box-shadow:0 6px 18px rgba(79,124,255,.28)}
.btn-primary:hover:not(:disabled){filter:brightness(1.06)}
.btn-soft{background:var(--raise);color:var(--ink);border:1px solid var(--line2)}
.btn-soft:hover:not(:disabled){border-color:#3a496a}
.btn-ghost{background:transparent;color:var(--ink2);border:1px solid var(--line)}
.btn-ghost:hover:not(:disabled){color:var(--ink);border-color:var(--line2)}
.btn-danger{background:#2a1620;color:#ffb3bd;border:1px solid #4a2330}
.btn-danger:hover:not(:disabled){background:#351a26}

.appbar{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;border-bottom:1px solid var(--line);background:rgba(15,19,28,.7);backdrop-filter:blur(10px);position:sticky;top:0;z-index:20}
.brand{display:flex;align-items:center;gap:11px}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--brand),var(--brand2));display:grid;place-items:center;box-shadow:0 6px 16px rgba(79,124,255,.35)}
.logo svg{width:17px;height:17px}
.brand h1{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em}
.brand .tag{color:var(--mut);font-size:11.5px;font-weight:500;margin-top:1px}
.appbar-right{display:flex;align-items:center;gap:8px}
.env-chip{display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:5px 11px;font-size:12px;color:var(--ink2)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--mut)}
.dot.live{background:var(--accent);box-shadow:0 0 0 3px rgba(34,211,166,.16)}

.shell{display:grid;grid-template-columns:400px minmax(0,1fr);gap:16px;padding:16px;align-items:start}
.col{display:flex;flex-direction:column;gap:14px;min-width:0}
.card{background:linear-gradient(180deg,var(--surface),var(--bg2));border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.card-h{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid var(--line)}
.card-h h2{margin:0;font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--ink2)}
.card-b{padding:14px 15px}
.count{font-size:11.5px;color:var(--mut);background:var(--raise);border:1px solid var(--line);border-radius:999px;padding:3px 9px}

.drop{border:1.5px dashed var(--line2);border-radius:var(--radius-sm);padding:18px 14px;text-align:center;color:var(--mut);background:rgba(255,255,255,.012);cursor:pointer;transition:.15s;font-size:13px}
.drop:hover{border-color:#3a496a;color:var(--ink2)}
.drop.hot{border-color:var(--brand);color:var(--ink);background:rgba(79,124,255,.08)}
.mini-actions{display:flex;gap:8px;margin:11px 0 4px}
.mini-actions .btn-ghost{padding:6px 11px;font-size:12.5px}

.unit{border:1px solid var(--line);border-radius:12px;padding:11px 12px;margin-top:10px;background:var(--surface2);transition:.15s;cursor:pointer;position:relative}
.unit:hover{border-color:var(--line2);background:var(--raise)}
.unit.sel{border-color:var(--brand);background:rgba(79,124,255,.08);box-shadow:0 0 0 1px rgba(79,124,255,.35) inset}
.unit-top{display:flex;align-items:flex-start;gap:11px}
.chk{appearance:none;width:18px;height:18px;border:1.5px solid var(--line2);border-radius:6px;margin-top:2px;flex:none;cursor:pointer;position:relative;transition:.12s;background:var(--bg)}
.chk:checked{background:var(--brand);border-color:var(--brand)}
.chk:checked::after{content:"";position:absolute;left:5px;top:2px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.unit-name{font-weight:650;font-size:13.5px;word-break:break-word}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.chip{font-size:11px;font-weight:600;padding:3px 8px;border-radius:7px;background:var(--raise);color:var(--ink2);border:1px solid var(--line)}
.chip.kind{background:rgba(79,124,255,.14);color:#a9c1ff;border-color:transparent}
.chip.host{background:transparent;color:var(--mut);font-weight:500}
.chip.golden{background:rgba(243,182,75,.16);color:var(--warn);border-color:transparent}
.unit-files{margin-top:8px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--mut);word-break:break-all}
.unit-files b{color:var(--ink2);font-weight:600}
.warnrow{margin-top:8px;border-left:2px solid var(--warn);padding:6px 9px;background:rgba(243,182,75,.07);border-radius:6px;color:#ffdc9a;font-size:12px}
.empty{padding:16px;border:1px dashed var(--line2);border-radius:12px;color:var(--mut);text-align:center;font-size:13px}

.field{display:grid;gap:6px;margin-bottom:11px}
.field label{font-size:11.5px;font-weight:600;color:var(--ink2);letter-spacing:.02em}
.field input,.field select,.field textarea{width:100%;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-sm);padding:9px 11px;transition:border-color .15s,box-shadow .15s}
.field input:focus,.field select:focus,.field textarea:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(79,124,255,.18)}
.field textarea{resize:vertical;min-height:56px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.run-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.hint{font-size:12px;color:var(--mut);margin-top:9px}
.pair{display:none;align-items:center;gap:10px;margin:6px 0 2px;padding:10px 12px;border:1px solid rgba(124,92,255,.4);background:rgba(124,92,255,.09);border-radius:var(--radius-sm)}
.pair.show{display:flex}
.pair .sw{position:relative;width:38px;height:22px;flex:none}
.pair .sw input{opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.pair .track{position:absolute;inset:0;background:var(--line2);border-radius:999px;transition:.15s;pointer-events:none}
.pair .knob{position:absolute;top:3px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.15s;pointer-events:none}
.pair input:checked ~ .track{background:linear-gradient(135deg,var(--brand),var(--brand2))}
.pair input:checked ~ .knob{left:19px}
.pair .txt{font-size:12.5px;color:var(--ink2)}
.pair .txt b{color:var(--ink)}

.stage{display:grid;grid-template-rows:auto minmax(200px,1fr) auto auto;min-height:calc(100vh - 88px)}
.stage-h{display:flex;align-items:center;justify-content:space-between;padding:15px 18px;border-bottom:1px solid var(--line)}
.phase{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em}
.statusline{display:flex;align-items:center;gap:9px;margin-top:7px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:999px;background:var(--raise);color:var(--ink2);border:1px solid var(--line)}
.badge.ready{color:var(--accent)} .badge.run{color:var(--warn)} .badge.ok{color:var(--ok)} .badge.bad{color:var(--bad)}
.elapsed{font-size:12px;color:var(--mut)}
.progress{height:6px;background:var(--bg);border-radius:999px;overflow:hidden;margin-top:12px;border:1px solid var(--line)}
.progress i{display:block;height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--brand),var(--accent));transition:width .4s ease}
.progress.err i{background:linear-gradient(90deg,#ff6a7a,#f3b64b)}
.stage-tools{display:flex;gap:8px}
.stage-tools .btn-ghost{padding:7px 11px;font-size:12.5px}

.console{margin:14px 18px;border:1px solid var(--line);border-radius:12px;background:#080b12;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.console-h{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--surface)}
.tl{width:11px;height:11px;border-radius:50%}
.tl.r{background:#ff5f57}.tl.y{background:#febc2e}.tl.g{background:#28c840}
.console-h .lbl{margin-left:6px;font-size:12px;color:var(--mut);font-family:ui-monospace,Consolas,monospace}
.log{flex:1;min-height:300px;max-height:44vh;overflow:auto;padding:13px 15px;white-space:pre-wrap;word-break:break-word;font:12.5px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#c4d0e4}
.log .l-warn{color:var(--warn)} .log .l-verdict{color:var(--accent);font-weight:700}
.log .l-you{color:#a9c1ff} .log .l-agent{color:var(--accent)}
.log .l-head{color:#7c5cff;font-weight:700} .log .l-key{color:var(--ink)}

.chat{margin:0 18px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.chat-h{display:flex;align-items:center;justify-content:space-between;padding:10px 13px;border-bottom:1px solid var(--line)}
.chat-h h3{margin:0;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2)}
.chat-h .k{font-size:11.5px;color:var(--mut)}
.chat-log{max-height:180px;overflow:auto;padding:11px 13px;display:grid;gap:7px}
.chat-empty{color:var(--mut);font-size:12.5px;text-align:center;padding:10px}
.bubble{max-width:88%;padding:8px 11px;border-radius:12px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.bubble.agent{background:var(--raise);border:1px solid var(--line2);justify-self:start;border-bottom-left-radius:4px}
.bubble.you{background:linear-gradient(135deg,rgba(79,124,255,.26),rgba(124,92,255,.24));border:1px solid #3c4d84;justify-self:end;border-bottom-right-radius:4px}
.chat-in{display:flex;gap:8px;padding:11px 13px;border-top:1px solid var(--line)}
.chat-in input{flex:1;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-sm);padding:9px 11px}
.chat-in input:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(79,124,255,.18)}

.results{border-top:1px solid var(--line);padding:14px 18px}
.results-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;gap:12px}
.results-h h3{margin:0;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);display:flex;align-items:center}
#outputs{max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:12px}
.hrow{display:flex;align-items:center;gap:10px;padding:10px 13px;border-bottom:1px solid var(--line);cursor:pointer;transition:background .12s}
.hrow:last-child{border-bottom:0}
.hrow:hover{background:var(--surface2)}
.hdot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--mut)}
.hdot.ok{background:var(--ok)} .hdot.warn{background:var(--warn)}
.hname{font-weight:600;font-size:13px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hmeta{font-size:11.5px;color:var(--mut);white-space:nowrap}
.hverdict{font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;flex:none}
.hverdict.ok{background:rgba(47,208,138,.14);color:var(--ok)} .hverdict.warn{background:rgba(243,182,75,.14);color:var(--warn)} .hverdict.gen{background:var(--raise);color:var(--ink2)}
.hcaret{color:var(--mut);font-size:11px;transition:transform .15s;flex:none}
.hrow.open .hcaret{transform:rotate(90deg)}
.hbody{display:none;padding:0 13px 13px 31px;border-bottom:1px solid var(--line);background:var(--surface2)}
.hbody.open{display:block}
.hbody .stats{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
.hbody .actions{display:flex;gap:8px;flex-wrap:wrap}
.action{display:inline-flex;align-items:center;gap:6px;border-radius:9px;padding:7px 12px;background:var(--raise);color:var(--ink);text-decoration:none;font-weight:600;font-size:12.5px;border:1px solid var(--line2)}
.action:hover{border-color:#3a496a}
.action.primary{background:linear-gradient(135deg,var(--brand),var(--brand2));border-color:transparent;color:#fff}

@media(max-width:1040px){.shell{grid-template-columns:1fr}.stage{min-height:auto}}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#26324a;border-radius:8px;border:2px solid transparent;background-clip:content-box}::-webkit-scrollbar-thumb:hover{background:#33425f;background-clip:content-box}
</style>
</head>
<body>
<div class="appbar">
  <div class="brand">
    <span class="logo"><svg viewBox="0 0 24 24" fill="none"><path d="M4 14l5-9 3 5 2-3 6 7" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <div><h1>PerfScript Studio</h1><div class="tag">Autonomous JMeter scripting &amp; correlation agent</div></div>
  </div>
  <div class="appbar-right">
    <span id="env-chip" class="env-chip"><span class="dot"></span><span id="env-text">idle</span></span>
    <button id="refresh" class="btn-ghost" type="button">Refresh</button>
  </div>
</div>

<div class="shell">
  <aside class="col">
    <section class="card">
      <div class="card-h"><h2>Input recordings</h2><span id="input-count" class="count">0</span></div>
      <div class="card-b">
        <div id="drop" class="drop">Drop <b>HAR</b>, <b>JMX</b>, <b>XML</b>, or <b>JTL</b> files &mdash; or click to browse</div>
        <input id="file" type="file" multiple style="display:none">
        <div class="field" style="margin-top:12px">
          <label>Recording 1 &mdash; primary</label>
          <select id="rec1"><option value="">Select a recording…</option></select>
          <div id="rec1-files" class="unit-files"></div>
        </div>
        <div class="field">
          <label>Recording 2 &mdash; pair for variance <span style="color:var(--mut);font-weight:500">(optional)</span></label>
          <select id="rec2"><option value="">None — run Recording 1 alone</option></select>
          <div id="rec2-files" class="unit-files"></div>
        </div>
        <div id="pair-status" class="hint" style="margin-top:2px"></div>
        <div id="input-issues"></div>
      </div>
    </section>

    <section class="card">
      <div class="card-h"><h2>Run control</h2></div>
      <div class="card-b">
        <div class="field">
          <label>Mode</label>
          <select id="mode">
            <option value="agent">Senior AI Agent — generate, validate, self-repair</option>
            <option value="senior-agent">Mature PE Agent — deeper reasoning</option>
            <option value="run">Generate + Validate</option>
            <option value="generate">Generate only</option>
            <option value="agent-watch">Watch input folder</option>
          </select>
        </div>
        <div class="grid3">
          <div class="field"><label>Fix iterations</label>
            <select id="iterations">
              <option value="1">1</option><option value="2">2</option>
              <option value="3" selected>3</option><option value="4">4</option>
              <option value="5">5</option><option value="6">6 (max)</option>
            </select></div>
          <div class="field"><label>Retry failed</label><input id="retry" type="number" min="1" placeholder="3"></div>
          <div class="field"><label>Gemini Pro</label><select id="gemini-pro"><option value="">No</option><option value="1">Yes</option></select></div>
        </div>
        <div class="run-btns">
          <button id="run-selected" class="btn-primary" type="button">Run selected</button>
          <button id="rerun-last" class="btn-soft" type="button">Rerun last</button>
          <button id="force-run" class="btn-ghost" type="button">Force rerun</button>
          <button id="stop" class="btn-danger" type="button" disabled>Stop</button>
        </div>
        <div id="run-hint" class="hint">Pick Recording 1 to run it alone, or add Recording 2 to pair them as one variance run.</div>
      </div>
    </section>

    <section class="card">
      <div class="card-h"><h2>Environment &amp; objective</h2></div>
      <div class="card-b">
        <div class="field"><label>Target URL</label><input id="cfg-target" placeholder="https://stage.example.com"></div>
        <div class="grid2">
          <div class="field"><label>Username</label><input id="cfg-user" placeholder="test user"></div>
          <div class="field"><label>Password</label><input id="cfg-pass" type="password" placeholder="unchanged"></div>
        </div>
        <div class="grid3">
          <div class="field"><label>Users</label><input id="cfg-users" type="number" min="1"></div>
          <div class="field"><label>Ramp-up s</label><input id="cfg-ramp" type="number" min="0"></div>
          <div class="field"><label>Hold s</label><input id="cfg-hold" type="number" min="0"></div>
        </div>
        <div class="field"><label>Business objective</label><input id="cfg-objective" placeholder="capacity, soak, release certification"></div>
        <div class="field"><label>Tech stack</label><input id="cfg-stack" placeholder="React, Spring Boot, OAuth"></div>
        <div class="field"><label>Domain notes</label><textarea id="cfg-domain" placeholder="business rules, test data, cleanup needs"></textarea></div>
        <div class="grid2">
          <div class="field"><label>p95 SLO ms</label><input id="cfg-p95" type="number" min="0"></div>
          <div class="field"><label>Error %</label><input id="cfg-error" type="number" min="0"></div>
        </div>
        <div class="run-btns"><button id="cfg-save" class="btn-soft" type="button">Save settings</button><span id="cfg-status" class="hint" style="margin-top:0"></span></div>
      </div>
    </section>
  </aside>

  <main class="card stage">
    <div class="stage-h">
      <div style="min-width:0">
        <h2 id="phase" class="phase">Idle</h2>
        <div class="statusline">
          <span id="busy-pill" class="badge ready"><span class="dot live"></span>Ready</span>
          <span id="selected-pill" class="badge">0 selected</span>
          <span id="elapsed" class="elapsed"></span>
        </div>
        <div id="progress" class="progress"><i></i></div>
      </div>
      <div class="stage-tools">
        <button id="copy-log" class="btn-ghost" type="button">Copy log</button>
        <button id="clear-log" class="btn-ghost" type="button">Clear</button>
      </div>
    </div>

    <div class="console">
      <div class="console-h"><span class="tl r"></span><span class="tl y"></span><span class="tl g"></span><span class="lbl">agent&nbsp;·&nbsp;live log</span></div>
      <pre id="log" class="log">Idle. Add or select recordings, then run the agent.
The agent will print its understanding of the flow and domain before it begins.</pre>
    </div>

    <div class="chat">
      <div class="chat-h"><h3>Steer the agent</h3><span class="k">protect &lt;name&gt; · disable &lt;name&gt; · guidance · question ending in ?</span></div>
      <div id="chat" class="chat-log"><div class="chat-empty">Chat activates during a run. Your messages change the agent's next decision.</div></div>
      <div class="chat-in">
        <input id="chat-input" placeholder="Chat is live only while a run is active" disabled>
        <button id="chat-send" class="btn-primary" type="button" disabled>Send</button>
      </div>
    </div>

    <div class="results">
      <div class="results-h">
        <h3>History <span id="hist-count" class="count" style="margin-left:6px">0</span></h3>
        <input id="hist-search" placeholder="Filter runs…" style="width:180px;background:var(--bg);border:1px solid var(--line2);border-radius:var(--radius-sm);padding:6px 10px;font-size:12.5px">
      </div>
      <div id="outputs"><div class="empty">No runs yet. Completed runs are listed here.</div></div>
    </div>
  </main>
</div>

<script>
var currentRunId=null,poll=null,lastState=null,startedAt=0,logText='',unitsById={};
function q(s){return document.querySelector(s)}
function qa(s){return Array.prototype.slice.call(document.querySelectorAll(s))}
function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
async function j(url,opt){var r=await fetch(url,opt||{});var d=await r.json();if(!r.ok)throw new Error(d.error||r.statusText);return d}
function selectedInputs(){return [q('#rec1').value,q('#rec2').value].filter(Boolean)}
function unitFilesHtml(u){if(!u)return '';return (u.files||[]).map(function(f){return '<b>'+esc(f.role)+'</b>: '+esc(f.name)}).join('<br>');}
function updateSelected(){
  var ins=selectedInputs();
  q('#selected-pill').textContent=ins.length+' selected';
  var u1=unitsById[q('#rec1').value],u2=unitsById[q('#rec2').value];
  q('#rec1-files').innerHTML=unitFilesHtml(u1);
  q('#rec2-files').innerHTML=unitFilesHtml(u2);
  var st=q('#pair-status');
  if(u1&&u2){
    var sameType=(/jmx/i.test(u1.kind)&&/jmx/i.test(u2.kind))||(/har/i.test(u1.kind)&&/har/i.test(u2.kind));
    st.innerHTML=sameType
      ?'<span style="color:var(--accent)">◆ Will pair as one dual-recording variance run</span> — dynamic values found across both.'
      :'<span style="color:var(--warn)">Pairing needs two recordings of the same type (two JMX or two HAR).</span>';
  } else if(u1){ st.textContent='Runs Recording 1 alone. Add Recording 2 to pair.'; }
  else { st.textContent=''; }
}
function phaseOf(txt){
 if(/Finished|DONE|verdict=|report\\.html|Done\\./i.test(txt))return{pct:100,label:'Finished'};
 if(/adjudicat|fold probe|re-verifying|LLM|round|replan/i.test(txt))return{pct:86,label:'Repairing & verifying'};
 if(/running bounded feedback loop|jmeter=|target=/i.test(txt))return{pct:66,label:'Running JMeter validation'};
 if(/generated .*\\.jmx|samplers,/i.test(txt))return{pct:50,label:'Generated JMX & correlations'};
 if(/Flow understanding|Business flow:/i.test(txt))return{pct:30,label:'Understanding the flow'};
 if(/wrote recording|scrubbed|parsed \\d+ entries/i.test(txt))return{pct:20,label:'Reading recordings'};
 return{pct:10,label:'Starting'};
}
async function refresh(){
 var s=await j('/api/state');lastState=s;
 renderUnits(s.inputUnits||[]);renderIssues(s.inputIssues||[]);renderOutputs(s.outputs||[]);
 q('#input-count').textContent=(s.inputUnits||[]).length;
 var busy=!!s.busy;
 q('#busy-pill').className='badge '+(busy?'run':'ready');q('#busy-pill').innerHTML='<span class="dot '+(busy?'':'live')+'"></span>'+(busy?'Running':'Ready');
 q('#env-chip').querySelector('.dot').className='dot '+(busy?'live':'');q('#env-text').textContent=busy?'run in progress':'idle';
 q('#stop').disabled=!busy;q('#run-selected').disabled=busy;q('#force-run').disabled=busy;q('#rerun-last').disabled=busy||!s.lastRun;
 if(s.activeRun&&!currentRunId)startPolling(s.activeRun.id,false);
 updateSelected();return s;
}
function unitLabel(u){
 var host=(u.hosts||[])[0]?' · '+u.hosts[0]:'';
 return u.name+'  ['+u.kind+', '+(u.requestCount||0)+' req'+(u.golden?', golden':'')+host+']';
}
function fillSelect(sel,units,keep,firstLabel){
 var prev=sel.value;
 sel.innerHTML='<option value="">'+firstLabel+'</option>'+units.map(function(u){
   return '<option value="'+esc(u.id)+'">'+esc(unitLabel(u))+'</option>';
 }).join('');
 if(keep&&units.some(function(u){return u.id===prev}))sel.value=prev;
}
function renderUnits(units){
 unitsById={};units.forEach(function(u){unitsById[u.id]=u});
 fillSelect(q('#rec1'),units,true,units.length?'Select a recording…':'No recordings — drop files above');
 fillSelect(q('#rec2'),units,true,'None — run Recording 1 alone');
 updateSelected();
}
function renderIssues(issues){
 q('#input-issues').innerHTML=(issues||[]).filter(function(i){return i.severity==='error'||i.severity==='warning'}).slice(0,8)
  .map(function(i){return '<div class="warnrow">'+esc(i.severity.toUpperCase()+': '+i.message)+'</div>'}).join('');
}
var allOutputs=[];
function renderOutputs(outputs){
 allOutputs=outputs||[];
 q('#hist-count').textContent=allOutputs.length;
 paintHistory();
}
function paintHistory(){
 var term=(q('#hist-search').value||'').toLowerCase();
 var list=allOutputs.filter(function(o){return !term||String(o.name||'').toLowerCase().indexOf(term)>=0});
 if(!list.length){q('#outputs').innerHTML='<div class="empty">'+(allOutputs.length?'No runs match the filter.':'No runs yet. Completed runs are listed here.')+'</div>';return}
 q('#outputs').innerHTML=list.map(function(o,i){
  var vc=o.verdict==='GREEN'?'ok':(o.verdict==='needs attention'?'warn':'gen');
  var vlabel=o.verdict==='GREEN'?'GREEN':(o.verdict==='needs attention'?'ATTENTION':'generated');
  var meta=o.kind==='validated'?((o.passed||0)+'/'+((o.passed||0)+(o.failed||0))+' passed'):((o.samplers||0)+' samplers');
  var stats=o.kind==='validated'
   ?'<span class="chip" style="color:var(--ok)">'+(o.passed||0)+' passed</span><span class="chip" style="color:'+((o.failed||0)?'var(--bad)':'var(--mut)')+'">'+(o.failed||0)+' failed</span><span class="chip">'+(o.total||0)+' app reqs</span>'
   :'<span class="chip">'+(o.samplers||0)+' samplers</span><span class="chip" style="color:var(--accent)">'+(o.correlations||0)+' correlations</span>';
  var act='';
  if(o.report)act+='<a class="action primary" target="_blank" href="/out/'+encodeURIComponent(o.name)+'/'+encodeURIComponent(o.report)+'">Open report</a>';
  if(o.jmx)act+='<a class="action" href="/out/'+encodeURIComponent(o.name)+'/'+encodeURIComponent(o.jmx)+'">Download JMX</a>';
  act+='<button class="action" type="button" data-name="'+esc(o.name)+'" onclick="event.stopPropagation();rerunName(this.dataset.name)">Rerun</button>';
  return '<div class="hrow" onclick="toggleHist('+i+')"><span class="hcaret">▶</span><span class="hdot '+vc+'"></span>'+
    '<span class="hname" title="'+esc(o.name)+'">'+esc(o.name)+'</span>'+
    '<span class="hmeta">'+esc(meta)+'</span>'+
    '<span class="hverdict '+vc+'">'+vlabel+'</span></div>'+
    '<div class="hbody" id="hbody-'+i+'"><div class="stats">'+stats+'</div><div class="actions">'+act+'</div></div>';
 }).join('');
}
function toggleHist(i){
 var row=qa('.hrow')[i],body=q('#hbody-'+i);
 if(!row||!body)return;
 var open=body.classList.toggle('open');row.classList.toggle('open',open);
}
function requestBody(force){
 var ins=selectedInputs();
 return JSON.stringify({mode:q('#mode').value,selectedInputs:ins,force:!!force,iterations:q('#iterations').value,retryFailed:q('#retry').value,geminiPro:q('#gemini-pro').value==='1',pair:ins.length===2});
}
async function saveCfg(quiet){
 await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetBaseUrl:q('#cfg-target').value,username:q('#cfg-user').value,password:q('#cfg-pass').value,loadProfile:{users:q('#cfg-users').value,rampUpSec:q('#cfg-ramp').value,holdSec:q('#cfg-hold').value},seniorMode:q('#mode').value==='senior-agent'?'mature':'strong',testObjective:q('#cfg-objective').value,techStack:q('#cfg-stack').value,domainNotes:q('#cfg-domain').value,slo:{p95Ms:q('#cfg-p95').value,errorRatePct:q('#cfg-error').value}})});
 q('#cfg-pass').value='';if(!quiet){q('#cfg-status').textContent='Saved';setTimeout(function(){q('#cfg-status').textContent=''},1800)}loadCfg();
}
async function loadCfg(){var c=await j('/api/config');q('#cfg-target').value=c.targetBaseUrl||'';q('#cfg-user').value=c.username||'';q('#cfg-pass').placeholder=c.hasPassword?'saved — unchanged':'password';q('#cfg-users').value=c.loadProfile.users||'';q('#cfg-ramp').value=c.loadProfile.rampUpSec||'';q('#cfg-hold').value=c.loadProfile.holdSec||'';q('#cfg-objective').value=c.testObjective||'';q('#cfg-stack').value=c.techStack||'';q('#cfg-domain').value=c.domainNotes||'';q('#cfg-p95').value=(c.slo&&c.slo.p95Ms)||'';q('#cfg-error').value=(c.slo&&c.slo.errorRatePct)||''}
async function run(force){if(!selectedInputs().length){alert('Select Recording 1 first.');return}await saveCfg(true);var d=await j('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:requestBody(force)});logText='';q('#log').textContent='';startPolling(d.id,true);refresh()}
async function rerunLast(){var d=await j('/api/rerun',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});logText='';q('#log').textContent='';startPolling(d.id,true);refresh()}
async function rerunName(name){var d=await j('/api/rerun',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selectedInputs:[name]})});logText='';q('#log').textContent='';startPolling(d.id,true);refresh()}
function colorLog(text){
 return text.split('\\n').map(function(ln){
  var e=esc(ln);
  if(/^\\s*\\[chat\\]\\s+you:/.test(ln))return '<span class="l-you">'+e+'</span>';
  if(/^\\s*\\[chat\\]\\s+agent:/.test(ln))return '<span class="l-agent">'+e+'</span>';
  if(/^\\s*──|Flow understanding/.test(ln))return '<span class="l-head">'+e+'</span>';
  if(/^\\s*(Business flow|Primary business action|Auth \\/ session|Tech stack|Application host|Playbooks matched|Native managers|User-input data|Stated objective|Operator domain notes):/.test(ln))return '<span class="l-key">'+e+'</span>';
  if(/verdict=GREEN|final green gate: GREEN|USE THIS/.test(ln))return '<span class="l-verdict">'+e+'</span>';
  if(/WARN|needs attention|BLOCKED|NOT GREEN/.test(ln))return '<span class="l-warn">'+e+'</span>';
  return e;
 }).join('\\n');
}
function addChat(role,text){var box=q('#chat');var em=box.querySelector('.chat-empty');if(em)em.remove();var el=document.createElement('div');el.className='bubble '+role;el.textContent=text;box.appendChild(el);box.scrollTop=box.scrollHeight}
function absorbChat(lines){lines.forEach(function(line){var m=line.match(/^\\[chat\\]\\s+(you|agent):\\s*([\\s\\S]*)$/);if(m)addChat(m[1],m[2])})}
function setChatEnabled(on){q('#chat-send').disabled=!on;q('#chat-input').disabled=!on;q('#chat-input').placeholder=on?'protect POST /tasks · disable /bf? · guidance for the next fix round':'Chat is live only while a run is active'}
async function sendChat(){var t=q('#chat-input').value.trim();if(!t)return;q('#chat-input').value='';try{await j('/api/steer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})})}catch(e){addChat('agent','(not delivered: '+e.message+')')}}
function startPolling(id,reset){currentRunId=id;startedAt=Date.now();var since=0;if(reset){q('#progress').className='progress';q('#progress i').style.width='6%';q('#chat').innerHTML='<div class="chat-empty">Chat activates during a run. Your messages change the agent\\'s next decision.</div>'}setChatEnabled(true);clearInterval(poll);
 poll=setInterval(async function(){var d=await j('/api/log?id='+id+'&since='+since);
  if(d.lines&&d.lines.length){since=d.total;absorbChat(d.lines);logText+=d.lines.join('\\n')+'\\n';q('#log').innerHTML=colorLog(logText);q('#log').scrollTop=q('#log').scrollHeight;var ph=phaseOf(logText);q('#phase').textContent=ph.label;q('#progress i').style.width=ph.pct+'%'}
  if(startedAt)q('#elapsed').textContent=Math.floor((Date.now()-startedAt)/1000)+'s elapsed';
  if(d.done){clearInterval(poll);poll=null;currentRunId=null;setChatEnabled(false);q('#progress').className='progress'+(d.code===0?'':' err');q('#progress i').style.width='100%';q('#phase').textContent=d.code===0?'Finished':'Finished — exit '+d.code;refresh()}
 },700)}
async function upload(files){for(var i=0;i<files.length;i++){var f=files[i];await fetch('/api/upload?name='+encodeURIComponent(f.name),{method:'POST',body:await f.arrayBuffer()})}refresh()}
q('#run-selected').onclick=function(){run(false).catch(function(e){alert(e.message)})};
q('#force-run').onclick=function(){run(true).catch(function(e){alert(e.message)})};
q('#rerun-last').onclick=function(){rerunLast().catch(function(e){alert(e.message)})};
q('#stop').onclick=async function(){await fetch('/api/cancel',{method:'POST'});q('#phase').textContent='Stopping…'};
q('#refresh').onclick=refresh;q('#cfg-save').onclick=function(){saveCfg(false)};
q('#rec1').onchange=updateSelected;q('#rec2').onchange=updateSelected;
q('#hist-search').oninput=paintHistory;
q('#copy-log').onclick=function(){navigator.clipboard&&navigator.clipboard.writeText(logText)};
q('#clear-log').onclick=function(){logText='';q('#log').textContent=''};
q('#chat-send').onclick=function(){sendChat()};q('#chat-input').onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();sendChat()}};
var drop=q('#drop'),file=q('#file');drop.onclick=function(){file.click()};file.onchange=function(){upload(file.files)};
drop.ondragover=function(e){e.preventDefault();drop.classList.add('hot')};drop.ondragleave=function(){drop.classList.remove('hot')};drop.ondrop=function(e){e.preventDefault();drop.classList.remove('hot');upload(e.dataTransfer.files)};
refresh();loadCfg();setInterval(function(){if(!poll)refresh()},4000);
</script>
</body>
</html>`;

module.exports = { PAGE };
