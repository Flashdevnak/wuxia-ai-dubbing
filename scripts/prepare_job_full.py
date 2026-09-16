from __future__ import annotations

import json
import sys
from pathlib import Path

import prepare_job as base
from worker_client import WorkerClient
from youtube_transcript import extract_youtube_transcript


def arg_value(name: str) -> str:
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError(f"missing argument {name}") from exc


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
        # blocks the hosted runner, the uploaded video still proceeds through
        # Whisper/VAD and produces its own timestamps.
        print(f"Hybrid YouTube timing unavailable; Whisper fallback will be used: {exc}", flush=True)


def main() -> None:
    enrich_uploaded_job_with_youtube_timing()
    base.main()


if __name__ == "__main__":
    main()
