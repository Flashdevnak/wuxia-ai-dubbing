from pathlib import Path
import re


def must_replace(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"anchor missing: {label}")
    return text.replace(old, new, 1)


# --- public/index.html -----------------------------------------------------
p = Path('public/index.html')
text = p.read_text(encoding='utf-8')
anchor = '''            </div>\n          </div>\n\n          <div class="option-grid">'''
har_ui = '''            </div>\n\n            <div class="har-import" id="harImport">\n              <div class="har-copy">\n                <b>มี HAR จาก Bunny</b>\n                <small>เลือกไฟล์ HAR แล้วระบบจะหาซับที่ตรงกับภาษาพากย์ให้อัตโนมัติ ไฟล์ HAR จะถูกอ่านในเครื่องนี้</small>\n              </div>\n              <div class="har-actions">\n                <input id="harInput" class="har-file-input" type="file" accept=".har,application/json" />\n                <label for="harInput" class="btn ghost har-btn">เลือก HAR</label>\n                <span id="harStatus" class="har-status">ยังไม่ได้เลือก HAR</span>\n              </div>\n            </div>\n          </div>\n\n          <div class="option-grid">'''
text = must_replace(text, anchor, har_ui, 'index HAR UI')
text = re.sub(r'\.\/app\.js\?v=[^"\']+', './app.js?v=20260831-har1', text, count=1)
p.write_text(text, encoding='utf-8')


# --- public/styles.css ----------------------------------------------------
p = Path('public/styles.css')
text = p.read_text(encoding='utf-8')
if '.har-import{' not in text.replace(' ', ''):
    text += r'''

/* HAR subtitle fallback */
.har-import{margin-top:14px;padding:14px 16px;border:1px solid rgba(255,180,84,.2);border-radius:14px;background:rgba(20,8,4,.45);display:flex;align-items:center;justify-content:space-between;gap:14px}
.har-copy{display:flex;flex-direction:column;gap:4px;min-width:0}.har-copy b{font-size:14px}.har-copy small{opacity:.72;line-height:1.45}
.har-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.har-file-input{display:none}.har-btn{cursor:pointer;white-space:nowrap}.har-status{font-size:12px;opacity:.78;max-width:360px}.har-status.ready{opacity:1}.har-status.error{opacity:1}
@media(max-width:760px){.har-import{align-items:stretch;flex-direction:column}.har-actions{justify-content:flex-start}.har-status{max-width:none;width:100%}}
'''
p.write_text(text, encoding='utf-8')


# --- public/app.js --------------------------------------------------------
p = Path('public/app.js')
text = p.read_text(encoding='utf-8')
text = must_replace(
    text,
    "const state = { sourceMode: 'link', sourceKey: null, jobs: [], files: [], storage: null, progressFloor: {} };",
    "const state = { sourceMode: 'link', sourceKey: null, captionUrl: null, captionMeta: null, harSubs: [], harFileName: '', jobs: [], files: [], storage: null, progressFloor: {} };",
    'app state',
)

anchor = '''function showFileMeta(file) {\n  const box = $('#fileMeta');\n  if (!box) return;\n  box.classList.remove('hidden');\n  box.innerHTML = `<div><span>ชื่อไฟล์</span><b>${esc(file.name)}</b></div><div><span>ชนิดไฟล์</span><b>${esc(extLabel(file.name))}</b></div><div><span>ขนาด</span><b>${fmtBytes(file.size)}</b></div>`;\n}\n'''
insert = anchor + r'''
function baseLang(value) {
  return String(value || '').toLowerCase().split('-')[0].split('_')[0];
}

function youtubeVideoId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be') return u.pathname.split('/').filter(Boolean)[0] || '';
    if (host.endsWith('youtube.com')) {
      const id = u.searchParams.get('v');
      if (id) return id;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length > 1 && ['shorts', 'embed', 'live'].includes(parts[0])) return parts[1];
    }
  } catch {}
  return '';
}

function decodeHarContent(content) {
  let raw = String(content?.text || '');
  if (String(content?.encoding || '').toLowerCase() !== 'base64') return raw;
  const binary = atob(raw.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function normalizedHarSubs(subs) {
  const out = [];
  for (const item of Array.isArray(subs) ? subs : []) {
    const raw = String(item?.url || '').trim();
    if (!raw) continue;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (!(host === 'youtube.com' || host.endsWith('.youtube.com')) || u.pathname !== '/api/timedtext') continue;
      const videoId = String(u.searchParams.get('v') || '');
      const lang = String(u.searchParams.get('lang') || '');
      const fmt = String(u.searchParams.get('fmt') || item?.ext || '').toLowerCase();
      if (!videoId || !lang) continue;
      out.push({ url: u.toString(), videoId, lang, fmt, name: String(item?.name || lang) });
    } catch {}
  }
  return out;
}

function refreshHarCaption({ quiet = false } = {}) {
  if (!state.harSubs.length) return null;
  const target = baseLang($('#targetLang')?.value || 'th');
  const source = baseLang($('#sourceLang')?.value || 'auto');
  const formatRank = fmt => ({ srv1: 0, vtt: 1, srv2: 2, json3: 3, ttml: 4 }[fmt] ?? 9);
  const ranked = [...state.harSubs].sort((a, b) => formatRank(a.fmt) - formatRank(b.fmt));
  let chosen = ranked.find(x => baseLang(x.lang) === target);
  if (!chosen && source && source !== 'auto') chosen = ranked.find(x => baseLang(x.lang) === source);
  chosen ||= ranked[0] || null;
  if (!chosen) {
    state.captionUrl = null;
    state.captionMeta = null;
    if ($('#harStatus')) { $('#harStatus').textContent = 'ไม่พบลิงก์ซับที่ใช้ได้ใน HAR'; $('#harStatus').className = 'har-status error'; }
    return null;
  }

  const linkId = youtubeVideoId($('#videoUrl')?.value || '');
  if (linkId && chosen.videoId !== linkId) {
    state.captionUrl = null;
    state.captionMeta = chosen;
    if ($('#harStatus')) { $('#harStatus').textContent = `HAR เป็นวิดีโอ ${chosen.videoId} แต่ลิงก์ที่วางเป็น ${linkId}`; $('#harStatus').className = 'har-status error'; }
    if (!quiet) throw new Error('HAR นี้ไม่ตรงกับลิงก์ YouTube ที่วางไว้');
    return null;
  }

  state.captionUrl = chosen.url;
  state.captionMeta = chosen;
  const exact = baseLang(chosen.lang) === target;
  if ($('#harStatus')) {
    $('#harStatus').textContent = exact
      ? `พร้อมใช้ ซับ ${langLabel(chosen.lang)} รูปแบบ ${chosen.fmt || 'timedtext'}`
      : `พบซับ ${langLabel(chosen.lang)} ระบบจะแปลเป็น ${langLabel(target)}`;
    $('#harStatus').className = 'har-status ready';
  }
  return chosen;
}

async function importHar(file) {
  if (!file) return;
  if (!/\.har$/i.test(file.name) && file.type && !String(file.type).includes('json')) throw new Error('กรุณาเลือกไฟล์ .har');
  const root = JSON.parse(await file.text());
  const entries = Array.isArray(root?.log?.entries) ? root.log.entries : [];
  const found = [];
  for (const entry of entries) {
    const content = entry?.response?.content;
    if (!content?.text) continue;
    let body;
    try { body = JSON.parse(decodeHarContent(content)); } catch { continue; }
    if (Array.isArray(body?.subs)) found.push(...normalizedHarSubs(body.subs));
  }
  const unique = [...new Map(found.map(x => [x.url, x])).values()];
  if (!unique.length) throw new Error('ไม่พบ signed subtitle ของ YouTube ใน HAR นี้');
  state.harSubs = unique;
  state.harFileName = file.name;
  const selected = refreshHarCaption();
  if (!selected) throw new Error('ไม่พบซับที่ใช้ได้ใน HAR นี้');
  if (state.sourceMode === 'link' && !state.sourceKey) setMode('upload');
  if ($('#message')) $('#message').textContent = `✓ อ่าน HAR แล้ว พบซับ ${langLabel(selected.lang)} พร้อมใช้ เลือกวิดีโอต้นฉบับเพื่ออัปโหลดแล้วเริ่มพากย์ได้เลย`;
}
'''
text = must_replace(text, anchor, insert, 'app HAR functions')

old = '''    autoCleanup: $('#autoCleanup')?.checked === true,\n  };'''
new = '''    autoCleanup: $('#autoCleanup')?.checked === true,\n    captionUrl: state.captionUrl || null,\n    captionSource: state.captionUrl ? 'bunny-har' : null,\n    captionLanguage: state.captionMeta?.lang || null,\n    captionFormat: state.captionMeta?.fmt || null,\n    captionVideoId: state.captionMeta?.videoId || null,\n  };'''
text = must_replace(text, old, new, 'app create payload')

old = '''  if (payload.sourceType === 'link' && !payload.sourceUrl) throw new Error('กรุณาวางลิงก์ก่อน');\n  if (payload.sourceType === 'upload' && !payload.sourceKey) throw new Error('กรุณาอัปโหลดไฟล์ให้เสร็จก่อน');\n'''
new = '''  if (payload.sourceType === 'link' && !payload.sourceUrl) throw new Error('กรุณาวางลิงก์ก่อน');\n  if (payload.sourceType === 'upload' && !payload.sourceKey) throw new Error('กรุณาอัปโหลดไฟล์ให้เสร็จก่อน');\n  if (payload.captionUrl) {\n    refreshHarCaption();\n    payload.captionUrl = state.captionUrl;\n    payload.captionLanguage = state.captionMeta?.lang || null;\n    payload.captionFormat = state.captionMeta?.fmt || null;\n    payload.captionVideoId = state.captionMeta?.videoId || null;\n  }\n'''
text = must_replace(text, old, new, 'app create validation')

old = '''    autoCleanup: false,\n  };'''
new = '''    autoCleanup: false,\n    captionUrl: state.captionUrl || null,\n    captionSource: state.captionUrl ? 'bunny-har' : null,\n    captionLanguage: state.captionMeta?.lang || null,\n    captionFormat: state.captionMeta?.fmt || null,\n    captionVideoId: state.captionMeta?.videoId || null,\n  };'''
text = must_replace(text, old, new, 'app transcript payload')

anchor = '''  $('#processingMode')?.addEventListener('change', updateSpeedNote);\n\n  $('#analyzeLinkBtn')?.addEventListener('click', async () => {'''
new = '''  $('#processingMode')?.addEventListener('change', updateSpeedNote);\n  $('#targetLang')?.addEventListener('change', () => { try { refreshHarCaption({ quiet: true }); } catch {} });\n  $('#sourceLang')?.addEventListener('change', () => { try { refreshHarCaption({ quiet: true }); } catch {} });\n  $('#videoUrl')?.addEventListener('input', () => { if (state.harSubs.length) refreshHarCaption({ quiet: true }); });\n  $('#harInput')?.addEventListener('change', async e => {\n    const f = e.target.files?.[0];\n    if (!f) return;\n    if ($('#harStatus')) { $('#harStatus').textContent = 'กำลังอ่าน HAR'; $('#harStatus').className = 'har-status'; }\n    try { await importHar(f); }\n    catch (err) {\n      state.captionUrl = null; state.captionMeta = null; state.harSubs = [];\n      if ($('#harStatus')) { $('#harStatus').textContent = err.message; $('#harStatus').className = 'har-status error'; }\n      if ($('#message')) $('#message').textContent = err.message;\n    }\n  });\n\n  $('#analyzeLinkBtn')?.addEventListener('click', async () => {'''
text = must_replace(text, anchor, new, 'app bind HAR')
p.write_text(text, encoding='utf-8')


# --- src/worker.js --------------------------------------------------------
p = Path('src/worker.js')
text = p.read_text(encoding='utf-8')
anchor = '''function originAllowed(request, env) {'''
insert = '''function validCaptionUrl(value) {\n  if (!value) return true;\n  try {\n    const u = new URL(String(value));\n    const host = u.hostname.toLowerCase();\n    return u.protocol === 'https:'\n      && (host === 'youtube.com' || host.endsWith('.youtube.com'))\n      && u.pathname === '/api/timedtext'\n      && Boolean(u.searchParams.get('v'))\n      && Boolean(u.searchParams.get('lang'));\n  } catch {\n    return false;\n  }\n}\n\n'''
if 'function validCaptionUrl(' not in text:
    text = must_replace(text, anchor, insert + anchor, 'worker caption URL validator')

anchor = '''    if (body.sourceType === 'link' && !/^https?:\\/\\//i.test(body.sourceUrl || '')) return json({ error: 'invalid source url' }, 400);\n    if (body.jobType === 'transcript' && body.sourceType !== 'link') return json({ error: 'คำบรรยาย YouTube ต้องใช้ลิงก์' }, 400);'''
new = '''    if (body.sourceType === 'link' && !/^https?:\\/\\//i.test(body.sourceUrl || '')) return json({ error: 'invalid source url' }, 400);\n    if (body.captionUrl && !validCaptionUrl(body.captionUrl)) return json({ error: 'ลิงก์ซับจาก HAR ไม่ถูกต้อง' }, 400);\n    if (body.jobType === 'transcript' && body.sourceType !== 'link') return json({ error: 'คำบรรยาย YouTube ต้องใช้ลิงก์' }, 400);'''
text = must_replace(text, anchor, new, 'worker job caption validation')

anchor = '''      autoCleanup: body.autoCleanup !== false,\n      pauseRequested: false,'''
new = '''      autoCleanup: body.autoCleanup !== false,\n      captionUrl: body.captionUrl || null,\n      captionSource: body.captionSource || null,\n      captionLanguage: body.captionLanguage || null,\n      captionFormat: body.captionFormat || null,\n      captionVideoId: body.captionVideoId || null,\n      pauseRequested: false,'''
text = must_replace(text, anchor, new, 'worker job caption fields')
p.write_text(text, encoding='utf-8')


# --- scripts/youtube_transcript.py ---------------------------------------
p = Path('scripts/youtube_transcript.py')
text = p.read_text(encoding='utf-8')
anchor = '''def extract_youtube_transcript(\n    url: str,'''
helper = r'''def extract_signed_youtube_transcript(
    signed_url: str,
    target_lang: str = "th",
    expected_video_url: str | None = None,
) -> dict[str, Any]:
    raw_url = str(signed_url or "").strip()
    parsed = urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (host == "youtube.com" or host.endswith(".youtube.com")) or parsed.path != "/api/timedtext":
        raise RuntimeError("ลิงก์ซับจาก HAR ไม่ใช่ YouTube timedtext")
    qs = parse_qs(parsed.query)
    vid = str((qs.get("v") or [""])[0])
    language = str((qs.get("lang") or [""])[0])
    fmt = str((qs.get("fmt") or ["srv1"])[0]).lower()
    if not vid or not language:
        raise RuntimeError("ลิงก์ซับจาก HAR ขาดรหัสวิดีโอหรือภาษา")
    if expected_video_url:
        try:
            expected = _video_id(expected_video_url)
        except Exception:
            expected = ""
        if expected and expected != vid:
            raise RuntimeError("HAR นี้ไม่ตรงกับลิงก์ YouTube ของงาน")

    raw = _http_get(raw_url)
    if fmt == "srv1":
        entries = _parse_srv1(raw)
    elif fmt == "json3":
        entries = _parse_json3(raw)
    elif fmt == "vtt":
        entries = _parse_vtt(raw)
    else:
        entries = _parse_srv1(raw) or _parse_vtt(raw)
        if not entries:
            try:
                root = ET.fromstring(raw.decode("utf-8", errors="replace"))
                for node in root.findall(".//p"):
                    text_value = _clean_text("".join(node.itertext()))
                    if not text_value:
                        continue
                    start_ms = float(node.attrib.get("t") or 0)
                    dur_ms = float(node.attrib.get("d") or 0)
                    entries.append({"start": max(0.0, start_ms / 1000.0), "duration": max(0.05, dur_ms / 1000.0), "text": text_value})
            except Exception:
                pass
    if not entries:
        raise RuntimeError("signed subtitle จาก HAR ไม่มีข้อความ หรือหมดอายุแล้ว")
    return {
        "videoId": vid,
        "title": "",
        "language": language,
        "targetLanguage": target_lang,
        "targetReady": _base_lang(language) == _base_lang(target_lang),
        "origin": "bunny-har-signed-timedtext",
        "format": fmt,
        "entries": entries,
    }


'''
if 'def extract_signed_youtube_transcript(' not in text:
    text = must_replace(text, anchor, helper + anchor, 'python signed caption helper')
p.write_text(text, encoding='utf-8')


# --- scripts/prepare_job.py ----------------------------------------------
p = Path('scripts/prepare_job.py')
text = p.read_text(encoding='utf-8')
text = must_replace(
    text,
    'from youtube_transcript import extract_youtube_transcript, slice_entries, transcript_xml',
    'from youtube_transcript import extract_youtube_transcript, extract_signed_youtube_transcript, slice_entries, transcript_xml',
    'prepare import signed helper',
)

anchor = '''    if job.get("sourceType") == "upload":\n        key = job.get("sourceKey")\n        if not key:\n            raise RuntimeError("Uploaded job has no sourceKey")\n        input_url = f"{args.worker_url.rstrip('/')}\/api\/internal\/file?key={quote(key, safe='')}"\n        headers = f"x-worker-token: {args.token}\\r\\n"'''
# f-string slash escaping above does not match file literal; use direct actual text.
anchor = '''    if job.get("sourceType") == "upload":\n        key = job.get("sourceKey")\n        if not key:\n            raise RuntimeError("Uploaded job has no sourceKey")\n        input_url = f"{args.worker_url.rstrip('/')}/api/internal/file?key={quote(key, safe='')}"\n        headers = f"x-worker-token: {args.token}\\r\\n"'''
new = '''    if job.get("sourceType") == "upload":\n        key = job.get("sourceKey")\n        if not key:\n            raise RuntimeError("Uploaded job has no sourceKey")\n        caption_url = str(job.get("captionUrl") or "").strip()\n        if caption_url:\n            youtube_transcript = extract_signed_youtube_transcript(\n                caption_url,\n                target_lang=str(job.get("targetLang") or "th"),\n                expected_video_url=str(job.get("sourceUrl") or "").strip() or None,\n            )\n            full_json = work / "youtube_transcript.json"\n            full_json.write_text(json.dumps(youtube_transcript, ensure_ascii=False, indent=2), encoding="utf-8")\n            client.upload(full_json, f"temp/{job_id}/transcript/full.json", "application/json")\n            xml_path = work / "youtube_transcript.xml"\n            xml_path.write_text(transcript_xml(youtube_transcript["entries"]), encoding="utf-8")\n            xml_key = f"outputs/{job_id}/youtube_transcript.xml"\n            client.upload(xml_path, xml_key, "application/xml")\n            client.patch_job(\n                job_id,\n                stage=f"ใช้ซับจาก HAR ภาษา {youtube_transcript['language']} เวลาเดิมของวิดีโอ",\n                transcriptXmlKey=xml_key,\n                transcriptLanguage=str(youtube_transcript.get("language") or ""),\n                transcriptSource="bunny-har",\n            )\n            print(f"HAR signed transcript ready: {len(youtube_transcript['entries'])} lines", flush=True)\n        input_url = f"{args.worker_url.rstrip('/')}/api/internal/file?key={quote(key, safe='')}"\n        headers = f"x-worker-token: {args.token}\\r\\n"'''
text = must_replace(text, anchor, new, 'prepare upload HAR transcript')

old = '''                youtube_transcript = extract_youtube_transcript(\n                    source_url,\n                    target_lang=str(job.get("targetLang") or "th"),\n                    source_lang=str(job.get("sourceLang") or "auto"),\n                    cookies_file=cookies_file,\n                )'''
new = '''                caption_url = str(job.get("captionUrl") or "").strip()\n                if caption_url:\n                    youtube_transcript = extract_signed_youtube_transcript(\n                        caption_url,\n                        target_lang=str(job.get("targetLang") or "th"),\n                        expected_video_url=source_url,\n                    )\n                else:\n                    youtube_transcript = extract_youtube_transcript(\n                        source_url,\n                        target_lang=str(job.get("targetLang") or "th"),\n                        source_lang=str(job.get("sourceLang") or "auto"),\n                        cookies_file=cookies_file,\n                    )'''
text = must_replace(text, old, new, 'prepare link prefers HAR')
p.write_text(text, encoding='utf-8')


# --- scripts/extract_transcript_job.py -----------------------------------
p = Path('scripts/extract_transcript_job.py')
text = p.read_text(encoding='utf-8')
text = must_replace(
    text,
    'from youtube_transcript import extract_youtube_transcript, transcript_xml',
    'from youtube_transcript import extract_youtube_transcript, extract_signed_youtube_transcript, transcript_xml',
    'transcript import signed helper',
)
old = '''        try:\n            data = client.youtube_transcript(source_url, target_lang=target_lang, source_lang=source_lang)\n            print(f"Cloudflare caption source: {data.get('origin')} {data.get('language')} {len(data.get('entries') or [])} lines")\n        except Exception as worker_exc:\n            print(f"Cloudflare caption extraction unavailable; using runner fallback: {worker_exc}")\n            data = extract_youtube_transcript(\n                source_url,\n                target_lang=target_lang,\n                source_lang=source_lang,\n                cookies_file=build_cookie_file(),\n            )'''
new = '''        caption_url = str(job.get("captionUrl") or "").strip()\n        if caption_url:\n            data = extract_signed_youtube_transcript(\n                caption_url,\n                target_lang=target_lang,\n                expected_video_url=source_url or None,\n            )\n            print(f"HAR signed caption source: {data.get('language')} {len(data.get('entries') or [])} lines")\n        else:\n            try:\n                data = client.youtube_transcript(source_url, target_lang=target_lang, source_lang=source_lang)\n                print(f"Cloudflare caption source: {data.get('origin')} {data.get('language')} {len(data.get('entries') or [])} lines")\n            except Exception as worker_exc:\n                print(f"Cloudflare caption extraction unavailable; using runner fallback: {worker_exc}")\n                data = extract_youtube_transcript(\n                    source_url,\n                    target_lang=target_lang,\n                    source_lang=source_lang,\n                    cookies_file=build_cookie_file(),\n                )'''
text = must_replace(text, old, new, 'transcript HAR preference')
text = text.replace('transcriptSource="youtube",', 'transcriptSource=("bunny-har" if caption_url else "youtube"),', 1)
p.write_text(text, encoding='utf-8')


# Remove one-off YouTube probe/hotfix files after this patch has done its job.
for name in [
    '.github/workflows/cloudflare-caption-hotfix.yml',
    '.github/workflows/android-caption-hotfix.yml',
    '.github/workflows/android-direct-probe.yml',
    '.github/workflows/youtube-multiclient-probe.yml',
    '.github/workflows/signed-caption-probe.yml',
    '.github/workflows/youtube-pot-probe.yml',
    '.github/workflows/youtube-embedded-probe.yml',
    '.github/workflows/youtube-trusted-session-probe.yml',
    'scripts/apply_android_caption_patch.py',
    'scripts/probe_youtube_clients.py',
    '.github/workflows/har-caption-fallback.yml',
    'scripts/apply_har_caption_fallback.py',
]:
    Path(name).unlink(missing_ok=True)

print('HAR caption fallback patched')
