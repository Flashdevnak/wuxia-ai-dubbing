from __future__ import annotations

import argparse
import json
import subprocess
import threading
from datetime import timedelta
from pathlib import Path

import srt

from worker_client import WorkerClient


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
    client.patch_job(job_id, status="processing", progress=94, stage="กำลังรวมวิดีโอพากย์ทั้งหมด")

    work = Path("work_finalize")
    work.mkdir(parents=True, exist_ok=True)

    # Combine subtitle timecodes using each chunk's real duration, avoiding drift
    # when the segment boundary lands on a nearby video keyframe.
    all_subs: list[srt.Subtitle] = []
    offset = 0.0
    for i in range(args.total):
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
        offset += chunk_duration

    subtitle_key = None
    if bool(job.get("subtitles", True)):
        final_srt = work / f"dub_{target}.srt"
        final_srt.write_text(srt.compose(all_subs), encoding="utf-8")
        subtitle_key = f"outputs/{job_id}/dub_{target}.srt"
        client.upload(final_srt, subtitle_key, "application/x-subrip")

    # The processed chunks are uniform MPEG-TS/H.264/AAC. Feeding their bytes
    # sequentially to one ffmpeg process makes them a continuous stream. ffmpeg
    # writes fragmented MP4 to stdout; stdout is multipart-uploaded directly to
    # R2, so a 10+ GB final video never has to fit on the GitHub runner disk.
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "mpegts", "-i", "pipe:0",
        "-map", "0:v:0", "-map", "0:a:0",
        "-c", "copy",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
    feed_error: list[Exception] = []

    def feed_chunks() -> None:
        try:
            for i in range(args.total):
                key = f"temp/{job_id}/dub/chunk_{i:05d}.ts"
                print(f"Streaming final chunk {i + 1}/{args.total}: {key}")
                for data in client.iter_object(key, chunk_size=8 * 1024 * 1024):
                    proc.stdin.write(data)
            proc.stdin.close()
        except Exception as exc:
            feed_error.append(exc)
            try:
                proc.stdin.close()
            except Exception:
                pass

    feeder = threading.Thread(target=feed_chunks, name="r2-ts-feeder", daemon=True)
    feeder.start()
    output_key = f"outputs/{job_id}/dub_{target}.mp4"
    upload_result = client.upload_stream(proc.stdout, output_key, "video/mp4")
    feeder.join()
    stderr = proc.stderr.read().decode("utf-8", errors="replace")
    rc = proc.wait()
    if feed_error:
        raise feed_error[0]
    if rc != 0:
        raise RuntimeError(f"Final ffmpeg failed ({rc}): {stderr[-3000:]}")

    size_bytes = int(upload_result.get("size") or 0)
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
