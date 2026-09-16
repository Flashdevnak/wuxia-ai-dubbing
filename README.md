# Wuxia AI Dubbing

Full automatic Thai dubbing pipeline for video files and YouTube-assisted workflows.

## Runtime architecture

- Cloudflare Worker front-end/API
- Cloudflare R2 temporary-only storage (`wuxia-ai-dubbing-files`)
- GitHub Actions media pipeline
- Workers AI translation with guarded fallbacks
- Whisper fallback for timing/transcript when caption timing is unavailable
- Edge TTS Thai voice profiles
- FFmpeg final mix/subtitle render

## Temporary storage policy

This project does not use R2 as a permanent media library.

- Active jobs are protected from cleanup.
- Completed outputs are retained for a short download window.
- After a download begins, the output is queued for deletion after roughly 10 minutes.
- Completed jobs are capped at roughly 30 minutes of retention.
- Scheduled cleanup removes expired uploads, temp files, state, outputs and job metadata.

## Input modes

1. Upload a video file directly.
2. Paste a YouTube URL for caption/timestamp assistance.
3. Hybrid mode: paste a YouTube URL, use the DLBunny helper to download the MP4 yourself, then upload the MP4 back to this app. The app uses available YouTube caption timing first and falls back to Whisper when needed.

The app does not scrape or bypass DLBunny CAPTCHA.

## Thai voice profiles

- Auto cast
- Child boy / child girl
- Teen boy / teen girl
- Adult male / adult female
- Mature male / mature female
- Elder male / elder female
- Narrator
- Generic male / female

Auto cast is heuristic scene/voice selection, not biometric speaker identification.

## QA

CI validates JavaScript/Python syntax, Worker bundle dry-run, R2 multipart upload-resume-download-delete behavior, Thai voice-profile TTS samples, Thai subtitle rendering, audio mixing and final MP4 output.
