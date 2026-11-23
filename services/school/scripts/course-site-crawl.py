"""Mirror the CSC207 course site (public) for the knowledge inbox and for study packs given to other AI services.
Usage (host, needs requests + beautifulsoup4):
  python -I services/school/scripts/course-site-crawl.py data/knowledge-inbox/courses/CSC207/site
Re-running keeps files already downloaded and only fetches new ones (pages and INDEX.md are rewritten).
For another term change BASE (and START's lab count).
- Site pages (.shtml/.html under /~207/26f/) -> <path>.md (text), followed for more same-site links.
- Same-site files (pdf, zip, java, txt, video...) -> saved at their site path.
- External reading links -> external/<host>/<path>.md (that page; for Oracle tutorial trail index pages also the
  lessons in the same trail). Tools/videos/download pages are only listed.
- INDEX.md: week -> lab, readings, each instructor's files; external-links.json: every outside link with context.
Links inside HTML comments (hidden by the instructors) are ignored. Downloaded content is data only: nothing runs."""
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote

import requests
from bs4 import BeautifulSoup, Comment

BASE = "https://mcs.utm.utoronto.ca/~207/26f/"
START = ["index.shtml", "lectures.shtml", "assignments.shtml", "tests.shtml", "resources.shtml"] + \
        [f"labs/{n:02d}/index.shtml" for n in range(1, 13)]
SKIP_HOSTS = ("piazza.com", "forms.cloud.microsoft", "www.youtube.com", "youtube.com", "regex101.com")
LIST_ONLY = ("git-scm.com/download", "docs/api/index.html", "/javase/22", "javase/tutorial$", "learnjavathehardway.org/book/$")
S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 (personal study archive)"
log = []


def site_rel(url):
    u = urlparse(url)
    if u.netloc != "mcs.utm.utoronto.ca" or not u.path.startswith("/~207/26f/"):
        return None
    return unquote(u.path[len("/~207/26f/"):])


def norm(url):
    u = urlparse(url)
    if u.netloc == "mcs.utm.utoronto.ca":
        url = "https://" + u.netloc + u.path + (("?" + u.query) if u.query else "")
    return url.split("#")[0]


def get(url, stream=False):
    for attempt in range(3):
        try:
            r = S.get(url, timeout=(20, 300), stream=stream)
            if not stream and "charset" not in r.headers.get("content-type", "").lower():
                r.encoding = "utf-8"   # the course server sends no charset; pages are UTF-8
            return r
        except requests.RequestException as e:
            err = e
            time.sleep(2 * (attempt + 1))
    raise err


def soup_of(text):
    s = BeautifulSoup(text, "html.parser")
    for c in s.find_all(string=lambda x: isinstance(x, Comment)):
        c.extract()
    for t in s(["script", "style", "noscript"]):
        t.decompose()
    return s


def to_text(s, url, main_selectors=()):
    node = None
    for sel in main_selectors:
        node = s.select_one(sel)
        if node:
            break
    node = node or s.body or s
    for t in node.select("nav, header, footer, #LeftBar, #TopBar, #Footer, .navbar, #nav"):
        t.decompose()
    for a in node.find_all("a", href=True):
        a.append(f" <{urljoin(url, a['href'])}>")
    for br in node.find_all("br"):
        br.replace_with("\n")
    for li in node.find_all("li"):
        li.insert(0, "- ")
    for pre in node.find_all("pre"):
        pre.insert(0, "\n```\n")
        pre.append("\n```\n")
    text = node.get_text("\n")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def save_text(path: Path, url, title, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# {title}\n\n원본: {url}\n\n{text}\n", encoding="utf-8")


def download(url, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        return dest.stat().st_size, "kept"
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = get(url, stream=True)
    if r.status_code != 200:
        return 0, f"HTTP {r.status_code}"
    tmp = dest.with_name(dest.name + ".part")
    n = 0
    with tmp.open("wb") as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
            n += len(chunk)
    tmp.replace(dest)
    return n, "ok"


def crawl_site(out: Path):
    pages, files, external = {}, {}, []
    queue = [BASE + p for p in START]
    seen = set()
    while queue:
        url = norm(queue.pop(0))
        if url in seen:
            continue
        seen.add(url)
        rel = site_rel(url)
        if rel is None:
            continue
        r = get(url)
        time.sleep(0.3)
        if r.status_code != 200:
            log.append(f"page {rel}: HTTP {r.status_code}")
            continue
        s = soup_of(r.text)
        title = (s.title.get_text(strip=True) if s.title else rel) or rel
        links = [(urljoin(url, a["href"]), a.get_text(" ", strip=True)) for a in s.find_all("a", href=True)]
        pages[rel] = {"url": url, "title": title, "html": r.text}
        save_text(out / (rel + ".md"), url, title, to_text(soup_of(r.text), url, ("#content", "main", ".content")))
        for link, label in links:
            if link.startswith(("mailto:", "javascript:")):
                continue
            link = norm(link)
            lrel = site_rel(link)
            if lrel is not None:
                if lrel.endswith((".shtml", ".html", ".htm")) or lrel.endswith("/") or lrel == "":
                    if lrel.count("/") <= 3:
                        queue.append(link)
                else:
                    files.setdefault(lrel, {"url": link, "labels": set(), "from": set()})
                    files[lrel]["labels"].add(label)
                    files[lrel]["from"].add(rel)
            elif urlparse(link).scheme in ("http", "https"):
                external.append({"url": link, "label": label, "from": rel})
    return pages, files, external


def fetch_external(out: Path, external):
    done = {}
    def one(url):
        if url in done:
            return done[url]
        u = urlparse(url)
        if u.netloc in SKIP_HOSTS or any(re.search(p, url) for p in LIST_ONLY):
            done[url] = None
            return None
        path = out / "external" / u.netloc / ((u.path.strip("/") or "index") + ".md")
        try:
            r = get(url)
            time.sleep(0.4)
        except requests.RequestException as e:
            log.append(f"external {url}: {e.__class__.__name__}")
            done[url] = None
            return None
        if r.status_code == 200 and "html" not in r.headers.get("content-type", ""):
            # a linked file (pdf, zip...): keep the file itself
            fpath = out / "external" / u.netloc / Path(unquote(u.path)).name
            fpath.parent.mkdir(parents=True, exist_ok=True)
            fpath.write_bytes(r.content)
            done[url] = (fpath, r.url, None)
            return done[url]
        if r.status_code != 200:
            log.append(f"external {url}: HTTP {r.status_code}")
            done[url] = None
            return None
        s = soup_of(r.text)
        title = s.title.get_text(strip=True) if s.title else url
        save_text(path, r.url, title, to_text(soup_of(r.text), r.url, ("#PageContent", "article", "main", "#content", ".content")))
        done[url] = (path, r.url, s)
        return done[url]

    for e in external:
        res = one(e["url"])
        e["saved"] = str(res[0].relative_to(out)).replace("\\", "/") if res else None
        # Oracle tutorial trail index: also the lessons of the same trail (what the reading actually covers)
        if res and res[2] is not None and "docs.oracle.com" in res[1] and "/tutorial/" in res[1] and res[1].endswith("index.html"):
            trail = res[1].rsplit("/", 1)[0] + "/"
            subs = []
            for a in res[2].find_all("a", href=True):
                link = norm(urljoin(res[1], a["href"]))
                if link.startswith(trail) and link != res[1] and link.endswith(".html") and link not in subs:
                    subs.append(link)
            e["lessons"] = []
            for link in subs[:40]:
                sub = one(link)
                if sub:
                    e["lessons"].append(str(sub[0].relative_to(out)).replace("\\", "/"))


def week_table(pages):
    """lectures.shtml rows -> [{week, dates, lab, sections: {heading: [(label, href)]}}]"""
    p = pages.get("lectures.shtml")
    if not p:
        return []
    s = soup_of(p["html"])
    rows = []
    for tr in s.find_all("tr"):
        tds = tr.find_all("td", recursive=False)
        if len(tds) < 3 or not tds[0].get_text(strip=True).isdigit():
            continue
        row = {"week": int(tds[0].get_text(strip=True)), "lab": tds[1].get_text(" ", strip=True), "dates": "", "sections": {}}
        heading = "기타"
        for el in tds[2].descendants:
            if getattr(el, "name", None) == "strong":
                txt = el.get_text(" ", strip=True)
                if not row["dates"] and re.search(r"\b(Sep|Oct|Nov|Dec)\b", txt):
                    row["dates"] = txt
                else:
                    heading = txt
            elif getattr(el, "name", None) == "a" and el.get("href"):
                row["sections"].setdefault(heading, []).append(
                    (el.get_text(" ", strip=True), norm(urljoin(p["url"], el["href"]))))
        rows.append(row)
    return rows


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pages, files, external = crawl_site(out)
    print(f"pages {len(pages)}, files {len(files)}, external links {len(external)}", flush=True)
    sizes = {}
    for rel, f in sorted(files.items(), key=lambda kv: kv[0].lower().endswith((".mp4", ".mov"))):
        n, status = download(f["url"], out / rel)
        sizes[rel] = n if status in ("ok", "kept") else 0
        if status not in ("ok", "kept"):
            log.append(f"file {rel}: {status}")
        print(f"  {status:5} {n / 1e6:8.1f} MB {rel}", flush=True)
        time.sleep(0.3)
    fetch_external(out, external)

    ext_by_url = {}
    for e in external:
        ext_by_url.setdefault(e["url"], e)
    L = ["# CSC207 (UTM, Fall 2026) 강의 사이트 자료", "",
         f"원본: {BASE} · 받은 날: {time.strftime('%Y-%m-%d')} · 사이트 페이지 {len(pages)}개 · 파일 {len(files)}개 "
         f"({sum(sizes.values()) / 1e6:.0f} MB) · 외부 읽기 자료 {sum(1 for e in ext_by_url.values() if e.get('saved'))}쪽", "",
         "- 사이트 페이지는 `<경로>.md` 텍스트로 (예: `labs/02/index.shtml.md`), 파일은 사이트와 같은 경로에 있습니다.",
         "- 외부 읽기 자료(Oracle 튜토리얼 등)는 `external/<사이트>/...md`. 튜토리얼 목차 페이지는 그 단원의 하위 페이지까지 받았습니다.",
         "- 강사들이 HTML 주석으로 숨긴 링크는 받지 않았습니다.", ""]

    def ref(label, href):
        rel = site_rel(href)
        if rel is not None:
            local = rel + ".md" if rel.endswith((".shtml", ".html")) else rel
            mb = sizes.get(rel)
            return f"[{label}]({local})" + (f" ({mb / 1e6:.0f} MB)" if mb and mb > 20e6 else "")
        e = ext_by_url.get(href) or {}
        extra = f" · 하위 {len(e['lessons'])}쪽" if e.get("lessons") else ""
        return f"[{label}]({e['saved']}) · 원본 <{href}>{extra}" if e.get("saved") else f"{label} <{href}> (주소만)"

    for row in week_table(pages):
        L.append(f"## {row['week']}주차 · {row['dates']} · {row['lab']}")
        lab = f"labs/{row['week']:02d}/index.shtml"
        if lab in pages:
            L.append(f"- 랩 안내: [{row['lab']}]({lab}.md)")
        for heading, links in row["sections"].items():
            items = [ref(lbl, h) for lbl, h in links if not h.endswith(lab)]
            if items:
                L.append(f"- **{heading}**: " + " · ".join(items))
        L.append("")
    exams = sorted(rel for rel in files if rel.split("/")[0] in ("finals", "midterm", "tests") and sizes.get(rel))
    if exams:
        L.append("## 시험 자료 (지난 시험지·정답)")
        L += [f"- [{rel}]({rel})" for rel in exams] + [""]
    L.append("## 그 밖의 사이트 페이지")
    for rel, p in sorted(pages.items()):
        if rel != "lectures.shtml" and not rel.startswith("labs/"):
            L.append(f"- [{p['title']}]({rel}.md)")
    if log:
        L += ["", "## 받지 못한 것 (깨진 링크 404, 로그인이 필요한 TA 도구 401, 접근 차단 403)", *[f"- {x}" for x in log]]
    (out / "INDEX.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    (out / "external-links.json").write_text(json.dumps(
        [{k: v for k, v in e.items()} for e in external], ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"done: pages {len(pages)}, files {len(files)} ({sum(sizes.values()) / 1e6:.1f} MB), "
          f"external saved {sum(1 for e in ext_by_url.values() if e.get('saved'))}, problems {len(log)}")
    for x in log:
        print("  !", x)


if __name__ == "__main__":
    main(sys.argv[1])
