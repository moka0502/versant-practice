SHORT_MAX_CHARS = 45
MEDIUM_MAX_CHARS = 80


def classify_difficulty(char_count: int) -> str:
    if char_count < 0:
        raise ValueError(f"char_count must be non-negative, got {char_count}")
    if char_count <= SHORT_MAX_CHARS:
        return "beginner"
    if char_count <= MEDIUM_MAX_CHARS:
        return "intermediate"
    return "advanced"
