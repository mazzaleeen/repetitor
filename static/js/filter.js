// Поиск и фильтр материалов на странице класса. Без скрипта страница показывает всё.
(function () {
  var root = document.querySelector("[data-materials]");
  if (!root) return;
  var input = document.getElementById("search");
  var chips = Array.prototype.slice.call(document.querySelectorAll("[data-kind-filter]"));
  var topics = Array.prototype.slice.call(root.querySelectorAll("[data-topic]"));
  var count = document.querySelector("[data-count]");
  var empty = document.querySelector("[data-empty]");
  var kind = "all";

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function normalize(s) {
    return (s || "").toLowerCase().replace(/ё/g, "е").trim();
  }

  function apply() {
    var q = normalize(input && input.value);
    var total = 0;
    topics.forEach(function (topic) {
      var visible = 0;
      topic.querySelectorAll("[data-item]").forEach(function (item) {
        var ok = (kind === "all" || item.dataset.kind === kind) &&
                 (!q || normalize(item.dataset.search).indexOf(q) !== -1);
        item.hidden = !ok;
        item.classList.toggle("first-visible", ok && visible === 0);
        if (ok) visible++;
      });
      topic.hidden = visible === 0;
      total += visible;
    });
    if (count) count.textContent = "Показано: " + total + " " + plural(total, "материал", "материала", "материалов");
    if (empty) empty.hidden = total !== 0;
  }

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      kind = chip.dataset.kindFilter;
      chips.forEach(function (c) { c.setAttribute("aria-pressed", c === chip ? "true" : "false"); });
      apply();
    });
  });
  if (input) input.addEventListener("input", apply);
  apply();
})();
