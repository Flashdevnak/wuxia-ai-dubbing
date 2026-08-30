from __future__ import annotations

import argparse
import json
import subprocess
import threading
from datetime import timedelta
from pathlib import Path

import srt

from worker_client import WorkerClient


def run_ffmpeg_to_drive(client: WorkerClient, cmd: list[str], output_key: str) -> dict:
    """Run ffmpeg, stream MP4 stdout to Drive, and always surface ffmpeg stderr."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    assert proc.stdout is not None and proc.stderr is not None

    stderr_parts: list[bytes] = []

    def drain_stderr() -> None:
        while True:
            block = proc.stderr.read(64 * 1024)
            if not block:
                break
            stderr_parts.append(block)

    stderr_thread = threading.Thread(target=drain_stderr, name="ffmpeg-stderr", daemon=True)
    stderr_thread.start()

    upload_error: Exception | None = None
    upload_result: dict = {}
    try:
        upload_result = client.upload_stream(proc.stdout, output_key, "video/mp4")
    except Exception as exc:
        upload_error = exc
        try:
            proc.kill()
        except Exception:
            pass
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass

    rc = proc.wait()
    stderr_thread.join(timeout=10)
    stderr = b"".join(stderr_parts).decode("utf-8", errors="replace")
    tail = stderr[-5000:].strip()

    if upload_error is not None:
        detail = f"; ffmpeg: {tail}" if tail else ""
        raise RuntimeError(f"อัปโหลดวิดีโอผลลัพธ์ไม่สำเร็จ: {upload_error}{detail}")
    if rc != 0:
        raise RuntimeError(f"รวมวิดีโอไม่สำเร็จ (ffmpeg {rc}): {tail or 'ไม่พบรายละเอียดจาก ffmpeg'}")
    if int(upload_result.get("size") or 0) <= 0:
        raise RuntimeError("ไฟล์วิดีโอผลลัพธ์มีขนาด 0 ไบต์")
    return upload_result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--worker-url", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--total", type=int, required=True)
    args = ap.parse_args()

    job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    job_id = job["id"]
    target = str(job.get("targetLang") or "th")
    client = WorkerClient(args.worker_url, args.token)

    if client.is_paused(job_id):
        print("Job is paused before finalization", flush=True)
        return

    client.patch_job(job_id, status="processing", progress=94, stage="กำลังเตรียมไฟล์วิดีโอสุดท้าย")

    work = Path("work_finalize")
    work.mkdir(parents=True, exist_ok=True)

    # Read metadata/subtitles and keep the dubbed TS chunks as normal files for
    # ffmpeg's concat demuxer. This is more reliable than feeding separately
    # timestamped MPEG-TS chunks into one stdin pipe.
    all_subs: list[srt.Subtitle] = []
    offset = 0.0
    chunk_files: list[Path] = []

    for i in range(args.total):
        if client.is_paused(job_id):
            print(f"Job paused before downloading final chunk {i + 1}", flush=True)
            return

        meta_file = work / f"meta_{i:05d}.json"
        client.download(f"temp/{job_id}/meta/chunk_{i:05d}.json", meta_file)
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        chunk_duration = float(meta.get("duration") or 0)

        if bool(job.get("subtitles", True)):
            sub_file = work / f"sub_{i:05d}.srt"
            client.download(f"temp/{job_id}/subs/chunk_{i:05d}.srt", sub_file)
            text = sub_file.read_text(encoding="utf-8", errors="replace")
            for item in srt.parse(text):
                item.start += timedelta(seconds=offset)
                item.end += timedelta(seconds=offset)
                item.index = len(all_subs) + 1
                all_subs.append(item)

        chunk_file = work / f"chunk_{i:05d}.ts"
        client.download(f"temp/{job_id}/dub/chunk_{i:05d}.ts", chunk_file)
        if not chunk_file.exists() or chunk_file.stat().st_size <= 0:
            raise RuntimeError(f"ช่วงวิดีโอ {i + 1}/{args.total} ว่างเปล่าหรือดาวน์โหลดไม่ครบ")
        chunk_files.append(chunk_file)
        offset += chunk_duration

        progress = min(96, 94 + round(((i + 1) / max(1, args.total)) * 2))
        client.patch_job(
            job_id,
            status="processing",
            progress=progress,
            stage=f"เตรียมวิดีโอแล้ว {i + 1}/{args.total} ช่วง",
        )

    subtitle_key = None
    if bool(job.get("subtitles", True)):
        final_srt = work / f"dub_{target}.srt"
        final_srt.write_text(srt.compose(all_subs), encoding="utf-8")
        subtitle_key = f"outputs/{job_id}/dub_{target}.srt"
        client.upload(final_srt, subtitle_key, "application/x-subrip")

    if client.is_paused(job_id):
        print("Job paused before final video assembly", flush=True)
        return

    concat_file = work / "concat.txt"
    concat_file.write_text(
        "".join(f"file '{path.name}'\n" for path in chunk_files),
        encoding="utf-8",
    )

    output_key = f"outputs/{job_id}/dub_{target}.mp4"
    client.patch_job(job_id, status="processing", progress=97, stage="กำลังรวมภาพและเสียง")

    # First try stream-copy: fastest and keeps the already encoded chunks intact.
    copy_cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-fflags", "+genpts",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-map", "0:v:0", "-map", "0:a:0",
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]

    try:
        upload_result = run_ffmpeg_to_drive(client, copy_cmd, output_key)
        print("Final concat stream-copy succeeded", flush=True)
    except Exception as copy_error:
        # Some MPEG-TS timestamp layouts cannot be stream-copied safely into MP4.
        # Retry once with a fast normalization encode instead of failing at 94%.
        print(f"Fast final merge failed, retrying with normalization: {copy_error}", flush=True)
        client.patch_job(job_id, status="processing", progress=98, stage="กำลังแก้เวลาไฟล์และรวมใหม่")
        encode_cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-fflags", "+genpts",
            "-f", "concat", "-safe", "0", "-i", str(concat_file),
            "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
            "-avoid_negative_ts", "make_zero",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4", "pipe:1",
        ]
        try:
            upload_result = run_ffmpeg_to_drive(client, encode_cmd, output_key)
        except Exception as encode_error:
            raise RuntimeError(
                "รวมวิดีโอขั้นสุดท้ายไม่สำเร็จทั้งแบบเร็วและแบบแก้เวลา: "
                f"{encode_error}; ครั้งแรก: {copy_error}"
            ) from encode_error

    size_bytes = int(upload_result.get("size") or 0)
    client.patch_job(job_id, status="processing", progress=99, stage="กำลังบันทึกผลลัพธ์")
    client.finish(job_id, output_key, subtitle_key, offset, size_bytes)
    print(json.dumps({
        "jobId": job_id,
        "outputKey": output_key,
        "subtitleKey": subtitle_key,
        "duration": offset,
        "sizeBytes": size_bytes,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
