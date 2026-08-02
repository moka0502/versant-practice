import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import pytest
from export_to_prototype import ACCENT, DUMMY_SOURCE, TTS_MODEL, VOICE, export

from versant_practice.audio_cache import cache_key
from versant_practice.models import Problem
from versant_practice.yaml_io import dump_problems


def make_problem(id_, text, verified, source="unknown", set_number=1):
    return Problem(
        id=id_,
        text=text,
        script_segments=[text],
        char_count=len(text),
        word_count=len(text.split()),
        difficulty="beginner",
        source=source,
        source_ref=id_,
        verified=verified,
        set_number=set_number,
    )


def write_audio_for(audio_cache_dir: Path, text: str):
    key = cache_key(text, ACCENT, VOICE, TTS_MODEL)
    (audio_cache_dir / f"{key}.mp3").write_bytes(b"fake mp3 bytes")
    return key


def test_export_includes_only_verified_with_audio(tmp_path):
    data_path = tmp_path / "problems.yaml"
    audio_cache_dir = tmp_path / "audio_cache"
    audio_cache_dir.mkdir()
    prototype_dir = tmp_path / "prototype"
    prototype_dir.mkdir()

    verified_problem = make_problem("rep-0001", "Hello there.", verified=True)
    unverified_problem = make_problem("rep-0002", "Goodbye now.", verified=False)
    dump_problems([verified_problem, unverified_problem], data_path)
    key = write_audio_for(audio_cache_dir, verified_problem.text)

    manifest = export(data_path, audio_cache_dir, prototype_dir)

    assert [m["id"] for m in manifest] == ["rep-0001"]
    assert manifest[0]["audio"] == f"audio/{key}.mp3"
    assert manifest[0]["set_number"] == 1
    assert (prototype_dir / "audio" / f"{key}.mp3").exists()
    assert json.loads((prototype_dir / "problems.json").read_text(encoding="utf-8")) == manifest


def test_export_includes_dummy_set_padding_without_audio_file(tmp_path):
    data_path = tmp_path / "problems.yaml"
    audio_cache_dir = tmp_path / "audio_cache"
    audio_cache_dir.mkdir()
    prototype_dir = tmp_path / "prototype"
    prototype_dir.mkdir()

    verified_problem = make_problem("rep-0001", "Hello there.", verified=True)
    dummy_problem = make_problem(
        "rep-dummy-0001", "This is a dummy sentence.", verified=False, source=DUMMY_SOURCE, set_number=2
    )
    dump_problems([verified_problem, dummy_problem], data_path)
    write_audio_for(audio_cache_dir, verified_problem.text)
    # dummy_problem用の音声ファイルはわざと用意しない

    manifest = export(data_path, audio_cache_dir, prototype_dir)

    assert {m["id"] for m in manifest} == {"rep-0001", "rep-dummy-0001"}
    dummy_entry = next(m for m in manifest if m["id"] == "rep-dummy-0001")
    assert dummy_entry["audio"] is None
    assert dummy_entry["set_number"] == 2
    assert not (prototype_dir / "audio" / "rep-dummy-0001.mp3").exists()


def test_export_still_raises_when_real_data_audio_missing_alongside_dummy(tmp_path):
    data_path = tmp_path / "problems.yaml"
    audio_cache_dir = tmp_path / "audio_cache"
    audio_cache_dir.mkdir()
    prototype_dir = tmp_path / "prototype"
    prototype_dir.mkdir()

    verified_without_audio = make_problem("rep-0001", "Hello there.", verified=True)
    dummy_problem = make_problem(
        "rep-dummy-0001", "This is a dummy sentence.", verified=False, source=DUMMY_SOURCE
    )
    dump_problems([verified_without_audio, dummy_problem], data_path)
    # 実データ(rep-0001)の音声ファイルをわざと用意しない → fail loudlyの安全装置が
    # ダミー問題の追加によって緩んでいないことを確認する

    with pytest.raises(FileNotFoundError):
        export(data_path, audio_cache_dir, prototype_dir)

    assert not (prototype_dir / "problems.json").exists()


def test_export_raises_and_writes_nothing_when_audio_missing(tmp_path):
    data_path = tmp_path / "problems.yaml"
    audio_cache_dir = tmp_path / "audio_cache"
    audio_cache_dir.mkdir()
    prototype_dir = tmp_path / "prototype"
    prototype_dir.mkdir()

    verified_problem = make_problem("rep-0001", "Hello there.", verified=True)
    dump_problems([verified_problem], data_path)
    # 音声ファイルをわざと生成しない

    with pytest.raises(FileNotFoundError):
        export(data_path, audio_cache_dir, prototype_dir)

    assert not (prototype_dir / "problems.json").exists()
    assert not (prototype_dir / "audio").exists()


def test_export_raises_when_no_verified_problems(tmp_path):
    data_path = tmp_path / "problems.yaml"
    audio_cache_dir = tmp_path / "audio_cache"
    audio_cache_dir.mkdir()
    prototype_dir = tmp_path / "prototype"
    prototype_dir.mkdir()

    dump_problems([make_problem("rep-0001", "Hello there.", verified=False)], data_path)

    with pytest.raises(ValueError):
        export(data_path, audio_cache_dir, prototype_dir)
