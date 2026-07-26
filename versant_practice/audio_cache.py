import hashlib


def cache_key(text: str, accent: str, voice: str, tts_model: str) -> str:
    raw = f"{text}|{accent}|{voice}|{tts_model}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
