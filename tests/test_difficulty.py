import pytest

from versant_practice.difficulty import classify_difficulty, count_words


@pytest.mark.parametrize(
    "word_count,expected",
    [
        (0, "beginner"),
        (8, "beginner"),
        (9, "beginner"),
        (10, "intermediate"),
        (11, "intermediate"),
        (12, "intermediate"),
        (13, "advanced"),
        (30, "advanced"),
    ],
)
def test_classify_difficulty_boundaries(word_count, expected):
    assert classify_difficulty(word_count) == expected


def test_classify_difficulty_rejects_negative():
    with pytest.raises(ValueError):
        classify_difficulty(-1)


def test_count_words():
    assert count_words("If you need any help, just let me know.") == 9
    assert count_words("Hello.") == 1
