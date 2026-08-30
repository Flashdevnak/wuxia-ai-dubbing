from pathlib import Path
import re


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'Patch target not found: {label}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')
    print('OK', label)


# prepare_job.py
replace_once(
    'scripts/prepare_job.py',
    'from worker_client import WorkerClient\n',
    'from worker_client import WorkerClient\nfrom youtube_transcript import extract_youtube_transcript, slice_entries, transcript_xml\n',
    'prepare transcript import',
)
replace_once(
    'scripts/prepare_job.py',
    '    headers = None\n    if job.get("sourceType") == "upload":',
    '    headers = None\n    youtube_transcript = None\n    if job.get("sourceType") == "upload":',
    'prepare transcript state',
)
replace_once(
    'scripts/prepare_job.py',
    '            cookies_file = build_cookie_file()\n            input_url = yt_direct_url(source_url, cookies_file)',
    '''            cookies_file = build_cookie_file()
            try:
                youtube_transcript = extract_youtube_transcript(
                    source_url,
                    target_lang=str(job.get("targetLang") or "th"),
                    source_lang=str(job.get("sourceLang") or "auto"),
                    cookies_file=cookies_file,
                )
                full_json = work / "youtube_transcript.json"
                full_json.write_text(json.dumps(youtube_transcript, ensure_ascii=False, indent=2), encoding="utf-8")
                client.upload(full_json, f"temp/{job_id}/transcript/full.json", "application/json")

                xml_path = work / "youtube_transcript.xml"
                xml_path.write_text(transcript_xml(youtube_transcript["entries"]), encoding="utf-8")
                xml_key = f"outputs/{job_id}/youtube_transcript.xml"
                client.upload(xml_path, xml_key, "application/xml")
                client.patch_job(
                    job_id,
                    stage=(
                        f"พบซับ YouTube ภาษา {youtube_transcript['language']} ใช้เวลาเดิมของวิดีโอ"
                        if youtube_transcript.get("targetReady")
                        else f"พบซับ YouTube ภาษา {youtube_transcript['language']} จะใช้เวลาเดิมแล้วแปลไทย"
                    ),
                    transcriptXmlKey=xml_key,
                    transcriptLanguage=str(youtube_transcript.get("language") or ""),
                    transcriptSource="youtube",
                )
                print(
                    f"YouTube transcript ready: {len(youtube_transcript['entries'])} lines, "
                    f"lang={youtube_transcript['language']}, targetReady={youtube_transcript.get('targetReady')}",
                    flush=True,
                )
            except Exception as transcript_error:
                youtube_transcript = None
                print(f"YouTube transcript unavailable; Whisper fallback will be used: {transcript_error}", flush=True)

            input_url = yt_direct_url(source_url, cookies_file)''',
    'extract YouTube transcript',
)
replace_once(
    'scripts/prepare_job.py',
    '''            client.upload(current, key, "video/x-matroska")
            uploaded.append({"index": next_index, "key": key, "size": size})
            current.unlink(missing_ok=True)''',
    '''            client.upload(current, key, "video/x-matroska")
            chunk_duration = probe_duration(str(current))
            if chunk_duration <= 0:
                chunk_duration = float(max(300, args.chunk_seconds))
            chunk_start = sum(float(c.get("duration") or 0) for c in uploaded)
            item = {
                "index": next_index,
                "key": key,
                "size": size,
                "start": chunk_start,
                "duration": chunk_duration,
            }
            if youtube_transcript:
                local_entries = slice_entries(youtube_transcript.get("entries") or [], chunk_start, chunk_duration)
                chunk_transcript = {
                    "language": youtube_transcript.get("language"),
                    "targetLanguage": youtube_transcript.get("targetLanguage"),
                    "targetReady": bool(youtube_transcript.get("targetReady")),
                    "origin": youtube_transcript.get("origin"),
                    "chunkStart": chunk_start,
                    "chunkDuration": chunk_duration,
                    "entries": local_entries,
                }
                transcript_path = work / f"transcript_{next_index:05d}.json"
                transcript_path.write_text(json.dumps(chunk_transcript, ensure_ascii=False), encoding="utf-8")
                transcript_key = f"temp/{job_id}/transcript/chunk_{next_index:05d}.json"
                client.upload(transcript_path, transcript_key, "application/json")
                item["transcriptKey"] = transcript_key
                item["transcriptLines"] = len(local_entries)
            uploaded.append(item)
            current.unlink(missing_ok=True)''',
    'split transcript per chunk',
)


# worker_client durations
p = Path('scripts/worker_client.py')
text = p.read_text(encoding='utf-8')
pattern = re.compile(
    r'''    def translate\(self, texts: list\[str\], source_lang: str, target_lang: str\) -> list\[str\]:\n        data = self\._json\(\n            "POST",\n            "/api/internal/translate",\n            json=\{"texts": texts, "sourceLang": source_lang, "targetLang": target_lang\},\n        \)\n        return \[str\(x\) for x in data\.get\("translations", \[\]\)\]'''
)
repl = '''    def translate(
        self,
        texts: list[str],
        source_lang: str,
        target_lang: str,
        durations: list[float] | None = None,
    ) -> list[str]:
        payload: dict[str, Any] = {
            "texts": texts,
            "sourceLang": source_lang,
            "targetLang": target_lang,
        }
        if durations is not None:
            payload["durations"] = [round(max(0.1, float(x)), 3) for x in durations]
        data = self._json("POST", "/api/internal/translate", json=payload)
        return [str(x) for x in data.get("translations", [])]'''
text2, n = pattern.subn(repl, text, count=1)
if n != 1:
    raise SystemExit(f'worker client translate patch count={n}')
p.write_text(text2, encoding='utf-8')
print('OK duration-aware translation client')


# dub_chunk.py
replace_once(
    'scripts/dub_chunk.py',
    'from pathlib import Path\n',
    'from pathlib import Path\nfrom types import SimpleNamespace\n',
    'SimpleNamespace import',
)
replace_once('scripts/dub_chunk.py', 'AUDIO_PROFILE_VERSION = 2', 'AUDIO_PROFILE_VERSION = 3', 'audio profile v3')
replace_once(
    'scripts/dub_chunk.py',
    'def translate_texts(client: WorkerClient, texts: list[str], source_lang: str, target_lang: str) -> list[str]:',
    'def translate_texts(client: WorkerClient, texts: list[str], source_lang: str, target_lang: str, durations: list[float] | None = None) -> list[str]:',
    'translate durations signature',
)
replace_once(
    'scripts/dub_chunk.py',
    '            got = client.translate(batch, source_lang, target_lang)',
    '            batch_durations = durations[i:i + 12] if durations is not None else None\n            got = client.translate(batch, source_lang, target_lang, batch_durations)',
    'translate durations batch',
)

p = Path('scripts/dub_chunk.py')
text = p.read_text(encoding='utf-8')
start = text.find('    model_name = os.environ.get("WHISPER_MODEL", "base")')
end_marker = '    client.patch_job(job_id, progress=17, stage=f"แปลช่วง {args.index + 1}/{args.total} เสร็จ กำลังสร้างเสียง")'
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit('transcription block not found')
end += len(end_marker)
new_block = '''    transcript_key = f"temp/{job_id}/transcript/chunk_{args.index:05d}.json"
    transcript_data = None
    transcript_file = work / f"youtube_transcript_{args.index:05d}.json"
    try:
        if client.exists(transcript_key):
            client.download(transcript_key, transcript_file)
            transcript_data = json.loads(transcript_file.read_text(encoding="utf-8"))
    except Exception as transcript_error:
        print(f"Cannot use YouTube transcript for chunk {args.index}: {transcript_error}", flush=True)
        transcript_data = None

    target_lang = str(job.get("targetLang") or "th")
    timed_entries = list((transcript_data or {}).get("entries") or [])
    if timed_entries:
        whisper_segments = [
            SimpleNamespace(
                start=max(0.0, float(item.get("start") or 0)),
                end=max(
                    max(0.0, float(item.get("start") or 0)) + 0.05,
                    float(item.get("start") or 0) + max(0.05, float(item.get("duration") or 0)),
                ),
                text=str(item.get("text") or "").strip(),
            )
            for item in timed_entries
            if str(item.get("text") or "").strip()
        ]
        detected_lang = str(transcript_data.get("language") or job.get("sourceLang") or "auto")
        client.patch_job(
            job_id,
            progress=15,
            stage=f"ใช้ซับ YouTube ช่วง {args.index + 1}/{args.total} {len(whisper_segments)} บรรทัด",
        )
    else:
        model_name = os.environ.get("WHISPER_MODEL", "base")
        beam_size = 1 if mode == "fast" else (2 if mode == "balanced" else 3)
        model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=max(2, os.cpu_count() or 2))
        requested_source = job.get("sourceLang", "auto")
        whisper_lang = None if requested_source == "auto" else requested_source
        seg_iter, info = model.transcribe(
            str(audio),
            language=whisper_lang,
            vad_filter=True,
            beam_size=beam_size,
            best_of=1,
            condition_on_previous_text=(mode == "quality"),
        )
        whisper_segments = [s for s in seg_iter if str(s.text or "").strip()]
        detected_lang = str(getattr(info, "language", None) or requested_source or "auto")
        client.patch_job(job_id, progress=15, stage=f"ถอดเสียงช่วง {args.index + 1}/{args.total} เสร็จ กำลังแปล")

    if pause_checkpoint(client, job_id, "after transcription"):
        return

    original_texts = [str(s.text).strip() for s in whisper_segments]
    segment_durations = [max(0.1, float(s.end) - float(s.start)) for s in whisper_segments]
    if transcript_data and bool(transcript_data.get("targetReady")):
        translated = original_texts
        client.patch_job(job_id, progress=17, stage=f"ใช้คำแปล YouTube ช่วง {args.index + 1}/{args.total} กำลังสร้างเสียง")
    else:
        translated = translate_texts(client, original_texts, detected_lang, target_lang, segment_durations)
        client.patch_job(job_id, progress=17, stage=f"แปลช่วง {args.index + 1}/{args.total} เสร็จ กำลังสร้างเสียง")
    voices = asyncio.run(list_matching_voices(target_lang, str(job.get("voiceMode") or "auto")))'''
text = text[:start] + new_block + text[end:]
p.write_text(text, encoding='utf-8')
print('OK transcript-first dubbing')

replace_once(
    'scripts/dub_chunk.py',
    '''    common_video = [
        "-vf", "scale=-2:'min(1080,ih)'",
        "-c:v", "libx264", "-preset", "ultrafast" if mode == "fast" else "veryfast",''',
    '''    video_filter = "scale=-2:'min(1080,ih)'"
    if bool(job.get("subtitles", True)) and subtitles:
        sub_name = subtitle_path.as_posix().replace("'", "\\\\'")
        video_filter += (
            f",subtitles=filename='{sub_name}':"
            "force_style='FontName=Noto Sans Thai,FontSize=22,Alignment=2,MarginV=46,"
            "BorderStyle=3,Outline=1,Shadow=0,PrimaryColour=&H00FFFFFF,BackColour=&H88000000'"
        )
    common_video = [
        "-vf", video_filter,
        "-c:v", "libx264", "-preset", "ultrafast" if mode == "fast" else "veryfast",''',
    'burn Thai subtitles',
)
replace_once(
    'scripts/dub_chunk.py',
    '''            "[0:a:0]aresample=48000,volume=0.90[base];"
            "[1:a:0]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=7,asplit=2[voice_sc][voice_mix];"
            "[base][voice_sc]sidechaincompress=threshold=0.010:ratio=20:attack=4:release=220[ducked];"
            "[ducked][voice_mix]amix=inputs=2:weights='0.80 1.35':normalize=0,"''',
    '''            "[0:a:0]aresample=48000,volume=0.78[base];"
            "[1:a:0]aresample=48000,loudnorm=I=-15:TP=-1.5:LRA=7,asplit=2[voice_sc][voice_mix];"
            "[base][voice_sc]sidechaincompress=threshold=0.004:ratio=30:attack=2:release=180[ducked];"
            "[ducked][voice_mix]amix=inputs=2:weights='0.42 1.55':normalize=0,"''',
    'stronger original dialogue ducking',
)


# worker.js
replace_once(
    'src/worker.js',
    "const allowed = ['status', 'stage', 'outputKey', 'subtitleKey', 'log', 'duration', 'sizeBytes', 'chunkTotal', 'error', 'runId', 'runAttempt'];",
    "const allowed = ['status', 'stage', 'outputKey', 'subtitleKey', 'transcriptXmlKey', 'transcriptLanguage', 'transcriptSource', 'log', 'duration', 'sizeBytes', 'chunkTotal', 'error', 'runId', 'runAttempt'];",
    'allow transcript job fields',
)
replace_once(
    'src/worker.js',
    'async function runTranslationBatch(env, texts, sourceLang, targetLang) {',
    'async function runTranslationBatch(env, texts, sourceLang, targetLang, durations = []) {',
    'translation batch durations signature',
)
replace_once(
    'src/worker.js',
    '''        content: 'Translate subtitle items faithfully and naturally. Preserve names, emotion and order. Output exactly one JSON object shaped like {"translations":["..."]}. No explanation or markdown.',
      },
      {
        role: 'user',
        content: JSON.stringify({ sourceLanguage: sourceLang || 'auto', targetLanguage: targetLang, texts }),''',
    '''        content: 'Translate these adjacent subtitle lines as one continuous scene. Use neighboring lines to resolve pronouns, names and meaning. Preserve names, emotion and item order. Make each translated line concise enough to speak naturally within its durationsSeconds value; never omit important meaning just to shorten it. Output exactly one JSON object shaped like {"translations":["..."]}. No explanation or markdown.',
      },
      {
        role: 'user',
        content: JSON.stringify({ sourceLanguage: sourceLang || 'auto', targetLanguage: targetLang, texts, durationsSeconds: durations }),''',
    'scene-aware translation prompt',
)
replace_once(
    'src/worker.js',
    'async function translateWithAI(env, texts, sourceLang, targetLang) {',
    'async function translateWithAI(env, texts, sourceLang, targetLang, durations = []) {',
    'translateWithAI durations signature',
)
replace_once(
    'src/worker.js',
    '    const batchOut = await runTranslationBatch(env, texts, sourceLang, targetLang);',
    '    const batchOut = await runTranslationBatch(env, texts, sourceLang, targetLang, durations);',
    'pass batch durations',
)
replace_once(
    'src/worker.js',
    '''    const translations = await translateWithAI(env, texts, String(body.sourceLang || 'auto'), String(body.targetLang || 'th'));
    return json({ translations });''',
    '''    const durations = Array.isArray(body.durations) ? body.durations.map(x => Math.max(0.1, Number(x) || 0.1)) : [];
    const translations = await translateWithAI(
      env,
      texts,
      String(body.sourceLang || 'auto'),
      String(body.targetLang || 'th'),
      durations.length === texts.length ? durations : [],
    );
    return json({ translations });''',
    'read translation durations',
)


# public/app.js XML button
replace_once(
    'public/app.js',
    '''${j.subtitleKey ? `<button class="mini-btn" data-file="${esc(j.subtitleKey)}">คำบรรยาย</button>` : ''}<button class="mini-btn danger"''',
    '''${j.subtitleKey ? `<button class="mini-btn" data-file="${esc(j.subtitleKey)}">คำบรรยาย</button>` : ''}${j.transcriptXmlKey ? `<button class="mini-btn" data-file="${esc(j.transcriptXmlKey)}">XML ซับ</button>` : ''}<button class="mini-btn danger"''',
    'XML transcript job button',
)
