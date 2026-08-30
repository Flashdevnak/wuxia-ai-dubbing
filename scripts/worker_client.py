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
        return {"x-worker-token": self.token}

    def _json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", {}) or {})
        r = requests.request(method, self.base_url + path, headers=headers, timeout=self.timeout, **kwargs)
        if not r.ok:
            raise RuntimeError(f"Worker {method} {path} failed: {r.status_code} {r.text[:1200]}")
        if not r.content:
            return {}
        return r.json()

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self._json("GET", f"/api/internal/jobs/{quote(job_id)}")["job"]

    def patch_job(self, job_id: str, **patch: Any) -> dict[str, Any]:
        return self._json("PATCH", f"/api/internal/jobs/{quote(job_id)}", json=patch)["job"]

    def download(self, key: str, destination: str | Path) -> Path:
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        url = self.base_url + "/api/internal/file?key=" + quote(key, safe="")
        with requests.get(url, headers=self.headers, stream=True, timeout=(30, 600)) as r:
            if not r.ok:
                raise RuntimeError(f"Download {key} failed: {r.status_code} {r.text[:1000]}")
            with destination.open("wb") as f:
                for chunk in r.iter_content(chunk_size=8 * 1024 * 1024):
                    if chunk:
                        f.write(chunk)
        return destination

    def iter_object(self, key: str, chunk_size: int = 8 * 1024 * 1024):
        url = self.base_url + "/api/internal/file?key=" + quote(key, safe="")
        with requests.get(url, headers=self.headers, stream=True, timeout=(30, 600)) as r:
            if not r.ok:
                raise RuntimeError(f"Download {key} failed: {r.status_code} {r.text[:1000]}")
            for chunk in r.iter_content(chunk_size=chunk_size):
                if chunk:
                    yield chunk

    def _start_upload(self, key: str, content_type: str) -> tuple[str, int]:
        init = self._json("POST", "/api/internal/uploads/start", json={"key": key, "type": content_type})
        upload_id = init["uploadId"]
        part_size = min(int(init.get("partSize") or 32 * 1024 * 1024), 32 * 1024 * 1024)
        return upload_id, part_size

    def _upload_part(self, key: str, upload_id: str, part_number: int, data: bytes) -> dict[str, Any]:
        url = (
            f"/api/internal/uploads/part?key={quote(key, safe='')}"
            f"&uploadId={quote(upload_id, safe='')}&partNumber={part_number}"
        )
        part = self._json(
            "PUT",
            url,
            data=data,
            headers={"content-type": "application/octet-stream", "content-length": str(len(data))},
        )
        return {"partNumber": int(part["partNumber"]), "etag": part["etag"]}

    def _complete_upload(self, key: str, upload_id: str, parts: list[dict[str, Any]]) -> dict[str, Any]:
        return self._json(
            "POST",
            "/api/internal/uploads/complete",
            json={"key": key, "uploadId": upload_id, "parts": parts},
        )

    def upload(self, source: str | Path, key: str, content_type: str | None = None) -> dict[str, Any]:
        source = Path(source)
        content_type = content_type or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        upload_id, part_size = self._start_upload(key, content_type)
        parts: list[dict[str, Any]] = []
        with source.open("rb") as f:
            part_number = 1
            while True:
                data = f.read(part_size)
                if not data:
                    break
                parts.append(self._upload_part(key, upload_id, part_number, data))
                part_number += 1
        return self._complete_upload(key, upload_id, parts)

    def upload_stream(self, stream: BinaryIO, key: str, content_type: str = "application/octet-stream") -> dict[str, Any]:
        upload_id, part_size = self._start_upload(key, content_type)
        parts: list[dict[str, Any]] = []
        total = 0
        part_number = 1
        while True:
            data = stream.read(part_size)
            if not data:
                break
            total += len(data)
            parts.append(self._upload_part(key, upload_id, part_number, data))
            part_number += 1
        result = self._complete_upload(key, upload_id, parts)
        result.setdefault("size", total)
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

    def fail(self, job_id: str, error: str) -> dict[str, Any]:
        return self._json("POST", "/api/internal/fail", json={"jobId": job_id, "error": error[:4000]})

    def translate(self, texts: list[str], source_lang: str, target_lang: str) -> list[str]:
        data = self._json(
            "POST",
            "/api/internal/translate",
            json={"texts": texts, "sourceLang": source_lang, "targetLang": target_lang},
        )
        return [str(x) for x in data.get("translations", [])]


def from_env() -> WorkerClient:
    return WorkerClient(os.environ["WORKER_URL"], os.environ["WORKER_SHARED_TOKEN"])
