from r3_studio import (
    apply_glossary, batch_plan, build_voice_map, cache_key, compact_thai,
    episode_defaults, quality_gate, quota_estimate, repair_plan, stable_speaker_ids,
    timing_plan,
)


def main():
    g = episode_defaults({"series":"ทดสอบ","season":2,"episode":8,"glossary":{"宗主":"ท่านเจ้าสำนัก"}})["glossary"]
    assert apply_glossary("宗主回宗门", g) == "ท่านเจ้าสำนัก回สำนัก"
    entries = [{"start":0,"end":1,"speaker":"A"},{"start":1.1,"end":2,"speaker":"B"},{"start":2.1,"end":3,"speaker":"A"}]
    speakers = stable_speaker_ids(entries)
    assert speakers == ["speaker-1","speaker-2","speaker-1"]
    m1 = build_voice_map(speakers,["v1","v2","v3"])
    m2 = build_voice_map(speakers,["v1","v2","v3"])
    assert m1 == m2 and m1["speaker-1"] == m1["speaker-1"]
    assert timing_plan(2.0,2.0)["strategy"] == "natural"
    assert timing_plan(2.15,2.0)["strategy"] == "tempo"
    assert timing_plan(3.0,2.0)["strategy"] == "rewrite_then_tempo"
    assert compact_thai("เพราะเหตุใดในตอนนี้จะต้องเป็นอย่างมาก", 1.5)
    assert cache_key("zh","th","x",g) == cache_key("zh","th","x",g)
    assert quality_gate(segments=3, translated=3, tts_ok=3, output_size=10, duration=2, has_audio=True).ok
    assert not quality_gate(segments=3, translated=3, tts_ok=2, output_size=10, duration=2, has_audio=True).ok
    assert repair_plan("j1",[2,2,1],"retranslate")["segments"] == [1,2]
    b = batch_plan([{"sourceKey":"uploads/a.mp4","episode":1},{"youtubeUrl":"https://youtu.be/x","episode":2}],2)
    assert len(b["jobs"]) == 2 and b["maxParallel"] == 2
    q = quota_estimate(duration_seconds=600, segments=120, cached_segments=60)
    assert q["translationCallsApprox"] == 5 and q["cacheReusePercent"] == 50.0
    print("R3 Smart Dubbing Studio acceptance: PASS")


if __name__ == "__main__":
    main()
