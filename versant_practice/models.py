from dataclasses import dataclass, field


@dataclass(frozen=True)
class AudioAsset:
    accent: str  # 例: "en-US"。MVPでは生成済み音声がなくてもレコード自体は作れる
    voice: str
    tts_model: str
    cache_key: str
    path: str | None = None  # audio_cache/配下の生成済みファイルパス。未生成ならNone


@dataclass(frozen=True)
class Problem:
    id: str
    text: str
    script_segments: list[str]
    char_count: int
    difficulty: str  # "beginner" / "intermediate" / "advanced"（docs/decisions.md参照）
    audio: list[AudioAsset] = field(default_factory=list)
    source: str = "unknown"
    source_ref: str = ""
