from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote

import requests


class WorkerClient:
    def __init__(self, base_url: str, token: str, timeout: int = 120):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        if not self.base_url.startswith(("https://", "http://")):
            raise ValueError("WORKER_URL must be http(s)")
        if not token:
            raise ValueError("WORKER_SHARED_TOKEN is required")

    @property
    def headers(self) -> dict[str, str]:
        # Keep internal runner traffic consistent with the browser-like headers
        # used by the production smoke tests. Some Cloudflare security layers
        # reject bare Python/urllib requests before they reach the Worker.
        return {
            "x-worker-token": self.token,
            "user-agent": "Mozilla/5.0 (Linux; Android 16; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
            "accept": "*/*",
            "accept-language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
        }

    def _json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", {}) or {})
        r = requests.request(method, self.base_url + path, headers=headers, timeout=self.timeout, **kwargs)
        if not r.ok:
            raise RuntimeError(f"Worker {method} {path} failed: {r.status_code} {r.text[:1200]}")
        if not r.content:
            return {}
        return r.json()

    def youtube_transcript(self, url: str, target_lang: str = "th", source_lang: str = "auto") -> dict[str, Any]:
        return self._json(
            "POST",
            "/api/internal/youtube-transcript",
            json={"url": url, "targetLang": target_lang, "sourceLang": source_lang},
        )

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self._json("GET", f"/api/internal/jobs/{quote(job_id)}")["job"]

    def patch_job(self, job_id: str, **patch: Any) -> dict[str, Any]:
        return self._json("PATCH", f"/api/internal/jobs/{quote(job_id)}", json=patch)["job"]

    def object_info(self, key: str) -> dict[str, Any]:
        return self._json("GET", "/api/internal/exists?key=" + quote(key, safe=""))

    def exists(self, key: str) -> bool:
        return bool(self.object_info(key).get("exists"))

    def is_paused(self, job_id: str) -> bool:
        job = self.get_job(job_id)
        return bool(job.get("pauseRequested") is True or job.get("status") == "paused")

    def download(self, key: str, destination: str | Path) -> Path:
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        url = self.base_url + "/api/internal/file?key=" + quote(key, safe="")
        with requests.get(url, headers=self.headers, stream=True, timeout=(30, 900)) as r:
            if not r.ok:
                raise RuntimeError(f"Download {key} failed: {r.status_code} {r.text[:1000]}")
            with destination.open("wb") as f:
                for chunk in r.iter_content(chunk_size=8 * 1024 * 1024):
                    if chunk:
                        f.write(chunk)
        return destination

    def iter_object(self, key: str, chunk_size: int = 8 * 1024 * 1024):
        url = self.base_url + "/api/internal/file?key=" + quote(key, safe="")
        with requests.get(url, headers=self.headers, stream=True, timeout=(30, 900)) as r:
            if not r.ok:
                raise RuntimeError(f"Download {key} failed: {r.status_code} {r.text[:1000]}")
            for chunk in r.iter_content(chunk_size=chunk_size):
                if chunk:
                    yield chunk

    def _start_upload(self, key: str, content_type: str, size: int | None = None) -> tuple[str, int]:
        payload: dict[str, Any] = {"key": key, "type": content_type}
        if size is not None:
            payload["size"] = int(size)
        init = self._json("POST", "/api/internal/uploads/start", json=payload)
        upload_id = init["uploadId"]
        part_size = min(int(init.get("partSize") or 32 * 1024 * 1024), 32 * 1024 * 1024)
        return upload_id, part_size

    def _upload_part(
        self,
        key: str,
        upload_id: str,
        part_number: int,
        data: bytes,
        final_total: int | None = None,
    ) -> dict[str, Any]:
        url = (
            f"/api/internal/uploads/part?key={quote(key, safe='')}"
            f"&uploadId={quote(upload_id, safe='')}&partNumber={part_number}"
        )
        if final_total is not None:
            url += f"&finalTotal={int(final_total)}"
        part = self._json(
            "PUT",
            url,
            data=data,
            headers={"content-type": "application/octet-stream", "content-length": str(len(data))},
        )
        return {"partNumber": int(part["partNumber"]), "etag": part.get("etag") or f"drive-{part_number}"}

    def _complete_upload(self, key: str, upload_id: str, parts: list[dict[str, Any]]) -> dict[str, Any]:
        return self._json(
            "POST",
            "/api/internal/uploads/complete",
            json={"key": key, "uploadId": upload_id, "parts": parts},
        )

    def upload(self, source: str | Path, key: str, content_type: str | None = None) -> dict[str, Any]:
        source = Path(source)
        content_type = content_type or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        size = source.stat().st_size
        upload_id, part_size = self._start_upload(key, content_type, size=size)
        parts: list[dict[str, Any]] = []
        with source.open("rb") as f:
            part_number = 1
            while True:
                data = f.read(part_size)
                if not data:
                    break
                parts.append(self._upload_part(key, upload_id, part_number, data))
                part_number += 1
        result = self._complete_upload(key, upload_id, parts)
        result.setdefault("size", size)
        return result

    @staticmethod
    def _read_stream_chunk(stream: BinaryIO, size: int) -> bytes:
        """Fill a chunk even when a pipe/socket returns short reads."""
        data = bytearray()
        while len(data) < size:
            piece = stream.read(size - len(data))
            if not piece:
                break
            data.extend(piece)
        return bytes(data)

    def upload_stream(self, stream: BinaryIO, key: str, content_type: str = "application/octet-stream") -> dict[str, Any]:
        # Google Drive resumable uploads can start without a known total. Pipe
        # reads may return short pieces, so fill each Drive chunk before sending.
        upload_id, part_size = self._start_upload(key, content_type, size=None)
        drive_granularity = 256 * 1024
        if part_size < drive_granularity or part_size % drive_granularity != 0:
            raise RuntimeError(f"Invalid Google Drive part size: {part_size}")

        parts: list[dict[str, Any]] = []
        uploaded = 0
        part_number = 1
        current = self._read_stream_chunk(stream, part_size)

        if not current:
            raise RuntimeError("Cannot upload an empty stream")

        while current:
            following = self._read_stream_chunk(stream, part_size)
            is_final = not following
            final_total = uploaded + len(current) if is_final else None
            parts.append(self._upload_part(key, upload_id, part_number, current, final_total=final_total))
            uploaded += len(current)
            part_number += 1
            current = following

        result = self._complete_upload(key, upload_id, parts)
        result.setdefault("size", uploaded)
        return result

    def mark_chunk_complete(self, job_id: str, index: int, total: int) -> dict[str, Any]:
        return self._json(
            "POST",
            "/api/internal/chunk-complete",
            json={"jobId": job_id, "index": index, "total": total},
        )

    def finish(self, job_id: str, output_key: str, subtitle_key: str | None, duration: float, size_bytes: int) -> dict[str, Any]:
        return self._json(
            "POST",
            "/api/internal/complete",
            json={
                "jobId": job_id,
                "outputKey": output_key,
                "subtitleKey": subtitle_key,
                "duration": duration,
                "sizeBytes": size_bytes,
                "deleteSource": False,
            },
        )

    def cleanup_job(self, job_id: str, kind: str) -> dict[str, Any]:
        if kind not in {"temp", "state"}:
            raise ValueError("cleanup kind must be temp or state")
        return self._json("POST", "/api/internal/cleanup-job", json={"jobId": job_id, "kind": kind})

    def fail(self, job_id: str, error: str) -> dict[str, Any]:
        return self._json("POST", "/api/internal/fail", json={"jobId": job_id, "error": error[:4000]})

    def translate(
        self,
        texts: list[str],
        source_lang: str,
        target_lang: str,
        durations: list[float] | None = None,
    ) -> list[str]:
        payload: dict[str, Any] = {
            "texts": texts,
            "sourceLang": source_lang,
            "targetLang": target_lang,
        }
        if durations is not None:
            payload["durations"] = [round(max(0.1, float(x)), 3) for x in durations]
        data = self._json("POST", "/api/internal/translate", json=payload)
        return [str(x) for x in data.get("translations", [])]


def from_env() -> WorkerClient:
    return WorkerClient(os.environ["WORKER_URL"], os.environ["WORKER_SHARED_TOKEN"])
