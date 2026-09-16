from __future__ import annotations

import json
import sys
from pathlib import Path

import prepare_job as base
from media_pair import has_stream, internal_file_url, mux_separate_audio, worker_headers
from worker_client import WorkerClient
from youtube_transcript import extract_youtube_transcript


def arg_value(name: str) -> str:
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError(f"missing argument {name}") from exc


def prepare_uploaded_media_pair() -> None:
    job_path = Path(arg_value("--job"))
    worker_url = arg_value("--worker-url")
    token = arg_value("--token")
    job = json.loads(job_path.read_text(encoding="utf-8"))

    if str(job.get("sourceType") or "") != "upload":
        return

    job_id = str(job.get("id") or "").strip()
    source_key = str(job.get("sourceKey") or "").strip()
    audio_key = str(job.get("sourceAudioKey") or "").strip()
    if not job_id or not source_key:
        raise RuntimeError("งานอัปโหลดไม่มีวิดีโอต้นฉบับ")

    client = WorkerClient(worker_url, token)
    if not client.exists(source_key):
        message = "ไม่พบไฟล์วิดีโอต้นฉบับ กรุณาอัปโหลดวิดีโอใหม่"
        client.fail(job_id, message)
        raise RuntimeError(message)

    headers = worker_headers(token)
    video_url = internal_file_url(worker_url, source_key)
    if not has_stream(video_url, "v:0", headers):
        message = "ไฟล์ที่เลือกไม่มีภาพวิดีโอ กรุณาเลือกไฟล์วิดีโอใหม่"
        client.fail(job_id, message)
        raise RuntimeError(message)

    if not audio_key:
        if not has_stream(video_url, "a:0", headers):
            message = (
                "วิดีโอนี้ไม่มีเสียงต้นฉบับ กรุณากลับไปเลือก “มีไฟล์เสียงแยก” "
                "แล้วอัปโหลดไฟล์เสียงที่ดาวน์โหลดมาคู่กับวิดีโอ"
            )
            client.fail(job_id, message)
            raise RuntimeError(message)
        job["mediaPairMode"] = "embedded-audio"
        job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        return

    if not client.exists(audio_key):
        message = "ไม่พบไฟล์เสียงแยก กรุณาเลือกและอัปโหลดไฟล์เสียงใหม่"
        client.fail(job_id, message)
        raise RuntimeError(message)

    audio_url = internal_file_url(worker_url, audio_key)
    if not has_stream(audio_url, "a:0", headers):
        message = "ไฟล์เสียงที่เลือกไม่มี audio track กรุณาเลือกไฟล์ M4A, MP3, AAC, WAV หรือไฟล์เสียงอื่นใหม่"
        client.fail(job_id, message)
        raise RuntimeError(message)

    paired_key = f"temp/{job_id}/paired_source.mkv"
    paired_local = Path("work_prepare") / "paired_source.mkv"

    try:
        if not client.exists(paired_key):
            client.patch_job(job_id, status="processing", progress=4, stage="กำลังจับคู่วิดีโอกับไฟล์เสียง")
            mux_separate_audio(video_url, audio_url, paired_local, headers)
            client.upload(paired_local, paired_key, "video/x-matroska")
            print(
                f"Separate audio paired: video={source_key}, audio={audio_key}, size={paired_local.stat().st_size}",
                flush=True,
            )
        else:
            print(f"Reusing paired media: {paired_key}", flush=True)
    except Exception as exc:
        message = f"รวมวิดีโอกับไฟล์เสียงไม่สำเร็จ: {exc}"
        if len(message) > 1200:
            message = message[-1200:]
        client.fail(job_id, message)
        raise RuntimeError(message) from exc

    # From this point the existing pipeline sees one normal A/V source. The
    # persistent job still keeps the original video + audio keys so retry and
    # cleanup remain safe; only this runner-local payload points at the mux.
    job["originalSourceKey"] = source_key
    job["sourceKey"] = paired_key
    job["mediaPairMode"] = "separate-audio"
    job["mediaPairPrepared"] = True
    job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    client.patch_job(job_id, status="processing", progress=5, stage="จับคู่วิดีโอกับไฟล์เสียงแล้ว กำลังเตรียมบทพูด")


def enrich_uploaded_job_with_youtube_timing() -> None:
    job_path = Path(arg_value("--job"))
    worker_url = arg_value("--worker-url")
    token = arg_value("--token")
    job = json.loads(job_path.read_text(encoding="utf-8"))

    if str(job.get("sourceType") or "") != "upload":
        return
    if job.get("captionKey") or job.get("captionUrl"):
        return

    source_url = str(job.get("sourceUrl") or "").strip()
    if not source_url:
        return
    if "youtube.com" not in source_url and "youtu.be" not in source_url:
        return

    client = WorkerClient(worker_url, token)
    try:
        cookies_file = base.build_cookie_file()
        transcript = extract_youtube_transcript(
            source_url,
            target_lang=str(job.get("targetLang") or "th"),
            source_lang=str(job.get("sourceLang") or "auto"),
            cookies_file=cookies_file,
        )
        entries = list(transcript.get("entries") or [])
        if not entries:
            raise RuntimeError("YouTube transcript has no timed entries")

        local = Path("work_prepare") / "hybrid_youtube_transcript.json"
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_text(json.dumps(transcript, ensure_ascii=False), encoding="utf-8")
        key = f"temp/{job['id']}/transcript/hybrid_full.json"
        client.upload(local, key, "application/json")

        job["captionKey"] = key
        job["captionSource"] = "youtube-auto-hybrid"
        job["captionLanguage"] = transcript.get("language")
        job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        client.patch_job(
            job["id"],
            stage=(
                f"พบ CC YouTube {len(entries)} บรรทัด ใช้ Timestamp เดิมกับไฟล์ที่อัปโหลด"
                if transcript.get("targetReady")
                else f"พบ CC YouTube {len(entries)} บรรทัด ใช้ Timestamp เดิมแล้วแปลเป็นไทย"
            ),
            transcriptLanguage=str(transcript.get("language") or ""),
            transcriptSource="youtube-auto-hybrid",
        )
        print(
            f"Hybrid timing ready: {len(entries)} lines, "
            f"lang={transcript.get('language')}, targetReady={transcript.get('targetReady')}",
            flush=True,
        )
    except Exception as exc:
        # Hybrid timing is an optimization, not a hard dependency. If YouTube
        # blocks the hosted runner, the uploaded media still proceeds through
        # Whisper/VAD and produces its own timestamps.
        print(f"Hybrid YouTube timing unavailable; Whisper fallback will be used: {exc}", flush=True)


def main() -> None:
    prepare_uploaded_media_pair()
    enrich_uploaded_job_with_youtube_timing()
    base.main()


if __name__ == "__main__":
    main()
