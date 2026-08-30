# ยุทธภพ AI Dubbing

เว็บ AI Dubbing ธีมจีนกำลังภายในสำหรับวิดีโอยาวหลายชั่วโมง รองรับอัปโหลดไฟล์/วางลิงก์ หลายภาษา พากย์ด้วย AI จัดการพื้นที่ และลบไฟล์คืนพื้นที่ได้

## สถาปัตยกรรมปัจจุบัน
- GitHub Pages: หน้า Preview
- Cloudflare Worker: API, Authentication, Workers AI และส่งงานเข้า GitHub Actions
- Google Drive: เก็บไฟล์ต้นฉบับ, chunk ชั่วคราว, ผลลัพธ์ MP4/SRT และสถานะงาน
- GitHub Actions: Faster-Whisper → Translate → Edge TTS → FFmpeg
- ไม่ใช้ Cloudflare R2

## ฟีเจอร์
- อัปโหลดไฟล์ใหญ่แบบ resumable เป็นช่วง 32 MB
- วางลิงก์วิดีโอที่ผู้ใช้มีสิทธิ์ใช้งาน
- รองรับคลิปยาวหลายชั่วโมงด้วยการแบ่งช่วงประมาณ 20 นาที
- ประมวลผลหลาย chunk พร้อมกัน
- หลายภาษาต้นฉบับและภาษาพากย์
- Workers AI สำหรับช่วยแปล พร้อม fallback ฝั่ง GitHub Actions
- Storage meter, รายการไฟล์, ลบไฟล์, Job history และ Auto cleanup
- Finalizer รวมวิดีโอแบบ streaming จึงไม่ต้องเก็บ final MP4 ทั้งก้อนบนดิสก์ Runner

## Preview
`https://flashdevnak.github.io/wuxia-ai-dubbing/`

หลัง deploy Cloudflare Worker แล้ว URL `*.workers.dev` จะเป็นเว็บใช้งานจริงแบบ same-origin กับ API ส่วน GitHub Pages ยังใช้เป็น Preview ได้

## Google Drive
Worker จะสร้างโฟลเดอร์ `Wuxia AI Dubbing` อัตโนมัติและเก็บไฟล์ของระบบไว้ในโฟลเดอร์นั้น โดยรักษา logical key ภายใน เช่น `uploads/`, `temp/`, `outputs/`, `_jobs/` และ `_state/`

การเชื่อม Drive ใช้ Google OAuth และควรจำกัดสิทธิ์ด้วย scope `drive.file` เพื่อให้แอปเข้าถึงไฟล์ที่แอปสร้างหรือเปิดใช้กับแอปเท่านั้น

## Pipeline
1. รับไฟล์อัปโหลดหรือ URL
2. สร้าง Job และส่ง `repository_dispatch`
3. แบ่งวิดีโอเป็นช่วงประมาณ 20 นาที
4. Faster-Whisper ถอดเสียงและตรวจภาษา
5. แปลเป็นภาษาปลายทาง
6. Edge TTS สร้างเสียงพากย์
7. FFmpeg ผสมเสียงและสร้าง chunk มาตรฐานเดียวกัน
8. รวม chunk เป็น MP4 และส่งกลับ Google Drive
9. รวม SRT และล้างไฟล์ชั่วคราวเมื่อเปิด Auto cleanup

## ไฟล์สำคัญ
- `public/` หน้าเว็บ
- `src/worker-v2.js` Cloudflare API + Google Drive + Workers AI
- `scripts/prepare_job.py` แบ่งวิดีโอยาวแบบ stream
- `scripts/dub_chunk.py` Whisper / Translate / TTS / FFmpeg
- `scripts/finalize_job.py` รวม MP4 แบบ streaming
- `scripts/worker_client.py` เชื่อม GitHub Actions กับ Worker
- `.github/workflows/dubbing.yml` AI pipeline
- `.github/workflows/deploy-cloudflare.yml` deploy Worker
- `wrangler.jsonc` Cloudflare bindings

> ใช้เฉพาะวิดีโอและลิงก์ที่คุณมีสิทธิ์ดาวน์โหลด แปล ดัดแปลง และพากย์ใหม่
