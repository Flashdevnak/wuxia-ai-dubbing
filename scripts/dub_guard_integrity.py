from __future__ import annotations

import re
from pathlib import Path

import srt

import dub_guard as guard

TRANSLATION_INTEGRITY_PROFILE = 7
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
LEAK_MARKERS = (
    '{"translations"',
    '"translations":',
    '"sourceLanguage":',
    '"targetLanguage":',
    '"durationsSeconds":',
    '```json',
    '```text',
)

_original_translation_bad = guard._translation_bad
_original_mark_chunk_complete = guard.guarded_mark_chunk_complete


def _repetition_runaway(text: str) -> bool:
    value = str(text or '')
    if re.search(r"(.)\1{24,}", value, flags=re.UNICODE):
        return True
    if re.search(r"(.{1,8})\1{10,}", value, flags=re.UNICODE):
        return True
    return False


def _output_problem(source: str, translated: str, target_lang: str, duration: float | None = None) -> str | None:
    src = str(source or '').strip()
    out = str(translated or '').strip()
    if not out:
        return 'empty'
    if any(marker in out for marker in LEAK_MARKERS):
        return 'prompt-or-json-leak'
    if target_lang == 'th' and CJK_RE.search(out):
        return 'cjk-leak-in-thai'
    if _repetition_runaway(out):
        return 'repetition-runaway'

    duration_value = max(0.0, float(duration or 0.0))
    source_allowance = len(src) * 12 + 160
    duration_allowance = int(duration_value * 45) + 100 if duration_value > 0 else 0
    max_chars = max(260, min(1200, source_allowance), min(1200, duration_allowance))
    if len(out) > max_chars:
        return f'oversized:{len(out)}>{max_chars}'
    return None


def strict_translation_bad(source: str, translated: str, target_lang: str) -> bool:
    if _original_translation_bad(source, translated, target_lang):
        return True
    return _output_problem(source, translated, target_lang) is not None


def strict_mark_chunk_complete(self, job_id: str, index: int, total: int):
    work = Path(f"work_chunk_{index:05d}")
    subtitle_path = work / f"chunk_{index:05d}.srt"
    meta_path = work / f"chunk_{index:05d}.json"

    if subtitle_path.exists():
        raw = subtitle_path.read_text(encoding='utf-8', errors='replace')
        subtitles = list(srt.parse(raw))
        failures: list[str] = []
        for item in subtitles:
            text = str(item.content or '').strip()
            duration = max(0.0, (item.end - item.start).total_seconds())
            problem = _output_problem('', text, 'th', duration)
            if problem:
                failures.append(f"#{item.index}:{problem}")
                if len(failures) >= 8:
                    break
        if failures:
            raise RuntimeError(
                'Translation Integrity Gate ไม่ผ่าน: '
                + ', '.join(failures)
                + ' ระบบไม่บันทึก chunk นี้เพื่อป้องกัน JSON/ภาษาจีน/ข้อความเสียหลุดเข้าไฟล์พากย์'
            )

    if meta_path.exists():
        import json
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
        meta['translationIntegrityProfile'] = TRANSLATION_INTEGRITY_PROFILE
        meta['translationIntegrityGate'] = 'pass'
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')

    return _original_mark_chunk_complete(self, job_id, index, total)


def main() -> None:
    # Bump the durable profile so v6 chunks and translation caches produced by
    # the permissive parser are never reused after this fix.
    guard.AUDIO_PROFILE_VERSION = TRANSLATION_INTEGRITY_PROFILE
    guard._translation_bad = strict_translation_bad
    guard.guarded_mark_chunk_complete = strict_mark_chunk_complete
    guard.main()


if __name__ == '__main__':
    main()
