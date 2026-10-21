"""
CLI Tool: Import spell-checked Markdown file into BookScan Studio session.
Usage:
    python import_md.py [path_to_file.md]
Examples:
    python import_md.py output/나의_스캔_도서.md
    python import_md.py all.md
"""

import sys
import re
import json
from pathlib import Path

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
SESSION_FILE = BASE_DIR / "session.json"
OUTPUT_DIR = BASE_DIR / "output"


def main():
    target_path = None
    if len(sys.argv) > 1:
        target_path = Path(sys.argv[1])
        if not target_path.is_absolute():
            target_path = BASE_DIR / target_path
    else:
        # Auto-discovery: look in output/ or all.md
        output_mds = list(OUTPUT_DIR.glob("*.md"))
        if output_mds:
            target_path = max(output_mds, key=lambda p: p.stat().st_mtime)
        elif (BASE_DIR / "all.md").exists():
            target_path = BASE_DIR / "all.md"

    if not target_path or not target_path.exists():
        print("❌ 불러올 마크다운 파일을 찾을 수 없습니다.")
        print("사용법: python import_md.py [파일경로.md]")
        return

    print(f"📖 마크다운 파일 읽는 중: {target_path}")
    content = target_path.read_text(encoding="utf-8", errors="replace")

    pattern = re.compile(r"<!--\s*Page\s*(\d+)\s*-->\s*(.*?)(?=(?:<!--\s*Page\s*\d+\s*-->)|\Z)", re.DOTALL)
    matches = pattern.findall(content)

    if not matches:
        print("❌ '<!-- Page 번호 -->' 형식의 페이지 구분자를 찾을 수 없습니다.")
        return

    print(f"🔍 총 {len(matches)}개 페이지 블록을 발견했습니다.")

    if not SESSION_FILE.exists():
        print("❌ session.json 파일이 존재하지 않습니다.")
        return

    with open(SESSION_FILE, "r", encoding="utf-8") as f:
        session_data = json.load(f)

    pages = session_data.get("pages", [])
    pages_by_num = {p.get("page_number"): p for p in pages}

    updated_count = 0
    for p_num_str, page_content in matches:
        try:
            p_num = int(p_num_str)
        except ValueError:
            continue

        clean_text = page_content.strip()
        clean_text = re.sub(r"\n*---\s*$", "", clean_text).strip()

        if p_num in pages_by_num:
            pages_by_num[p_num]["formatted_text"] = clean_text
            pages_by_num[p_num]["status"] = "done"
            updated_count += 1

    with open(SESSION_FILE, "w", encoding="utf-8") as f:
        json.dump(session_data, f, ensure_ascii=False, indent=2)

    print(f"✅ 완료: 총 {updated_count}개 페이지가 session.json에 정상 반영되었습니다!")
    print("👉 웹 브라우저 (http://localhost:8000)를 새로고침(F5)하시면 편집기에서 즉시 확인하실 수 있습니다.")


if __name__ == "__main__":
    main()
