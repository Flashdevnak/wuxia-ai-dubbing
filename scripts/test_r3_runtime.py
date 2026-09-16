from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    wrangler = (root / 'wrangler.jsonc').read_text(encoding='utf-8')
    worker = (root / 'src' / 'worker-r3.js').read_text(encoding='utf-8')
    fast_worker_path = root / 'src' / 'worker-fast.js'
    fast_worker = fast_worker_path.read_text(encoding='utf-8') if fast_worker_path.exists() else ''
    pair_worker_path = root / 'src' / 'worker-pairfix.js'
    pair_worker = pair_worker_path.read_text(encoding='utf-8') if pair_worker_path.exists() else ''
    ui = (root / 'public' / 'r3-studio.js').read_text(encoding='utf-8')
    guard = (root / 'scripts' / 'dub_guard.py').read_text(encoding='utf-8')

    direct_r3 = '"main": "src/worker-r3.js"' in wrangler
    wrapped_r3 = '"main": "src/worker-fast.js"' in wrangler and "import r3Worker from './worker-r3.js'" in fast_worker
    pair_wrapped_r3 = (
        '"main": "src/worker-pairfix.js"' in wrangler
        and "import fastWorker from './worker-fast.js'" in pair_worker
        and "import r3Worker from './worker-r3.js'" in fast_worker
    )
    assert direct_r3 or wrapped_r3 or pair_wrapped_r3
    if wrapped_r3 or pair_wrapped_r3:
        for marker in ('uploadAcceleration', 'uploadConcurrencyMax', 'upload-fast.js'):
            assert marker in fast_worker, marker
    if pair_wrapped_r3:
        for marker in ('separateAudioPairRecovery', 'pair-recovery.js', 'attach-audio'):
            assert marker in pair_worker, marker

    for marker in (
        'r3SmartStudio', '/api/r3/batch', '/repair', 'r3-studio.js',
        'glossaryMemory', 'timingRescue', 'qualityGate', 'finalQualityGate',
        'segmentRepair', 'batchQueue', 'quotaCacheGuard', '/api/internal/complete',
    ):
        assert marker in worker, marker
    for marker in (
        'Smart Dubbing Studio R3', 'r3Glossary', 'r3BatchBtn', 'r3-repair-btn',
        'r3ContextTranslation', 'wuxia-r3-project-last-v1', 'advanceEpisode',
    ):
        assert marker in ui, marker
    for marker in (
        'AUDIO_PROFILE_VERSION = 6', 'translation cache HIT', 'compact_thai',
        'R3 Quality Gate', 'quota_estimate',
    ):
        assert marker in guard, marker

    print('R3 runtime integration acceptance: PASS')


if __name__ == '__main__':
    main()
