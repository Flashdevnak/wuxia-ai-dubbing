from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import dub_chunk as base


# Runtime hardening for the existing, battle-tested dubbing pipeline.
# This wrapper intentionally keeps dub_chunk.py intact so rollback is one workflow line.
AUDIO_PROFILE_VERSION = 4
MAX_TEMPO_RATIO = 1.18
MAX_GAP_EXTENSION = 1.50

_original_translate = base.translate_texts
_original_synthesize_many = base.synthesize_many
_original_run = base.run
_original_mark_chunk_complete = base.WorkerClient.mark_chunk_complete


def _contains_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", text or ""))


def _translation_bad(source: str, translated: str, target_lang: str) -> bool:
    src = str(source or "").strip()
    out = str(translated or "").strip()
    if not src:
        return False
    if not out:
        return True

    # Numbers / punctuation / short symbols can legitimately remain unchanged.
    if out == src:
        if target_lang == "th" and _contains_cjk(src):
            return True
        letters = re.sub(r"[\W\d_]+", "", src, flags=re.UNICODE)
        return len(letters) >= 4

    # A Thai dub should not accidentally pass an untranslated Chinese sentence
    # through to the Thai TTS voice after all translation fallbacks fail.
    if target_lang == "th" and _contains_cjk(src):
        cjk_count = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", out))
        thai_count = len(re.findall(r"[\u0e00-\u0e7f]", out))
        if cjk_count >= 3 and thai_count == 0:
            return True
    return False


def guarded_translate_texts(
    client,
    texts: list[str],
    source_lang: str,
    target_lang: str,
    durations: list[float] | None = None,
) -> list[str]:
    if not texts:
        return []

    translated = _original_translate(client, texts, source_lang, target_lang, durations)
    if source_lang == target_lang:
        return translated

    bad = [
        i
        for i, (src, out) in enumerate(zip(texts, translated))
        if _translation_bad(src, out, target_lang)
    ]
    if not bad:
        return translated

    # One final per-line Workers AI retry before failing the chunk. This is
    # preferable to silently producing Thai audio with missing/untranslated lines.
    unresolved: list[int] = []
    for i in bad:
        duration = None
        if durations is not None and i < len(durations):
            duration = [durations[i]]
        try:
            retry = client.translate([texts[i]], source_lang, target_lang, duration)
            candidate = str(retry[0]) if retry else ""
            if not _translation_bad(texts[i], candidate, target_lang):
                translated[i] = candidate
                continue
        except Exception as exc:
            print(f"Translation guard retry failed for segment {i}: {exc}", flush=True)
        unresolved.append(i)

    if unresolved:
        preview = ", ".join(str(i + 1) for i in unresolved[:8])
        raise RuntimeError(
            "คำแปลไม่ครบหรือยังเป็นภาษาต้นฉบับในประโยค "
            f"{preview}{'…' if len(unresolved) > 8 else ''} "
            "ระบบหยุดช่วงนี้เพื่อไม่สร้างวิดีโอพากย์ไทยที่ขาดบทพูด"
        )
    return translated


async def guarded_synthesize_many(plans: list[dict], concurrency: int = 4) -> None:
    if not plans:
        return
    await _original_synthesize_many(plans, concurrency=concurrency)

    failed = [p for p in plans if not p.get("tts_ok")]
    if failed:
        # Edge TTS already retries internally; give only failed lines one extra,
        # low-concurrency pass to recover transient rate limits/network errors.
        await asyncio.sleep(1.0)
        await _original_synthesize_many(failed, concurrency=1)

    failed = [p for p in plans if not p.get("tts_ok")]
    if failed:
        indexes = ", ".join(str(int(p.get("i", -1)) + 1) for p in failed[:8])
        raise RuntimeError(
            "สร้างเสียงไทยไม่ครบทุกประโยค "
            f"(ประโยค {indexes}{'…' if len(failed) > 8 else ''}) "
            "ระบบหยุดช่วงนี้เพื่อให้ลองใหม่แทนการปล่อยวิดีโอที่บทพูดหาย"
        )


def guarded_run(cmd: list[str]) -> None:
    # Improve the existing "keep music/SFX" mix without changing the proven
    # ffmpeg graph structure. It still cannot perfectly separate dialogue from
    # BGM, but it ducks the original soundtrack harder while Thai speech is active
    # and lets ambience/music breathe more between Thai lines.
    safe_cmd = list(cmd)
    try:
        idx = safe_cmd.index("-filter_complex")
        graph = safe_cmd[idx + 1]
        if (
            "sidechaincompress=threshold=0.004:ratio=30:attack=2:release=180" in graph
            and "weights='0.42 1.55'" in graph
        ):
            graph = graph.replace("volume=0.78[base]", "volume=0.92[base]")
            graph = graph.replace(
                "sidechaincompress=threshold=0.004:ratio=30:attack=2:release=180",
                "sidechaincompress=threshold=0.002:ratio=30:attack=1:release=240",
            )
            graph = graph.replace("weights='0.42 1.55'", "weights='0.62 1.55'")
            safe_cmd[idx + 1] = graph
    except (ValueError, IndexError):
        pass
    _original_run(safe_cmd)


def guarded_mark_chunk_complete(self, job_id: str, index: int, total: int):
    meta_path = Path(f"work_chunk_{index:05d}") / f"chunk_{index:05d}.json"
    if not meta_path.exists():
        raise RuntimeError("ไม่พบ metadata สำหรับตรวจคุณภาพช่วงวิดีโอก่อนบันทึก checkpoint")

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    segments = int(meta.get("segments") or 0)
    tts_segments = int(meta.get("ttsSegments") or 0)
    if segments <= 0:
        raise RuntimeError(
            "ไม่พบคำพูดในช่วงวิดีโอนี้ ระบบไม่บันทึกช่วงเป็นเสร็จสมบูรณ์ "
            "กรุณาตรวจภาษาต้นฉบับหรือไฟล์เสียง"
        )
    if tts_segments != segments:
        raise RuntimeError(
            f"เสียงพากย์ไม่ครบ: สร้างได้ {tts_segments}/{segments} ประโยค "
            "ระบบไม่บันทึก checkpoint เพื่อให้ลองใหม่ได้อย่างปลอดภัย"
        )
    return _original_mark_chunk_complete(self, job_id, index, total)


def main() -> None:
    # Keep the underlying implementation and durable checkpoint system, but make
    # correctness fail-closed for Thai dubbing.
    base.AUDIO_PROFILE_VERSION = AUDIO_PROFILE_VERSION
    base.MAX_TEMPO_RATIO = MAX_TEMPO_RATIO
    base.MAX_GAP_EXTENSION = MAX_GAP_EXTENSION
    base.translate_texts = guarded_translate_texts
    base.synthesize_many = guarded_synthesize_many
    base.run = guarded_run
    base.WorkerClient.mark_chunk_complete = guarded_mark_chunk_complete
    base.main()


if __name__ == "__main__":
    main()
