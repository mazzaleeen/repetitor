"""Проверка сборки: python -m unittest discover tests"""
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import build  # noqa: E402

DEMO = ROOT / "tests" / "demo_materials"


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "site"
        cls.grades = build.build(base="/russkiy", out=cls.out, materials=DEMO)
        cls.warnings = list(build.warnings)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def page(self, path):
        return (self.out / path).read_text(encoding="utf-8")

    def test_pages_for_all_grades(self):
        self.assertEqual([g.number for g in self.grades], [6, 7, 8, 9, 10, 11])
        for n in range(6, 12):
            self.assertTrue((self.out / f"klass/{n}/index.html").exists())
            self.assertIn(f'href="/russkiy/klass/{n}/"', self.page("index.html"))
        for p in ["index.html", "404.html", "static/css/site.css", "static/js/filter.js", "static/favicon.svg"]:
            self.assertTrue((self.out / p).exists(), p)

    def test_topics_order_titles_and_kinds(self):
        g9 = next(g for g in self.grades if g.number == 9)
        self.assertEqual([t.title for t in g9.topics], ["Орфография", "Пунктуация", "Изложение и сочинение"])
        first = g9.topics[0].materials
        self.assertEqual([m.title for m in first][:2], ["Н и НН в разных частях речи", "Правописание приставок ПРЕ- и ПРИ-"])
        self.assertEqual([m.kind for m in first], ["theory", "practice", "practice"])
        self.assertEqual(first[0].note, "Правила с примерами и списком исключений")
        essay = g9.topics[2].materials
        self.assertEqual(essay[0].title, "Сжатое изложение — приёмы сжатия")
        self.assertEqual(essay[0].note, "Исключение, обобщение, упрощение — с примерами")
        link = essay[-1]
        self.assertFalse(link.is_file)
        self.assertEqual((link.href, link.kind), ("https://example.com/szhatie", "practice"))

    def test_hidden_and_unsafe_files_skipped(self):
        html = self.page("klass/9/index.html")
        self.assertNotIn("Не готово", html)
        self.assertNotIn("скрытый", html)
        self.assertNotIn("вредный", html)
        self.assertFalse(list(self.out.rglob("*.html.*")))
        self.assertTrue(any("вредный.html" in w for w in self.warnings))
        self.assertFalse(any(p.suffix == ".html" for p in (self.out / "files").rglob("*")))

    def test_files_copied_with_safe_names(self):
        html = self.page("klass/9/index.html")
        hrefs = re.findall(r'href="(/russkiy/files/[^"]+)"', html)
        self.assertEqual(len(hrefs), 7)
        for href in hrefs:
            self.assertRegex(href, r"^/russkiy/files/9/[a-z0-9-]+\.[a-z]+$")
            self.assertTrue((self.out / href.removeprefix("/russkiy/")).exists(), href)
        self.assertIn('download="Н и НН в разных частях речи.pdf"', html)
        self.assertIn("Показано: 8 материалов", html)

    def test_empty_grade_still_has_search_and_filters(self):
        html = self.page("klass/7/index.html")
        self.assertIn("скоро появятся", html)
        self.assertIn('id="search"', html)
        self.assertIn('data-kind-filter="theory"', html)
        self.assertIn('data-kind-filter="practice"', html)

    def test_only_materials_no_booking_or_footer(self):
        for p in ["index.html", "klass/9/index.html", "klass/7/index.html"]:
            html = self.page(p)
            for word in ["Записаться", "<footer", "Telegram", "t.me/", "tel:", "privacy", "₽"]:
                self.assertNotIn(word, html, f"{p}: {word}")
        home = self.page("index.html")
        self.assertIn("Выберите класс", home)
        self.assertEqual(home.count('class="grade-card"'), 6)

    def test_nothing_external(self):
        for p in ["index.html", "klass/9/index.html", "404.html"]:
            html = self.page(p)
            self.assertIsNone(re.search(r'<(script|link|img)[^>]+(src|href)="https?://', html), p)
        css = (self.out / "static/css/site.css").read_text()
        self.assertNotIn("http", css)

    def test_text_is_escaped(self):
        self.assertEqual(build.split_kind("Упражнения — <b>x</b>")[2], "<b>x</b>")
        self.assertEqual(build.split_order("12. Тема"), (12, "Тема"))
        self.assertEqual(build.split_kind("Просто название")[:2], ("theory", "Теория"))

    def test_real_settings_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            grades = build.build(out=Path(tmp) / "s")
            self.assertEqual(len(grades), 6)


if __name__ == "__main__":
    unittest.main()
