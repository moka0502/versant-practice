"""OpenAI TTSで問題音声を生成し、audio_cache/にキャッシュする。

冪等: 既に同じcache_key（text|accent|voice|model）のmp3があれば再生成しない（コスト発生なし）。
デフォルトはスパイクモード（先頭3件のみ）。本番の全件生成には --full を明示的に指定する。

アクセント（en-US/en-GB/en-AU）はgpt-4o-mini-ttsの`instructions`パラメータで指定する
（OpenAI TTSは地域別ボイスを持たないため、指示文で発音を誘導する方式。2026-08-02、
docs/decisions.md「アクセント別音声の生成方針」参照）。

実行例:
  python scripts/generate_audio.py                                # スパイク: 先頭3件、voice=alloy、en-US
  python scripts/generate_audio.py --accent en-GB --spike 3        # 英アクセントのスパイク
  python scripts/generate_audio.py --accent en-AU --spike 5 --voices alloy,coral
  python scripts/generate_audio.py --accent en-GB --full           # 全件生成（音質確認後のみ）
"""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # PYTHONPATH無しでも実行できるように

from dotenv import load_dotenv
from openai import OpenAI

from versant_practice.audio_cache import cache_key
from versant_practice.yaml_io import load_problems

load_dotenv()

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "problems.yaml"
AUDIO_CACHE_DIR = Path(__file__).resolve().parent.parent / "audio_cache"
DEFAULT_MODEL = "gpt-4o-mini-tts"

# OpenAI TTSには地域別の専用ボイスが無いため、instructionsで発音を誘導する。
# en-USはこれまで通り指示なし（既存キャッシュのcache_keyを変えないため）
ACCENT_INSTRUCTIONS = {
    "en-US": None,
    "en-GB": "Speak with a natural British (UK) English accent.",
    "en-AU": "Speak with a natural Australian English accent.",
}


def generate_one(client: OpenAI, text: str, accent: str, voice: str, model: str) -> tuple[str, bool]:
    """1件分のTTS音声を生成しaudio_cache/に保存する。戻り値は(cache_key, 新規生成したか)。"""
    key = cache_key(text, accent, voice, model)
    final_path = AUDIO_CACHE_DIR / f"{key}.mp3"
    if final_path.exists():
        return key, False

    tmp_path = AUDIO_CACHE_DIR / f"{key}.mp3.tmp"
    kwargs = {"model": model, "voice": voice, "input": text}
    instructions = ACCENT_INSTRUCTIONS.get(accent)
    if instructions:
        kwargs["instructions"] = instructions
    with client.audio.speech.with_streaming_response.create(**kwargs) as response:
        response.stream_to_file(str(tmp_path))
    tmp_path.rename(final_path)  # atomic write: 生成失敗時に壊れたmp3が残らないように
    return key, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spike", type=int, default=3, help="生成する問題数（先頭からN件。--full指定時は無視）")
    parser.add_argument("--voices", type=str, default="alloy", help="カンマ区切りで複数指定すると全組み合わせを生成")
    parser.add_argument("--accent", type=str, default="en-US", choices=sorted(ACCENT_INSTRUCTIONS), help="生成するアクセント")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="TTSモデル")
    parser.add_argument("--full", action="store_true", help="スパイクではなく全件を本番生成する")
    parser.add_argument(
        "--verified-only", action="store_true", help="verified=Trueの問題だけを対象にする（配信対象と揃えたい場合）"
    )
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY が設定されていません。.env を確認してください。")

    AUDIO_CACHE_DIR.mkdir(exist_ok=True)
    problems = load_problems(DATA_PATH)
    if not problems:
        raise SystemExit(f"{DATA_PATH} に問題が1件もありません。")
    if args.verified_only:
        problems = [p for p in problems if p.verified]

    if not args.full:
        problems = problems[: args.spike]
        print(f"[スパイクモード] {len(problems)}件 × voice({args.voices}) × accent({args.accent}) を生成します\n")
    else:
        print(f"[本番モード] {len(problems)}件 × accent({args.accent}) を生成します\n")

    voices = [v.strip() for v in args.voices.split(",") if v.strip()]
    client = OpenAI()

    generated = 0
    skipped = 0
    for p in problems:
        for voice in voices:
            key, was_generated = generate_one(client, p.text, args.accent, voice, args.model)
            status = "generated" if was_generated else "skip(cached)"
            print(f"  [{p.id}] voice={voice:8s} {status:14s} -> audio_cache/{key}.mp3")
            generated += 1 if was_generated else 0
            skipped += 0 if was_generated else 1

    print(f"\n完了: 新規生成{generated}件 / キャッシュ済みスキップ{skipped}件")
    if not args.full:
        print("音質を確認し、問題なければ --full で全件生成してください。")


if __name__ == "__main__":
    main()
