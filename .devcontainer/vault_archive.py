"""SessionEndフックから呼ばれる。指定session_idのjsonl transcriptを
1セッション1Markdownファイルとしてvaultのdaily-notesに変換して保存する。"""
import json
import re
import sys
from pathlib import Path

INVALID_CHARS = re.compile(r'[\\/:*?"<>|]')
PROJECTS_ROOT = Path.home() / ".claude" / "projects"


def sanitize(name: str, limit: int = 60) -> str:
    name = INVALID_CHARS.sub("_", name).strip()
    return name[:limit] if name else "無題セッション"


def extract_text(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [b.get("text", "").strip() for b in content if isinstance(b, dict) and b.get("type") == "text"]
        parts = [p for p in parts if p]
        return "\n".join(parts)
    return ""


def find_jsonl(session_id: str):
    matches = list(PROJECTS_ROOT.glob(f"*/{session_id}.jsonl"))
    return matches[0] if matches else None


def convert(jsonl_path: Path, out_dir: Path):
    title = None
    date = None
    turns = []

    with jsonl_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            t = obj.get("type")
            if t == "ai-title" and obj.get("aiTitle"):
                title = obj["aiTitle"]
            if date is None and obj.get("timestamp"):
                date = obj["timestamp"][:10]
            if t in ("user", "assistant"):
                msg = obj.get("message", {})
                role = msg.get("role", t)
                text = extract_text(msg.get("content"))
                if text:
                    turns.append((role, text))

    if not turns:
        return None

    if title is None:
        title = turns[0][1][:40]
    if date is None:
        date = "不明日付"

    fname = f"{date}_{sanitize(title)}.md"
    out_path = out_dir / fname
    n = 2
    while out_path.exists():
        out_path = out_dir / f"{date}_{sanitize(title)}_{n}.md"
        n += 1

    role_label = {"user": "Human", "assistant": "Claude"}
    lines = [f"# {title}", "", f"- 日付: {date}", f"- 元セッションID: {jsonl_path.stem}",
             "- ソース: Claude Code (自動アーカイブ)", "", "---", ""]
    for role, text in turns:
        lines.append(f"**{role_label.get(role, role)}:**")
        lines.append("")
        lines.append(text)
        lines.append("")

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path


def main():
    if len(sys.argv) < 2:
        return

    if len(sys.argv) >= 3:
        # 手動テスト用: session_idを直接引数で渡す
        session_id = sys.argv[1].strip()
        out_dir = Path(sys.argv[2])
    else:
        # フックからの呼び出し: 標準入力のJSONからsession_idを読む
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError:
            return
        session_id = (payload.get("session_id") or "").strip()
        out_dir = Path(sys.argv[1])

    if not session_id:
        return

    jsonl_path = find_jsonl(session_id)
    if jsonl_path is None:
        return

    convert(jsonl_path, out_dir)


if __name__ == "__main__":
    main()
