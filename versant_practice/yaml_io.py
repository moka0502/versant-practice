from dataclasses import asdict
from pathlib import Path

import yaml

from .models import AudioAsset, Problem


def dump_problems(problems: list[Problem], path: Path) -> None:
    payload = [asdict(p) for p in problems]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        yaml.safe_dump(payload, f, allow_unicode=True, sort_keys=False)


def problems_to_yaml_str(problems: list[Problem]) -> str:
    payload = [asdict(p) for p in problems]
    return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)


def load_problems(path: Path) -> list[Problem]:
    with path.open(encoding="utf-8") as f:
        payload = yaml.safe_load(f) or []
    problems = []
    for row in payload:
        audio = [AudioAsset(**a) for a in row.get("audio", [])]
        problems.append(Problem(**{**row, "audio": audio}))
    return problems
