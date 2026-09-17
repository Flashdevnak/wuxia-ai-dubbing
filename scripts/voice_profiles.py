from __future__ import annotations

import asyncio
import base64
import json
import re
import subprocess
import unicodedata
from pathlib import Path

import edge_tts


PREFIX = "vp1:"

THAI_PROFILE_PRESETS = {
    "child-boy": {"gender": "Male", "rate": "+9%", "pitch": "+20Hz", "volume": "+0%", "label": "เด็กผู้ชาย"},
    "child-girl": {"gender": "Female", "rate": "+9%", "pitch": "+22Hz", "volume": "+0%", "label": "เด็กผู้หญิง"},
    "teen-boy": {"gender": "Male", "rate": "+5%", "pitch": "+10Hz", "volume": "+0%", "label": "วัยรุ่นผู้ชาย"},
    "teen-girl": {"gender": "Female", "rate": "+4%", "pitch": "+10Hz", "volume": "+0%", "label": "วัยรุ่นผู้หญิง"},
    "adult-male": {"gender": "Male", "rate": "-2%", "pitch": "+0Hz", "volume": "+0%", "label": "ผู้ชายผู้ใหญ่"},
    "adult-female": {"gender": "Female", "rate": "-2%", "pitch": "+0Hz", "volume": "+0%", "label": "ผู้หญิงผู้ใหญ่"},
    "mature-male": {"gender": "Male", "rate": "-6%", "pitch": "-5Hz", "volume": "+1%", "label": "ชายวัยกลางคน"},
    "mature-female": {"gender": "Female", "rate": "-5%", "pitch": "-4Hz", "volume": "+1%", "label": "หญิงวัยกลางคน"},
    "elder-male": {"gender": "Male", "rate": "-11%", "pitch": "-9Hz", "volume": "+1%", "label": "ชายสูงวัย"},
    "elder-female": {"gender": "Female", "rate": "-10%", "pitch": "-8Hz", "volume": "+1%", "label": "หญิงสูงวัย"},
    "narrator": {"gender": "Male", "rate": "-7%", "pitch": "-4Hz", "volume": "+2%", "label": "ผู้บรรยาย"},
    "male": {"gender": "Male", "rate": "-3%", "pitch": "+0Hz", "volume": "+0%", "label": "ผู้ชาย"},
    "female": {"gender": "Female", "rate": "-3%", "pitch": "+0Hz", "volume": "+0%", "label": "ผู้หญิง"},
}

AUTO_CAST_ORDER = [
    "adult-male",
    "adult-female",
    "teen-boy",
    "teen-girl",
    "mature-male",
    "mature-female",
    "elder-male",
    "elder-female",
]


def _b64url(data: str) -> str:
    return base64.urlsafe_b64encode(data.encode("utf-8")).decode("ascii").rstrip("=")


def _unb64url(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8")


def encode_profile(profile: dict) -> str:
    return PREFIX + _b64url(json.dumps(profile, ensure_ascii=False, separators=(",", ":")))


def decode_profile(value: str) -> dict | None:
    raw = str(value or "")
    if not raw.startswith(PREFIX):
        return None
    try:
        value = json.loads(_unb64url(raw[len(PREFIX):]))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def _pick_voice(candidates: list[dict], gender: str, preferred_names: list[str]) -> str:
    wanted = [v for v in candidates if str(v.get("Gender", "")) == gender]
    pool = wanted or candidates
    names = {str(v.get("ShortName") or ""): v for v in pool}
    for name in preferred_names:
        if name in names:
            return name
    for voice in pool:
        name = str(voice.get("ShortName") or "")
        if name:
            return name
    raise RuntimeError(f"No TTS voice available for gender={gender}")


async def list_profile_voices(lang: str, mode: str, locale_map: dict[str, str]) -> list[str]:
    locale = locale_map.get(lang, lang)
    voices = await edge_tts.list_voices()
    candidates = [v for v in voices if str(v.get("Locale", "")).lower() == locale.lower()]
    if not candidates:
        candidates = [v for v in voices if str(v.get("Locale", "")).lower().startswith(lang.lower() + "-")]
    if not candidates:
        raise RuntimeError(f"No Edge TTS voice found for {lang} / {locale}")

    if lang != "th":
        wanted = {"male": "Male", "female": "Female", "narrator": "Male"}.get(mode)
        if wanted:
            filtered = [v for v in candidates if str(v.get("Gender", "")) == wanted]
            if filtered:
                candidates = filtered
        return [str(v["ShortName"]) for v in candidates if v.get("ShortName")][:4]

    male = _pick_voice(candidates, "Male", ["th-TH-NiwatNeural"])
    female = _pick_voice(candidates, "Female", ["th-TH-AcharaNeural", "th-TH-PremwadeeNeural"])

    requested = str(mode or "auto-cast")
    profile_names = AUTO_CAST_ORDER if requested in {"auto", "auto-cast"} else [requested]
    result: list[str] = []
    for name in profile_names:
        preset = THAI_PROFILE_PRESETS.get(name) or THAI_PROFILE_PRESETS["adult-male"]
        voice = male if preset["gender"] == "Male" else female
        result.append(encode_profile({
            "id": name,
            "voice": voice,
            "rate": preset["rate"],
            "pitch": preset["pitch"],
            "volume": preset["volume"],
            "label": preset["label"],
            "gender": preset["gender"],
        }))
    return result


def normalize_tts_text(text: str) -> str:
    """Normalize invisible/control-heavy translated text before Edge TTS.

    The subtitle/translation itself is left untouched; this value is only used
    for speech synthesis recovery when Edge returns no audio for a sentence.
    """
    value = unicodedata.normalize("NFKC", str(text or ""))
    cleaned: list[str] = []
    for char in value:
        category = unicodedata.category(char)
        if char in "\r\n\t":
            cleaned.append(" ")
        elif category.startswith("C"):
            # Strip zero-width, bidi and other non-spoken control characters.
            continue
        else:
            cleaned.append(char)
    return re.sub(r"\s+", " ", "".join(cleaned)).strip()


def _plain_tts_text(text: str) -> str:
    # Last-resort speech text keeps letters/numbers from every Unicode script
    # while dropping symbols that can occasionally break an Edge TTS request.
    value = normalize_tts_text(text)
    reduced = "".join(char if (char.isalnum() or char.isspace()) else " " for char in value)
    return re.sub(r"\s+", " ", reduced).strip()


def _has_speakable_text(text: str) -> bool:
    return any(char.isalnum() for char in normalize_tts_text(text))


def _write_silence_mp3(destination: Path, seconds: float = 0.12) -> None:
    destination.unlink(missing_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
        "-t", f"{max(0.05, seconds):.3f}", "-q:a", "9", str(destination),
    ], check=True)
    if not destination.exists() or destination.stat().st_size <= 0:
        raise RuntimeError("Unable to create silent TTS placeholder")


async def _edge_save(
    *,
    text: str,
    voice: str,
    rate: str,
    pitch: str,
    volume: str,
    destination: Path,
    attempts: int,
) -> Exception | None:
    last: Exception | None = None
    for attempt in range(1, max(1, attempts) + 1):
        destination.unlink(missing_ok=True)
        try:
            communicate = edge_tts.Communicate(
                text=text,
                voice=voice,
                rate=rate,
                pitch=pitch,
                volume=volume,
            )
            await communicate.save(str(destination))
            if destination.exists() and destination.stat().st_size > 0:
                return None
            last = RuntimeError("Edge TTS returned empty audio")
        except Exception as exc:
            last = exc
        if attempt < attempts:
            await asyncio.sleep(attempt * 1.2)
    return last


async def _fallback_voice_specs(current_voice: str, current_gender: str) -> list[dict]:
    """Return live locale-compatible voices, preferring the current gender."""
    try:
        voices = await edge_tts.list_voices()
    except Exception as exc:
        print(f"TTS fallback voice discovery skipped: {exc}", flush=True)
        return []

    pieces = str(current_voice or "").split("-")
    locale = "-".join(pieces[:2]).lower() if len(pieces) >= 2 else "th-th"
    candidates = [
        voice for voice in voices
        if str(voice.get("Locale") or "").lower() == locale
        and str(voice.get("ShortName") or "")
        and str(voice.get("ShortName") or "") != current_voice
    ]
    candidates.sort(key=lambda item: 0 if str(item.get("Gender") or "") == current_gender else 1)

    specs: list[dict] = []
    for item in candidates[:3]:
        specs.append({
            "voice": str(item.get("ShortName") or ""),
            "gender": str(item.get("Gender") or ""),
            "rate": "+0%",
            "pitch": "+0Hz",
            "volume": "+0%",
        })
    return specs


async def synthesize_profile(text: str, voice_spec: str, destination: Path) -> None:
    """Synthesize speech with deterministic recovery for Edge `No audio` cases.

    Recovery order keeps the chosen actor whenever possible:
    original profile -> normalized text -> neutral same voice -> live alternate
    locale voice -> punctuation-stripped text. Punctuation-only segments become
    a short silence because there is no spoken content to synthesize.
    """
    profile = decode_profile(voice_spec)
    if profile:
        voice = str(profile.get("voice") or "th-TH-NiwatNeural")
        rate = str(profile.get("rate") or "-3%")
        pitch = str(profile.get("pitch") or "+0Hz")
        volume = str(profile.get("volume") or "+0%")
        gender = str(profile.get("gender") or "")
    else:
        voice = str(voice_spec)
        rate = "-5%"
        pitch = "+0Hz"
        volume = "+0%"
        gender = ""

    original_text = str(text or "").strip()
    normalized_text = normalize_tts_text(original_text)
    if not _has_speakable_text(normalized_text):
        print("TTS punctuation-only segment -> silence placeholder", flush=True)
        _write_silence_mp3(destination)
        return

    last = await _edge_save(
        text=original_text,
        voice=voice,
        rate=rate,
        pitch=pitch,
        volume=volume,
        destination=destination,
        attempts=3,
    )
    if last is None:
        return

    # Deterministic TTS recovery: retry a normalized request without changing
    # the actor first. This addresses invisible/control character failures.
    recovery_attempts: list[tuple[str, str, str, str, str, str]] = []
    if normalized_text != original_text:
        recovery_attempts.append(("normalized", normalized_text, voice, rate, pitch, volume))
    recovery_attempts.append(("neutral-same-voice", normalized_text, voice, "+0%", "+0Hz", "+0%"))

    fallback_specs = await _fallback_voice_specs(voice, gender)
    for spec in fallback_specs:
        recovery_attempts.append((
            "alternate-locale-voice",
            normalized_text,
            spec["voice"],
            spec["rate"],
            spec["pitch"],
            spec["volume"],
        ))

    plain_text = _plain_tts_text(normalized_text)
    if plain_text and plain_text != normalized_text:
        recovery_attempts.append(("plain-text", plain_text, voice, "+0%", "+0Hz", "+0%"))
        for spec in fallback_specs[:2]:
            recovery_attempts.append((
                "plain-text-alternate-voice",
                plain_text,
                spec["voice"],
                spec["rate"],
                spec["pitch"],
                spec["volume"],
            ))

    seen: set[tuple[str, str, str, str, str]] = set()
    for strategy, recovery_text, recovery_voice, recovery_rate, recovery_pitch, recovery_volume in recovery_attempts:
        key = (recovery_text, recovery_voice, recovery_rate, recovery_pitch, recovery_volume)
        if key in seen:
            continue
        seen.add(key)
        print(f"TTS deterministic recovery: {strategy} voice={recovery_voice}", flush=True)
        error = await _edge_save(
            text=recovery_text,
            voice=recovery_voice,
            rate=recovery_rate,
            pitch=recovery_pitch,
            volume=recovery_volume,
            destination=destination,
            attempts=2,
        )
        if error is None:
            return
        last = error

    raise RuntimeError(f"TTS failed after profile/text fallbacks: {last}")


def choose_profile_voice(voices: list[str], gap: float, speaker_mode: bool, state: dict) -> str:
    if len(voices) <= 1 or not speaker_mode:
        return voices[0]

    idx = int(state.get("voice_index", 0)) % len(voices)
    # Keep short back-and-forth lines on the same slot, and only change actor
    # when there is a meaningful pause. This is still a heuristic rather than
    # true biometric speaker identification, but it gives repeatable casting.
    if gap >= 3.5:
        idx = (idx + 2) % len(voices)
    elif gap >= 1.35:
        idx = (idx + 1) % len(voices)
    state["voice_index"] = idx
    return voices[idx]
