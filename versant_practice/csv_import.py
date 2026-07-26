import csv
import re
from pathlib import Path

from .difficulty import classify_difficulty
from .models import Problem

# NOTE: english-quiz-bot 側の実CSV列名は未確認（取り出し待ち）。ここでは
# CLAUDE.mdに記載の「scriptにフレーズ区切り済み」という情報から妥当な暫定スキーマ
# （id列 + script列）を仮定している。実CSVを入手したら列名をここで確定させること。
SEGMENT_PATTERN = re.compile(r"\[([^\]]+)\]")


def parse_script(script: str) -> list[str]:
    segments = SEGMENT_PATTERN.findall(script)
    if not segments:
        raise ValueError(f"script contains no bracketed [phrase] segments: {script!r}")
    return segments


def problem_from_row(row: dict, source: str = "english-quiz-bot") -> Problem:
    source_ref = row.get("id") or row.get("no")
    if not source_ref:
        raise ValueError(f"row is missing an id/no column to use as source_ref: {row!r}")

    segments = parse_script(row["script"])
    text = " ".join(segments)
    char_count = len(text)

    return Problem(
        id=f"rep-{source_ref}",
        text=text,
        script_segments=segments,
        char_count=char_count,
        difficulty=classify_difficulty(char_count),
        audio=[],
        source=source,
        source_ref=str(source_ref),
    )


def import_csv(path: Path, source: str = "english-quiz-bot") -> list[Problem]:
    with path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError(f"no rows found in {path}")
    return [problem_from_row(row, source=source) for row in rows]
