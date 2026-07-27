"""検証済み(verified=True)の問題データと音声をprototype/へ書き出す。

Netlifyはprototype/をビルドステップなしでそのまま公開する静的サイトのため、
アプリが必要とする生成物（問題マニフェストJSONと音声mp3）はprototype/内に
物理的に存在しコミットされている必要がある。

verified=Trueなのに音声ファイルが見つからない問題が1件でもあれば、
何も書き込まずにエラー終了する（壊れた問題を配信しないため）。

実行例:
  python scripts/export_to_prototype.py
"""

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # PYTHONPATH無しでも実行できるように

from versant_practice.audio_cache import cache_key
from versant_practice.yaml_io import load_problems

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "problems.yaml"
AUDIO_CACHE_DIR = Path(__file__).resolve().parent.parent / "audio_cache"
PROTOTYPE_DIR = Path(__file__).resolve().parent.parent / "prototype"

ACCENT = "en-US"
VOICE = "alloy"
TTS_MODEL = "gpt-4o-mini-tts"


def export(data_path: Path, audio_cache_dir: Path, prototype_dir: Path) -> list[dict]:
    """verified=Trueの問題をprototype_dir配下に書き出す。戻り値は書き出したマニフェスト。

    1パス目で全件の音声ファイル存在を確認し、1件でも欠けていれば何も書き込まず例外。
    2パス目で実際にコピー＋マニフェスト生成する。
    """
    problems = load_problems(data_path)
    verified = [p for p in problems if p.verified]
    if not verified:
        raise ValueError("verified=Trueの問題が1件もありません。先にjudge_audio.pyを実行してください。")

    # 1パス目: 存在確認のみ
    resolved = []
    missing = []
    for p in verified:
        key = cache_key(p.text, ACCENT, VOICE, TTS_MODEL)
        src = audio_cache_dir / f"{key}.mp3"
        if not src.exists():
            missing.append((p.id, src))
        else:
            resolved.append((p, key, src))

    if missing:
        lines = "\n".join(f"  [{pid}] expected {path}" for pid, path in missing)
        raise FileNotFoundError(
            f"verified=Trueだが音声ファイルが見つからない問題が{len(missing)}件あります。"
            f"出力を中断しました（壊れた問題を配信しないため）:\n{lines}"
        )

    # 2パス目: 全部揃っている場合のみコピー＋マニフェスト生成
    audio_dir = prototype_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for p, key, src in resolved:
        dest_name = f"{key}.mp3"
        shutil.copyfile(src, audio_dir / dest_name)
        manifest.append({"id": p.id, "level": p.difficulty, "text": p.text, "audio": f"audio/{dest_name}"})

    manifest_path = prototype_dir / "problems.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    try:
        manifest = export(DATA_PATH, AUDIO_CACHE_DIR, PROTOTYPE_DIR)
    except (ValueError, FileNotFoundError) as e:
        raise SystemExit(str(e)) from e
    print(f"完了: {len(manifest)}件を {PROTOTYPE_DIR / 'problems.json'} と {PROTOTYPE_DIR / 'audio'}/ に書き出しました。")


if __name__ == "__main__":
    main()
