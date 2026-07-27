from pathlib import Path

import pytest

from versant_practice.csv_import import import_csv, parse_script, problem_from_row
from versant_practice.difficulty import classify_difficulty, count_words

FIXTURE = Path(__file__).parent / "fixtures" / "sample_quizzes.csv"


def test_parse_script_extracts_bracketed_segments():
    assert parse_script("[Hello] [world.]") == ["Hello", "world."]


def test_parse_script_rejects_no_brackets():
    with pytest.raises(ValueError):
        parse_script("Hello world.")


def test_problem_from_row_builds_expected_fields():
    row = {"id": "q1", "script": "[If you need] [any help,] [just let me know.]"}
    problem = problem_from_row(row)

    assert problem.id == "rep-q1"
    assert problem.source_ref == "q1"
    assert problem.script_segments == ["If you need", "any help,", "just let me know."]
    assert problem.text == "If you need any help, just let me know."
    assert problem.char_count == len(problem.text)
    assert problem.word_count == count_words(problem.text)
    assert problem.difficulty == classify_difficulty(problem.word_count)
    assert problem.audio == []


def test_problem_from_row_requires_source_ref():
    with pytest.raises(ValueError):
        problem_from_row({"script": "[Hello.]"})


def test_import_csv_reads_all_rows():
    problems = import_csv(FIXTURE)
    assert [p.source_ref for p in problems] == ["q1", "q2"]
    assert [p.id for p in problems] == ["rep-q1", "rep-q2"]


def test_import_csv_rejects_empty_file(tmp_path):
    empty = tmp_path / "empty.csv"
    empty.write_text("id,script\n", encoding="utf-8")
    with pytest.raises(ValueError):
        import_csv(empty)
