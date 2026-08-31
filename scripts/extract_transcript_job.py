from __future__ import annotations

import argparse
import base64
import json
from datetime import timedelta
from pathlib import Path

import srt

from worker_client import WorkerClient
from youtube_transcript import extract_youtube_transcript, extract_signed_youtube_transcript, transcript_xml


def build_cookie_file() -> Path | None:
    import os

    raw = (os.environ.get("YOUTUBE_COOKIES_B64") or "").strip()
    if not raw:
        return None
    data = base64.b64decode(raw)
    if not data.strip():
        return None
    path = Path("youtube-cookies.txt")
    path.write_bytes(data)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def translate_entries(
    client: WorkerClient,
    entries: list[dict],
    source_lang: str,
    target_lang: str,
) -> list[dict]:
    if not entries:
        return []
    out: list[dict] = []
    for start in range(0, len(entries), 12):
        batch = entries[start:start + 12]
        texts = [str(item.get("text") or "") for item in batch]
        durations = [max(0.1, float(item.get("duration") or 0.1)) for item in batch]
        translated = client.translate(texts, source_lang, target_lang, durations)
        if len(translated) != len(batch):
            raise RuntimeError("จำนวนบรรทัดคำแปลไม่ตรงกับคำบรรยายต้นฉบับ")
        for item, text in zip(batch, translated):
            out.append({
                "start": float(item.get("start") or 0),
                "duration": max(0.05, float(item.get("duration") or 0.05)),
                "text": str(text or item.get("text") or "").strip(),
            })
    return out


def write_srt(entries: list[dict], path: Path) -> None:
    subtitles = []
    for i, item in enumerate(entries, 1):
        start = max(0.0, float(item.get("start") or 0))
        dur = max(0.05, float(item.get("duration") or 0.05))
        subtitles.append(srt.Subtitle(
            index=i,
            start=timedelta(seconds=start),
            end=timedelta(seconds=start + dur),
            content=str(item.get("text") or "").strip(),
        ))
    path.write_text(srt.compose(subtitles), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--worker-url", required=True)
    ap.add_argument("--token", required=True)
    args = ap.parse_args()

    job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    job_id = str(job["id"])
    source_url = str(job.get("sourceUrl") or "").strip()
    source_lang = str(job.get("sourceLang") or "auto")
    target_lang = str(job.get("targetLang") or "th")
    client = WorkerClient(args.worker_url, args.token)

    try:
        client.patch_job(job_id, status="processing", progress=10, stage="กำลังอ่านคำบรรยายจาก YouTube")
        caption_url = str(job.get("captionUrl") or "").strip()
        if caption_url:
            data = extract_signed_youtube_transcript(
                caption_url,
                target_lang=target_lang,
                expected_video_url=source_url or None,
            )
            print(f"HAR signed caption source: {data.get('language')} {len(data.get('entries') or [])} lines")
        else:
            try:
                data = client.youtube_transcript(source_url, target_lang=target_lang, source_lang=source_lang)
                print(f"Cloudflare caption source: {data.get('origin')} {data.get('language')} {len(data.get('entries') or [])} lines")
            except Exception as worker_exc:
                print(f"Cloudflare caption extraction unavailable; using runner fallback: {worker_exc}")
                data = extract_youtube_transcript(
                    source_url,
                    target_lang=target_lang,
                    source_lang=source_lang,
                    cookies_file=build_cookie_file(),
                )
        entries = list(data.get("entries") or [])
        if not entries:
            raise RuntimeError("ไม่พบข้อความคำบรรยายในวิดีโอนี้")

        if bool(data.get("targetReady")):
            final_entries = entries
            client.patch_job(job_id, progress=65, stage=f"พบคำบรรยายภาษา {target_lang} แล้ว")
        else:
            client.patch_job(job_id, progress=45, stage=f"พบคำบรรยายภาษา {data.get('language') or source_lang} กำลังแปลเป็น {target_lang}")
            final_entries = translate_entries(client, entries, str(data.get("language") or source_lang), target_lang)

        work = Path("work_transcript")
        work.mkdir(parents=True, exist_ok=True)
        xml_path = work / f"transcript_{target_lang}.xml"
        srt_path = work / f"transcript_{target_lang}.srt"
        xml_path.write_text(transcript_xml(final_entries), encoding="utf-8")
        write_srt(final_entries, srt_path)

        xml_key = f"outputs/{job_id}/transcript_{target_lang}.xml"
        srt_key = f"outputs/{job_id}/transcript_{target_lang}.srt"
        xml_result = client.upload(xml_path, xml_key, "application/xml")
        srt_result = client.upload(srt_path, srt_key, "application/x-subrip")
        end_time = max((float(x.get("start") or 0) + float(x.get("duration") or 0) for x in final_entries), default=0.0)

        client.patch_job(
            job_id,
            status="completed",
            progress=100,
            stage=f"ดึงคำบรรยาย {target_lang} เสร็จแล้ว {len(final_entries)} บรรทัด",
            transcriptXmlKey=xml_key,
            subtitleKey=srt_key,
            transcriptLanguage=target_lang,
            transcriptSource=("bunny-har" if caption_url else "youtube"),
            duration=end_time,
            sizeBytes=int(xml_result.get("size") or 0) + int(srt_result.get("size") or 0),
            error=None,
        )
        print(json.dumps({
            "jobId": job_id,
            "language": target_lang,
            "lines": len(final_entries),
            "xmlKey": xml_key,
            "srtKey": srt_key,
            "youtubeLanguage": data.get("language"),
            "usedYouTubeTranslation": bool(data.get("targetReady")),
        }, ensure_ascii=False))
    except Exception as exc:
        try:
            client.fail(job_id, str(exc))
        except Exception:
            pass
        raise


if __name__ == "__main__":
    main()
