"""プレースホルダーの問題データ（data/problems.yaml）を生成する。

english-quiz-bot側の実CSV（versant_quizzes.csv）を取り出すまでの暫定データ。
文面はprototype/app.jsのダミー問題と同じもので、実際のVersant Part B（Repeats）
の16問という件数に合わせている。実CSVが手に入ったらcsv_import.py経由の本データに
差し替える。

実行: python scripts/seed_placeholder_data.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # PYTHONPATH無しでも実行できるように

from versant_practice.difficulty import classify_difficulty, count_words
from versant_practice.models import Problem
from versant_practice.yaml_io import dump_problems

PLACEHOLDER_SENTENCES = [
    ("If you need any help, just let me know."),
    ("Can you close the door, please?"),
    ("I'll call you back in five minutes."),
    ("The train leaves at nine o'clock sharp."),
    ("Please turn off the lights before you leave."),
    ("Could you please send me the report before the end of the day?"),
    ("I was wondering if you could help me with this file."),
    ("We need to finalize the budget before the meeting tomorrow."),
    ("She usually takes the bus to work unless it's raining heavily."),
    ("Let me know if you have any questions about the new policy."),
    ("The meeting has been rescheduled to next Tuesday because several key members are traveling."),
    ("Although the proposal looked promising, the committee decided to postpone their decision."),
    ("Despite the heavy rain, the construction team managed to finish the project ahead of schedule."),
    ("The new marketing strategy focuses on expanding into international markets over the next few years."),
    ("Even though the flight was delayed by several hours, most passengers remained remarkably calm."),
    ("Researchers discovered that the unexpected results were caused by a flaw in the original experiment."),
]

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "problems.yaml"


def build_problems() -> list[Problem]:
    problems = []
    for i, text in enumerate(PLACEHOLDER_SENTENCES, start=1):
        word_count = count_words(text)
        problems.append(
            Problem(
                id=f"rep-placeholder-{i:04d}",
                text=text,
                script_segments=[text],  # プレースホルダーにつきフレーズ区切りはしていない
                char_count=len(text),
                word_count=word_count,
                difficulty=classify_difficulty(word_count),
                audio=[],
                source="placeholder",
                source_ref=f"placeholder-{i}",
            )
        )
    return problems


if __name__ == "__main__":
    problems = build_problems()
    dump_problems(problems, DATA_PATH)
    print(f"wrote {len(problems)} placeholder problems to {DATA_PATH}")
