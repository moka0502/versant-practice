import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from dataclasses import replace

from judge_audio import merge_updates, normalize

from versant_practice.models import Problem


def make_problem(id_, verified=False):
    return Problem(
        id=id_,
        text="Some text.",
        script_segments=["Some text."],
        char_count=10,
        word_count=2,
        difficulty="beginner",
        source_ref=id_,
        verified=verified,
    )


def test_merge_updates_only_changes_targeted_ids():
    full = [make_problem("a"), make_problem("b"), make_problem("c")]
    updated = [replace(full[1], verified=True)]  # スパイクで"b"だけ処理した想定

    merged = merge_updates(full, updated)

    assert [p.verified for p in merged] == [False, True, False]
    assert [p.id for p in merged] == ["a", "b", "c"]


def test_normalize_ignores_punctuation_and_case():
    assert normalize("Can you close the door, please?") == normalize("can you close the door please")
