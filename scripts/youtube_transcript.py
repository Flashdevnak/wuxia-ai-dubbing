from __future__ import annotations

import html
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any
from urllib.request import HTTPCookieProcessor, Request, build_opener


PREFERRED_FORMATS = ("srv1", "json3", "vtt")


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
    raise RuntimeError("อ่านข้อมูลคำบรรยาย YouTube ไม่สำเร็จ: " + " | ".join(errors[-2:])[-900:])


def _base_lang(value: str) -> str:
    return str(value or "").lower().split("-")[0].split("_")[0]


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

    # Prefer a caption that is already in the requested target language. yt-dlp
    # exposes YouTube automatic translations with keys such as th-en as well.
    for origin, items in groups:
        for key, formats in items:
            if _base_lang(key) == target:
                return key, formats, origin

    # Otherwise keep the original caption timing/text and translate later.
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
    headers.setdefault("User-Agent", "Mozilla/5.0")
    handlers = []
    if cookies_file:
        try:
            jar = MozillaCookieJar(str(cookies_file))
            jar.load(ignore_discard=True, ignore_expires=True)
            handlers.append(HTTPCookieProcessor(jar))
        except Exception:
            pass
    opener = build_opener(*handlers)
    with opener.open(Request(url, headers=headers), timeout=60) as r:
        return r.read()


def _clean_text(value: str) -> str:
    value = html.unescape(str(value or ""))
    value = re.sub(r"<[^>]+>", "", value)
    value = value.replace("\u200b", " ").replace("\n", " ")
    return re.sub(r"\s+", " ", value).strip()


def _parse_srv1(raw: bytes) -> list[dict[str, Any]]:
    root = ET.fromstring(raw.decode("utf-8", errors="replace"))
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
        # Auto-VTT can repeat rolling caption windows; avoid adjacent duplicates.
        if not body or body == last_text:
            continue
        last_text = body
        entries.append({"start": start, "duration": max(0.05, end - start), "text": body})
    return entries


def extract_youtube_transcript(
    url: str,
    target_lang: str = "th",
    source_lang: str = "auto",
    cookies_file: Path | None = None,
) -> dict[str, Any]:
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
        "videoId": str(info.get("id") or ""),
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
