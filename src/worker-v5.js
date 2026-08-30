import workerV4 from "./worker-v4.js";

const DIRECT_MOBILE_PART_SIZE = 4 * 1024 * 1024;
const DIRECT_DESKTOP_PART_SIZE = 16 * 1024 * 1024;

function b64urlDecode(text) {
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function decodeUploadState(value) {
  try {
    return JSON.parse(b64urlDecode(value));
  } catch {
    return null;
  }
}

function isBrowser(request) {
  return Boolean(
    request.headers.get("sec-fetch-site") ||
    request.headers.get("sec-fetch-mode") ||
    request.headers.get("sec-ch-ua") ||
    request.headers.get("sec-ch-ua-mobile")
  );
}

function isMobileBrowser(request) {
  const mobile = request.headers.get("sec-ch-ua-mobile") || "";
  const ua = request.headers.get("user-agent") || "";
  return mobile.includes("?1") || /Android|iPhone|iPad|Mobile/i.test(ua);
}

function copyHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/uploads/start" && request.method === "POST" && isBrowser(request)) {
      const response = await workerV4.fetch(request, env);
      if (!response.ok) return response;

      const data = await response.json();
      const state = decodeUploadState(data.uploadId || "");
      if (!state?.session || !state?.fileId) {
        return new Response(JSON.stringify({ error: "Google Drive session missing" }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }

      // The OAuth bearer token stays inside the Worker. The browser only receives
      // the resumable session URI created by Google Drive, then sends file bytes
      // directly to Google instead of proxying every chunk through Cloudflare.
      data.directUpload = true;
      data.directSession = state.session;
      data.partSize = isMobileBrowser(request) ? DIRECT_MOBILE_PART_SIZE : DIRECT_DESKTOP_PART_SIZE;

      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: copyHeaders(response),
      });
    }

    return workerV4.fetch(request, env);
  },
};
