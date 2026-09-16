from __future__ import annotations

import asyncio
import base64
import json
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


async def synthesize_profile(text: str, voice_spec: str, destination: Path) -> None:
    profile = decode_profile(voice_spec)
    if profile:
        voice = str(profile.get("voice") or "th-TH-NiwatNeural")
        rate = str(profile.get("rate") or "-3%")
        pitch = str(profile.get("pitch") or "+0Hz")
        volume = str(profile.get("volume") or "+0%")
    else:
        voice = str(voice_spec)
        rate = "-5%"
        pitch = "+0Hz"
        volume = "+0%"

    last: Exception | None = None
    for attempt in range(1, 4):
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
                return
        except Exception as exc:
            last = exc
            await asyncio.sleep(attempt * 1.2)
    raise RuntimeError(f"TTS failed after retries: {last}")


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
