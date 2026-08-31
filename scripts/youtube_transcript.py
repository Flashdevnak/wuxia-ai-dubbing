from __future__ import annotations

import html
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener


PREFERRED_FORMATS = ("srv1", "json3", "vtt")
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36"


def _base_lang(value: str) -> str:
    return str(value or "").lower().split("-")[0].split("_")[0]


def _video_id(url: str) -> str:
    value = str(url or "").strip()
    parsed = urlparse(value)
    host = parsed.netloc.lower().split(":")[0]
    if host in {"youtu.be", "www.youtu.be"}:
        return parsed.path.strip("/").split("/")[0]
    if host.endswith("youtube.com"):
        qs = parse_qs(parsed.query)
        if qs.get("v"):
            return str(qs["v"][0]).strip()
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in {"shorts", "embed", "live"}:
            return parts[1]
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{6,})", value)
    if m:
        return m.group(1)
    raise RuntimeError("ลิงก์ YouTube นี้ไม่มีรหัสวิดีโอที่อ่านได้")


def _opener(cookies_file: Path | None):
    handlers = []
    if cookies_file:
        try:
            jar = MozillaCookieJar(str(cookies_file))
            jar.load(ignore_discard=True, ignore_expires=True)
            handlers.append(HTTPCookieProcessor(jar))
        except Exception:
            pass
    return build_opener(*handlers)


def _http_get(url: str, cookies_file: Path | None = None, headers: dict[str, str] | None = None) -> bytes:
    merged = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "*/*",
    }
    if headers:
        merged.update({str(k): str(v) for k, v in headers.items() if v is not None})
    req = Request(url, headers=merged)
    with _opener(cookies_file).open(req, timeout=60) as response:
        return response.read()


def _direct_tracks(video_id: str, cookies_file: Path | None = None) -> list[dict[str, str]]:
    query = urlencode({"v": video_id, "type": "list", "hl": "en"})
    raw = _http_get(f"https://www.youtube.com/api/timedtext?{query}", cookies_file)
    if not raw.strip():
        return []
    try:
        root = ET.fromstring(raw.decode("utf-8", errors="replace"))
    except Exception:
        return []
    tracks: list[dict[str, str]] = []
    for node in root.findall(".//track"):
        attrs = {str(k): str(v) for k, v in node.attrib.items()}
        lang = attrs.get("lang_code") or attrs.get("lang") or ""
        if not lang:
            continue
        tracks.append({
            "lang": lang,
            "name": attrs.get("name") or "",
            "kind": attrs.get("kind") or "",
            "cantran": attrs.get("cantran") or attrs.get("can_translate") or "",
            "lang_original": attrs.get("lang_original") or "",
        })
    return tracks


def _select_direct_track(tracks: list[dict[str, str]], target_lang: str, source_lang: str) -> dict[str, str]:
    target = _base_lang(target_lang)
    source = _base_lang(source_lang)
    for track in tracks:
        if _base_lang(track.get("lang", "")) == target:
            return track
    if source and source != "auto":
        for track in tracks:
            if _base_lang(track.get("lang", "")) == source:
                return track
    # Prefer a normal/manual track before ASR when language is otherwise unknown.
    for track in tracks:
        if str(track.get("kind") or "").lower() != "asr":
            return track
    if tracks:
        return tracks[0]
    raise RuntimeError("วิดีโอนี้ไม่มีคำบรรยาย YouTube ที่ดึงได้")


def _timedtext_url(video_id: str, track: dict[str, str], target_lang: str | None = None) -> str:
    params: dict[str, str] = {
        "v": video_id,
        "lang": str(track.get("lang") or ""),
        "fmt": "srv1",
    }
    if track.get("name"):
        params["name"] = str(track["name"])
    if track.get("kind"):
        params["kind"] = str(track["kind"])
    if target_lang:
        params["tlang"] = str(target_lang)
    return "https://www.youtube.com/api/timedtext?" + urlencode(params)


def _extract_direct(
    url: str,
    target_lang: str,
    source_lang: str,
    cookies_file: Path | None,
) -> dict[str, Any] | None:
    video_id = _video_id(url)
    try:
        tracks = _direct_tracks(video_id, cookies_file)
    except Exception:
        return None
    if not tracks:
        return None
    track = _select_direct_track(tracks, target_lang, source_lang)
    track_lang = str(track.get("lang") or "")
    target = _base_lang(target_lang)

    # If a Thai/target track already exists, download it directly.
    if _base_lang(track_lang) == target:
        raw = _http_get(_timedtext_url(video_id, track), cookies_file)
        entries = _parse_srv1(raw) if raw.strip() else []
        if entries:
            return {
                "videoId": video_id,
                "title": "",
                "language": target_lang,
                "targetLanguage": target_lang,
                "targetReady": True,
                "origin": "youtube-timedtext",
                "format": "srv1",
                "entries": entries,
            }

    # YouTube's timedtext endpoint can translate a caption track while keeping
    # the original timestamps. Try that before asking our translator to rewrite it.
    can_translate = str(track.get("cantran") or "").lower() in {"1", "true", "yes"}
    if target and can_translate:
        try:
            translated_raw = _http_get(_timedtext_url(video_id, track, target_lang), cookies_file)
            translated_entries = _parse_srv1(translated_raw) if translated_raw.strip() else []
            if translated_entries:
                return {
                    "videoId": video_id,
                    "title": "",
                    "language": target_lang,
                    "targetLanguage": target_lang,
                    "targetReady": True,
                    "origin": "youtube-timedtext-translation",
                    "format": "srv1",
                    "entries": translated_entries,
                    "sourceTrackLanguage": track_lang,
                }
        except Exception:
            pass

    # Translation unavailable: preserve the YouTube timing and translate later.
    raw = _http_get(_timedtext_url(video_id, track), cookies_file)
    entries = _parse_srv1(raw) if raw.strip() else []
    if not entries:
        return None
    return {
        "videoId": video_id,
        "title": "",
        "language": track_lang,
        "targetLanguage": target_lang,
        "targetReady": _base_lang(track_lang) == target,
        "origin": "youtube-timedtext",
        "format": "srv1",
        "entries": entries,
    }


def _yt_info(url: str, cookies_file: Path | None = None) -> dict[str, Any]:
    cookie_args = ["--cookies", str(cookies_file)] if cookies_file else []
    attempts = [
        ["yt-dlp", "--no-playlist", "--no-warnings", "--skip-download", *cookie_args, "-J", url],
        ["yt-dlp", "--no-playlist", "--no-warnings", "--skip-download", *cookie_args,
         "--extractor-args", "youtube:player_client=android_vr,web_safari", "-J", url],
        ["yt-dlp", "--no-playlist", "--no-warnings", "--skip-download", *cookie_args,
         "--extractor-args", "youtube:player_client=tv,web", "-J", url],
    ]
    errors: list[str] = []
    for cmd in attempts:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if p.returncode == 0 and p.stdout.strip():
            try:
                return json.loads(p.stdout)
            except Exception as exc:
                errors.append(f"invalid metadata json: {exc}")
        else:
            tail = " ".join((p.stderr or "").strip().splitlines()[-3:])
            errors.append(tail or f"yt-dlp exited {p.returncode}")
    detail = " | ".join(errors[-2:])[-900:]
    if "not a bot" in detail.lower() or "sign in to confirm" in detail.lower():
        raise RuntimeError("YouTube ปฏิเสธการเชื่อมต่อจากเซิร์ฟเวอร์ชั่วคราว ระบบลองช่องทางดึงซับโดยตรงแล้วแต่ยังเข้าไม่ได้")
    raise RuntimeError("อ่านข้อมูลคำบรรยาย YouTube ไม่สำเร็จ: " + detail)


def _select_track(info: dict[str, Any], target_lang: str, source_lang: str) -> tuple[str, list[dict[str, Any]], str]:
    manual = dict(info.get("subtitles") or {})
    automatic = dict(info.get("automatic_captions") or {})
    target = _base_lang(target_lang)
    source = _base_lang(source_lang)

    def usable(mapping: dict[str, Any]) -> list[tuple[str, list[dict[str, Any]]]]:
        out = []
        for key, formats in mapping.items():
            if key == "live_chat" or not isinstance(formats, list) or not formats:
                continue
            out.append((str(key), formats))
        return out

    groups = [("manual", usable(manual)), ("automatic", usable(automatic))]
    for origin, items in groups:
        for key, formats in items:
            if _base_lang(key) == target:
                return key, formats, origin
    if source and source != "auto":
        for origin, items in groups:
            for key, formats in items:
                if _base_lang(key) == source:
                    return key, formats, origin
    detected = _base_lang(str(info.get("language") or ""))
    if detected:
        for origin, items in groups:
            for key, formats in items:
                if _base_lang(key) == detected:
                    return key, formats, origin
    for origin, items in groups:
        if items:
            return items[0][0], items[0][1], origin
    raise RuntimeError("วิดีโอนี้ไม่มีคำบรรยาย YouTube ที่ดึงได้")


def _choose_format(formats: list[dict[str, Any]]) -> dict[str, Any]:
    for wanted in PREFERRED_FORMATS:
        for item in formats:
            if str(item.get("ext") or "").lower() == wanted and item.get("url"):
                return item
    for item in formats:
        if item.get("url"):
            return item
    raise RuntimeError("ไม่พบ URL ของคำบรรยาย")


def _download(url: str, info: dict[str, Any], cookies_file: Path | None) -> bytes:
    headers = {str(k): str(v) for k, v in dict(info.get("http_headers") or {}).items() if v is not None}
    return _http_get(url, cookies_file, headers)


def _clean_text(value: str) -> str:
    value = html.unescape(str(value or ""))
    value = re.sub(r"<[^>]+>", "", value)
    value = value.replace("\u200b", " ").replace("\n", " ")
    return re.sub(r"\s+", " ", value).strip()


def _parse_srv1(raw: bytes) -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(raw.decode("utf-8", errors="replace"))
    except Exception:
        return []
    entries: list[dict[str, Any]] = []
    for node in root.findall(".//text"):
        text = _clean_text("".join(node.itertext()))
        if not text:
            continue
        try:
            start = float(node.attrib.get("start") or 0)
            dur = float(node.attrib.get("dur") or 0)
        except Exception:
            continue
        entries.append({"start": max(0.0, start), "duration": max(0.05, dur), "text": text})
    return entries


def _parse_json3(raw: bytes) -> list[dict[str, Any]]:
    data = json.loads(raw.decode("utf-8", errors="replace"))
    entries: list[dict[str, Any]] = []
    for event in data.get("events") or []:
        segs = event.get("segs") or []
        text = _clean_text("".join(str(x.get("utf8") or "") for x in segs if isinstance(x, dict)))
        if not text:
            continue
        start = float(event.get("tStartMs") or 0) / 1000.0
        dur = float(event.get("dDurationMs") or 0) / 1000.0
        entries.append({"start": max(0.0, start), "duration": max(0.05, dur), "text": text})
    return entries


def _parse_vtt(raw: bytes) -> list[dict[str, Any]]:
    text = raw.decode("utf-8", errors="replace").replace("\r", "")
    pattern = re.compile(
        r"(?m)^(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s+-->\s+"
        r"(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})[^\n]*\n(.*?)(?=\n\n|\Z)",
        re.S,
    )

    def ts(v: str) -> float:
        parts = [float(x) for x in v.split(":")]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        return parts[0] * 60 + parts[1]

    entries = []
    last_text = None
    for m in pattern.finditer(text):
        start, end = ts(m.group(1)), ts(m.group(2))
        body = _clean_text(m.group(3))
        if not body or body == last_text:
            continue
        last_text = body
        entries.append({"start": start, "duration": max(0.05, end - start), "text": body})
    return entries


def extract_signed_youtube_transcript(
    signed_url: str,
    target_lang: str = "th",
    expected_video_url: str | None = None,
) -> dict[str, Any]:
    raw_url = str(signed_url or "").strip()
    parsed = urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (host == "youtube.com" or host.endswith(".youtube.com")) or parsed.path != "/api/timedtext":
        raise RuntimeError("ลิงก์ซับจาก HAR ไม่ใช่ YouTube timedtext")
    qs = parse_qs(parsed.query)
    vid = str((qs.get("v") or [""])[0])
    language = str((qs.get("lang") or [""])[0])
    fmt = str((qs.get("fmt") or ["srv1"])[0]).lower()
    if not vid or not language:
        raise RuntimeError("ลิงก์ซับจาก HAR ขาดรหัสวิดีโอหรือภาษา")
    if expected_video_url:
        try:
            expected = _video_id(expected_video_url)
        except Exception:
            expected = ""
        if expected and expected != vid:
            raise RuntimeError("HAR นี้ไม่ตรงกับลิงก์ YouTube ของงาน")

    raw = _http_get(raw_url)
    if fmt == "srv1":
        entries = _parse_srv1(raw)
    elif fmt == "json3":
        entries = _parse_json3(raw)
    elif fmt == "vtt":
        entries = _parse_vtt(raw)
    else:
        entries = _parse_srv1(raw) or _parse_vtt(raw)
        if not entries:
            try:
                root = ET.fromstring(raw.decode("utf-8", errors="replace"))
                for node in root.findall(".//p"):
                    text_value = _clean_text("".join(node.itertext()))
                    if not text_value:
                        continue
                    start_ms = float(node.attrib.get("t") or 0)
                    dur_ms = float(node.attrib.get("d") or 0)
                    entries.append({"start": max(0.0, start_ms / 1000.0), "duration": max(0.05, dur_ms / 1000.0), "text": text_value})
            except Exception:
                pass
    if not entries:
        raise RuntimeError("signed subtitle จาก HAR ไม่มีข้อความ หรือหมดอายุแล้ว")
    return {
        "videoId": vid,
        "title": "",
        "language": language,
        "targetLanguage": target_lang,
        "targetReady": _base_lang(language) == _base_lang(target_lang),
        "origin": "bunny-har-signed-timedtext",
        "format": fmt,
        "entries": entries,
    }


def extract_youtube_transcript(
    url: str,
    target_lang: str = "th",
    source_lang: str = "auto",
    cookies_file: Path | None = None,
) -> dict[str, Any]:
    direct = _extract_direct(url, target_lang, source_lang, cookies_file)
    if direct and direct.get("entries"):
        return direct

    # Fallback for videos where the legacy timedtext track list is unavailable.
    info = _yt_info(url, cookies_file)
    language, formats, origin = _select_track(info, target_lang, source_lang)
    selected = _choose_format(formats)
    raw = _download(str(selected["url"]), info, cookies_file)
    ext = str(selected.get("ext") or "").lower()
    if ext == "srv1":
        entries = _parse_srv1(raw)
    elif ext == "json3":
        entries = _parse_json3(raw)
    else:
        entries = _parse_vtt(raw)
    if not entries:
        raise RuntimeError(f"คำบรรยาย YouTube ภาษา {language} ไม่มีข้อความ")

    target_ready = _base_lang(language) == _base_lang(target_lang)
    return {
        "videoId": str(info.get("id") or _video_id(url)),
        "title": str(info.get("title") or ""),
        "language": language,
        "targetLanguage": target_lang,
        "targetReady": target_ready,
        "origin": origin,
        "format": ext,
        "entries": entries,
    }


def slice_entries(entries: list[dict[str, Any]], chunk_start: float, chunk_duration: float) -> list[dict[str, Any]]:
    left = float(chunk_start)
    right = left + float(chunk_duration)
    out: list[dict[str, Any]] = []
    for item in entries:
        start = float(item.get("start") or 0)
        end = start + max(0.05, float(item.get("duration") or 0))
        if end <= left or start >= right:
            continue
        local_start = max(0.0, start - left)
        local_end = min(float(chunk_duration), end - left)
        text = _clean_text(str(item.get("text") or ""))
        if text and local_end > local_start:
            out.append({
                "start": round(local_start, 3),
                "duration": round(max(0.05, local_end - local_start), 3),
                "text": text,
            })
    return out


def transcript_xml(entries: list[dict[str, Any]]) -> str:
    root = ET.Element("transcript")
    for item in entries:
        node = ET.SubElement(root, "text", {
            "start": f"{float(item.get('start') or 0):.3f}".rstrip("0").rstrip("."),
            "dur": f"{float(item.get('duration') or 0):.3f}".rstrip("0").rstrip("."),
        })
        node.text = str(item.get("text") or "")
    return ET.tostring(root, encoding="unicode")
