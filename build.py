#!/usr/bin/env python3
"""Сборка сайта из настроек и папки «материалы» в готовые HTML-страницы (папка _site).

Запуск на своём компьютере:  python build.py && python -m http.server -d _site
На GitHub сборка запускается сама после каждого изменения (.github/workflows/deploy.yml).
"""
import argparse
import re
import shutil
import sys
import tomllib
from datetime import date
from dataclasses import dataclass, field
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parent
SETTINGS = ROOT / "настройки.toml"
MATERIALS = ROOT / "материалы"
OUT = ROOT / "_site"

ALLOWED = {"pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "rtf", "txt",
           "jpg", "jpeg", "png", "webp", "mp3", "m4a", "mp4"}
FORMATS = {"doc": "Word", "docx": "Word", "ppt": "PowerPoint", "pptx": "PowerPoint", "xls": "Excel",
           "xlsx": "Excel", "jpg": "Фото", "jpeg": "Фото", "png": "Фото", "webp": "Фото",
           "mp3": "Аудио", "m4a": "Аудио", "mp4": "Видео"}
KINDS = {"теория": ("theory", "Теория"), "упражнения": ("practice", "Упражнения"),
         "упражнение": ("practice", "Упражнения"), "практика": ("practice", "Упражнения")}
SERVICE_FILES = {"описания.txt", "ссылки.txt"}

TRANSLIT = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
                    ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s",
                     "t", "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya"]))

warnings: list[str] = []


def warn(msg):
    warnings.append(msg)
    print(f"  ! {msg}", file=sys.stderr)


def slugify(text: str) -> str:
    text = "".join(TRANSLIT.get(ch, ch) for ch in text.lower())
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:80] or "file"


def split_order(name: str):
    """«2. Пунктуация» → (2, «Пунктуация»); без номера → (999, имя)."""
    m = re.match(r"^\s*(\d+)\s*[.)]\s*(.+)$", name)
    return (int(m.group(1)), m.group(2).strip()) if m else (999, name.strip())


def split_kind(name: str):
    """«Упражнения — Приставки» → ("practice", "Упражнения", «Приставки»); без типа — теория."""
    m = re.match(r"^\s*([А-Яа-яЁё]+)\s*[—–-]\s*(.+)$", name)
    if m and m.group(1).lower() in KINDS:
        kind, label = KINDS[m.group(1).lower()]
        return kind, label, pretty(m.group(2))
    return "theory", "Теория", pretty(name)


def pretty(title: str) -> str:
    """В именах файлов нельзя «:», поэтому вместо него пишут « - »; на сайте показываем тире."""
    return re.sub(r"\s+-\s+", " — ", title.strip())


def human_size(size: int) -> str:
    if size < 1024 * 1024:
        return f"{max(1, round(size / 1024))} КБ"
    return f"{size / 1024 / 1024:.1f} МБ".replace(".", ",")


def plural(n, one, few, many):
    m10, m100 = n % 10, n % 100
    if m10 == 1 and m100 != 11:
        return one
    if 2 <= m10 <= 4 and not 12 <= m100 <= 14:
        return few
    return many


@dataclass
class Material:
    title: str
    kind: str
    kind_label: str
    order: int
    note: str = ""
    href: str = ""
    is_file: bool = True
    download_name: str = ""
    format_label: str = ""
    size_label: str = ""


@dataclass
class Topic:
    title: str
    order: int
    materials: list = field(default_factory=list)


@dataclass
class Grade:
    number: int
    exam: str
    description: str
    intro: str
    topics: list = field(default_factory=list)

    @property
    def total(self):
        return sum(len(t.materials) for t in self.topics)


def read_pairs(path: Path):
    """Строки вида «Название | значение | …», пустые строки и # — пропускаются."""
    rows = []
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                rows.append([part.strip() for part in line.split("|")])
    return rows


def find_grade_dir(number: int, materials: Path):
    if not materials.exists():
        return None
    for d in materials.iterdir():
        m = re.match(r"^\s*(\d+)", d.name)
        if d.is_dir() and m and int(m.group(1)) == number:
            return d
    return None


def collect_topics(grade_dir: Path, number: int, files_out: Path, base: str):
    topics = []
    for tdir in sorted(p for p in grade_dir.iterdir() if p.is_dir() and not p.name.startswith(("_", "."))):
        t_order, t_title = split_order(tdir.name)
        topic = Topic(title=t_title, order=t_order)
        notes = {split_kind(split_order(row[0])[1])[2]: row[1] for row in read_pairs(tdir / "описания.txt") if len(row) >= 2}

        for f in sorted(p for p in tdir.iterdir() if p.is_file()):
            if f.name.startswith(("_", ".")) or f.name.lower() in SERVICE_FILES:
                continue
            ext = f.suffix.lstrip(".").lower()
            if ext not in ALLOWED:
                warn(f"пропущен файл неподдерживаемого формата: {f.name}")
                continue
            order, rest = split_order(f.stem)
            kind, kind_label, title = split_kind(rest)
            slug = f"{slugify(t_title)}-{slugify(title)}"
            target = files_out / str(number) / f"{slug}.{ext}"
            n = 2
            while target.exists():
                target = files_out / str(number) / f"{slug}-{n}.{ext}"
                n += 1
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, target)
            topic.materials.append(Material(
                title=title, kind=kind, kind_label=kind_label, order=order,
                note=notes.get(title, ""),
                href=f"{base}/files/{number}/{target.name}", download_name=f"{title}.{ext}",
                format_label=FORMATS.get(ext, ext.upper()), size_label=human_size(f.stat().st_size)))

        for row in read_pairs(tdir / "ссылки.txt"):
            if len(row) < 2 or not row[1].startswith(("http://", "https://")):
                warn(f"строка без ссылки в {tdir.name}/ссылки.txt: {' | '.join(row)}")
                continue
            order, rest = split_order(row[0])
            kind, kind_label, title = split_kind(rest)
            topic.materials.append(Material(
                title=title, kind=kind, kind_label=kind_label, order=order,
                note=row[2] if len(row) > 2 else notes.get(title, ""),
                href=row[1], is_file=False, format_label="Ссылка"))

        topic.materials.sort(key=lambda m: (m.order, m.title.lower()))
        if topic.materials:
            topics.append(topic)
    topics.sort(key=lambda t: (t.order, t.title.lower()))
    return topics


def load_settings():
    with SETTINGS.open("rb") as fh:
        data = tomllib.load(fh)
    site = {**data.get("site", {}), "lessons": data.get("lessons", {}), "contacts": data.get("contacts", {})}
    contacts = site["contacts"]
    digits = "".join(ch for ch in contacts.get("phone", "") if ch.isdigit() or ch == "+")
    contacts["phone_href"] = f"tel:{digits}" if digits else ""
    contacts["telegram"] = contacts.get("telegram", "").strip().lstrip("@")
    grades = [g for g in data.get("grade", []) if g.get("show", True)]
    grades.sort(key=lambda g: g["number"])
    return site, grades


def build(base: str = "", out: Path = OUT, materials: Path = MATERIALS):
    warnings.clear()
    base = base.rstrip("/")
    site, grade_rows = load_settings()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copytree(ROOT / "static", out / "static")

    grades = []
    for row in grade_rows:
        g = Grade(number=row["number"], exam=row.get("exam", ""), description=row.get("description", ""),
                  intro=row.get("intro", ""))
        gdir = find_grade_dir(g.number, materials)
        if gdir:
            g.topics = collect_topics(gdir, g.number, out / "files", base)
        grades.append(g)

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=select_autoescape(["html"]),
                      trim_blocks=True, lstrip_blocks=True)
    env.filters["plural"] = lambda n, forms: plural(n, *forms.split(","))
    ctx = {"site": site, "base": base, "grades": grades, "year": date.today().year}

    def render(template, path, **extra):
        target = out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(env.get_template(template).render(**ctx, **extra), encoding="utf-8")

    render("home.html", "index.html")
    for g in grades:
        render("grade.html", f"klass/{g.number}/index.html", grade=g)
    render("privacy.html", "privacy/index.html")
    render("404.html", "404.html")

    total = sum(g.total for g in grades)
    print(f"Готово: {len(grades)} классов, {total} материалов → {out}")
    return grades


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-path", default="", help="Путь сайта, например /russkiy (GitHub подставляет сам).")
    args = parser.parse_args()
    build(args.base_path)
