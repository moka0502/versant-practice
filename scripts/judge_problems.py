"""生成済み問題文(テキスト)の自然さ・文法をLLM-as-judgeでチェックする。

generate_problems.py の構造チェック(segments整合性・単語数帯・重複)とは別に、
「文章として自然か」という意味的なチェックを行う。閾値未満でも自動では
削除しない（人間の最終判断に委ねる）。判定はmini級モデルで十分という
判断（docs/backlog.md「問題の質チェック機構」の設計方針を踏襲）。

実行例:
  python scripts/judge_problems.py
  python scripts/judge_problems.py --spike 5
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # PYTHONPATH無しでも実行できるように

from dotenv import load_dotenv
from openai import OpenAI

from versant_practice.yaml_io import load_problems

load_dotenv()

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "problems.yaml"
MODEL = "gpt-5.6-terra"  # 判定用なのでmini級で十分（フラッグシップは生成側で使用済み）
BATCH_SIZE = 10

SYSTEM_PROMPT = (
    "You evaluate practice sentences for a 'Repeat' listening/speaking drill "
    "(Versant English Test Part B style). For each sentence, rate: naturalness_1to5 "
    "(would a native speaker actually say this out loud?), grammar_ok (boolean), "
    "standalone_clarity_1to5 (is it understandable with zero extra context?), and "
    "issues (array of strings, empty if none)."
)


def build_prompt(problems: list) -> str:
    items = "\n".join(f'{i + 1}. "{p.text}"' for i, p in enumerate(problems))
    return (
        f"Evaluate these {len(problems)} sentences:\n{items}\n\n"
        'Respond with a JSON object: {"results": [{"naturalness_1to5": n, "grammar_ok": bool, '
        '"standalone_clarity_1to5": n, "issues": []}, ...]} in the same order as the input.'
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spike", type=int, default=None, help="先頭N件だけチェックする")
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY が設定されていません。.env を確認してください。")

    problems = load_problems(DATA_PATH)
    if args.spike is not None:
        problems = problems[: args.spike]

    client = OpenAI()
    flagged = []
    checked = 0

    for start in range(0, len(problems), BATCH_SIZE):
        batch = problems[start : start + BATCH_SIZE]
        response = client.chat.completions.create(
            model=MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_prompt(batch)},
            ],
        )
        results = json.loads(response.choices[0].message.content)["results"]
        for p, r in zip(batch, results):
            checked += 1
            is_ok = r["grammar_ok"] and r["naturalness_1to5"] >= 4 and r["standalone_clarity_1to5"] >= 4
            mark = "OK  " if is_ok else "要確認"
            print(f"  {mark} [{p.id}] naturalness={r['naturalness_1to5']} clarity={r['standalone_clarity_1to5']} {p.text}")
            if not is_ok:
                flagged.append((p.id, p.text, r))

    print(f"\nチェック結果: {checked - len(flagged)}/{checked}件が問題なし")
    if flagged:
        print("\n要確認一覧:")
        for pid, text, r in flagged:
            print(f"  [{pid}] {text}")
            print(f"    {r}")


if __name__ == "__main__":
    main()
