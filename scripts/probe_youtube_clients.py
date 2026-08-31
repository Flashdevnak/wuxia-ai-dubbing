from __future__ import annotations

import json
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests

VIDEO_ID = "Q3Ff-OExkB0"
STANDARD_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
ANDROID_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w"

PROFILES = [
    {
        "name": "ANDROID_NO_SDK",
        "key": ANDROID_KEY,
        "header_id": "3",
        "version": "20.10.38",
        "ua": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
        "client": {
            "hl": "en", "gl": "US", "clientName": "ANDROID",
            "clientVersion": "20.10.38",
            "userAgent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
        },
    },
    {
        "name": "ANDROID_VR",
        "key": STANDARD_KEY,
        "header_id": "28",
        "version": "1.71.26",
        "ua": "com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
        "client": {
            "hl": "en", "gl": "US", "clientName": "ANDROID_VR",
            "clientVersion": "1.71.26", "deviceMake": "Oculus", "deviceModel": "Quest 3",
            "androidSdkVersion": 32, "osName": "Android", "osVersion": "12L",
            "userAgent": "com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
            "timeZone": "UTC", "utcOffsetMinutes": 0,
        },
    },
    {
        "name": "IOS",
        "key": STANDARD_KEY,
        "header_id": "5",
        "version": "21.26.4",
        "ua": "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
        "client": {
            "hl": "en", "gl": "US", "clientName": "IOS", "clientVersion": "21.26.4",
            "deviceMake": "Apple", "deviceModel": "iPhone16,2", "osName": "iPhone",
            "osVersion": "18.3.2.22D82", "userAgent": "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
            "timeZone": "UTC", "utcOffsetMinutes": 0,
        },
    },
    {
        "name": "VISIONOS",
        "key": STANDARD_KEY,
        "header_id": "101",
        "version": "1.02",
        "ua": "com.google.ios.youtube/1.02 (RealityDevice17,1; U; CPU visionOS 26_5 like Mac OS X;)",
        "client": {
            "hl": "en", "gl": "US", "clientName": "VISIONOS", "clientVersion": "1.02",
            "deviceMake": "Apple", "deviceModel": "RealityDevice17,1", "osName": "visionOS",
            "osVersion": "26.5.23O471", "userAgent": "com.google.ios.youtube/1.02 (RealityDevice17,1; U; CPU visionOS 26_5 like Mac OS X;)",
            "timeZone": "UTC", "utcOffsetMinutes": 0,
        },
    },
]


def caption_variant(base_url: str, target: str = "th") -> list[str]:
    u = urlparse(base_url)
    q = dict(parse_qsl(u.query, keep_blank_values=True))
    variants = []
    for mode in ("tlang", "lang", "source"):
        qq = dict(q)
        qq["fmt"] = "srv1"
        if mode == "tlang":
            qq["tlang"] = target
        elif mode == "lang":
            qq.pop("tlang", None)
            qq["lang"] = target
        else:
            qq.pop("tlang", None)
        variants.append(urlunparse((u.scheme, u.netloc, u.path, u.params, urlencode(qq), u.fragment)))
    return variants


def probe(profile: dict) -> dict:
    endpoint = f"https://www.youtube.com/youtubei/v1/player?key={profile['key']}&prettyPrint=false"
    headers = {
        "Content-Type": "application/json",
        "User-Agent": profile["ua"],
        "X-YouTube-Client-Name": profile["header_id"],
        "X-YouTube-Client-Version": profile["version"],
    }
    payload = {
        "context": {"client": profile["client"]},
        "videoId": VIDEO_ID,
        "contentCheckOk": True,
        "racyCheckOk": True,
    }
    result = {"profile": profile["name"]}
    try:
        r = requests.post(endpoint, headers=headers, json=payload, timeout=25)
        result["playerHttp"] = r.status_code
        if not r.ok:
            result["error"] = f"player HTTP {r.status_code}"
            return result
        data = r.json()
        ps = data.get("playabilityStatus") or {}
        result["playability"] = ps.get("status")
        result["reason"] = ps.get("reason")
        renderer = ((data.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {})
        tracks = renderer.get("captionTracks") or []
        result["tracks"] = len(tracks)
        result["langs"] = [x.get("languageCode") for x in tracks[:8]]
        if not tracks:
            return result
        target = next((x for x in tracks if str(x.get("languageCode") or "").split("-")[0] == "th"), None)
        source = target or tracks[0]
        result["selectedLang"] = source.get("languageCode")
        for idx, cap_url in enumerate(caption_variant(source.get("baseUrl") or ""), 1):
            try:
                c = requests.get(cap_url, headers={"User-Agent": profile["ua"]}, timeout=25)
                result[f"caption{idx}Http"] = c.status_code
                result[f"caption{idx}Bytes"] = len(c.content)
                if c.ok and len(c.content) > 100:
                    result["captionOk"] = True
                    return result
            except Exception as exc:
                result[f"caption{idx}Error"] = type(exc).__name__
        return result
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result


results = [probe(p) for p in PROFILES]
for item in results:
    print(json.dumps(item, ensure_ascii=False))

if not any(x.get("captionOk") for x in results):
    raise SystemExit("NO_WORKING_CLIENT")
