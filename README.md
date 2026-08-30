# ยุทธภพ AI Dubbing

เว็บ AI Dubbing ธีมจีนกำลังภายใน สำหรับวิดีโอยาวหลายชั่วโมง รองรับอัปโหลดไฟล์/ลิงก์ หลายภาษา พากย์ด้วย AI จัดการพื้นที่ และลบไฟล์คืนพื้นที่ได้

## สถานะระบบ
- ✅ Frontend ธีมยุทธภพ + Responsive มือถือ/แท็บเล็ต/คอม
- ✅ หมอก/ประกาย/Shimmer/Qi loading และ progress งาน
- ✅ GitHub Pages สำหรับ Preview
- ✅ Cloudflare Worker v2 + R2 multipart upload + Range streaming
- ✅ Storage meter / รายการไฟล์ / ลบไฟล์ / Job history
- ✅ Workers AI สำหรับช่วยแปลหลายภาษา (มี fallback ฝั่ง GitHub Actions)
- ✅ GitHub Actions AI pipeline: แบ่งคลิป 20 นาที → Faster-Whisper → แปล → Edge TTS → FFmpeg → รวม MP4
- ✅ รองรับคลิปยาวโดยสตรีม chunk เข้า/ออก R2 ไม่ต้องเก็บวิดีโอทั้งก้อนบน GitHub Runner
- ✅ Auto cleanup ไฟล์ชั่วคราวหลังงานสำเร็จ

## URL Preview
`https://flashdevnak.github.io/wuxia-ai-dubbing/`

GitHub Pages เป็นหน้า Preview จนกว่าจะ deploy Cloudflare backend. หลัง deploy แล้ว URL `*.workers.dev` จะเป็นเว็บใช้งานจริงแบบ same-origin กับ API/R2.

## ตั้งค่า Cloudflare ผ่าน GitHub Actions
Workflow: `.github/workflows/deploy-cloudflare.yml`

เพิ่ม Repository Secrets ที่ **Settings → Secrets and variables → Actions**:

| Secret | ใช้ทำอะไร |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy Worker / สร้าง R2 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID ของ Cloudflare |
| `WUXIA_ACCESS_KEY` | รหัสสำนักที่กรอกบนหน้าเว็บ |
| `WORKER_SHARED_TOKEN` | รหัสภายในระหว่าง Worker ↔ GitHub Actions (ควรยาวและสุ่ม) |
| `GH_DISPATCH_TOKEN` | Fine-grained GitHub token สำหรับ Worker ส่ง `repository_dispatch` เข้า repo นี้ |

จากนั้นไป **Actions → Deploy Cloudflare Backend → Run workflow**. Workflow จะพยายามสร้าง bucket `wuxia-ai-dubbing-media`, deploy Worker, ผูก Workers AI และตั้ง Worker secrets ให้อัตโนมัติ.

### Cloudflare API Token ที่ต้องใช้
สร้าง token ที่อนุญาตเฉพาะ account นี้สำหรับ Workers Scripts และ R2 ที่จำเป็นต่อการ deploy. ไม่ต้องใส่ token ลง source code.

### GH_DISPATCH_TOKEN
ใช้ Fine-grained PAT จำกัดเฉพาะ repo `Flashdevnak/wuxia-ai-dubbing` และสิทธิ์เท่าที่จำเป็นสำหรับ Repository Dispatch. เก็บเป็น GitHub Secret เท่านั้น.

## กระบวนการพากย์
1. ผู้ใช้วางลิงก์ที่มีสิทธิ์ใช้งาน หรืออัปโหลดไฟล์แบบ multipart/resume
2. Worker สร้าง Job ใน R2 และส่ง `repository_dispatch`
3. `prepare_job.py` อ่านวิดีโอแบบ stream และแบ่งเป็นช่วงประมาณ 20 นาที
4. Matrix jobs ประมวลผลแต่ละช่วงพร้อมกันสูงสุด 4 งาน
5. Faster-Whisper ถอดเสียงและตรวจภาษา
6. Workers AI ช่วยแปล; ถ้าใช้งานไม่ได้จะ fallback ไปตัวแปลฟรีใน runner
7. Edge TTS สร้างเสียงภาษาปลายทาง
8. FFmpeg duck เสียงต้นฉบับระหว่างเสียงพากย์และสร้าง H.264/AAC MPEG-TS ที่รูปแบบเหมือนกันทุกช่วง
9. Finalizer สตรีมทุกช่วงต่อกันเป็น fragmented MP4 แล้ว multipart upload กลับ R2 โดยตรง
10. รวม SRT ด้วยเวลาจริงของแต่ละช่วง และล้าง `temp/` เมื่อเปิด Auto cleanup

## ไฟล์สำคัญ
- `public/` หน้าเว็บ
- `src/worker-v2.js` Cloudflare API / R2 / Workers AI / Jobs
- `scripts/prepare_job.py` เตรียมและแบ่งคลิปยาวแบบ stream
- `scripts/dub_chunk.py` Whisper / Translate / TTS / FFmpeg
- `scripts/finalize_job.py` รวม MP4 แบบ streaming
- `scripts/worker_client.py` ส่งไฟล์/สถานะระหว่าง Actions กับ Worker
- `.github/workflows/dubbing.yml` AI pipeline
- `.github/workflows/deploy-cloudflare.yml` deploy backend
- `wrangler.jsonc` Cloudflare bindings

## หมายเหตุ
- โหมด “แยกผู้พูด” ในสายฟรีปัจจุบันเป็น heuristic เปลี่ยนเสียงหลังช่วงเงียบ ไม่ใช่ biometric speaker identification.
- การแยกเสียงพูดออกจากเพลงแบบ Demucs คุณภาพสูงสามารถเพิ่มภายหลังได้ แต่จะใช้ CPU/เวลามากขึ้นมากบน runner ฟรี.
- Workers AI / R2 / GitHub Actions / Edge TTS ต่างมีโควตาและเงื่อนไขของบริการ ควรดูหน้า Storage ในเว็บและลบงานเก่าเมื่อไม่ใช้แล้ว.
- ใช้เฉพาะวิดีโอ/ลิงก์ที่คุณมีสิทธิ์ดาวน์โหลด แปล ดัดแปลง และพากย์ใหม่.
