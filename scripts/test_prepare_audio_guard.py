from __future__ import annotations

import inspect
import subprocess
import tempfile
from pathlib import Path

import prepare_job


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> None:
    source = inspect.getsource(prepare_job)
    assert "ไฟล์วิดีโอนี้ไม่มีเสียง (video-only)" in source
    assert "sourceStreamsVerified" in source
    assert 'has_media_stream(first_url, "a:0", reuse_headers)' in source

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        video_only = root / "video_only.mkv"
        video_audio = root / "video_audio.mkv"

        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=160x90:r=24",
            "-t", "1", "-an", "-c:v", "ffv1", str(video_only),
        ])
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=160x90:r=24",
            "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
            "-t", "1", "-shortest", "-c:v", "ffv1", "-c:a", "pcm_s16le", str(video_audio),
        ])

        assert prepare_job.has_media_stream(str(video_only), "v:0")
        assert not prepare_job.has_media_stream(str(video_only), "a:0")
        assert prepare_job.has_media_stream(str(video_audio), "v:0")
        assert prepare_job.has_media_stream(str(video_audio), "a:0")

    print("PREPARE_AUDIO_GUARD_ACCEPTANCE_PASS")


if __name__ == "__main__":
    main()
