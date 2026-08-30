from __future__ import annotations

import argparse
import base64
import json
import os
import shlex
import subprocess
import time
from pathlib import Path
from urllib.parse import quote

from worker_client import WorkerClient


class CommandError(RuntimeError):
    pass


def run_capture(cmd: list[str]) -> str:
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        stderr = (p.stderr or "").strip()
        tail = "\n".join(stderr.splitlines()[-12:])
        raise CommandError(
            f"Command failed ({p.returncode}): {' '.join(shlex.quote(x) for x in cmd[:8])}\n{tail}"
        )
    return p.stdout.strip()


def build_cookie_file() -> Path | None:
    """Decode an optional Netscape cookies.txt supplied through a GitHub secret.

    The secret is base64-encoded so multiline cookie files survive GitHub Actions
    environment handling without being printed to logs.
    """
    raw = (os.environ.get("YOUTUBE_COOKIES_B64") or "").strip()
    if not raw:
        return None
    try:
        data = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise RuntimeError("YOUTUBE_COOKIES_B64 ไม่ใช่ Base64 ที่ถูกต้อง") from exc
    if not data.strip():
        raise RuntimeError("YOUTUBE_COOKIES_B64 ว่างเปล่า")
    path = Path("work_prepare") / "youtube-cookies.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def yt_direct_url(url: str, cookies_file: Path | None = None) -> str:
    # YouTube often blocks datacenter IPs used by GitHub-hosted runners. Try a few
    # progressive-format clients. If the owner supplied a cookies.txt secret, use
    # it for all attempts without ever printing its contents.
    cookie_args = ["--cookies", str(cookies_file)] if cookies_file else []
    attempts = [
        [
            "yt-dlp", "--no-playlist", "--no-warnings", *cookie_args, "-g",
            "-f", "best[height<=1080][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best",
            url,
        ],
        [
            "yt-dlp", "--no-playlist", "--no-warnings", *cookie_args,
            "--extractor-args", "youtube:player_client=android_vr,web_safari",
            "-g", "-f",
            "best[height<=720][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best",
            url,
        ],
        [
            "yt-dlp", "--no-playlist", "--no-warnings", *cookie_args,
            "--extractor-args", "youtube:player_client=tv,web",
            "-g", "-f",
            "best[height<=720][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best",
            url,
        ],
    ]
    errors: list[str] = []
    bot_blocked = False
    for idx, cmd in enumerate(attempts, start=1):
        try:
            out = run_capture(cmd)
            urls = [line.strip() for line in out.splitlines() if line.strip()]
            if urls:
                print(f"yt-dlp source strategy {idx} succeeded")
                return urls[0]
            errors.append(f"strategy {idx}: yt-dlp returned no playable URL")
        except Exception as exc:
            msg = str(exc)
            if "Sign in to confirm you’re not a bot" in msg or "Sign in to confirm you're not a bot" in msg:
                bot_blocked = True
            errors.append(f"strategy {idx}: {msg}")
            print(f"yt-dlp strategy {idx} failed: {msg}", flush=True)

    if bot_blocked and not cookies_file:
        raise RuntimeError(
            "YouTube บล็อก IP ของ GitHub Actions และขอให้ยืนยันการเข้าสู่ระบบ "
            "จึงดึงวิดีโอจากลิงก์โดยตรงไม่ได้ในตอนนี้ กรุณาใช้โหมดอัปโหลดไฟล์ "
            "หรือเพิ่ม GitHub Secret ชื่อ YOUTUBE_COOKIES_B64 สำหรับบัญชีที่มีสิทธิ์ดูวิดีโอนี้"
        )
    if bot_blocked and cookies_file:
        raise RuntimeError(
            "YouTube ยังปฏิเสธการเข้าถึงแม้ใช้ cookies แล้ว อาจเป็นเพราะ cookies หมดอายุ "
            "หรือ YouTube ไม่ยอมรับ IP ของ GitHub Actions กรุณาสร้าง cookies ใหม่หรือใช้โหมดอัปโหลดไฟล์"
        )
    tail = " | ".join(errors[-2:])
    if len(tail) > 700:
        tail = tail[-700:]
    raise RuntimeError("เปิดแหล่งวิดีโอ YouTube ไม่สำเร็จ: " + tail)


def probe_duration(input_url: str, headers: str | None = None) -> float:
    cmd = ["ffprobe", "-v", "error"]
    if headers:
        cmd += ["-headers", headers]
    cmd += ["-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input_url]
    try:
        return float(run_capture(cmd) or 0)
    except Exception:
        return 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, help="Job JSON file")
    ap.add_argument("--worker-url", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--chunk-seconds", type=int, default=1200)
    ap.add_argument("--github-output")
    args = ap.parse_args()

    job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    job_id = job["id"]
    client = WorkerClient(args.worker_url, args.token)
    client.patch_job(job_id, status="processing", progress=3, stage="กำลังเตรียมวิดีโอและแบ่งช่วง")

    headers = None
    if job.get("sourceType") == "upload":
        key = job.get("sourceKey")
        if not key:
            raise RuntimeError("Uploaded job has no sourceKey")
        input_url = f"{args.worker_url.rstrip('/')}/api/internal/file?key={quote(key, safe='')}"
        headers = f"x-worker-token: {args.token}\r\n"
    else:
        source_url = str(job.get("sourceUrl") or "").strip()
        if not source_url:
            raise RuntimeError("Link job has no sourceUrl")
        try:
            cookies_file = build_cookie_file()
            input_url = yt_direct_url(source_url, cookies_file)
        except Exception as exc:
            # Surface a concise, actionable reason in the web UI instead of a raw
            # yt-dlp traceback that can fill the whole mobile job card.
            message = str(exc)
            if len(message) > 900:
                message = message[-900:]
            client.fail(job_id, "เปิดลิงก์ YouTube ไม่สำเร็จ: " + message)
            raise

    duration = probe_duration(input_url, headers)
    work = Path("work_prepare")
    chunks_dir = work / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(chunks_dir / "chunk_%05d.mkv")

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y"]
    if headers:
        cmd += ["-headers", headers]
    cmd += [
        "-i", input_url,
        "-map", "0:v:0?", "-map", "0:a:0?",
        "-sn", "-dn", "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-f", "segment", "-segment_time", str(max(300, args.chunk_seconds)),
        "-reset_timestamps", "1", "-segment_format", "matroska",
        pattern,
    ]

    print("Starting segmenter:", " ".join(shlex.quote(x) for x in cmd[:12]), "...")
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
            # Once the next segment exists, ffmpeg has closed the current one.
            size = current.stat().st_size
            if size <= 0:
                return
            key = f"temp/{job_id}/source/chunk_{next_index:05d}.mkv"
            print(f"Uploading source chunk {next_index}: {size} bytes")
            client.upload(current, key, "video/x-matroska")
            uploaded.append({"index": next_index, "key": key, "size": size})
            current.unlink(missing_ok=True)
            next_index += 1
            approx = 5 + min(5, len(uploaded) // 2)
            client.patch_job(job_id, progress=approx, stage=f"แบ่งวิดีโอแล้ว {len(uploaded)} ช่วง")

    while proc.poll() is None:
        upload_ready(False)
        time.sleep(2)
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"ffmpeg segmenter exited with code {rc}")
    upload_ready(True)

    if not uploaded:
        raise RuntimeError("No video chunks were produced")

    total = len(uploaded)
    manifest = {
        "jobId": job_id,
        "duration": duration,
        "chunkSeconds": max(300, args.chunk_seconds),
        "total": total,
        "chunks": uploaded,
        "sourceLang": job.get("sourceLang", "auto"),
        "targetLang": job.get("targetLang", "th"),
        "voiceMode": job.get("voiceMode", "auto"),
        "subtitles": bool(job.get("subtitles", True)),
        "keepMusic": bool(job.get("keepMusic", True)),
        "speakerSeparation": bool(job.get("speakerSeparation", False)),
    }
    manifest_path = work / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest_key = f"temp/{job_id}/manifest.json"
    client.upload(manifest_path, manifest_key, "application/json")
    client.patch_job(
        job_id,
        status="processing",
        progress=10,
        stage=f"แบ่งวิดีโอเสร็จ {total} ช่วง · เริ่มพากย์",
        duration=duration,
        chunkTotal=total,
    )

    matrix = {"include": [{"index": c["index"], "key": c["key"], "total": total} for c in uploaded]}
    output = json.dumps(matrix, separators=(",", ":"))
    print("MATRIX_JSON=" + output)
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as f:
            f.write("matrix=" + output + "\n")
            f.write("total=" + str(total) + "\n")
            f.write("duration=" + str(duration) + "\n")


if __name__ == "__main__":
    main()
