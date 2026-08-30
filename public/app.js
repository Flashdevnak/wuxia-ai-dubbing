const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const LANGS = [
  ["auto","ตรวจอัตโนมัติ"],["th","ไทย"],["zh","จีน (แมนดาริน)"],["en","อังกฤษ"],["ja","ญี่ปุ่น"],["ko","เกาหลี"],["vi","เวียดนาม"],["id","อินโดนีเซีย"],["ms","มาเลย์"],["es","สเปน"],["fr","ฝรั่งเศส"],["de","เยอรมัน"],["pt","โปรตุเกส"],["ru","รัสเซีย"],["ar","อาหรับ"],["hi","ฮินดี"],["it","อิตาลี"],["tr","ตุรกี"],["nl","ดัตช์"],["pl","โปแลนด์"]
];

const state = { sourceMode:'link', sourceKey:null, jobs:[], files:[], storage:null };
const IS_GITHUB_PAGES = location.hostname.endsWith('github.io');
const API_BASE = window.WUXIA_API_BASE || '';
let accessKey = '';

const fmtBytes = n => { n=Number(n)||0; const u=['B','KB','MB','GB','TB']; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return `${n.toFixed(i>2?2:i?1:0)} ${u[i]}`; };
const esc = s => String(s??'').replace(/[&<>\"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]||c));
const sleep = ms => new Promise(r=>setTimeout(r,ms));

function getAccessKey(){
  if(accessKey) return accessKey;
  const key = window.prompt('กรอกรหัสสำนักเพื่อเข้าใช้งานระบบ');
  if(!key) throw new Error('ต้องใส่รหัสสำนักก่อนใช้งาน');
  accessKey = key.trim();
  return accessKey;
}

function clearAccessKey(){ accessKey=''; }

function initSparks(){ const f=$('#sparkField'); for(let i=0;i<42;i++){const s=document.createElement('i');s.className='spark';s.style.left=Math.random()*100+'%';s.style.top=(20+Math.random()*85)+'%';s.style.setProperty('--dur',(5+Math.random()*7)+'s');s.style.setProperty('--drift',(-40+Math.random()*80)+'px');s.style.animationDelay=(-Math.random()*8)+'s';f.appendChild(s);} }
function fillLangs(){ const src=$('#sourceLang'),tgt=$('#targetLang'); for(const [v,n] of LANGS){src.add(new Option(n,v));if(v!=='auto')tgt.add(new Option(n,v));} src.value='auto';tgt.value='th'; $('#languageCloud').innerHTML=LANGS.filter(x=>x[0]!=='auto').map(x=>`<span class="lang-pill">${esc(x[1])}</span>`).join(''); }
function go(page){ $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===page)); $$('.page').forEach(p=>p.classList.toggle('active',p.dataset.pagePanel===page)); $('#sidebar').classList.remove('open'); window.scrollTo({top:0,behavior:'smooth'}); if(page==='files'||page==='results') loadFiles(); if(page==='jobs') loadJobs(); if(page==='storage') loadStorage(); }
function setMode(mode){state.sourceMode=mode; $('#linkInputWrap').classList.toggle('hidden',mode!=='link'); $('#fileInputWrap').classList.toggle('hidden',mode!=='upload'); $('#message').textContent=mode==='link'?'โหมดลิงก์พร้อมแล้ว':'โหมดอัปโหลดพร้อมแล้ว';}

async function api(path,opts={}){
  if(IS_GITHUB_PAGES&&!window.WUXIA_API_BASE) throw new Error('GitHub Pages เป็นหน้า Preview — ใช้ URL Cloudflare Worker สำหรับระบบจริง');
  const key=getAccessKey();
  const headers={...(opts.headers||{}),'x-access-key':key};
  if(opts.body && !(opts.body instanceof Blob) && !(opts.body instanceof ArrayBuffer) && !headers['content-type']) headers['content-type']='application/json';
  const r=await fetch(API_BASE+path,{...opts,headers});
  const data=await r.json().catch(()=>({}));
  if(r.status===401){ clearAccessKey(); throw new Error(data.error||'รหัสสำนักไม่ถูกต้อง'); }
  if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);
  return data;
}

function showLoader(title,text='กำลังเตรียมงาน',pct=5){$('#loadingTitle').textContent=title;$('#loadingText').textContent=text;$('#loadingPercent').textContent=pct+'%';$('#loadingBar').style.width=pct+'%';$('#loadingOverlay').classList.remove('hidden');}
function updateLoader(text,pct){$('#loadingText').textContent=text;$('#loadingPercent').textContent=Math.round(pct)+'%';$('#loadingBar').style.width=Math.max(0,Math.min(100,pct))+'%';}
function hideLoader(){setTimeout(()=>$('#loadingOverlay').classList.add('hidden'),250);}

async function uploadFile(file){
  const init=await api('/api/uploads/start',{method:'POST',body:JSON.stringify({name:file.name,size:file.size,type:file.type})});
  const {key,uploadId,partSize}=init; const total=Math.ceil(file.size/partSize); const parts=[]; $('#uploadProgress').classList.remove('hidden'); $('#uploadName').textContent=file.name;
  for(let i=0;i<total;i++){
    const start=i*partSize,end=Math.min(file.size,start+partSize),blob=file.slice(start,end); let attempt=0,done=false,lastErr;
    while(attempt<4&&!done){
      attempt++;
      try{
        const r=await fetch(`${API_BASE}/api/uploads/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${i+1}`,{method:'PUT',headers:{'x-access-key':getAccessKey()},body:blob});
        const d=await r.json().catch(()=>({}));
        if(r.status===401){clearAccessKey();throw new Error('รหัสสำนักไม่ถูกต้อง');}
        if(!r.ok)throw new Error(d.error||'upload failed');
        parts.push({partNumber:d.partNumber,etag:d.etag});done=true;
      }catch(e){lastErr=e;await sleep(700*attempt);}
    }
    if(!done){await api('/api/uploads/abort',{method:'POST',body:JSON.stringify({key,uploadId})}).catch(()=>{});throw lastErr;}
    const pct=((i+1)/total)*100;$('#uploadPct').textContent=Math.round(pct)+'%';$('#uploadBar').style.width=pct+'%';$('#uploadStatus').textContent=`อัปโหลดช่วง ${i+1}/${total} · ${fmtBytes(end)} / ${fmtBytes(file.size)}`;
  }
  parts.sort((a,b)=>a.partNumber-b.partNumber); await api('/api/uploads/complete',{method:'POST',body:JSON.stringify({key,uploadId,parts})}); state.sourceKey=key; $('#uploadStatus').textContent='อัปโหลดเสร็จแล้ว พร้อมสร้างงาน'; await loadStorage(); return key;
}

async function createJob(){
  const payload={title:'งานพากย์ '+new Date().toLocaleString('th-TH'),sourceType:state.sourceMode,sourceKey:state.sourceKey,sourceUrl:$('#videoUrl').value.trim()||null,sourceLang:$('#sourceLang').value,targetLang:$('#targetLang').value,voiceMode:$('#voiceMode').value,subtitles:$('#subtitles').checked,keepMusic:$('#keepMusic').checked,speakerSeparation:$('#speakerSep').checked,autoCleanup:$('#autoCleanup').checked};
  if(payload.sourceType==='link'&&!payload.sourceUrl) throw new Error('กรุณาวางลิงก์ก่อน');
  if(payload.sourceType==='upload'&&!payload.sourceKey) throw new Error('กรุณาอัปโหลดไฟล์ก่อน');
  showLoader('กำลังเปิดคัมภีร์งานพากย์','บันทึกงานลงคลัง',18); const data=await api('/api/jobs',{method:'POST',body:JSON.stringify(payload)}); updateLoader(data.dispatch?.triggered?'ส่งงานเข้า GitHub Actions แล้ว':'สร้างงานแล้ว · ยังไม่ได้ตั้งค่า GitHub dispatch',100); setTimeout(hideLoader,600); $('#message').textContent=data.dispatch?.triggered?'✓ เริ่มประมวลผลแล้ว':'✓ สร้างงานแล้ว แต่ backend ยัง dispatch ไม่ได้'; await loadJobs(); await loadStorage();
}

function jobHtml(j){const p=Math.max(0,Math.min(100,Number(j.progress)||0));const status=j.status==='completed'?'เสร็จสมบูรณ์':j.stage||j.status||'เข้าคิว';return `<article class="job-card"><div class="job-top"><div><div class="job-title">${esc(j.title)}</div><div class="job-meta">${esc(j.sourceLang)} → ${esc(j.targetLang)} · ${esc(status)}</div>${j.error?`<div class="job-meta" style="color:#ff9c9c">${esc(j.error)}</div>`:''}</div><div class="job-actions">${j.outputKey?`<button class="mini-btn" data-file="${esc(j.outputKey)}">ดาวน์โหลด MP4</button>`:''}${j.subtitleKey?`<button class="mini-btn" data-file="${esc(j.subtitleKey)}">SRT</button>`:''}<button class="mini-btn danger" data-delete-job="${esc(j.id)}">ลบ</button></div></div><div class="progress"><i style="width:${p}%"></i></div><div class="job-meta">${p}% · อัปเดต ${new Date(j.updatedAt||j.createdAt).toLocaleString('th-TH')}</div></article>`;}
async function loadJobs(){try{const d=await api('/api/jobs');state.jobs=d.jobs||[];const html=state.jobs.length?state.jobs.map(jobHtml).join(''):'ยังไม่มีงาน';$('#jobsList').classList.toggle('empty-state',!state.jobs.length);$('#jobsList').innerHTML=html;$('#homeJobs').classList.toggle('empty-state',!state.jobs.length);$('#homeJobs').innerHTML=state.jobs.length?state.jobs.slice(0,3).map(jobHtml).join(''):'ยังไม่มีงานพากย์';}catch(e){$('#homeJobs').textContent=e.message||'ยังเชื่อม API ไม่ได้';}}
async function loadFiles(){try{const d=await api('/api/files');state.files=d.files||[];const mk=(list)=>list.length?list.map(f=>`<div class="file-row"><div><b>${esc(f.key.split('/').pop())}</b><div class="file-meta">${fmtBytes(f.size)} · ${new Date(f.uploaded).toLocaleString('th-TH')}</div></div><div class="file-actions">${f.key.startsWith('outputs/')?`<button class="mini-btn" data-file="${esc(f.key)}">ดาวน์โหลด</button>`:''}<button class="mini-btn danger" data-delete-file="${esc(f.key)}">ลบ</button></div></div>`).join(''):'ยังไม่มีไฟล์';const src=state.files.filter(f=>f.key.startsWith('uploads/'));const out=state.files.filter(f=>f.key.startsWith('outputs/'));$('#filesList').classList.toggle('empty-state',!src.length);$('#filesList').innerHTML=mk(src);$('#resultsList').classList.toggle('empty-state',!out.length);$('#resultsList').innerHTML=mk(out);}catch(e){console.warn(e);}}
async function loadStorage(){try{const d=await api('/api/storage');state.storage=d;const gb=d.bytes/1024**3,limit=d.limitBytes/1024**3,pct=Math.min(100,d.bytes/d.limitBytes*100||0);$('#topStorage').textContent=`${gb.toFixed(2)} GB / ${limit.toFixed(0)} GB`;$('#topStorageBar').style.width=pct+'%';$('#ringGb').textContent=gb.toFixed(2);$('#ringText').textContent=`${gb.toFixed(2)} GB`;$('.storage-ring').style.setProperty('--p',pct+'%');const g=d.groups||{};$('#storageBreakdown').innerHTML=`<div><span><i style="background:#39d9c1"></i>ต้นฉบับ</span><b>${fmtBytes(g.uploads)}</b></div><div><span><i style="background:#e7b85c"></i>ชั่วคราว</span><b>${fmtBytes(g.temp)}</b></div><div><span><i style="background:#6ad6a2"></i>ผลลัพธ์</span><b>${fmtBytes(g.outputs)}</b></div>`;$('#stTotal').textContent=fmtBytes(d.bytes);$('#stUpload').textContent=fmtBytes(g.uploads);$('#stTemp').textContent=fmtBytes(g.temp);$('#stOutput').textContent=fmtBytes(g.outputs);}catch(e){console.warn(e);}}

function downloadFile(key){
  const k=getAccessKey();
  const url=`${API_BASE}/api/files/download?key=${encodeURIComponent(key)}&access_key=${encodeURIComponent(k)}`;
  window.open(url,'_blank','noopener');
}

function bind(){
  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page))); $$('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go))); $('#seeJobs').addEventListener('click',()=>go('jobs')); $('#menuBtn').addEventListener('click',()=>$('#sidebar').classList.toggle('open')); $('#linkCard').addEventListener('click',()=>setMode('link')); $('#uploadCard').addEventListener('click',()=>setMode('upload'));
  $('#analyzeLinkBtn').addEventListener('click',()=>{const v=$('#videoUrl').value.trim();try{new URL(v);$('#message').textContent='✓ ลิงก์ถูกต้อง พร้อมสร้างงาน';}catch{$('#message').textContent='กรุณาตรวจสอบลิงก์อีกครั้ง';}});
  $('#fileInput').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;try{showLoader('กำลังรับไฟล์เข้าสำนัก',`${f.name} · ${fmtBytes(f.size)}`,4);hideLoader();await uploadFile(f);}catch(err){$('#uploadStatus').textContent='อัปโหลดไม่สำเร็จ: '+err.message;}});
  $('#startBtn').addEventListener('click',async()=>{try{await createJob();}catch(e){hideLoader();$('#message').textContent=e.message;}});
  $('#refreshBtn').addEventListener('click',()=>Promise.all([loadJobs(),loadFiles(),loadStorage()])); $('#cleanupBtn').addEventListener('click',async()=>{showLoader('กำลังกวาดลานยุทธภพ','ลบไฟล์ชั่วคราว',35);try{await api('/api/cleanup/temp',{method:'POST',body:'{}'});updateLoader('ล้างไฟล์ชั่วคราวแล้ว',100);await loadStorage();}finally{setTimeout(hideLoader,500);}});
  document.body.addEventListener('click',async e=>{
    const dl=e.target.closest('[data-file]'); if(dl){downloadFile(dl.dataset.file);return;}
    const jb=e.target.closest('[data-delete-job]');if(jb&&confirm('ลบงานนี้และไฟล์ที่เกี่ยวข้องหรือไม่?')){await api('/api/jobs/'+jb.dataset.deleteJob,{method:'DELETE'});await Promise.all([loadJobs(),loadFiles(),loadStorage()]);}
    const fb=e.target.closest('[data-delete-file]');if(fb&&confirm('ลบไฟล์นี้เพื่อคืนพื้นที่หรือไม่?')){await api('/api/files?key='+encodeURIComponent(fb.dataset.deleteFile),{method:'DELETE'});await Promise.all([loadFiles(),loadStorage()]);}
  });
  $$('.voice-card').forEach(c=>c.addEventListener('click',()=>{$$('.voice-card').forEach(x=>x.classList.remove('active'));c.classList.add('active');}));
}

initSparks();fillLangs();bind();
if(IS_GITHUB_PAGES&&!window.WUXIA_API_BASE){
  const badge=$('#deployMode'); if(badge) badge.textContent='GitHub Preview';
  $('#message').textContent='หน้าเว็บ Preview ออนไลน์แล้ว · ระบบจริงจะใช้งานผ่าน URL Cloudflare Worker';
  $('#topStorage').textContent='Preview';
  $('#homeJobs').textContent='Preview UI พร้อม · เปิด URL Cloudflare Worker หลัง Deploy เพื่ออัปโหลดและพากย์จริง';
}else{
  const badge=$('#deployMode'); if(badge) badge.textContent='Cloudflare + R2';
  Promise.all([loadJobs(),loadFiles(),loadStorage()]); setInterval(loadJobs,15000);
}
