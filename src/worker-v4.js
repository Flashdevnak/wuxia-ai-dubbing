import workerV3 from "./worker-v3.js";

const MOBILE_PART_SIZE = 1 * 1024 * 1024;

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

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

function encodeUploadState(state) {
  return b64urlEncode(JSON.stringify(state));
}

function isRealBrowser(request) {
  return Boolean(
    request.headers.get("sec-fetch-site") ||
    request.headers.get("sec-fetch-mode") ||
    request.headers.get("sec-ch-ua-mobile")
  );
}

function copyHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  return headers;
}

const APP_PATCH = String.raw`

// Android/Samsung upload compatibility patch.
// Convert Blob -> ArrayBuffer before XHR send. Some Android webviews/Samsung Internet
// can drop the socket when a sliced File/Blob is streamed directly.
xhrUploadPart = async function(url, blob, overallStart, totalBytes){
  let payload;
  try {
    payload = await blob.arrayBuffer();
  } catch (e) {
    throw new Error('อ่านส่วนไฟล์จากมือถือไม่สำเร็จ');
  }
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST',url,true);
    xhr.timeout=120000;
    xhr.responseType='text';
    xhr.setRequestHeader('x-access-key',getAccessKey());
    xhr.setRequestHeader('content-type','application/octet-stream');
    xhr.upload.onprogress=e=>{
      if(!e.lengthComputable)return;
      const sent=Math.min(totalBytes,overallStart+e.loaded);
      const pct=totalBytes?sent/totalBytes*100:0;
      $('#uploadPct').textContent=Math.floor(pct)+'%';
      $('#uploadBar').style.width=pct+'%';
      $('#uploadStatus').textContent='กำลังส่งไฟล์ · '+fmtBytes(sent)+' / '+fmtBytes(totalBytes);
    };
    xhr.onload=()=>{
      let data={};
      try{data=xhr.responseText?JSON.parse(xhr.responseText):{};}catch{}
      if(xhr.status===401){clearAccessKey();reject(new Error(data.error||'รหัสสำนักไม่ถูกต้อง'));return;}
      if(xhr.status>=200&&xhr.status<300){resolve(data);return;}
      reject(new Error(data.error||data.detail||('HTTP '+xhr.status)));
    };
    xhr.onerror=()=>reject(new Error('เครือข่ายมือถือปิดการเชื่อมต่อระหว่างส่งข้อมูล'));
    xhr.ontimeout=()=>reject(new Error('อัปโหลดส่วนนี้เกิน 120 วินาที'));
    xhr.onabort=()=>reject(new Error('การอัปโหลดถูกยกเลิก'));
    xhr.send(payload);
  });
};
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve app.js dynamically with the Android compatibility patch appended and no cache.
    if (url.pathname === "/app.js" && request.method === "GET") {
      const response = await workerV3.fetch(request, env);
      if (!response.ok) return response;
      const js = await response.text();
      const headers = copyHeaders(response);
      headers.set("content-type", "application/javascript; charset=utf-8");
      return new Response(js + APP_PATCH, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // Keep CI/server clients on the proven 4 MiB path, but use smaller 1 MiB chunks
    // for real browsers. The upload state is intentionally plain base64url JSON.
    if (url.pathname === "/api/uploads/start" && request.method === "POST" && isRealBrowser(request)) {
      const response = await workerV3.fetch(request, env);
      if (!response.ok) return response;
      const data = await response.json();
      const state = decodeUploadState(data.uploadId || "");
      if (state?.session && state?.fileId) {
        state.partSize = MOBILE_PART_SIZE;
        data.uploadId = encodeUploadState(state);
        data.partSize = MOBILE_PART_SIZE;
      }
      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: copyHeaders(response),
      });
    }

    return workerV3.fetch(request, env);
  },
};
