from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path

import dub_chunk as base
from r3_studio import apply_glossary, cache_key, compact_thai, normalize_glossary, quality_gate, quota_estimate
from voice_profiles import (
    choose_profile_voice,
    decode_profile,
    encode_profile,
    list_profile_voices,
    synthesize_profile,
)

# R3 profile v6 adds glossary-aware translation cache, deterministic series
# casting, timing rescue and strict chunk quality gates. Runtime reliability
# guards below keep the same profile version so durable v6 chunks stay reusable.
AUDIO_PROFILE_VERSION = 6
MAX_TEMPO_RATIO = 1.18
MAX_GAP_EXTENSION = 1.50
MAX_TTS_CONCURRENCY = 2
TTS_RETRY_DELAYS = (2.0, 5.0, 10.0)
MAX_SIDECHAIN_RATIO = 20.0

_original_translate = base.translate_texts
_original_synthesize_many = base.synthesize_many
_original_run = base.run
_original_mark_chunk_complete = base.WorkerClient.mark_chunk_complete

RUNTIME_JOB: dict = {}
RUNTIME_INDEX = 0
RUNTIME_CACHE_HIT = False
RUNTIME_REPAIR: dict = {}
RUNTIME_SERIES_SEED = 0


def _cli(name: str, default: str = '') -> str:
    try:
        idx = sys.argv.index(name)
        return sys.argv[idx + 1]
    except (ValueError, IndexError):
        return default


def _contains_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", text or ""))


def _translation_bad(source: str, translated: str, target_lang: str) -> bool:
    src = str(source or '').strip()
    out = str(translated or '').strip()
    if not src:
        return False
    if not out:
        return True
    if out == src:
        if target_lang == 'th' and _contains_cjk(src):
            return True
        letters = re.sub(r"[\W\d_]+", '', src, flags=re.UNICODE)
        return len(letters) >= 4
    if target_lang == 'th' and _contains_cjk(src):
        cjk_count = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", out))
        thai_count = len(re.findall(r"[\u0e00-\u0e7f]", out))
        if cjk_count >= 3 and thai_count == 0:
            return True
    return False


def _repair_applies(action: str | None = None) -> bool:
    if not RUNTIME_REPAIR:
        return False
    chunks = [int(x) for x in RUNTIME_REPAIR.get('chunks') or [] if str(x).lstrip('-').isdigit()]
    if RUNTIME_INDEX not in chunks:
        return False
    return action is None or str(RUNTIME_REPAIR.get('action') or '') == action


def _cache_key_for_batch(texts: list[str], source_lang: str, target_lang: str, durations: list[float] | None) -> str:
    glossary = normalize_glossary(RUNTIME_JOB)
    payload = {
        'items': [cache_key(source_lang, target_lang, text, glossary) for text in texts],
        'durations': [round(float(x), 3) for x in (durations or [])],
        'series': str(RUNTIME_JOB.get('series') or ''),
        'season': int(RUNTIME_JOB.get('season') or 1),
        'episode': int(RUNTIME_JOB.get('episode') or 1),
        'v': AUDIO_PROFILE_VERSION,
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _translation_cache_object(job_id: str) -> str:
    return f"_state/{job_id}/r3/translation_{RUNTIME_INDEX:05d}.json"


def _load_translation_cache(client, key: str, fingerprint: str, count: int) -> list[str] | None:
    if not bool(RUNTIME_JOB.get('r3Cache', True)) or _repair_applies('retranslate') or _repair_applies('edit_text'):
        return None
    try:
        if not client.exists(key):
            return None
        local = Path(f"r3_translation_cache_{RUNTIME_INDEX:05d}.json")
        client.download(key, local)
        data = json.loads(local.read_text(encoding='utf-8'))
        local.unlink(missing_ok=True)
        values = [str(x) for x in data.get('translations') or []]
        if data.get('fingerprint') == fingerprint and len(values) == count:
            return values
    except Exception as exc:
        print(f"R3 translation cache read skipped: {exc}", flush=True)
    return None


def _save_translation_cache(client, key: str, fingerprint: str, translated: list[str]) -> None:
    if not bool(RUNTIME_JOB.get('r3Cache', True)):
        return
    try:
        local = Path(f"r3_translation_cache_{RUNTIME_INDEX:05d}.json")
        local.write_text(json.dumps({
            'version': AUDIO_PROFILE_VERSION,
            'fingerprint': fingerprint,
            'translations': translated,
            'series': RUNTIME_JOB.get('series') or '',
            'season': int(RUNTIME_JOB.get('season') or 1),
            'episode': int(RUNTIME_JOB.get('episode') or 1),
        }, ensure_ascii=False), encoding='utf-8')
        client.upload(local, key, 'application/json')
        local.unlink(missing_ok=True)
    except Exception as exc:
        print(f"R3 translation cache write skipped: {exc}", flush=True)


def guarded_translate_texts(client, texts: list[str], source_lang: str, target_lang: str, durations: list[float] | None = None) -> list[str]:
    global RUNTIME_CACHE_HIT
    if not texts:
        return []

    glossary = normalize_glossary(RUNTIME_JOB)
    prepared = [apply_glossary(str(x), glossary) for x in texts]
    fingerprint = _cache_key_for_batch(prepared, source_lang, target_lang, durations)
    cache_object = _translation_cache_object(str(RUNTIME_JOB.get('id') or 'unknown'))
    cached = _load_translation_cache(client, cache_object, fingerprint, len(prepared))
    if cached is not None:
        RUNTIME_CACHE_HIT = True
        translated = cached
        print(f"R3 translation cache HIT chunk={RUNTIME_INDEX + 1}", flush=True)
    else:
        RUNTIME_CACHE_HIT = False
        translated = _original_translate(client, prepared, source_lang, target_lang, durations)

    if source_lang != target_lang:
        bad = [i for i, (src, out) in enumerate(zip(prepared, translated)) if _translation_bad(src, out, target_lang)]
        unresolved: list[int] = []
        google = None
        google_source = "auto" if source_lang == "auto" else base.GOOGLE_CODES.get(source_lang, source_lang)
        google_target = base.GOOGLE_CODES.get(target_lang, target_lang)

        for i in bad:
            one_duration = [durations[i]] if durations is not None and i < len(durations) else None

            # First ask Workers AI to repair only the single bad sentence.
            try:
                retry = client.translate([prepared[i]], source_lang, target_lang, one_duration)
                candidate = str(retry[0]) if retry else ''
                if not _translation_bad(prepared[i], candidate, target_lang):
                    translated[i] = candidate
                    print(f"Translation guard repaired segment {i + 1} with Workers AI", flush=True)
                    continue
            except Exception as exc:
                print(f"Translation guard Workers AI retry failed for segment {i + 1}: {exc}", flush=True)

            # Only this one unresolved sentence is allowed to reach Google.
            # Never spill a whole 12-line batch into the emergency provider.
            if google is None:
                google = base.GoogleTranslator(source=google_source, target=google_target)
            try:
                candidate = base._google_translate_limited(google, prepared[i], i + 1)
                if not _translation_bad(prepared[i], candidate, target_lang):
                    translated[i] = candidate
                    print(f"Translation guard repaired segment {i + 1} with paced Google fallback", flush=True)
                    continue
            except Exception as exc:
                print(f"Translation guard Google fallback failed for segment {i + 1}: {exc}", flush=True)

            unresolved.append(i)

        if unresolved:
            preview = ', '.join(str(i + 1) for i in unresolved[:8])
            raise RuntimeError(
                'คำแปลไม่ครบหรือยังเป็นภาษาต้นฉบับในประโยค '
                f"{preview}{'…' if len(unresolved) > 8 else ''} "
                'ระบบหยุดช่วงนี้เพื่อไม่สร้างวิดีโอพากย์ไทยที่ขาดบทพูด'
            )

    if target_lang == 'th' and bool(RUNTIME_JOB.get('r3TimingRescue', True)):
        translated = [
            compact_thai(text, durations[i] if durations is not None and i < len(durations) else 0)
            for i, text in enumerate(translated)
        ]

    if _repair_applies('edit_text'):
        value = str(RUNTIME_REPAIR.get('value') or '').strip()
        if value and translated:
            translated[0] = value

    if not RUNTIME_CACHE_HIT:
        _save_translation_cache(client, cache_object, fingerprint, translated)
    return translated


async def guarded_synthesize(text: str, voice_spec: str, destination: Path) -> None:
    profile = decode_profile(voice_spec)
    action = str(RUNTIME_REPAIR.get('action') or '') if _repair_applies() else ''
    if profile and action in {'slower', 'faster'}:
        raw = str(profile.get('rate') or '0%').replace('%', '')
        try:
            rate = int(raw)
        except ValueError:
            rate = 0
        rate += -10 if action == 'slower' else 10
        rate = max(-30, min(30, rate))
        profile['rate'] = f"{rate:+d}%"
        voice_spec = encode_profile(profile)
    await synthesize_profile(text, voice_spec, destination)


def _reset_failed_tts_plan(plan: dict) -> None:
    plan['tts_ok'] = False
    plan.pop('tts_error', None)
    for key in ('mp3', 'wav'):
        path = plan.get(key)
        if isinstance(path, Path):
            path.unlink(missing_ok=True)


async def guarded_synthesize_many(plans: list[dict], concurrency: int = 4) -> None:
    if not plans:
        return

    # GitHub runs several chunks in parallel. Capping each chunk here prevents
    # a burst of 16+ simultaneous Edge TTS sessions from dropping sentences.
    initial_concurrency = max(1, min(int(concurrency or 1), MAX_TTS_CONCURRENCY))
    await _original_synthesize_many(plans, concurrency=initial_concurrency)

    for retry_number, delay in enumerate(TTS_RETRY_DELAYS, 1):
        failed = [p for p in plans if not p.get('tts_ok')]
        if not failed:
            break
        indexes = ', '.join(str(int(p.get('i', -1)) + 1) for p in failed[:8])
        print(
            f"TTS guard retry {retry_number}/{len(TTS_RETRY_DELAYS)} "
            f"for {len(failed)} sentence(s): {indexes}",
            flush=True,
        )
        for plan in failed:
            _reset_failed_tts_plan(plan)
        await asyncio.sleep(delay)
        # Retry only missing sentences and serialize them to avoid another burst.
        await _original_synthesize_many(failed, concurrency=1)

    failed = [p for p in plans if not p.get('tts_ok')]
    if failed:
        for plan in failed[:8]:
            print(
                f"TTS final failure sentence={int(plan.get('i', -1)) + 1}: "
                f"{plan.get('tts_error', 'unknown error')}",
                flush=True,
            )
        indexes = ', '.join(str(int(p.get('i', -1)) + 1) for p in failed[:8])
        raise RuntimeError(
            'สร้างเสียงไทยไม่ครบทุกประโยค '
            f"(ประโยค {indexes}{'…' if len(failed) > 8 else ''}) "
            'ระบบลองซ้ำหลายรอบแล้วและหยุดเพื่อไม่ปล่อยวิดีโอที่บทพูดหาย'
        )


async def guarded_list_matching_voices(lang: str, mode: str) -> list[str]:
    if _repair_applies('change_voice'):
        requested = str(RUNTIME_REPAIR.get('value') or '').strip()
        if requested:
            mode = requested
    return await list_profile_voices(lang, mode, base.LOCALES)


def guarded_choose_voice(voices: list[str], gap: float, speaker_mode: bool, state: dict) -> str:
    if voices and not state.get('r3_seeded'):
        state['voice_index'] = RUNTIME_SERIES_SEED % len(voices)
        state['r3_seeded'] = True
    return choose_profile_voice(voices, gap, speaker_mode, state)


def _clamp_sidechain_ratio(graph: str) -> str:
    pattern = re.compile(r"(sidechaincompress=[^;\]]*?\bratio=)([0-9]+(?:\.[0-9]+)?)")

    def clamp(match: re.Match[str]) -> str:
        try:
            value = float(match.group(2))
        except ValueError:
            value = MAX_SIDECHAIN_RATIO
        value = max(1.0, min(MAX_SIDECHAIN_RATIO, value))
        return f"{match.group(1)}{value:g}"

    return pattern.sub(clamp, graph)


def guarded_run(cmd: list[str]) -> None:
    safe_cmd = list(cmd)
    try:
        idx = safe_cmd.index('-filter_complex')
        graph = safe_cmd[idx + 1]
        if 'sidechaincompress=threshold=0.004:ratio=30:attack=2:release=180' in graph and "weights='0.42 1.55'" in graph:
            graph = graph.replace('volume=0.78[base]', 'volume=0.92[base]')
            graph = graph.replace(
                'sidechaincompress=threshold=0.004:ratio=30:attack=2:release=180',
                'sidechaincompress=threshold=0.002:ratio=20:attack=1:release=240',
            )
            graph = graph.replace("weights='0.42 1.55'", "weights='0.62 1.55'")
        # FFmpeg 6.x sidechaincompress accepts ratio only in [1, 20].
        # Clamp any future mix profile too, not only the current exact graph.
        graph = _clamp_sidechain_ratio(graph)
        safe_cmd[idx + 1] = graph
    except (ValueError, IndexError):
        pass
    _original_run(safe_cmd)


def guarded_mark_chunk_complete(self, job_id: str, index: int, total: int):
    work = Path(f"work_chunk_{index:05d}")
    meta_path = work / f"chunk_{index:05d}.json"
    output_path = work / f"chunk_{index:05d}.ts"
    if not meta_path.exists():
        raise RuntimeError('ไม่พบ metadata สำหรับตรวจคุณภาพช่วงวิดีโอก่อนบันทึก checkpoint')
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    segments = int(meta.get('segments') or 0)
    tts_segments = int(meta.get('ttsSegments') or 0)
    gate = quality_gate(
        segments=segments,
        translated=segments,
        tts_ok=tts_segments,
        output_size=output_path.stat().st_size if output_path.exists() else 0,
        duration=float(meta.get('duration') or 0),
        has_audio=base.has_audio(output_path) if output_path.exists() else False,
    )
    if segments <= 0:
        raise RuntimeError('ไม่พบคำพูดในช่วงวิดีโอนี้ ระบบไม่บันทึกช่วงเป็นเสร็จสมบูรณ์ กรุณาตรวจภาษาต้นฉบับหรือไฟล์เสียง')
    if not gate.ok:
        raise RuntimeError('R3 Quality Gate ไม่ผ่าน: ' + ', '.join(gate.errors))
    meta['r3'] = {
        'version': 3,
        'qualityGate': 'pass',
        'coverage': gate.coverage,
        'translationCacheHit': RUNTIME_CACHE_HIT,
        'series': RUNTIME_JOB.get('series') or '',
        'season': int(RUNTIME_JOB.get('season') or 1),
        'episode': int(RUNTIME_JOB.get('episode') or 1),
        'quota': quota_estimate(
            duration_seconds=float(meta.get('duration') or 0),
            segments=segments,
            cached_segments=segments if RUNTIME_CACHE_HIT else 0,
        ),
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
    # Re-upload the enriched metadata before the durable chunk marker is written.
    self.upload(meta_path, f"temp/{job_id}/meta/chunk_{index:05d}.json", 'application/json')
    return _original_mark_chunk_complete(self, job_id, index, total)


def load_runtime_job() -> None:
    global RUNTIME_JOB, RUNTIME_INDEX, RUNTIME_REPAIR, RUNTIME_SERIES_SEED
    job_path = Path(_cli('--job'))
    if not job_path.exists():
        return
    payload = json.loads(job_path.read_text(encoding='utf-8'))
    RUNTIME_INDEX = int(_cli('--index', '0') or 0)
    worker_url = _cli('--worker-url')
    token = _cli('--token')
    if worker_url and token and payload.get('id'):
        try:
            latest = base.WorkerClient(worker_url, token).get_job(str(payload['id']))
            if latest:
                payload.update(latest)
        except Exception as exc:
            print(f"R3 latest job refresh skipped: {exc}", flush=True)
    payload.setdefault('r3Enabled', True)
    payload.setdefault('r3Version', 3)
    payload.setdefault('r3ContextTranslation', True)
    payload.setdefault('r3TimingRescue', True)
    payload.setdefault('r3QualityGate', True)
    payload.setdefault('r3Cache', True)
    RUNTIME_JOB = payload
    RUNTIME_REPAIR = payload.get('r3Repair') if isinstance(payload.get('r3Repair'), dict) else {}
    seed_source = str(payload.get('series') or payload.get('title') or payload.get('id') or 'r3')
    RUNTIME_SERIES_SEED = int.from_bytes(hashlib.sha256(seed_source.encode('utf-8')).digest()[:4], 'big')
    # base.main reads this same file; keep it aligned with the authoritative Worker state.
    job_path.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')


def main() -> None:
    load_runtime_job()
    base.AUDIO_PROFILE_VERSION = AUDIO_PROFILE_VERSION
    base.MAX_TEMPO_RATIO = MAX_TEMPO_RATIO
    base.MAX_GAP_EXTENSION = MAX_GAP_EXTENSION
    base.translate_texts = guarded_translate_texts
    base.synthesize = guarded_synthesize
    base.synthesize_many = guarded_synthesize_many
    base.list_matching_voices = guarded_list_matching_voices
    base.choose_voice = guarded_choose_voice
    base.run = guarded_run
    base.WorkerClient.mark_chunk_complete = guarded_mark_chunk_complete
    base.main()


if __name__ == '__main__':
    main()
