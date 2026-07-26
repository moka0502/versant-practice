import pytest

from versant_practice.difficulty import classify_difficulty


@pytest.mark.parametrize(
    "char_count,expected",
    [
        (0, "beginner"),
        (44, "beginner"),
        (45, "beginner"),
        (46, "intermediate"),
        (79, "intermediate"),
        (80, "intermediate"),
        (81, "advanced"),
        (200, "advanced"),
    ],
)
def test_classify_difficulty_boundaries(char_count, expected):
    assert classify_difficulty(char_count) == expected


def test_classify_difficulty_rejects_negative():
    with pytest.raises(ValueError):
        classify_difficulty(-1)
