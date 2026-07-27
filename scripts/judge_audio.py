"""生成済みTTS音声の品質チェック。デフォルトでdata/problems.yamlに結果を書き戻す。

主軸は文字起こし一致チェック（客観的・信頼できる）。この結果だけがProblem.verifiedを
左右する。--deep を付けると、アクセント・自然さの主観判定（gpt-audio）も追加で行うが、
これはあくまで参考情報として表示するだけで、verifiedには反映しない（TTS生成モデルと
同じ会社の系統のモデルで判定しているため、自己採点バイアスの可能性がある。
docs/decisions.md参照）。

再実行のたびに全件を再チェックする（スキップ条件は導入していない。50件・少額コストの
ため、キャッシュ的なスキップロジックを入れる複雑さの方が割に合わないという判断）。

実行例:
  python scripts/judge_audio.py                # 全件チェック、結果を書き戻す
  python scripts/judge_audio.py --spike 3       # 先頭3件だけ（他の件は書き戻し時に保持される）
  python scripts/judge_audio.py --dry-run       # 書き戻さず表示のみ
  python scripts/judge_audio.py --deep          # アクセント・自然さの参考判定も追加
"""

import argparse
import os
import re
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # PYTHONPATH無しでも実行できるように

from dotenv import load_dotenv
from openai import OpenAI

from versant_practice.audio_cache import cache_key
from versant_practice.models import Problem
from versant_practice.yaml_io import dump_problems, load_problems

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


def merge_updates(full_problems: list[Problem], updated: list[Problem]) -> list[Problem]:
    """updated（スパイク等で一部だけ処理した結果）をidで突き合わせ、full_problems全体に反映する。
    updatedに含まれないidはfull_problemsの元の値のまま保持される。"""
    updates = {p.id: p for p in updated}
    return [updates.get(p.id, p) for p in full_problems]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spike", type=int, default=None, help="先頭N件だけチェックする（未指定なら全件）")
    parser.add_argument("--deep", action="store_true", help="アクセント・自然さの参考判定も追加で行う（コスト増）")
    parser.add_argument("--dry-run", action="store_true", help="判定結果をdata/problems.yamlに書き戻さない")
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY が設定されていません。.env を確認してください。")

    full_problems = load_problems(DATA_PATH)
    problems = full_problems[: args.spike] if args.spike is not None else full_problems

    client = OpenAI()
    updated = []
    failures = []
    skipped = 0

    for p in problems:
        key = cache_key(p.text, ACCENT, VOICE, TTS_MODEL)
        path = AUDIO_CACHE_DIR / f"{key}.mp3"
        if not path.exists():
            print(f"  [{p.id}] SKIP: audio_cache/{key}.mp3 が見つかりません（未生成）")
            skipped += 1
            continue

        result = check_transcription(client, path, p.text)
        p = replace(p, verified=result["matches"])
        updated.append(p)

        mark = "OK  " if result["matches"] else "NG  "
        print(f"  {mark}[{p.id}] {p.text}")
        if not result["matches"]:
            print(f"        transcribed: {result['transcribed']!r}")
            failures.append(p.id)

        if args.deep:
            print(f"        deep-check: {check_deep(client, path, p.text)}")

    checked = len(updated)
    print()
    print(f"チェック結果: {checked - len(failures)}/{checked}件が文字起こし一致（未生成スキップ{skipped}件）")
    if failures:
        print("要確認:", failures)

    if args.dry_run:
        print("(--dry-run のため data/problems.yaml への書き戻しはしていません)")
        return

    merged = merge_updates(full_problems, updated)
    dump_problems(merged, DATA_PATH)
    print(f"{DATA_PATH} に verified の判定結果を書き戻しました。")


if __name__ == "__main__":
    main()
