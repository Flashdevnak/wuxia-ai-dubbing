from __future__ import annotations

import argparse
import json
import subprocess
import threading
import xml.etree.ElementTree as ET
from datetime import timedelta
from pathlib import Path

import srt

from worker_client import WorkerClient


# Final output policy: keep a browser/device friendly H.264 MP4, but never
# stream-copy the much higher temporary chunk bitrate into the final file.
# At the configured VBV ceiling, a 3-hour job stays around 4 GB instead of
# growing to 6+ GB while retaining 1080p source resolution and frame rate.
FINAL_VIDEO_CODEC = "libx264"
FINAL_VIDEO_PRESET = "veryfast"
FINAL_VIDEO_CRF = "22"
FINAL_VIDEO_MAXRATE = "2800k"
FINAL_VIDEO_BUFSIZE = "5600k"
FINAL_AUDIO_BITRATE = "160k"
FINAL_AUDIO_RATE = "48000"
FINAL_COMPRESSION_CONTRACT = "final-h264-capped-v1"


def run_ffmpeg_to_drive(client: WorkerClient, cmd: list[str], output_key: str) -> dict:
    """Run ffmpeg, stream MP4 stdout to R2, and always surface ffmpeg stderr."""
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


def final_encode_command(concat_file: Path, preset: str, crf: str) -> list[str]:
    """Build the bounded H.264 final encode used for every successful dub."""
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-fflags", "+genpts",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", FINAL_VIDEO_CODEC,
        "-preset", preset,
        "-crf", crf,
        "-maxrate", FINAL_VIDEO_MAXRATE,
        "-bufsize", FINAL_VIDEO_BUFSIZE,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", FINAL_AUDIO_BITRATE, "-ar", FINAL_AUDIO_RATE,
        "-avoid_negative_ts", "make_zero",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]


def subtitles_to_transcript_xml(items: list[srt.Subtitle]) -> str:
    """Export the final translated timing as YouTube-style transcript XML."""
    root = ET.Element("transcript")
    for item in items:
        start = max(0.0, item.start.total_seconds())
        dur = max(0.05, (item.end - item.start).total_seconds())
        node = ET.SubElement(root, "text", {
            "start": f"{start:.3f}".rstrip("0").rstrip("."),
            "dur": f"{dur:.3f}".rstrip("0").rstrip("."),
        })
        node.text = str(item.content or "").strip()
    return ET.tostring(root, encoding="unicode")


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
    transcript_xml_key = None
    if bool(job.get("subtitles", True)):
        final_srt = work / f"dub_{target}.srt"
        final_srt.write_text(srt.compose(all_subs), encoding="utf-8")
        subtitle_key = f"outputs/{job_id}/dub_{target}.srt"
        client.upload(final_srt, subtitle_key, "application/x-subrip")

        # This is the translated transcript actually used by the dub, in the
        # same <text start="..." dur="..."> format commonly exported from
        # YouTube caption tools.
        final_xml = work / f"dub_{target}.xml"
        final_xml.write_text(subtitles_to_transcript_xml(all_subs), encoding="utf-8")
        transcript_xml_key = f"outputs/{job_id}/dub_{target}.xml"
        client.upload(final_xml, transcript_xml_key, "application/xml")
        client.patch_job(
            job_id,
            transcriptXmlKey=transcript_xml_key,
            transcriptLanguage=target,
            transcriptSource="youtube" if job.get("sourceType") == "link" else "generated",
        )

    if client.is_paused(job_id):
        print("Job paused before final video assembly", flush=True)
        return

    concat_file = work / "concat.txt"
    concat_file.write_text(
        "".join(f"file '{path.name}'\n" for path in chunk_files),
        encoding="utf-8",
    )

    output_key = f"outputs/{job_id}/dub_{target}.mp4"
    client.patch_job(job_id, status="processing", progress=97, stage="กำลังบีบอัดและรวมวิดีโอสุดท้าย")

    # Always normalize the final MP4 instead of stream-copying chunk bitrates.
    # The old stream-copy path produced 6+ GB outputs for ~3-hour 1080p jobs.
    # CRF keeps normal scenes clean while maxrate/bufsize bound pathological
    # chunk bitrates so the 8 GB app workspace remains usable.
    primary_cmd = final_encode_command(concat_file, FINAL_VIDEO_PRESET, FINAL_VIDEO_CRF)
    try:
        upload_result = run_ffmpeg_to_drive(client, primary_cmd, output_key)
        print(
            f"Final compression succeeded: {FINAL_COMPRESSION_CONTRACT} "
            f"preset={FINAL_VIDEO_PRESET} crf={FINAL_VIDEO_CRF} maxrate={FINAL_VIDEO_MAXRATE}",
            flush=True,
        )
    except Exception as primary_error:
        # Retry once with a faster encoder setting, while preserving the same
        # bitrate ceiling. Never fall back to stream-copy because that recreates
        # the oversized-output problem this contract is designed to prevent.
        print(f"Primary final compression failed; retrying fast-safe encode: {primary_error}", flush=True)
        client.patch_job(job_id, status="processing", progress=98, stage="กำลังรวมวิดีโอด้วยโหมดสำรอง")
        fallback_cmd = final_encode_command(concat_file, "ultrafast", "23")
        try:
            upload_result = run_ffmpeg_to_drive(client, fallback_cmd, output_key)
        except Exception as fallback_error:
            raise RuntimeError(
                "รวมวิดีโอขั้นสุดท้ายไม่สำเร็จทั้งโหมดหลักและโหมดสำรอง: "
                f"{fallback_error}; ครั้งแรก: {primary_error}"
            ) from fallback_error

    size_bytes = int(upload_result.get("size") or 0)
    # The configured video+audio ceiling is about 2.96 Mbps. Allow generous
    # muxing/VBV overhead but surface a warning if a long output escapes it.
    if offset >= 600:
        expected_ceiling = int(offset * 3_200_000 / 8)
        if size_bytes > expected_ceiling:
            print(
                f"Final size warning: {size_bytes} bytes exceeds bounded expectation {expected_ceiling}",
                flush=True,
            )

    client.patch_job(job_id, status="processing", progress=99, stage="กำลังบันทึกผลลัพธ์")
    client.finish(job_id, output_key, subtitle_key, offset, size_bytes)

    if bool(job.get("autoCleanup", True)):
        # Source uploads are released safely by worker-stability once every dub
        # chunk is durable / the job completes. Here we remove per-job temporary
        # and checkpoint objects after the final output has been verified.
        for cleanup_kind in ("temp", "state"):
            for _ in range(200):
                try:
                    cleanup = client.cleanup_job(job_id, cleanup_kind)
                except Exception as cleanup_error:
                    print(f"Cleanup warning ({cleanup_kind}): {cleanup_error}", flush=True)
                    break
                if int(cleanup.get("remaining") or 0) <= 0:
                    break

    print(json.dumps({
        "jobId": job_id,
        "outputKey": output_key,
        "subtitleKey": subtitle_key,
        "transcriptXmlKey": transcript_xml_key,
        "duration": offset,
        "sizeBytes": size_bytes,
        "finalCompressionContract": FINAL_COMPRESSION_CONTRACT,
        "videoCrf": int(FINAL_VIDEO_CRF),
        "videoMaxrate": FINAL_VIDEO_MAXRATE,
        "audioBitrate": FINAL_AUDIO_BITRATE,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
