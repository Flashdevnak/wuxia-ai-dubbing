from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

R3_VERSION = 1
DEFAULT_GLOSSARY = {
    "宗主": "เจ้าสำนัก", "宗门": "สำนัก", "师父": "อาจารย์", "师尊": "ท่านอาจารย์",
    "师兄": "ศิษย์พี่", "师姐": "ศิษย์พี่หญิง", "师弟": "ศิษย์น้อง", "师妹": "ศิษย์น้องหญิง",
    "长老": "ผู้อาวุโส", "掌门": "เจ้าสำนัก", "灵气": "ปราณวิญญาณ", "修为": "พลังบำเพ็ญ",
}

@dataclass(frozen=True)
class QualityResult:
    ok: bool
    errors: tuple[str, ...]
    warnings: tuple[str, ...]
    coverage: float


def normalize_glossary(job: dict[str, Any]) -> dict[str, str]:
    result = dict(DEFAULT_GLOSSARY)
    supplied = job.get("glossary") or {}
    if isinstance(supplied, list):
        supplied = {str(x.get("source", "")): str(x.get("target", "")) for x in supplied if isinstance(x, dict)}
    if isinstance(supplied, dict):
        for source, target in supplied.items():
            source, target = str(source).strip(), str(target).strip()
            if source and target:
                result[source] = target
    return result


def apply_glossary(text: str, glossary: dict[str, str]) -> str:
    value = str(text or "")
    for source in sorted(glossary, key=len, reverse=True):
        value = value.replace(source, glossary[source])
    return value


def context_windows(texts: list[str], radius: int = 2) -> list[str]:
    out = []
    for i, current in enumerate(texts):
        before = texts[max(0, i-radius):i]
        after = texts[i+1:i+1+radius]
        out.append("\n".join([*(f"ก่อนหน้า: {x}" for x in before), f"ปัจจุบัน: {current}", *(f"ถัดไป: {x}" for x in after)]))
    return out


def stable_speaker_ids(entries: list[dict[str, Any]], gap_seconds: float = 1.8) -> list[str]:
    """Keep explicit speaker labels; otherwise use deterministic conversational turns.

    This is deliberately not biometric identification. It gives stable casting within
    an episode without pretending to know a person's identity.
    """
    result: list[str] = []
    turn = 0
    previous_end = 0.0
    explicit_map: dict[str, str] = {}
    for item in entries:
        explicit = str(item.get("speaker") or item.get("speakerId") or "").strip()
        if explicit:
            explicit_map.setdefault(explicit, f"speaker-{len(explicit_map)+1}")
            speaker = explicit_map[explicit]
        else:
            start = float(item.get("start") or 0)
            if result and start - previous_end >= gap_seconds:
                turn += 1
            speaker = f"speaker-{(turn % 4)+1}"
        result.append(speaker)
        previous_end = max(previous_end, float(item.get("end") or (float(item.get("start") or 0) + float(item.get("duration") or 0))))
    return result


def build_voice_map(speakers: Iterable[str], voices: list[str], saved: dict[str, str] | None = None) -> dict[str, str]:
    if not voices:
        raise ValueError("voices is required")
    mapping = dict(saved or {})
    for speaker in speakers:
        if speaker not in mapping or mapping[speaker] not in voices:
            digest = hashlib.sha256(speaker.encode("utf-8")).digest()
            mapping[speaker] = voices[int.from_bytes(digest[:2], "big") % len(voices)]
    return mapping


def compact_thai(text: str, target_seconds: float) -> str:
    """Conservative timing rescue before tempo changes; never invents meaning."""
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if target_seconds <= 0:
        return value
    # Thai speech is roughly 9-13 visible characters/sec depending on delivery.
    budget = max(8, int(target_seconds * 12.5))
    if len(value) <= budget:
        return value
    replacements = [("เป็นอย่างมาก", "มาก"), ("ในตอนนี้", "ตอนนี้"), ("เพราะเหตุใด", "ทำไม"), ("ไม่สามารถ", "ไม่ได้"), ("จะต้อง", "ต้อง")]
    for a, b in replacements:
        value = value.replace(a, b)
        if len(value) <= budget:
            return value
    # Do not blindly truncate dialogue. Signal caller to use tempo/window rescue.
    return value


def timing_plan(spoken_seconds: float, desired_seconds: float, free_gap: float = 0.0) -> dict[str, float | str]:
    desired = max(0.12, float(desired_seconds))
    window = desired + min(1.2, max(0.0, float(free_gap)))
    ratio = max(1.0, float(spoken_seconds) / max(window, 0.12))
    if ratio <= 1.02:
        strategy = "natural"
    elif ratio <= 1.10:
        strategy = "tempo"
    else:
        strategy = "rewrite_then_tempo"
    return {"window": round(window, 3), "requiredRatio": round(ratio, 4), "tempo": round(min(1.10, ratio), 4), "strategy": strategy}


def cache_key(source: str, target: str, text: str, glossary: dict[str, str], voice: str = "") -> str:
    payload = json.dumps({"v": R3_VERSION, "s": source, "t": target, "text": text, "glossary": glossary, "voice": voice}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def quality_gate(*, segments: int, translated: int, tts_ok: int, output_size: int, duration: float, has_audio: bool, missing_indices: list[int] | None = None) -> QualityResult:
    errors: list[str] = []
    warnings: list[str] = []
    total = max(0, int(segments))
    translated = max(0, int(translated))
    tts_ok = max(0, int(tts_ok))
    if total and translated < total:
        errors.append(f"translation_missing:{total-translated}")
    if total and tts_ok < total:
        errors.append(f"tts_missing:{total-tts_ok}")
    if output_size <= 0:
        errors.append("output_empty")
    if duration <= 0:
        errors.append("duration_invalid")
    if not has_audio:
        errors.append("audio_missing")
    if missing_indices:
        errors.append("segments_missing:" + ",".join(map(str, missing_indices[:30])))
    coverage = 1.0 if total == 0 else min(translated, tts_ok) / total
    if 0 < coverage < 1:
        warnings.append(f"coverage:{coverage:.3f}")
    return QualityResult(not errors, tuple(errors), tuple(warnings), coverage)


def repair_plan(job_id: str, segment_indices: list[int], action: str, value: str | None = None) -> dict[str, Any]:
    allowed = {"retranslate", "change_voice", "slower", "faster", "edit_text"}
    if action not in allowed:
        raise ValueError("unsupported repair action")
    clean = sorted({int(x) for x in segment_indices if int(x) >= 0})
    if not clean:
        raise ValueError("segment_indices is required")
    return {"jobId": job_id, "action": action, "segments": clean, "value": value, "invalidate": [f"tts:{i}" for i in clean] + [f"mix:{i}" for i in clean]}


def episode_defaults(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "series": str(job.get("series") or "").strip(),
        "season": max(1, int(job.get("season") or 1)),
        "episode": max(1, int(job.get("episode") or 1)),
        "glossary": normalize_glossary(job),
        "voiceMap": dict(job.get("voiceMap") or {}),
    }


def batch_plan(items: list[dict[str, Any]], max_parallel: int = 2) -> dict[str, Any]:
    jobs = []
    for position, item in enumerate(items):
        if not item.get("sourceKey") and not item.get("youtubeUrl"):
            raise ValueError(f"batch item {position} has no source")
        jobs.append({"position": position, "status": "queued", **episode_defaults(item), **item})
    return {"version": R3_VERSION, "maxParallel": max(1, min(int(max_parallel), 4)), "jobs": jobs}


def quota_estimate(*, duration_seconds: float, segments: int, cached_segments: int = 0) -> dict[str, Any]:
    uncached = max(0, int(segments) - max(0, int(cached_segments)))
    minutes = max(0.0, float(duration_seconds)) / 60.0
    return {"mediaMinutes": round(minutes, 2), "segments": int(segments), "cachedSegments": int(cached_segments), "translationCallsApprox": (uncached + 11) // 12, "ttsSegments": uncached, "cacheReusePercent": round((1 - uncached/max(1, int(segments))) * 100, 1)}
