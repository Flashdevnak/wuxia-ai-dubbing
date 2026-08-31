from pathlib import Path
import shutil


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'anchor missing: {label}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Keep generated Python bytecode out of the repository.
Path('.gitignore').write_text('__pycache__/\n*.py[cod]\n', encoding='utf-8')
for cache in Path('scripts').glob('__pycache__'):
    shutil.rmtree(cache, ignore_errors=True)

# Cloudflare-side signed caption reader. The HAR itself is never uploaded.
replace_once(
    'src/youtube.js',
    "export async function fetchYouTubeTranscript(sourceUrl, targetLang = 'th', sourceLang = 'auto') {",
    r'''export async function fetchSignedYouTubeTranscript(signedUrl, targetLang = 'th', expectedVideoId = '') {
  let u;
  try { u = new URL(String(signedUrl || '').trim()); } catch { throw new Error('ลิงก์ซับจาก HAR ไม่ถูกต้อง'); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !(host === 'youtube.com' || host.endsWith('.youtube.com')) || u.pathname !== '/api/timedtext') {
    throw new Error('ลิงก์ซับจาก HAR ไม่ใช่ YouTube timedtext');
  }
  const id = String(u.searchParams.get('v') || '');
  const language = String(u.searchParams.get('lang') || '');
  const format = String(u.searchParams.get('fmt') || 'srv1').toLowerCase();
  if (!id || !language) throw new Error('ลิงก์ซับจาก HAR ขาดรหัสวิดีโอหรือภาษา');
  if (expectedVideoId && String(expectedVideoId) !== id) throw new Error('HAR นี้ไม่ตรงกับวิดีโอที่วางไว้');

  let raw;
  try { raw = await getText(u.toString(), {}, 15000); }
  catch (err) { throw new Error(`เปิดซับจาก HAR ไม่สำเร็จ อาจหมดอายุแล้ว (${err?.message || err})`); }
  const entries = parseCaption(raw);
  if (!entries.length) throw new Error('ซับจาก HAR ไม่มีข้อความ หรือหมดอายุแล้ว');
  return {
    videoId: id,
    title: '',
    language,
    targetLanguage: targetLang,
    targetReady: baseLang(language) === baseLang(targetLang),
    origin: 'bunny-har-signed-timedtext',
    format,
    entries,
  };
}

export async function fetchYouTubeTranscript(sourceUrl, targetLang = 'th', sourceLang = 'auto') {''',
    'youtube signed export',
)

# Worker: cache the signed subtitle immediately while it is fresh.
replace_once(
    'src/worker.js',
    "import { fetchYouTubeTranscript } from './youtube.js';",
    "import { fetchYouTubeTranscript, fetchSignedYouTubeTranscript } from './youtube.js';",
    'worker youtube import',
)
replace_once(
    'src/worker.js',
    "  if (p === '/api/storage' && request.method === 'GET') return json(await storageInfo(env));",
    r'''  if (p === '/api/captions/import' && request.method === 'POST') {
    const body = await request.json();
    if (!validCaptionUrl(body.captionUrl)) return json({ error: 'ลิงก์ซับจาก HAR ไม่ถูกต้อง' }, 400);
    try {
      const transcript = await fetchSignedYouTubeTranscript(
        String(body.captionUrl || ''),
        String(body.targetLang || 'th'),
        String(body.expectedVideoId || ''),
      );
      const key = `temp/caption-imports/${crypto.randomUUID()}.json`;
      await uploadSmallText(env, key, JSON.stringify(transcript), 'application/json');
      return json({
        ok: true,
        captionKey: key,
        videoId: transcript.videoId,
        language: transcript.language,
        targetReady: transcript.targetReady,
        format: transcript.format,
        lines: transcript.entries.length,
      });
    } catch (err) {
      return json({ error: err?.message || String(err) }, 502);
    }
  }

  if (p === '/api/storage' && request.method === 'GET') return json(await storageInfo(env));''',
    'worker caption import route',
)
replace_once(
    'src/worker.js',
    "    if (body.captionUrl && !validCaptionUrl(body.captionUrl)) return json({ error: 'ลิงก์ซับจาก HAR ไม่ถูกต้อง' }, 400);\n    if (body.jobType === 'transcript' && body.sourceType !== 'link') return json({ error: 'คำบรรยาย YouTube ต้องใช้ลิงก์' }, 400);",
    "    if (body.captionUrl && !validCaptionUrl(body.captionUrl)) return json({ error: 'ลิงก์ซับจาก HAR ไม่ถูกต้อง' }, 400);\n    if (body.captionKey) {\n      if (!String(body.captionKey).startsWith('temp/caption-imports/')) return json({ error: 'ไฟล์ซับสำรองไม่ถูกต้อง' }, 400);\n      const cachedCaption = await resolveLogical(env, String(body.captionKey));\n      if (!cachedCaption?.id) return json({ error: 'ไม่พบซับที่บันทึกไว้ กรุณาเลือก HAR ใหม่' }, 404);\n    }\n    if (body.jobType === 'transcript' && body.sourceType !== 'link') return json({ error: 'คำบรรยาย YouTube ต้องใช้ลิงก์' }, 400);",
    'worker caption key validation',
)
replace_once(
    'src/worker.js',
    "      captionUrl: body.captionUrl || null,\n      captionSource: body.captionSource || null,",
    "      captionUrl: body.captionUrl || null,\n      captionKey: body.captionKey || null,\n      captionSource: body.captionSource || null,",
    'worker caption key field',
)

# Browser: after parsing the HAR locally, immediately cache only the selected
# subtitle transcript in Drive so long video uploads do not outlive the signed URL.
replace_once(
    'public/app.js',
    "const state = { sourceMode: 'link', sourceKey: null, captionUrl: null, captionMeta: null, harSubs: [], harFileName: '', jobs: [], files: [], storage: null, progressFloor: {} };",
    "const state = { sourceMode: 'link', sourceKey: null, captionUrl: null, captionKey: null, captionCacheUrl: null, captionMeta: null, harSubs: [], harFileName: '', jobs: [], files: [], storage: null, progressFloor: {} };",
    'app caption cache state',
)
replace_once(
    'public/app.js',
    "  state.captionUrl = chosen.url;\n  state.captionMeta = chosen;",
    "  if (state.captionCacheUrl !== chosen.url) { state.captionKey = null; state.captionCacheUrl = null; }\n  state.captionUrl = chosen.url;\n  state.captionMeta = chosen;",
    'app invalidate old cache',
)
replace_once(
    'public/app.js',
    "async function importHar(file) {",
    r'''async function cacheSelectedHarCaption() {
  if (!state.captionUrl || !state.captionMeta) return null;
  if (state.captionKey && state.captionCacheUrl === state.captionUrl) return state.captionKey;
  const status = $('#harStatus');
  const before = status?.textContent || '';
  if (status) { status.textContent = 'กำลังเก็บซับไว้ก่อนลิงก์หมดอายุ'; status.className = 'har-status'; }
  try {
    const data = await api('/api/captions/import', {
      method: 'POST',
      body: JSON.stringify({
        captionUrl: state.captionUrl,
        targetLang: $('#targetLang')?.value || 'th',
        expectedVideoId: state.captionMeta.videoId || youtubeVideoId($('#videoUrl')?.value || ''),
      }),
    });
    state.captionKey = data.captionKey || null;
    state.captionCacheUrl = state.captionKey ? state.captionUrl : null;
    if (status) {
      status.textContent = `เก็บซับไว้แล้ว ${Number(data.lines || 0).toLocaleString('th-TH')} บรรทัด ใช้ได้แม้ลิงก์ HAR หมดอายุ`;
      status.className = 'har-status ready';
    }
    return state.captionKey;
  } catch (err) {
    state.captionKey = null;
    state.captionCacheUrl = null;
    if (status) {
      status.textContent = `${before || 'พบซับแล้ว'} แต่ยังเก็บสำรองไม่ได้ ระบบจะลองอ่านตอนเริ่มงาน`;
      status.className = 'har-status error';
    }
    console.warn('caption cache failed', err);
    return null;
  }
}

async function importHar(file) {''',
    'app cache function',
)
replace_once(
    'public/app.js',
    "  const selected = refreshHarCaption();\n  if (!selected) throw new Error('ไม่พบซับที่ใช้ได้ใน HAR นี้');\n  if (state.sourceMode === 'link' && !state.sourceKey) setMode('upload');\n  if ($('#message')) $('#message').textContent = `✓ อ่าน HAR แล้ว พบซับ ${langLabel(selected.lang)} พร้อมใช้ เลือกวิดีโอต้นฉบับเพื่ออัปโหลดแล้วเริ่มพากย์ได้เลย`;",
    "  const selected = refreshHarCaption();\n  if (!selected) throw new Error('ไม่พบซับที่ใช้ได้ใน HAR นี้');\n  await cacheSelectedHarCaption();\n  if (state.sourceMode === 'link' && !state.sourceKey) setMode('upload');\n  if ($('#message')) $('#message').textContent = state.captionKey\n    ? `✓ อ่าน HAR แล้ว และเก็บซับ ${langLabel(selected.lang)} ไว้แล้ว เลือกวิดีโอต้นฉบับเพื่ออัปโหลดได้เลย`\n    : `✓ อ่าน HAR แล้ว พบซับ ${langLabel(selected.lang)} เลือกวิดีโอต้นฉบับเพื่ออัปโหลดได้เลย`;",
    'app import caches caption',
)
replace_once(
    'public/app.js',
    "async function createJob() {\n  const payload = {",
    "async function createJob() {\n  if (state.captionUrl) await cacheSelectedHarCaption();\n  const payload = {",
    'app create cache first',
)
replace_once(
    'public/app.js',
    "    captionUrl: state.captionUrl || null,\n    captionSource: state.captionUrl ? 'bunny-har' : null,",
    "    captionUrl: state.captionUrl || null,\n    captionKey: state.captionKey || null,\n    captionSource: state.captionUrl ? 'bunny-har' : null,",
    'app dubbing captionKey',
)
replace_once(
    'public/app.js',
    "async function extractLinkTranscript() {\n  const sourceUrl = $('#videoUrl')?.value.trim();",
    "async function extractLinkTranscript() {\n  if (state.captionUrl) await cacheSelectedHarCaption();\n  const sourceUrl = $('#videoUrl')?.value.trim();",
    'app transcript cache first',
)
# second payload occurrence
replace_once(
    'public/app.js',
    "    captionUrl: state.captionUrl || null,\n    captionSource: state.captionUrl ? 'bunny-har' : null,",
    "    captionUrl: state.captionUrl || null,\n    captionKey: state.captionKey || null,\n    captionSource: state.captionUrl ? 'bunny-har' : null,",
    'app transcript captionKey',
)
replace_once(
    'public/app.js',
    "  $('#targetLang')?.addEventListener('change', () => { try { refreshHarCaption({ quiet: true }); } catch {} });\n  $('#sourceLang')?.addEventListener('change', () => { try { refreshHarCaption({ quiet: true }); } catch {} });",
    "  $('#targetLang')?.addEventListener('change', async () => { try { refreshHarCaption({ quiet: true }); await cacheSelectedHarCaption(); } catch {} });\n  $('#sourceLang')?.addEventListener('change', async () => { try { refreshHarCaption({ quiet: true }); await cacheSelectedHarCaption(); } catch {} });",
    'app language recache',
)

# Prepare uses durable cached transcript first; network signed URL is fallback.
replace_once(
    'scripts/prepare_job.py',
    '''        caption_url = str(job.get("captionUrl") or "").strip()\n        if caption_url:\n            youtube_transcript = extract_signed_youtube_transcript(\n                caption_url,\n                target_lang=str(job.get("targetLang") or "th"),\n                expected_video_url=str(job.get("sourceUrl") or "").strip() or None,\n            )''',
    '''        caption_url = str(job.get("captionUrl") or "").strip()\n        caption_key = str(job.get("captionKey") or "").strip()\n        if caption_key:\n            cached_caption = work / "cached_har_transcript.json"\n            client.download(caption_key, cached_caption)\n            youtube_transcript = json.loads(cached_caption.read_text(encoding="utf-8"))\n            print(f"Using cached HAR transcript: {len(youtube_transcript.get('entries') or [])} lines", flush=True)\n        elif caption_url:\n            youtube_transcript = extract_signed_youtube_transcript(\n                caption_url,\n                target_lang=str(job.get("targetLang") or "th"),\n                expected_video_url=str(job.get("sourceUrl") or "").strip() or None,\n            )''',
    'prepare upload cached caption',
)
replace_once(
    'scripts/prepare_job.py',
    '''                caption_url = str(job.get("captionUrl") or "").strip()\n                if caption_url:\n                    youtube_transcript = extract_signed_youtube_transcript(\n                        caption_url,\n                        target_lang=str(job.get("targetLang") or "th"),\n                        expected_video_url=source_url,\n                    )\n                else:\n                    youtube_transcript = extract_youtube_transcript(''',
    '''                caption_url = str(job.get("captionUrl") or "").strip()\n                caption_key = str(job.get("captionKey") or "").strip()\n                if caption_key:\n                    cached_caption = work / "cached_har_transcript.json"\n                    client.download(caption_key, cached_caption)\n                    youtube_transcript = json.loads(cached_caption.read_text(encoding="utf-8"))\n                    print(f"Using cached HAR transcript: {len(youtube_transcript.get('entries') or [])} lines", flush=True)\n                elif caption_url:\n                    youtube_transcript = extract_signed_youtube_transcript(\n                        caption_url,\n                        target_lang=str(job.get("targetLang") or "th"),\n                        expected_video_url=source_url,\n                    )\n                else:\n                    youtube_transcript = extract_youtube_transcript(''',
    'prepare link cached caption',
)

# Transcript-only jobs can also use the durable cached copy.
replace_once(
    'scripts/extract_transcript_job.py',
    '''        caption_url = str(job.get("captionUrl") or "").strip()\n        if caption_url:\n            data = extract_signed_youtube_transcript(''',
    '''        caption_url = str(job.get("captionUrl") or "").strip()\n        caption_key = str(job.get("captionKey") or "").strip()\n        if caption_key:\n            cached_caption = Path("cached_har_transcript.json")\n            client.download(caption_key, cached_caption)\n            data = json.loads(cached_caption.read_text(encoding="utf-8"))\n            print(f"Cached HAR caption source: {data.get('language')} {len(data.get('entries') or [])} lines")\n        elif caption_url:\n            data = extract_signed_youtube_transcript(''',
    'transcript cached caption',
)

# Cache bust the web UI.
p = Path('public/index.html')
text = p.read_text(encoding='utf-8')
text = text.replace('./app.js?v=20260831-har1', './app.js?v=20260831-har2')
p.write_text(text, encoding='utf-8')

# Self-clean temporary patch files. The workflow continues after checkout.
Path('scripts/apply_caption_cache_patch.py').unlink(missing_ok=True)
Path('.github/workflows/caption-cache-hotfix.yml').unlink(missing_ok=True)
print('durable HAR caption cache patched')
