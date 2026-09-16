from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    wrangler = (root / 'wrangler.jsonc').read_text(encoding='utf-8')
    worker = (root / 'src' / 'worker-r3.js').read_text(encoding='utf-8')
    ui = (root / 'public' / 'r3-studio.js').read_text(encoding='utf-8')
    guard = (root / 'scripts' / 'dub_guard.py').read_text(encoding='utf-8')

    assert '"main": "src/worker-r3.js"' in wrangler
    for marker in (
        'r3SmartStudio', '/api/r3/batch', '/repair', 'r3-studio.js',
        'glossaryMemory', 'timingRescue', 'qualityGate', 'segmentRepair',
        'batchQueue', 'quotaCacheGuard',
    ):
        assert marker in worker, marker
    for marker in ('Smart Dubbing Studio R3', 'r3Glossary', 'r3BatchBtn', 'r3-repair-btn', 'r3ContextTranslation'):
        assert marker in ui, marker
    for marker in ('AUDIO_PROFILE_VERSION = 6', 'translation cache HIT', 'compact_thai', 'R3 Quality Gate', 'quota_estimate'):
        assert marker in guard, marker

    print('R3 runtime integration acceptance: PASS')


if __name__ == '__main__':
    main()
