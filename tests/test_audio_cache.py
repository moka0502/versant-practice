from versant_practice.audio_cache import cache_key


def test_cache_key_is_deterministic():
    a = cache_key("Hello world.", "en-US", "alloy", "tts-1")
    b = cache_key("Hello world.", "en-US", "alloy", "tts-1")
    assert a == b


def test_cache_key_differs_by_text():
    a = cache_key("Hello world.", "en-US", "alloy", "tts-1")
    b = cache_key("Goodbye world.", "en-US", "alloy", "tts-1")
    assert a != b


def test_cache_key_differs_by_accent():
    a = cache_key("Hello world.", "en-US", "alloy", "tts-1")
    b = cache_key("Hello world.", "en-GB", "alloy", "tts-1")
    assert a != b


def test_cache_key_differs_by_voice_and_model():
    base = cache_key("Hello world.", "en-US", "alloy", "tts-1")
    assert base != cache_key("Hello world.", "en-US", "nova", "tts-1")
    assert base != cache_key("Hello world.", "en-US", "alloy", "tts-1-hd")
