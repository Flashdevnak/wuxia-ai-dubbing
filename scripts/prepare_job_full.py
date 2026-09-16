from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import prepare_job as base
from media_pair import has_stream, internal_file_url, worker_headers
from worker_client import WorkerClient
from youtube_transcript import extract_youtube_transcript, slice_entries


DIRECT_PAIR_MODE = "direct-separate-audio-v1"


def arg_value(name: str, default: str | None = None) -> str:
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError):
        if default is not None:
            return default
        raise RuntimeError(f"missing argument {name}")


def fail(client: WorkerClient, job_id: str, message: str) -> None:
    client.fail(job_id, message)
    raise RuntimeError(message)


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
        print(f"Hybrid YouTube timing unavailable; Whisper fallback will be used: {exc}", flush=True)


def _completed_chunk_available(client: WorkerClient, job: dict, job_id: str, index: int) -> bool:
    n = f"{index:05d}"
    required = [
        f"_state/{job_id}/chunks/{n}.json",
        f"temp/{job_id}/dub/chunk_{n}.ts",
        f"temp/{job_id}/meta/chunk_{n}.json",
    ]
    if bool(job.get("subtitles", True)):
        required.append(f"temp/{job_id}/subs/chunk_{n}.srt")
    return all(client.exists(key) for key in required)


def _recover_completed_dub_chunks(client: WorkerClient, job: dict, github_output: str | None) -> bool:
    job_id = str(job.get("id") or "")
    total = int(job.get("chunkTotal") or 0)
    if not job_id or total < 1:
        return False
    if not all(_completed_chunk_available(client, job, job_id, i) for i in range(total)):
        return False

    recovered = {
        "jobId": job_id,
        "duration": float(job.get("duration") or 0),
        "total": total,
        "chunks": [
            {"index": i, "key": f"temp/{job_id}/source/chunk_{i:05d}.mkv", "size": 0}
            for i in range(total)
        ],
        "sourceLang": job.get("sourceLang", "auto"),
        "targetLang": job.get("targetLang", "th"),
        "mediaPairMode": DIRECT_PAIR_MODE,
        "storageEfficient": True,
        "recoveredWithoutOriginals": True,
    }
    client.patch_job(
        job_id,
        status="processing",
        progress=94,
        stage=f"พบไฟล์พากย์ครบ {total} ช่วง กำลังรวมวิดีโอ",
        duration=float(job.get("duration") or 0),
        chunkTotal=total,
    )
    print(f"Recovering direct-pair job from {total} completed dubbed chunks; originals are not required", flush=True)
    base.emit_outputs(recovered, github_output)
    return True


def _reuse_prepared_manifest(client: WorkerClient, job: dict, manifest_key: str, manifest_path: Path) -> dict | None:
    if not client.exists(manifest_key):
        return None
    try:
        client.download(manifest_key, manifest_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        chunks = list(manifest.get("chunks") or [])
        if not chunks:
            return None
        for chunk in chunks:
            index = int(chunk.get("index") or 0)
            source_key = str(chunk.get("key") or "")
            if source_key and client.exists(source_key):
                continue
            if _completed_chunk_available(client, job, str(job["id"]), index):
                continue
            return None
        return manifest
    except Exception as exc:
        print(f"Prepared direct-pair manifest cannot be reused: {exc}", flush=True)
        return None


def _load_timed_transcript(client: WorkerClient, job: dict, work: Path) -> dict | None:
    caption_key = str(job.get("captionKey") or "").strip()
    if not caption_key:
        return None
    local = work / "timed_transcript.json"
    try:
        client.download(caption_key, local)
        data = json.loads(local.read_text(encoding="utf-8"))
        if list(data.get("entries") or []):
            return data
    except Exception as exc:
        print(f"Timed transcript unavailable for direct pairing: {exc}", flush=True)
    return None


def prepare_separate_audio_direct() -> bool:
    job_path = Path(arg_value("--job"))
    worker_url = arg_value("--worker-url")
    token = arg_value("--token")
    github_output = arg_value("--github-output", "") or None
    chunk_seconds = max(300, int(arg_value("--chunk-seconds", "1200")))
    job = json.loads(job_path.read_text(encoding="utf-8"))

    if str(job.get("sourceType") or "") != "upload":
        return False
    audio_key = str(job.get("sourceAudioKey") or "").strip()
    if not audio_key:
        return False

    job_id = str(job.get("id") or "").strip()
    source_key = str(job.get("sourceKey") or "").strip()
    if not job_id or not source_key:
        raise RuntimeError("งานอัปโหลดไม่มีวิดีโอต้นฉบับ")

    client = WorkerClient(worker_url, token)

    # When every dubbed chunk is already durable, retries can go straight to
    # finalization. This makes it safe for the Worker to release large original
    # uploads before final MP4 export and prevents a late 5 GB storage spike.
    if _recover_completed_dub_chunks(client, job, github_output):
        return True

    if not client.exists(source_key):
        fail(client, job_id, "ไม่พบไฟล์วิดีโอต้นฉบับ กรุณาอัปโหลดวิดีโอใหม่")
    if not client.exists(audio_key):
        fail(client, job_id, "ไม่พบไฟล์เสียงแยก กรุณาเลือกและอัปโหลดไฟล์เสียงใหม่")

    headers = worker_headers(token)
    video_url = internal_file_url(worker_url, source_key)
    audio_url = internal_file_url(worker_url, audio_key)
    if not has_stream(video_url, "v:0", headers):
        fail(client, job_id, "ไฟล์ที่เลือกไม่มีภาพวิดีโอ กรุณาเลือกไฟล์วิดีโอใหม่")
    if not has_stream(audio_url, "a:0", headers):
        fail(client, job_id, "ไฟล์เสียงที่เลือกไม่มี audio track กรุณาเลือกไฟล์ M4A, MP3, AAC, WAV หรือไฟล์เสียงอื่นใหม่")

    work = Path("work_prepare")
    work.mkdir(parents=True, exist_ok=True)
    manifest_path = work / "manifest.json"
    manifest_key = f"temp/{job_id}/manifest.json"

    previous = _reuse_prepared_manifest(client, job, manifest_key, manifest_path)
    if previous:
        total = int(previous.get("total") or len(previous.get("chunks") or []))
        client.patch_job(
            job_id,
            status="processing",
            progress=10,
            stage=f"ใช้วิดีโอที่แบ่งไว้แล้ว {total} ช่วง",
            duration=float(previous.get("duration") or 0),
            chunkTotal=total,
        )
        print(f"Reusing direct-pair manifest with {total} chunks", flush=True)
        base.emit_outputs(previous, github_output)
        return True

    transcript_data = _load_timed_transcript(client, job, work)
    duration = base.probe_duration(video_url, headers)
    audio_duration = base.probe_duration(audio_url, headers)
    if duration <= 0:
        duration = audio_duration
    if duration <= 0:
        fail(client, job_id, "ตรวจความยาววิดีโอหรือไฟล์เสียงไม่ได้")

    chunks_dir = work / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(chunks_dir / "chunk_%05d.mkv")

    # Important: do not create temp/{job}/paired_source.mkv. Feeding the video
    # and the separate audio directly into the segmenter prevents a full extra
    # 1-2 GB R2 copy before dubbing starts.
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y"]
    cmd += ["-headers", headers, "-i", video_url]
    cmd += ["-headers", headers, "-i", audio_url]
    cmd += [
        "-map", "0:v:0", "-map", "1:a:0",
        "-sn", "-dn", "-c:v", "copy", "-c:a", "copy",
        "-shortest", "-avoid_negative_ts", "make_zero",
        "-f", "segment", "-segment_time", str(chunk_seconds),
        "-reset_timestamps", "1", "-segment_format", "matroska", pattern,
    ]

    client.patch_job(job_id, status="processing", progress=4, stage="กำลังแบ่งวิดีโอและเสียงโดยตรง ไม่สร้างไฟล์ซ้ำทั้งเรื่อง")
    print("Starting direct separate-audio segmenter; paired_source.mkv is intentionally not created", flush=True)
    proc = subprocess.Popen(cmd)
    uploaded: list[dict] = []
    next_index = 0

    def upload_ready(final_pass: bool = False) -> None:
        nonlocal next_index
        while True:
            current = chunks_dir / f"chunk_{next_index:05d}.mkv"
            following = chunks_dir / f"chunk_{next_index + 1:05d}.mkv"
            if not current.exists():
                return
            if not final_pass and not following.exists():
                return
            size = current.stat().st_size
            if size <= 0:
                return

            key = f"temp/{job_id}/source/chunk_{next_index:05d}.mkv"
            print(f"Uploading direct-pair source chunk {next_index}: {size} bytes", flush=True)
            client.upload(current, key, "video/x-matroska")
            chunk_duration = base.probe_duration(str(current))
            if chunk_duration <= 0:
                chunk_duration = float(chunk_seconds)
            chunk_start = sum(float(c.get("duration") or 0) for c in uploaded)
            item = {
                "index": next_index,
                "key": key,
                "size": size,
                "start": chunk_start,
                "duration": chunk_duration,
                "mediaPairMode": DIRECT_PAIR_MODE,
            }

            if transcript_data:
                local_entries = slice_entries(transcript_data.get("entries") or [], chunk_start, chunk_duration)
                chunk_transcript = {
                    "language": transcript_data.get("language"),
                    "targetLanguage": transcript_data.get("targetLanguage"),
                    "targetReady": bool(transcript_data.get("targetReady")),
                    "origin": transcript_data.get("origin"),
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
            current.unlink(missing_ok=True)
            next_index += 1
            client.patch_job(
                job_id,
                progress=min(9, 5 + len(uploaded) // 2),
                stage=f"แบ่งวิดีโอและเสียงแล้ว {len(uploaded)} ช่วง",
            )

    while proc.poll() is None:
        upload_ready(False)
        time.sleep(2)
    rc = proc.wait()
    if rc != 0:
        fail(client, job_id, f"แบ่งวิดีโอกับไฟล์เสียงไม่สำเร็จ (ffmpeg {rc})")
    upload_ready(True)

    if not uploaded:
        fail(client, job_id, "ไม่สามารถสร้างช่วงวิดีโอจากไฟล์ภาพและเสียงที่เลือกได้")

    total = len(uploaded)
    manifest = {
        "jobId": job_id,
        "duration": duration,
        "chunkSeconds": chunk_seconds,
        "total": total,
        "chunks": uploaded,
        "sourceLang": job.get("sourceLang", "auto"),
        "targetLang": job.get("targetLang", "th"),
        "voiceMode": job.get("voiceMode", "auto"),
        "subtitles": bool(job.get("subtitles", True)),
        "keepMusic": bool(job.get("keepMusic", True)),
        "speakerSeparation": bool(job.get("speakerSeparation", False)),
        "mediaPairMode": DIRECT_PAIR_MODE,
        "storageEfficient": True,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    client.upload(manifest_path, manifest_key, "application/json")
    client.patch_job(
        job_id,
        status="processing",
        progress=10,
        stage=f"แบ่งวิดีโอและเสียงเสร็จ {total} ช่วง เริ่มพากย์",
        duration=duration,
        chunkTotal=total,
    )
    print(f"STORAGE_EFFICIENT_DIRECT_PAIR_PASS chunks={total} no_full_pair_copy=true", flush=True)
    base.emit_outputs(manifest, github_output)
    return True


def main() -> None:
    enrich_uploaded_job_with_youtube_timing()
    if prepare_separate_audio_direct():
        return
    base.main()


if __name__ == "__main__":
    main()
