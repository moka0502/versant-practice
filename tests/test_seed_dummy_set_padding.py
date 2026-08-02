import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from collections import Counter

from seed_dummy_set_padding import DUMMY_SOURCE, PROBLEMS_PER_SET, SETS_PER_LEVEL, build_dummy_problems

from versant_practice.difficulty import classify_difficulty
from versant_practice.models import Problem
from versant_practice.yaml_io import dump_problems, load_problems


def test_dummy_problems_match_intended_difficulty_and_set_size():
    problems = build_dummy_problems()
    counts = Counter((p.difficulty, p.set_number) for p in problems)

    for level in ("beginner", "intermediate", "advanced"):
        for set_number in range(2, 2 + SETS_PER_LEVEL):
            assert counts[(level, set_number)] == PROBLEMS_PER_SET

    for p in problems:
        assert classify_difficulty(p.word_count) == p.difficulty
        assert p.source == DUMMY_SOURCE
        assert p.verified is False


def test_dummy_ids_are_unique():
    problems = build_dummy_problems()
    ids = [p.id for p in problems]
    assert len(ids) == len(set(ids))


def test_existing_real_problems_are_preserved(tmp_path, monkeypatch):
    import seed_dummy_set_padding as seed_module

    data_path = tmp_path / "problems.yaml"
    real_problem = Problem(
        id="rep-0001",
        text="Please leave the package by the front door.",
        script_segments=["Please leave the package", "by the front door."],
        char_count=43,
        word_count=8,
        difficulty="beginner",
        audio=[],
        source="generated",
        source_ref="generated-1",
        verified=True,
    )
    dump_problems([real_problem], data_path)
    monkeypatch.setattr(seed_module, "DATA_PATH", data_path)

    seed_module.main()

    result = load_problems(data_path)
    assert real_problem in result
    assert len(result) == 1 + len(build_dummy_problems())
