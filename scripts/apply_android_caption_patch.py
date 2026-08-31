from pathlib import Path

p = Path('src/youtube.js')
text = p.read_text(encoding='utf-8')

if 'const INNERTUBE_API_KEY =' not in text:
    anchor = "const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';\n"
    if anchor not in text:
        raise SystemExit('UA anchor missing')
    text = text.replace(anchor, anchor + "const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';\n", 1)

fn = '''async function androidTranscript(id, targetLang, sourceLang) {
  try {
    const androidUA = 'com.google.android.youtube/19.47.53 (Linux; U; Android 14) gzip';
    const res = await fetchTimeout(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': androidUA,
          'x-youtube-client-name': '3',
          'x-youtube-client-version': '19.47.53',
        },
        body: JSON.stringify({
          context: {
            client: {
              hl: 'en',
              gl: 'US',
              clientName: 'ANDROID',
              clientVersion: '19.47.53',
              androidSdkVersion: 34,
              userAgent: androidUA,
            },
          },
          videoId: id,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      },
      10000,
    );
    if (!res.ok) return null;
    const player = await res.json();
    const { tracks, translations } = tracksFromPlayer(player);
    if (!tracks.length) return null;
    const chosen = chooseTrack(tracks, targetLang, sourceLang);
    if (!chosen?.baseUrl) return null;
    const target = baseLang(targetLang);
    const exact = baseLang(chosen.languageCode) === target;
    const canTranslate = chosen.isTranslatable === true || translations.some(x => baseLang(x.languageCode) === target);
    const attempts = [];
    if (exact) attempts.push({ url: signedVariant(chosen.baseUrl, { fmt: 'srv1' }), language: chosen.languageCode, ready: true, origin: 'innertube-android-exact' });
    if (!exact && canTranslate) {
      attempts.push({ url: signedVariant(chosen.baseUrl, { tlang: targetLang, fmt: 'srv1' }), language: targetLang, ready: true, origin: 'innertube-android-translate' });
      attempts.push({ url: signedVariant(chosen.baseUrl, { lang: targetLang, fmt: 'srv1' }), language: targetLang, ready: true, origin: 'innertube-android-language' });
    }
    attempts.push({ url: signedVariant(chosen.baseUrl, { fmt: 'srv1' }), language: chosen.languageCode, ready: exact, origin: 'innertube-android-source' });
    for (const attempt of attempts) {
      const hit = await fetchCaption(attempt.url, id);
      if (hit?.entries?.length) {
        return {
          videoId: id,
          title: String(player?.videoDetails?.title || ''),
          language: attempt.language,
          targetLanguage: targetLang,
          targetReady: attempt.ready,
          origin: attempt.origin,
          format: 'srv1',
          entries: hit.entries,
        };
      }
    }
  } catch {}
  return null;
}

'''
if 'async function androidTranscript(' not in text:
    anchor = 'async function signedYouTubeTranscript(id, targetLang, sourceLang) {'
    if anchor not in text:
        raise SystemExit('signed transcript anchor missing')
    text = text.replace(anchor, fn + anchor, 1)

if 'const android = await androidTranscript' not in text:
    anchor = "  const direct = await directUnsigned(id, targetLang, sourceLang);\n  if (direct?.entries?.length) return { videoId: id, targetLanguage: targetLang, format: 'srv1', ...direct };\n\n"
    if anchor not in text:
        raise SystemExit('fetch order anchor missing')
    text = text.replace(anchor, anchor + "  const android = await androidTranscript(id, targetLang, sourceLang);\n  if (android?.entries?.length) return android;\n\n", 1)

p.write_text(text, encoding='utf-8')
print('Android InnerTube caption path added')
