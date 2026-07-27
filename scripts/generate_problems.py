"""OpenAIでVersant Part B（Repeats）向けの問題文を新規生成する。

一から作成する方針（docs/decisions.md「問題データの作り方」参照）。既存の
english-quiz-bot CSVは使わない。生成後は構造的な自動検証（segments整合性・
文字数の妥当な範囲・重複）を通し、data/problems.yaml を実データで置き換える。

実行例:
  python scripts/generate_problems.py --count 50
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # PYTHONPATH無しでも実行できるように

from dotenv import load_dotenv
from openai import OpenAI

from versant_practice.difficulty import (
    MEDIUM_MAX_WORDS,
    SHORT_MAX_WORDS,
    classify_difficulty,
    count_words,
)
from versant_practice.models import Problem
from versant_practice.yaml_io import dump_problems

load_dotenv()

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "problems.yaml"
MODEL = "gpt-5.6-sol"
BATCH_SIZE = 8
MIN_CHARS = 10
MAX_CHARS = 260

# レベルごとの単語数の目標帯（difficulty.pyの閾値と一致させる）
LEVEL_BANDS = {
    "beginner": (1, SHORT_MAX_WORDS),
    "intermediate": (SHORT_MAX_WORDS + 1, MEDIUM_MAX_WORDS),
    "advanced": (MEDIUM_MAX_WORDS + 1, MEDIUM_MAX_WORDS + 10),
}

SYSTEM_PROMPT = (
    "You write practice sentences for a 'Repeat' listening/speaking drill, similar to "
    "Versant English Test Part B (Repeats). Sentences must be: natural everyday spoken "
    "English a person might actually say out loud; grammatically correct; standalone "
    "(understandable with no extra context); free of proper nouns, slang, or narrow "
    "cultural references. Vary topics and sentence structure across requests so the "
    "overall set feels diverse, not formulaic."
)


def split_counts(total: int) -> dict[str, int]:
    """レベルごとの目標件数（できるだけ均等に分配）。"""
    base = total // 3
    counts = {"beginner": base, "intermediate": base, "advanced": total - base * 2}
    return counts


def build_user_prompt(n: int, level: str, existing_texts: list[str]) -> str:
    lo, hi = LEVEL_BANDS[level]
    avoid = "\n".join(f"- {t}" for t in existing_texts[-30:]) or "(none yet)"
    return (
        f"Write {n} NEW sentences, each EXACTLY {lo} to {hi} words long (count every word "
        f"carefully). Do not repeat or closely paraphrase any of these already-used "
        f"sentences:\n{avoid}\n\n"
        "For each sentence, also split it into natural phrase chunks suitable for "
        "chunked repeating practice. The chunks, joined with single spaces, must "
        "reconstruct the exact sentence.\n\n"
        'Respond with a JSON object: {"problems": [{"text": "...", "segments": ["...", "..."]}]}'
    )


def validate_candidate(candidate: dict, level: str, seen_lower: set[str]) -> str | None:
    """問題があれば理由の文字列を返す。問題なければNone。"""
    text = candidate.get("text", "").strip()
    segments = candidate.get("segments", [])
    if not text or not segments:
        return "text/segmentsが空"
    if " ".join(segments) != text:
        return f"segmentsを結合してもtextと一致しない: {segments!r} != {text!r}"
    if not (MIN_CHARS <= len(text) <= MAX_CHARS):
        return f"文字数が範囲外: {len(text)}文字"
    if classify_difficulty(count_words(text)) != level:
        return f"単語数が目標帯外: {count_words(text)}語（目標={level}）"
    if text.lower() in seen_lower:
        return "重複"
    return None


def generate_level(client: OpenAI, level: str, count: int, all_existing: list[str]) -> list[dict]:
    accepted: list[dict] = []
    seen_lower = {t.lower() for t in all_existing}
    max_rounds = count * 3 // BATCH_SIZE + 10  # 無限ループ防止

    for _ in range(max_rounds):
        if len(accepted) >= count:
            break
        n = min(BATCH_SIZE, count - len(accepted))
        response = client.chat.completions.create(
            model=MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": build_user_prompt(n, level, all_existing + [c["text"] for c in accepted]),
                },
            ],
        )
        payload = json.loads(response.choices[0].message.content)
        for candidate in payload.get("problems", []):
            if len(accepted) >= count:
                break
            reason = validate_candidate(candidate, level, seen_lower)
            if reason:
                print(f"  [却下:{level}] {reason}: {candidate.get('text', '')!r}")
                continue
            accepted.append(candidate)
            seen_lower.add(candidate["text"].strip().lower())

    if len(accepted) < count:
        raise SystemExit(
            f"{level}を{count}件に到達できませんでした（{len(accepted)}件で打ち切り）。プロンプト調整が必要かもしれません。"
        )
    return accepted


def generate_problems(client: OpenAI, count: int) -> list[Problem]:
    level_counts = split_counts(count)
    all_texts: list[str] = []
    accepted_by_level: dict[str, list[dict]] = {}

    for level, n in level_counts.items():
        print(f"-- {level}: {n}件生成 --")
        candidates = generate_level(client, level, n, all_texts)
        accepted_by_level[level] = candidates
        all_texts.extend(c["text"] for c in candidates)

    problems = []
    i = 0
    for level in ("beginner", "intermediate", "advanced"):
        for c in accepted_by_level[level]:
            i += 1
            text = c["text"].strip()
            word_count = count_words(text)
            problems.append(
                Problem(
                    id=f"rep-{i:04d}",
                    text=text,
                    script_segments=c["segments"],
                    char_count=len(text),
                    word_count=word_count,
                    difficulty=classify_difficulty(word_count),
                    audio=[],
                    source="generated",
                    source_ref=f"generated-{i}",
                )
            )
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=50, help="生成する問題数")
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY が設定されていません。.env を確認してください。")

    client = OpenAI()
    problems = generate_problems(client, args.count)
    dump_problems(problems, DATA_PATH)

    breakdown = {"beginner": 0, "intermediate": 0, "advanced": 0}
    for p in problems:
        breakdown[p.difficulty] += 1

    print(f"\n完了: {len(problems)}件を {DATA_PATH} に書き込みました")
    print(f"内訳: 初級={breakdown['beginner']} 中級={breakdown['intermediate']} 上級={breakdown['advanced']}")


if __name__ == "__main__":
    main()
