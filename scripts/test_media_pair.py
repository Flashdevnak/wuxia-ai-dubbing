from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from media_pair import has_stream, mux_separate_audio, pair_ffmpeg_command


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def main() -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg and ffprobe are required for media-pair acceptance")

    with tempfile.TemporaryDirectory(prefix="wuxia-media-pair-") as raw:
        root = Path(raw)
        video = root / "video-only.mp4"
        audio = root / "audio-only.wav"
        paired = root / "paired.mkv"

        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=1.2",
            "-an", "-c:v", "mpeg4", video.as_posix(),
        ])
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1.2",
            "-vn", "-c:a", "pcm_s16le", audio.as_posix(),
        ])

        assert has_stream(video.as_posix(), "v:0") is True
        assert has_stream(video.as_posix(), "a:0") is False
        assert has_stream(audio.as_posix(), "a:0") is True

        command = pair_ffmpeg_command(video.as_posix(), audio.as_posix(), paired)
        assert command.count("-i") == 2
        assert "0:v:0" in command
        assert "1:a:0" in command
        assert "-shortest" in command

        mux_separate_audio(video.as_posix(), audio.as_posix(), paired)
        assert paired.exists() and paired.stat().st_size > 0
        assert has_stream(paired.as_posix(), "v:0") is True
        assert has_stream(paired.as_posix(), "a:0") is True

    print("MEDIA_PAIR_ACCEPTANCE_PASS")


if __name__ == "__main__":
    main()
