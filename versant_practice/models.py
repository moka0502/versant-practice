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
    char_count: int  # 参考値（TTS音声の長さ推定等に使う可能性があるため保持）。難易度判定には使わない
    word_count: int  # 難易度判定の基準（docs/decisions.md参照）
    difficulty: str  # "beginner" / "intermediate" / "advanced"
    audio: list[AudioAsset] = field(default_factory=list)
    source: str = "unknown"
    source_ref: str = ""
    verified: bool = False  # judge_audio.pyの文字起こし一致チェックを通過したか。配信可否の唯一の判定基準
    set_number: int = 1  # 同一difficulty内で16問区切りの「セット」を識別する番号（docs/backlog.md No.3.5）
