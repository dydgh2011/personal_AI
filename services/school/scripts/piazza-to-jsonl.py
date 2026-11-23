"""Convert piazza_scrape.py backups (post.json per post) into school backfill .jsonl.
1) Backup (owner's script, login from secrets/school.env, one --out per course):
   python -I C:/Users/dydgh/Downloads/piazza_scrape.py --nid <class nid> --out data/school-backup/piazza/<COURSE>
2) Convert:  python -I services/school/scripts/piazza-to-jsonl.py data/school-backup/piazza data/knowledge-inbox/school
3) Import:   docker exec personal_ai-school-1 python -m school import /import   (Git Bash: MSYS_NO_PATHCONV=1)
The backup keeps classmates' names (users.json, post.md); the .jsonl keeps only roles (강사/TA, 학생, 익명).
id = <nid>:<nr>:backfill  (one full-text item per post; live polling keeps its own per-version ids)."""
import html
import json
import re
import sys
from pathlib import Path

COURSES = {  # folder -> (nid, course label used by live polling)
    "CSC207": ("mt1qu7tffk56ae", "CSC 207"),
    "CSC236": ("mtrunjsim0k24w", "CSC 236"),
    "MAT223": ("mtk9zmspaz376c", "MAT 223H5 ALL SECTIONS - FALL 2026"),
    "STA256": ("mtq72crlgi05s8", "STA 256H5 F LEC0101"),
}
ASSET = re.compile(r"""(?:https?://(?:www\.)?piazza\.com)?/redirect/s3\?[^"'\s<>)\]]+|https?://cdn-uploads\.piazza\.com/[^"'\s<>)\]]+|https?://piazza-resources\.s3[^"'\s<>)\]]+""")


def text(h):
    h = h or ""
    h = re.sub(r"<img[^>]*>", " [이미지] ", h, flags=re.I)
    h = re.sub(r"<a [^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", lambda m: m.group(2) + (" [첨부]" if ASSET.search(m.group(1)) else f" ({m.group(1)})"), h, flags=re.I | re.S)
    h = re.sub(r"<(br|/p|/li|/div|/h\d|/pre|/tr)[^>]*>", "\n", h, flags=re.I)
    h = re.sub(r"<li[^>]*>", "- ", h, flags=re.I)
    h = re.sub(r"<[^>]+>", "", h)
    h = ASSET.sub("[첨부]", html.unescape(h))
    h = re.sub(r"[ \t ]+", " ", h)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", h).strip()


def who(node, users):
    if node.get("anon", "no") != "no" or not node.get("uid"):
        return "익명"
    role = (users.get(node["uid"]) or {}).get("role") or "student"
    return "강사/TA" if role != "student" else "학생"


def convert(post, nid, course, users):
    cur = (post.get("history") or [{}])[0]
    first = (post.get("history") or [{}])[-1]
    nr = post["nr"]
    tags = post.get("tags") or []
    instructor = "instructor-note" in tags or who(first, users) == "강사/TA"
    parts = [f"[{post.get('type')} · {who(first, users)} 작성]" + (f" 폴더: {', '.join(post.get('folders') or [])}" if post.get("folders") else ""),
             text(cur.get("content"))]
    answers = followups = 0
    for c in post.get("children") or []:
        t = c.get("type")
        if t in ("i_answer", "s_answer"):
            answers += 1
            h = (c.get("history") or [{}])[0]
            parts.append(f"[{'강사 답변' if t == 'i_answer' else '학생 답변'}] {text(h.get('content'))}")
        elif t in ("followup", "feedback"):
            followups += 1
            state = "해결됨" if c.get("no_answer") == 0 else "미해결"
            parts.append(f"[후속 질문 · {who(c, users)} · {state}] {text(c.get('subject'))}")
            for r in c.get("children") or []:
                parts.append(f"  [답글 · {who(r, users)}] {text(r.get('subject'))}")
    subject = text(cur.get("subject")) or "(제목 없음)"
    title = f"@{nr} {subject}" + (" [instructor]" if instructor else "")
    return {
        "service": "piazza", "id": f"{nid}:{nr}:backfill", "kind": "post", "title": title[:300],
        "url": f"https://piazza.com/class/{nid}/post/{nr}", "date": post.get("created") or "",
        "course": course, "body": "\n\n".join(p for p in parts if p)[:2_000_000],
        "extra": {"type": post.get("type"), "tags": tags, "folders": post.get("folders") or [],
                  "instructor": instructor, "answers": answers, "followups": followups,
                  "private": post.get("status") == "private"},
    }


def main(root, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for folder, (nid, course) in COURSES.items():
        base = Path(root) / folder
        if not base.exists():
            print(f"{folder}: no backup"); continue
        users = json.loads((base / "users.json").read_text(encoding="utf-8")) if (base / "users.json").exists() else {}
        rows = []
        for pj in sorted(base.glob("posts/*/post.json")):
            post = json.loads(pj.read_text(encoding="utf-8"))
            if post.get("nr") and post.get("type"):   # deleted posts come back without a type
                rows.append(convert(post, nid, course, users))
        rows.sort(key=lambda r: int(r["id"].split(":")[1]))
        with (out / f"piazza-{folder}.jsonl").open("w", encoding="utf-8", newline="\n") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"{folder}: {len(rows)} posts, {sum(len(r['body']) for r in rows):,} chars")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
