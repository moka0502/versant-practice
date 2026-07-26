from pathlib import Path

from versant_practice.csv_import import import_csv
from versant_practice.yaml_io import dump_problems, load_problems, problems_to_yaml_str

FIXTURE = Path(__file__).parent / "fixtures" / "sample_quizzes.csv"
GOLDEN = Path(__file__).parent / "golden" / "sample_problems.yaml"


def test_csv_to_yaml_matches_golden_output():
    problems = import_csv(FIXTURE)
    actual = problems_to_yaml_str(problems)
    expected = GOLDEN.read_text(encoding="utf-8")
    assert actual == expected


def test_dump_then_load_roundtrips(tmp_path):
    problems = import_csv(FIXTURE)
    out_path = tmp_path / "problems.yaml"
    dump_problems(problems, out_path)
    loaded = load_problems(out_path)
    assert loaded == problems
