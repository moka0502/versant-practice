"""生成済みTTS音声の品質チェック。

主軸は文字起こし一致チェック（客観的・信頼できる）。
--deep を付けると、アクセント・自然さの主観判定（gpt-audio）も追加で行うが、
これはあくまで参考情報として扱うこと（TTS生成モデルと同じ会社の系統のモデルで
判定しているため、自己採点バイアスの可能性がある。docs/decisions.md参照）。

実行例:
  python scripts/judge_audio.py                # 全件、文字起こし一致チェックのみ
  python scripts/judge_audio.py --spike 3       # 先頭3件だけ
  python scripts/judge_audio.py --deep          # アクセント・自然さの参考判定も追加
"""

import argparse
import os
import re
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
ACCENT = "en-US"
VOICE = "alloy"
TTS_MODEL = "gpt-4o-mini-tts"

# 句読点の違いは実際の音声の誤りではないので、比較前に正規化して無視する
_PUNCTUATION_PATTERN = re.compile(r"[.,!?;:]")


def normalize(text: str) -> str:
    return _PUNCTUATION_PATTERN.sub("", text).lower().split()


def check_transcription(client: OpenAI, path: Path, expected_text: str) -> dict:
    with open(path, "rb") as f:
        result = client.audio.transcriptions.create(model="gpt-4o-transcribe", file=f)
    matches = normalize(result.text) == normalize(expected_text)
    return {"transcribed": result.text, "matches": matches}


def check_deep(client: OpenAI, path: Path, expected_text: str) -> dict:
    import base64

    with open(path, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode("utf-8")
    response = client.chat.completions.create(
        model="gpt-audio",
        modalities=["text"],
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "input_audio", "input_audio": {"data": audio_b64, "format": "mp3"}},
                    {
                        "type": "text",
                        "text": (
                            f'The expected script is: "{expected_text}". Evaluate as a JSON object with keys: '
                            "accent_description (is it natural American English? describe briefly), "
                            "naturalness_1to5 (int). Output JSON only, no markdown fences."
                        ),
                    },
                ],
            }
        ],
    )
    return response.choices[0].message.content


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spike", type=int, default=None, help="先頭N件だけチェックする（未指定なら全件）")
    parser.add_argument("--deep", action="store_true", help="アクセント・自然さの参考判定も追加で行う（コスト増）")
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY が設定されていません。.env を確認してください。")

    problems = load_problems(DATA_PATH)
    if args.spike is not None:
        problems = problems[: args.spike]

    client = OpenAI()
    failures = []

    for p in problems:
        key = cache_key(p.text, ACCENT, VOICE, TTS_MODEL)
        path = AUDIO_CACHE_DIR / f"{key}.mp3"
        if not path.exists():
            print(f"  [{p.id}] SKIP: audio_cache/{key}.mp3 が見つかりません（未生成）")
            continue

        result = check_transcription(client, path, p.text)
        mark = "OK  " if result["matches"] else "NG  "
        print(f"  {mark}[{p.id}] {p.text}")
        if not result["matches"]:
            print(f"        transcribed: {result['transcribed']!r}")
            failures.append(p.id)

        if args.deep:
            print(f"        deep-check: {check_deep(client, path, p.text)}")

    print()
    print(f"チェック結果: {len(problems) - len(failures)}/{len(problems)}件が文字起こし一致")
    if failures:
        print("要確認:", failures)


if __name__ == "__main__":
    main()
