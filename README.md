# ยุทธภพ AI Dubbing

เว็บ AI Dubbing ธีมจีนกำลังภายใน รองรับการออกแบบงานสำหรับวิดีโอยาวหลายชั่วโมง หลายภาษา อัปโหลด/ลิงก์ จัดการพื้นที่ และเตรียม backend Cloudflare Workers + R2.

## สถานะปัจจุบัน
- ✅ Frontend ยุทธภพพร้อมใช้งานและ deploy ผ่าน GitHub Pages
- ✅ Responsive มือถือ/แท็บเล็ต/คอม
- ✅ เอฟเฟกต์หมอก ประกาย ปุ่ม shimmer และ Qi loading
- ✅ UI สำหรับลิงก์/อัปโหลด หลายภาษา งาน ประวัติ Storage และลบไฟล์
- ✅ Cloudflare Worker + R2 API source อยู่ใน `src/worker.js`
- ⏳ GitHub Pages เป็น **Preview frontend** เท่านั้น จนกว่าจะเชื่อม object storage/backend จริง
- ⏳ AI pipeline (Whisper → Translate → TTS → FFmpeg) จะต่อเข้าคิวประมวลผลแยกจาก Pages

## GitHub Pages
Workflow: `.github/workflows/pages.yml`

หลังเปิด **Settings → Pages → Source: GitHub Actions** เว็บจะ deploy อัตโนมัติเมื่อ push เข้า `main`.

URL ปกติของ repo นี้:
`https://flashdevnak.github.io/wuxia-ai-dubbing/`

## Cloudflare backend
```bash
npm install
npx wrangler r2 bucket create wuxia-ai-dubbing-media
npm run deploy
```

## โครงสร้าง
- `public/` หน้าเว็บ
- `src/worker.js` API สำหรับ Jobs / Storage / Multipart upload
- `wrangler.jsonc` Cloudflare Worker + R2 binding
- `.github/workflows/` GitHub Pages และ validation

> ใช้ลิงก์/วิดีโอที่คุณมีสิทธิ์ดาวน์โหลดและดัดแปลงเท่านั้น
