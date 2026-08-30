from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import subprocess
import time
from datetime import timedelta
from pathlib import Path

import edge_tts
import srt
from deep_translator import GoogleTranslator
from faster_whisper import WhisperModel
from pydub import AudioSegment

from worker_client import WorkerClient


LOCALES = {
    "th": "th-TH", "zh": "zh-CN", "en": "en-US", "ja": "ja-JP", "ko": "ko-KR",
    "vi": "vi-VN", "id": "id-ID", "ms": "ms-MY", "es": "es-ES", "fr": "fr-FR",
    "de": "de-DE", "pt": "pt-BR", "ru": "ru-RU", "ar": "ar-SA", "hi": "hi-IN",
    "it": "it-IT", "tr": "tr-TR", "nl": "nl-NL", "pl": "pl-PL",
}

GOOGLE_CODES = {"zh": "zh-CN"}


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def capture(cmd: list[str]) -> str:
    p = subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return p.stdout.strip()


def duration(path: Path) -> float:
    try:
        return float(capture([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ]) or 0)
    except Exception:
        return 0.0


def has_audio(path: Path) -> bool:
    try:
        out = capture([
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=index", "-of", "csv=p=0", str(path),
        ])
        return bool(out.strip())
    except Exception:
        return False


def atempo_chain(ratio: float) -> str:
    ratio = max(1.0, ratio)
    values: list[float] = []
    while ratio > 2.0:
        values.append(2.0)
        ratio /= 2.0
    values.append(ratio)
    return ",".join(f"atempo={v:.5f}" for v in values)


async def list_matching_voices(lang: str, mode: str) -> list[str]:
    locale = LOCALES.get(lang, lang)
    voices = await edge_tts.list_voices()
    candidates = [v for v in voices if str(v.get("Locale", "")).lower() == locale.lower()]
    if not candidates:
        candidates = [v for v in voices if str(v.get("Locale", "")).lower().startswith(lang.lower() + "-")]
    wanted = {"male": "Male", "female": "Female", "narrator": "Male"}.get(mode)
    if wanted:
        preferred = [v for v in candidates if v.get("Gender") == wanted]
        if preferred:
            candidates = preferred
    names = [str(v["ShortName"]) for v in candidates if v.get("ShortName")]
    if not names:
        raise RuntimeError(f"No Edge TTS voice found for {lang} / {locale}")
    # Keep a few voices for the optional multi-character heuristic.
    return names[:4]


async def synthesize(text: str, voice: str, destination: Path) -> None:
    last: Exception | None = None
    for attempt in range(1, 4):
        try:
            communicate = edge_tts.Communicate(text=text, voice=voice, rate="+0%", volume="+0%")
            await communicate.save(str(destination))
            if destination.exists() and destination.stat().st_size > 0:
                return
        except Exception as exc:
            last = exc
            await asyncio.sleep(attempt * 1.5)
    raise RuntimeError(f"TTS failed after retries: {last}")


def translate_texts(client: WorkerClient, texts: list[str], source_lang: str, target_lang: str) -> list[str]:
    if not texts or source_lang == target_lang:
        return texts

    translated: list[str] = []
    # First prefer the Cloudflare Workers AI endpoint. It keeps translation behind
    # our own Worker and avoids putting any third-party API key in Actions.
    try:
        for i in range(0, len(texts), 12):
            batch = texts[i:i + 12]
            got = client.translate(batch, source_lang, target_lang)
            if len(got) != len(batch):
                raise RuntimeError("Workers AI returned an unexpected translation count")
            translated.extend(got)
        return translated
    except Exception as exc:
        print("Workers AI translation unavailable, falling back to GoogleTranslator:", exc)

    source = "auto" if source_lang == "auto" else GOOGLE_CODES.get(source_lang, source_lang)
    target = GOOGLE_CODES.get(target_lang, target_lang)
    translator = GoogleTranslator(source=source, target=target)
    for idx, text in enumerate(texts, 1):
        if not text.strip():
            translated.append("")
            continue
        last: Exception | None = None
        for attempt in range(1, 4):
            try:
                translated.append(translator.translate(text) or text)
                last = None
                break
            except Exception as exc:
                last = exc
                time.sleep(attempt * 1.3)
        if last is not None:
            print(f"Translation failed for segment {idx}; using source text: {last}")
            translated.append(text)
    return translated


def choose_voice(voices: list[str], segment_index: int, gap: float, speaker_mode: bool, state: dict) -> str:
    if len(voices) == 1 or not speaker_mode:
        return voices[0]
    # This is a lightweight no-account heuristic, not biometric speaker ID.
    # A long pause rotates among available voices to make multi-character clips
    # less monotonous while keeping the system fully free.
    if gap >= 1.8:
        state["voice_index"] = (state.get("voice_index", 0) + 1) % len(voices)
    return voices[state.get("voice_index", 0) % len(voices)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--worker-url", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--index", type=int, required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--total", type=int, required=True)
    args = ap.parse_args()

    job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    job_id = job["id"]
    client = WorkerClient(args.worker_url, args.token)

    work = Path(f"work_chunk_{args.index:05d}")
    work.mkdir(parents=True, exist_ok=True)
    source = work / "source.mkv"
    audio = work / "speech.wav"
    dubbed_wav = work / "dubbed_voice.wav"
    output = work / f"chunk_{args.index:05d}.mp4"
    subtitle_path = work / f"chunk_{args.index:05d}.srt"

    client.download(args.key, source)
    chunk_duration = duration(source)
    if chunk_duration <= 0:
        raise RuntimeError("Unable to determine chunk duration")
    if not has_audio(source):
        raise RuntimeError("Video chunk has no audio stream")

    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio),
    ])

    model_name = os.environ.get("WHISPER_MODEL", "small")
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=max(2, os.cpu_count() or 2))
    requested_source = job.get("sourceLang", "auto")
    whisper_lang = None if requested_source == "auto" else requested_source
    seg_iter, info = model.transcribe(
        str(audio), language=whisper_lang, vad_filter=True, beam_size=3,
        condition_on_previous_text=True,
    )
    whisper_segments = [s for s in seg_iter if str(s.text or "").strip()]
    detected_lang = str(getattr(info, "language", None) or requested_source or "auto")
    target_lang = str(job.get("targetLang") or "th")

    original_texts = [str(s.text).strip() for s in whisper_segments]
    translated = translate_texts(client, original_texts, detected_lang, target_lang)
    voices = asyncio.run(list_matching_voices(target_lang, str(job.get("voiceMode") or "auto")))

    timeline = AudioSegment.silent(duration=max(1, int(math.ceil(chunk_duration * 1000))), frame_rate=24000)
    timeline = timeline.set_channels(1).set_sample_width(2)
    subtitles: list[srt.Subtitle] = []
    voice_state = {"voice_index": 0}
    previous_end = 0.0

    for i, (seg, text) in enumerate(zip(whisper_segments, translated)):
        start = max(0.0, float(seg.start))
        end = min(chunk_duration, max(start + 0.12, float(seg.end)))
        desired = max(0.12, end - start)
        clean_text = (text or original_texts[i]).strip()
        if not clean_text:
            continue
        gap = max(0.0, start - previous_end)
        voice = choose_voice(voices, i, gap, bool(job.get("speakerSeparation", False)), voice_state)
        tts_mp3 = work / f"tts_{i:05d}.mp3"
        tts_wav = work / f"tts_{i:05d}.wav"
        asyncio.run(synthesize(clean_text, voice, tts_mp3))
        spoken = duration(tts_mp3)
        filters = []
        if spoken > desired * 1.03:
            filters.append(atempo_chain(spoken / desired))
        filters += ["aresample=24000", "aformat=sample_fmts=s16:channel_layouts=mono"]
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(tts_mp3),
            "-af", ",".join(filters), "-ac", "1", "-ar", "24000", str(tts_wav),
        ])
        clip = AudioSegment.from_file(tts_wav).set_frame_rate(24000).set_channels(1).set_sample_width(2)
        max_len = max(120, int(desired * 1000))
        if len(clip) > max_len:
            clip = clip[:max_len]
        timeline = timeline.overlay(clip, position=int(start * 1000))
        previous_end = end
        subtitles.append(srt.Subtitle(
            index=len(subtitles) + 1,
            start=timedelta(seconds=start),
            end=timedelta(seconds=end),
            content=clean_text,
        ))
        tts_mp3.unlink(missing_ok=True)
        tts_wav.unlink(missing_ok=True)

    timeline.export(dubbed_wav, format="wav")
    subtitle_path.write_text(srt.compose(subtitles), encoding="utf-8")

    keep_music = bool(job.get("keepMusic", True))
    if keep_music:
        filter_complex = (
            "[0:a:0]aresample=48000,volume=0.95[base];"
            "[1:a:0]aresample=48000[voice];"
            "[base][voice]sidechaincompress=threshold=0.025:ratio=10:attack=8:release=280[ducked];"
            "[ducked][voice]amix=inputs=2:weights='1 1.15':normalize=0[aout]"
        )
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-i", str(dubbed_wav),
            "-filter_complex", filter_complex,
            "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart", str(output),
        ])
    else:
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-i", str(dubbed_wav),
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart", str(output),
        ])

    out_key = f"temp/{job_id}/dub/chunk_{args.index:05d}.mp4"
    sub_key = f"temp/{job_id}/subs/chunk_{args.index:05d}.srt"
    client.upload(output, out_key, "video/mp4")
    if bool(job.get("subtitles", True)):
        client.upload(subtitle_path, sub_key, "application/x-subrip")
    client.mark_chunk_complete(job_id, args.index, args.total)
    print(json.dumps({
        "jobId": job_id,
        "index": args.index,
        "segments": len(whisper_segments),
        "detectedLanguage": detected_lang,
        "targetLanguage": target_lang,
        "outputKey": out_key,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
