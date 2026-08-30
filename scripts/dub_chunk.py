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
from types import SimpleNamespace

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

# Audio profile v2 keeps translated speech natural instead of forcing every
# sentence into the exact Whisper segment length. Old checkpoints are rebuilt
# when a retry uses this newer timing/mix profile.
AUDIO_PROFILE_VERSION = 3
MAX_TEMPO_RATIO = 1.10
MAX_GAP_EXTENSION = 1.20


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
    return names[:4]


async def synthesize(text: str, voice: str, destination: Path) -> None:
    last: Exception | None = None
    for attempt in range(1, 4):
        try:
            communicate = edge_tts.Communicate(text=text, voice=voice, rate="-5%", volume="+0%")
            await communicate.save(str(destination))
            if destination.exists() and destination.stat().st_size > 0:
                return
        except Exception as exc:
            last = exc
            await asyncio.sleep(attempt * 1.2)
    raise RuntimeError(f"TTS failed after retries: {last}")


async def synthesize_many(plans: list[dict], concurrency: int = 4) -> None:
    sem = asyncio.Semaphore(max(1, concurrency))

    async def one(plan: dict) -> None:
        async with sem:
            try:
                await synthesize(plan["text"], plan["voice"], plan["mp3"])
                plan["tts_ok"] = True
            except Exception as exc:
                plan["tts_ok"] = False
                plan["tts_error"] = str(exc)

    await asyncio.gather(*(one(p) for p in plans))


def translate_texts(client: WorkerClient, texts: list[str], source_lang: str, target_lang: str, durations: list[float] | None = None) -> list[str]:
    if not texts or source_lang == target_lang:
        return texts

    translated: list[str] = []
    try:
        for i in range(0, len(texts), 12):
            batch = texts[i:i + 12]
            batch_durations = durations[i:i + 12] if durations is not None else None
            got = client.translate(batch, source_lang, target_lang, batch_durations)
            if len(got) != len(batch):
                raise RuntimeError("Workers AI returned an unexpected translation count")
            translated.extend(got)
        return translated
    except Exception as exc:
        print("Workers AI translation unavailable, falling back to GoogleTranslator:", exc, flush=True)

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
                time.sleep(attempt * 1.0)
        if last is not None:
            print(f"Translation failed for segment {idx}; using source text: {last}", flush=True)
            translated.append(text)
    return translated


def choose_voice(voices: list[str], gap: float, speaker_mode: bool, state: dict) -> str:
    if len(voices) == 1 or not speaker_mode:
        return voices[0]
    if gap >= 1.8:
        state["voice_index"] = (state.get("voice_index", 0) + 1) % len(voices)
    return voices[state.get("voice_index", 0) % len(voices)]


def pause_checkpoint(client: WorkerClient, job_id: str, label: str) -> bool:
    try:
        paused = client.is_paused(job_id)
    except Exception as exc:
        print(f"Pause check failed at {label}: {exc}", flush=True)
        return False
    if paused:
        print(f"Job paused at safe checkpoint: {label}", flush=True)
        return True
    return False


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
    mode = str(job.get("processingMode") or "fast")

    out_key = f"temp/{job_id}/dub/chunk_{args.index:05d}.ts"
    sub_key = f"temp/{job_id}/subs/chunk_{args.index:05d}.srt"
    meta_key = f"temp/{job_id}/meta/chunk_{args.index:05d}.json"
    state_key = f"_state/{job_id}/chunks/{args.index:05d}.json"

    # A retry reuses every chunk that already reached the durable completion
    # marker. Only the missing/failed chunks are processed again.
    already_done = client.exists(state_key) and client.exists(out_key) and client.exists(meta_key)
    if bool(job.get("subtitles", True)):
        already_done = already_done and client.exists(sub_key)
    checkpoint_current = False
    if already_done:
        checkpoint_meta = Path(f"checkpoint_meta_{args.index:05d}.json")
        try:
            client.download(meta_key, checkpoint_meta)
            saved = json.loads(checkpoint_meta.read_text(encoding="utf-8"))
            checkpoint_current = int(saved.get("audioProfileVersion") or 0) == AUDIO_PROFILE_VERSION
        except Exception as exc:
            print(f"Cannot verify checkpoint audio profile: {exc}", flush=True)
        finally:
            checkpoint_meta.unlink(missing_ok=True)
    if already_done and checkpoint_current:
        print(f"Chunk {args.index + 1}/{args.total} already complete with audio profile {AUDIO_PROFILE_VERSION}; skipping", flush=True)
        return
    if already_done:
        print(f"Chunk {args.index + 1}/{args.total} uses an older audio profile; rebuilding", flush=True)

    if pause_checkpoint(client, job_id, "before chunk"):
        return

    work = Path(f"work_chunk_{args.index:05d}")
    work.mkdir(parents=True, exist_ok=True)
    source = work / "source.mkv"
    audio = work / "speech.wav"
    dubbed_wav = work / "dubbed_voice.wav"
    output = work / f"chunk_{args.index:05d}.ts"
    subtitle_path = work / f"chunk_{args.index:05d}.srt"
    meta_path = work / f"chunk_{args.index:05d}.json"

    client.patch_job(job_id, status="processing", progress=12, stage=f"กำลังถอดเสียงช่วง {args.index + 1}/{args.total}")
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

    transcript_key = f"temp/{job_id}/transcript/chunk_{args.index:05d}.json"
    transcript_data = None
    transcript_file = work / f"youtube_transcript_{args.index:05d}.json"
    try:
        if client.exists(transcript_key):
            client.download(transcript_key, transcript_file)
            transcript_data = json.loads(transcript_file.read_text(encoding="utf-8"))
    except Exception as transcript_error:
        print(f"Cannot use YouTube transcript for chunk {args.index}: {transcript_error}", flush=True)
        transcript_data = None

    target_lang = str(job.get("targetLang") or "th")
    timed_entries = list((transcript_data or {}).get("entries") or [])
    if timed_entries:
        whisper_segments = [
            SimpleNamespace(
                start=max(0.0, float(item.get("start") or 0)),
                end=max(
                    max(0.0, float(item.get("start") or 0)) + 0.05,
                    float(item.get("start") or 0) + max(0.05, float(item.get("duration") or 0)),
                ),
                text=str(item.get("text") or "").strip(),
            )
            for item in timed_entries
            if str(item.get("text") or "").strip()
        ]
        detected_lang = str(transcript_data.get("language") or job.get("sourceLang") or "auto")
        client.patch_job(
            job_id,
            progress=15,
            stage=f"ใช้ซับ YouTube ช่วง {args.index + 1}/{args.total} {len(whisper_segments)} บรรทัด",
        )
    else:
        model_name = os.environ.get("WHISPER_MODEL", "base")
        beam_size = 1 if mode == "fast" else (2 if mode == "balanced" else 3)
        model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=max(2, os.cpu_count() or 2))
        requested_source = job.get("sourceLang", "auto")
        whisper_lang = None if requested_source == "auto" else requested_source
        seg_iter, info = model.transcribe(
            str(audio),
            language=whisper_lang,
            vad_filter=True,
            beam_size=beam_size,
            best_of=1,
            condition_on_previous_text=(mode == "quality"),
        )
        whisper_segments = [s for s in seg_iter if str(s.text or "").strip()]
        detected_lang = str(getattr(info, "language", None) or requested_source or "auto")
        client.patch_job(job_id, progress=15, stage=f"ถอดเสียงช่วง {args.index + 1}/{args.total} เสร็จ กำลังแปล")

    if pause_checkpoint(client, job_id, "after transcription"):
        return

    original_texts = [str(s.text).strip() for s in whisper_segments]
    segment_durations = [max(0.1, float(s.end) - float(s.start)) for s in whisper_segments]
    if transcript_data and bool(transcript_data.get("targetReady")):
        translated = original_texts
        client.patch_job(job_id, progress=17, stage=f"ใช้คำแปล YouTube ช่วง {args.index + 1}/{args.total} กำลังสร้างเสียง")
    else:
        translated = translate_texts(client, original_texts, detected_lang, target_lang, segment_durations)
        client.patch_job(job_id, progress=17, stage=f"แปลช่วง {args.index + 1}/{args.total} เสร็จ กำลังสร้างเสียง")
    voices = asyncio.run(list_matching_voices(target_lang, str(job.get("voiceMode") or "auto")))

    if pause_checkpoint(client, job_id, "after translation"):
        return

    timeline = AudioSegment.silent(duration=max(1, int(math.ceil(chunk_duration * 1000))), frame_rate=24000)
    timeline = timeline.set_channels(1).set_sample_width(2)
    subtitles: list[srt.Subtitle] = []
    voice_state = {"voice_index": 0}
    previous_end = 0.0
    plans: list[dict] = []

    for i, (seg, text) in enumerate(zip(whisper_segments, translated)):
        start = max(0.0, float(seg.start))
        end = min(chunk_duration, max(start + 0.12, float(seg.end)))
        desired = max(0.12, end - start)
        next_start = chunk_duration
        if i + 1 < len(whisper_segments):
            next_start = max(end, float(whisper_segments[i + 1].start))
        free_gap = max(0.0, next_start - end - 0.08)
        extension = min(MAX_GAP_EXTENSION, free_gap)
        window_end = min(chunk_duration, end + extension)
        speech_window = max(desired, window_end - start)
        clean_text = (text or original_texts[i]).strip()
        if not clean_text:
            continue
        gap = max(0.0, start - previous_end)
        voice = choose_voice(voices, gap, bool(job.get("speakerSeparation", False)), voice_state)
        plans.append({
            "i": i,
            "start": start,
            "end": end,
            "desired": desired,
            "speech_window": speech_window,
            "text": clean_text,
            "voice": voice,
            "mp3": work / f"tts_{i:05d}.mp3",
            "wav": work / f"tts_{i:05d}.wav",
        })
        previous_end = end
        subtitles.append(srt.Subtitle(
            index=len(subtitles) + 1,
            start=timedelta(seconds=start),
            end=timedelta(seconds=end),
            content=clean_text,
        ))

    if plans:
        asyncio.run(synthesize_many(plans, concurrency=4 if mode != "quality" else 3))

    if pause_checkpoint(client, job_id, "after speech generation"):
        return

    successful_tts = 0
    for n, plan in enumerate(plans, 1):
        if not plan.get("tts_ok"):
            print(f"TTS segment {plan['i']} skipped: {plan.get('tts_error', 'unknown error')}", flush=True)
            continue
        try:
            clip = AudioSegment.from_file(plan["mp3"])
            spoken = max(0.001, len(clip) / 1000.0)
            speech_window = max(plan["desired"], float(plan.get("speech_window") or plan["desired"]))
            required_ratio = spoken / speech_window
            tempo_ratio = min(MAX_TEMPO_RATIO, max(1.0, required_ratio))
            if tempo_ratio > 1.01:
                filters = [
                    atempo_chain(tempo_ratio),
                    "aresample=24000",
                    "aformat=sample_fmts=s16:channel_layouts=mono",
                ]
                run([
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(plan["mp3"]),
                    "-af", ",".join(filters), "-ac", "1", "-ar", "24000", str(plan["wav"]),
                ])
                clip = AudioSegment.from_file(plan["wav"])
            clip = clip.set_frame_rate(24000).set_channels(1).set_sample_width(2)
            # Prefer a small overlap to robotic high-speed speech. Only trim a
            # severe overrun so the following line is still intelligible.
            max_len = max(300, int((speech_window + 0.55) * 1000))
            if len(clip) > max_len:
                clip = clip[:max_len].fade_out(min(90, max_len // 5))
            timeline = timeline.overlay(clip, position=int(plan["start"] * 1000))
            successful_tts += 1
        except Exception as exc:
            print(f"TTS render segment {plan['i']} skipped: {exc}", flush=True)
        finally:
            plan["mp3"].unlink(missing_ok=True)
            plan["wav"].unlink(missing_ok=True)

        if plans and (n % max(1, len(plans) // 4) == 0 or n == len(plans)):
            client.patch_job(
                job_id,
                progress=min(24, 18 + round((n / len(plans)) * 6)),
                stage=f"สร้างเสียงช่วง {args.index + 1}/{args.total} {n}/{len(plans)} ประโยค",
            )

    if plans and successful_tts == 0:
        raise RuntimeError("สร้างเสียงพากย์ไม่สำเร็จทุกประโยค กรุณาลองใหม่")

    timeline.export(dubbed_wav, format="wav")
    if not has_audio(dubbed_wav):
        raise RuntimeError("ไฟล์เสียงพากย์ไม่มี audio stream")
    subtitle_path.write_text(srt.compose(subtitles), encoding="utf-8")

    if pause_checkpoint(client, job_id, "before audio mix"):
        return

    client.patch_job(job_id, progress=25, stage=f"กำลังผสมเสียงช่วง {args.index + 1}/{args.total}")
    keep_music = bool(job.get("keepMusic", True))
    video_filter = "scale=-2:'min(1080,ih)'"
    if bool(job.get("subtitles", True)) and subtitles:
        sub_name = subtitle_path.as_posix().replace("'", "\\'")
        video_filter += (
            f",subtitles=filename='{sub_name}':"
            "force_style='FontName=Noto Sans Thai,FontSize=22,Alignment=2,MarginV=46,"
            "BorderStyle=3,Outline=1,Shadow=0,PrimaryColour=&H00FFFFFF,BackColour=&H88000000'"
        )
    common_video = [
        "-vf", video_filter,
        "-c:v", "libx264", "-preset", "ultrafast" if mode == "fast" else "veryfast",
        "-crf", "23" if mode == "fast" else "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-f", "mpegts",
    ]
    if keep_music:
        filter_complex = (
            "[0:a:0]aresample=48000,volume=0.78[base];"
            "[1:a:0]aresample=48000,loudnorm=I=-15:TP=-1.5:LRA=7,asplit=2[voice_sc][voice_mix];"
            "[base][voice_sc]sidechaincompress=threshold=0.004:ratio=30:attack=2:release=180[ducked];"
            "[ducked][voice_mix]amix=inputs=2:weights='0.42 1.55':normalize=0,"
            "alimiter=limit=0.95[aout]"
        )
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-i", str(dubbed_wav),
            "-filter_complex", filter_complex,
            "-map", "0:v:0", "-map", "[aout]", *common_video, str(output),
        ])
    else:
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-i", str(dubbed_wav),
            "-map", "0:v:0", "-map", "1:a:0", "-filter:a",
            "loudnorm=I=-16:TP=-1.5:LRA=7", *common_video, str(output),
        ])

    if not output.exists() or output.stat().st_size <= 0:
        raise RuntimeError("FFmpeg did not produce a dubbed video chunk")

    if pause_checkpoint(client, job_id, "before chunk upload"):
        return

    meta_path.write_text(json.dumps({
        "index": args.index,
        "audioProfileVersion": AUDIO_PROFILE_VERSION,
        "duration": chunk_duration,
        "segments": len(whisper_segments),
        "ttsSegments": successful_tts,
        "detectedLanguage": detected_lang,
        "targetLanguage": target_lang,
        "outputKey": out_key,
        "subtitleKey": sub_key if bool(job.get("subtitles", True)) else None,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    client.upload(output, out_key, "video/mp2t")
    client.upload(meta_path, meta_key, "application/json")
    if bool(job.get("subtitles", True)):
        client.upload(subtitle_path, sub_key, "application/x-subrip")
    client.mark_chunk_complete(job_id, args.index, args.total)
    print(meta_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
