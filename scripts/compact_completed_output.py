from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from worker_client import WorkerClient


VIDEO_PRESET = "veryfast"
VIDEO_CRF = "22"
VIDEO_MAXRATE = "2800k"
VIDEO_BUFSIZE = "5600k"
AUDIO_BITRATE = "160k"
AUDIO_RATE = "48000"
COMPACTION_CONTRACT = "completed-output-reencode-v1"


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-5000:]
        raise RuntimeError(f"command failed ({proc.returncode}): {tail}")


def probe_streams(path: Path) -> dict:
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "stream=codec_type,codec_name,width,height:format=duration,size",
            "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "ffprobe failed")[-3000:])
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    if not any(x.get("codec_type") == "video" for x in streams):
        raise RuntimeError("ไฟล์ผลลัพธ์ไม่มี video stream")
    if not any(x.get("codec_type") == "audio" for x in streams):
        raise RuntimeError("ไฟล์ผลลัพธ์ไม่มี audio stream")
    return data


def encode(source: Path, destination: Path) -> None:
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "libx264",
        "-preset", VIDEO_PRESET,
        "-crf", VIDEO_CRF,
        "-maxrate", VIDEO_MAXRATE,
        "-bufsize", VIDEO_BUFSIZE,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", AUDIO_RATE,
        "-movflags", "+faststart",
        str(destination),
    ])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--worker-url", required=True)
    ap.add_argument("--token", required=True)
    args = ap.parse_args()

    client = WorkerClient(args.worker_url, args.token)
    job = client.get_job(args.job_id)
    if str(job.get("status") or "") != "completed":
        raise RuntimeError(f"job {args.job_id} is not completed")

    output_key = str(job.get("outputKey") or "")
    if not output_key:
        raise RuntimeError("completed job has no outputKey")

    info = client.object_info(output_key)
    old_size = int(info.get("size") or 0)
    if old_size <= 0:
        raise RuntimeError("current output is missing or empty")

    work = Path("work_compact_output")
    work.mkdir(parents=True, exist_ok=True)
    original = work / "original.mp4"
    compact = work / "compact.mp4"

    print(json.dumps({
        "event": "compact-start",
        "jobId": args.job_id,
        "outputKey": output_key,
        "oldSize": old_size,
        "contract": COMPACTION_CONTRACT,
    }), flush=True)

    client.download(output_key, original)
    if original.stat().st_size != old_size:
        raise RuntimeError(f"download size mismatch: {original.stat().st_size}/{old_size}")
    probe_streams(original)

    encode(original, compact)
    probe_streams(compact)
    new_size = compact.stat().st_size
    if new_size <= 0:
        raise RuntimeError("compacted output is empty")
    if new_size >= old_size:
        raise RuntimeError(f"compaction did not reduce size: {new_size} >= {old_size}")

    try:
        uploaded = client.upload(compact, output_key, "video/mp4")
        uploaded_size = int(uploaded.get("size") or 0)
        if uploaded_size != new_size:
            raise RuntimeError(f"uploaded compact size mismatch: {uploaded_size}/{new_size}")
        confirmed = client.object_info(output_key)
        if int(confirmed.get("size") or 0) != new_size:
            raise RuntimeError("R2 compact output verification failed")
    except Exception as exc:
        print(f"Compact upload failed; restoring original output: {exc}", flush=True)
        rollback = client.upload(original, output_key, "video/mp4")
        rollback_size = int(rollback.get("size") or 0)
        if rollback_size != old_size:
            raise RuntimeError(
                f"compact upload failed and rollback size mismatched: {rollback_size}/{old_size}"
            ) from exc
        raise

    client.patch_job(
        args.job_id,
        status="completed",
        stage="เสร็จสมบูรณ์",
        progress=100,
        sizeBytes=new_size,
        outputKey=output_key,
    )

    print(json.dumps({
        "event": "compact-complete",
        "jobId": args.job_id,
        "outputKey": output_key,
        "oldSize": old_size,
        "newSize": new_size,
        "savedBytes": old_size - new_size,
        "savedPercent": round((old_size - new_size) * 100 / old_size, 2),
        "contract": COMPACTION_CONTRACT,
        "videoCrf": int(VIDEO_CRF),
        "videoMaxrate": VIDEO_MAXRATE,
        "audioBitrate": AUDIO_BITRATE,
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
