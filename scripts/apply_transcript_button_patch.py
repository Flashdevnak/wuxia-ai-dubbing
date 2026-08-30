from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"Patch target not found: {label}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("OK", label)


# Worker dispatches transcript-only jobs to a lightweight dedicated workflow.
replace_once(
    "src/worker.js",
    '''async function triggerGitHub(env, job, workerBase) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return { triggered: false, reason: 'GitHub dispatch not configured' };
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({ event_type: 'dubbing_job', client_payload: { job, workerBase } }),
  });''',
    '''async function triggerGitHub(env, job, workerBase) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return { triggered: false, reason: 'GitHub dispatch not configured' };
  const eventType = job.jobType === 'transcript' ? 'transcript_job' : 'dubbing_job';
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({ event_type: eventType, client_payload: { job, workerBase } }),
  });''',
    "transcript dispatch",
)

replace_once(
    "src/worker.js",
    '''    if (body.sourceType === 'link' && !/^https?:\/\//i.test(body.sourceUrl || '')) return json({ error: 'invalid source url' }, 400);
    const job = {
      id: crypto.randomUUID(),
      title: body.title || 'งานพากย์ใหม่',
      sourceType: body.sourceType || 'upload',''',
    '''    if (body.sourceType === 'link' && !/^https?:\/\//i.test(body.sourceUrl || '')) return json({ error: 'invalid source url' }, 400);
    if (body.jobType === 'transcript' && body.sourceType !== 'link') return json({ error: 'คำบรรยาย YouTube ต้องใช้ลิงก์' }, 400);
    const job = {
      id: crypto.randomUUID(),
      jobType: body.jobType === 'transcript' ? 'transcript' : 'dubbing',
      title: body.title || (body.jobType === 'transcript' ? 'ดึงคำบรรยาย YouTube' : 'งานพากย์ใหม่'),
      sourceType: body.sourceType || 'upload',''',
    "job type",
)

replace_once(
    "src/worker.js",
    '''      status: 'queued',
      progress: 3,
      stage: 'เข้าคิวประมวลผล',
      createdAt: new Date().toISOString(),''',
    '''      status: 'queued',
      progress: 3,
      stage: body.jobType === 'transcript' ? 'เข้าคิวดึงคำบรรยาย' : 'เข้าคิวประมวลผล',
      createdAt: new Date().toISOString(),''',
    "transcript queued stage",
)

# Browser: one tap on the link button now creates a transcript-only job.
replace_once(
    "public/app.js",
    '''async function controlJob(id, action) {''',
    '''async function extractLinkTranscript() {
  const sourceUrl = $('#videoUrl')?.value.trim();
  if (!sourceUrl) throw new Error('กรุณาวางลิงก์ YouTube ก่อน');
  try {
    const u = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
  } catch {
    throw new Error('กรุณาตรวจสอบลิงก์อีกครั้ง');
  }

  const targetLang = $('#targetLang')?.value || 'th';
  const payload = {
    jobType: 'transcript',
    title: `คำบรรยาย YouTube ${new Date().toLocaleString('th-TH')}`,
    sourceType: 'link',
    sourceUrl,
    sourceLang: $('#sourceLang')?.value || 'auto',
    targetLang,
    subtitles: true,
    keepMusic: false,
    speakerSeparation: false,
    autoCleanup: false,
  };

  showLoader('กำลังดึงคำบรรยาย', 'กำลังอ่านซับและเวลาเริ่ม–จบจาก YouTube', 5);
  const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
  updateLoader(data.dispatch?.triggered ? 'ส่งงานดึงคำบรรยายแล้ว' : 'สร้างงานแล้ว แต่ระบบยังเริ่มไม่ได้', 15);
  $('#message').textContent = data.dispatch?.triggered
    ? `✓ กำลังดึงคำบรรยายเป็น ${langLabel(targetLang)} เมื่อเสร็จจะมีปุ่ม XML ซับ และคำบรรยาย`
    : 'สร้างงานแล้ว แต่ระบบดึงคำบรรยายยังไม่พร้อม';
  await loadJobs();
  setTimeout(hideLoader, 500);
}

async function controlJob(id, action) {''',
    "extract transcript action",
)

replace_once(
    "public/app.js",
    '''  const mode = j.processingMode === 'quality' ? 'คุณภาพสูง' : j.processingMode === 'balanced' ? 'สมดุล' : 'เร็ว';
  const control = j.status === 'failed' ''',
    '''  const mode = j.processingMode === 'quality' ? 'คุณภาพสูง' : j.processingMode === 'balanced' ? 'สมดุล' : 'เร็ว';
  const jobMeta = j.jobType === 'transcript'
    ? `คำบรรยาย YouTube ${langLabel(j.sourceLang)} → ${langLabel(j.targetLang)}`
    : `ต้นฉบับ ${langLabel(j.sourceLang)} พากย์เป็น ${langLabel(j.targetLang)} โหมด${mode}`;
  const control = j.status === 'failed' ''',
    "transcript job metadata",
)
replace_once(
    "public/app.js",
    '''<div class="job-title">${esc(j.title)}</div><div class="job-meta">ต้นฉบับ ${esc(langLabel(j.sourceLang))} พากย์เป็น ${esc(langLabel(j.targetLang))} โหมด${mode}</div><div class="job-stage">''',
    '''<div class="job-title">${esc(j.title)}</div><div class="job-meta">${esc(jobMeta)}</div><div class="job-stage">''',
    "render transcript metadata",
)
replace_once(
    "public/app.js",
    '''  $('#analyzeLinkBtn')?.addEventListener('click', () => {
    const v = $('#videoUrl')?.value.trim();
    try {
      const u = new URL(v);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
      $('#message').textContent = '✓ ลิงก์ใช้ได้ พร้อมเริ่มงาน';
    } catch {
      $('#message').textContent = 'กรุณาตรวจสอบลิงก์อีกครั้ง';
    }
  });''',
    '''  $('#analyzeLinkBtn')?.addEventListener('click', async () => {
    try { await extractLinkTranscript(); }
    catch (e) { hideLoader(); $('#message').textContent = e.message; }
  });''',
    "link button behavior",
)

# Page copy should say what the button really does.
replace_once(
    "public/index.html",
    '<button id="analyzeLinkBtn" class="btn ghost">ตรวจลิงก์</button>',
    '<button id="analyzeLinkBtn" class="btn ghost">ดึงซับ</button>',
    "link button label",
)
