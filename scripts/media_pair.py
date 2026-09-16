from __future__ import annotations

import shlex
import subprocess
from pathlib import Path
from urllib.parse import quote


class MediaPairError(RuntimeError):
    pass


def run_capture(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        tail = "\n".join(stderr.splitlines()[-12:])
        raise MediaPairError(
            f"Command failed ({proc.returncode}): {' '.join(shlex.quote(x) for x in cmd[:10])}\n{tail}"
        )
    return (proc.stdout or "").strip()


def internal_file_url(worker_url: str, key: str) -> str:
    return f"{worker_url.rstrip('/')}/api/internal/file?key={quote(str(key), safe='')}"


def worker_headers(token: str) -> str:
    return f"x-worker-token: {token}\r\n"


def has_stream(input_url: str, selector: str, headers: str | None = None) -> bool:
    cmd = ["ffprobe", "-v", "error"]
    if headers:
        cmd += ["-headers", headers]
    cmd += [
        "-select_streams", selector,
        "-show_entries", "stream=index",
        "-of", "csv=p=0",
        input_url,
    ]
    try:
        return bool(run_capture(cmd).strip())
    except Exception:
        return False


def pair_ffmpeg_command(
    video_input: str,
    audio_input: str,
    output_path: str | Path,
    headers: str | None = None,
) -> list[str]:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y"]
    if headers:
        cmd += ["-headers", headers]
    cmd += ["-i", video_input]
    if headers:
        cmd += ["-headers", headers]
    cmd += [
        "-i", audio_input,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-sn", "-dn",
        "-c:v", "copy",
        "-c:a", "copy",
        "-shortest",
        str(output_path),
    ]
    return cmd


def mux_separate_audio(
    video_input: str,
    audio_input: str,
    output_path: str | Path,
    headers: str | None = None,
) -> Path:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    run_capture(pair_ffmpeg_command(video_input, audio_input, output, headers))
    if not output.exists() or output.stat().st_size <= 0:
        raise MediaPairError("ffmpeg did not produce paired media")
    if not has_stream(str(output), "v:0"):
        raise MediaPairError("paired media has no video stream")
    if not has_stream(str(output), "a:0"):
        raise MediaPairError("paired media has no audio stream")
    return output
