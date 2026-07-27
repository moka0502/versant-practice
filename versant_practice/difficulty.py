SHORT_MAX_WORDS = 9
MEDIUM_MAX_WORDS = 12


def count_words(text: str) -> int:
    return len(text.split())


def classify_difficulty(word_count: int) -> str:
    if word_count < 0:
        raise ValueError(f"word_count must be non-negative, got {word_count}")
    if word_count <= SHORT_MAX_WORDS:
        return "beginner"
    if word_count <= MEDIUM_MAX_WORDS:
        return "intermediate"
    return "advanced"
