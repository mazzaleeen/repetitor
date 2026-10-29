// Страница загрузки материалов. Работает без сервера: файлы отправляются прямо в репозиторий
// через GitHub API, после чего GitHub сам пересобирает сайт.
(function () {
  "use strict";

  var root = document.getElementById("uploader");
  if (!root || !root.dataset.repo) return;

  var REPO = root.dataset.repo;
  var BRANCH = root.dataset.branch || "main";
  var SITE = root.dataset.site || "";
  var GRADES = JSON.parse(root.dataset.grades || "[]");
  var ALLOWED = (root.dataset.allowed || "").split(",");
  var MAX_MB = 25;
  var API = "https://api.github.com/repos/" + REPO;
  var STORE_KEY = "repetitor-upload-token";
  var MAT = "материалы";
  var SERVICE = { "описания.txt": 1, "ссылки.txt": 1 };
  var KINDS = {
    "теория": ["theory", "Теория"], "упражнения": ["practice", "Упражнения"],
    "упражнение": ["practice", "Упражнения"], "практика": ["practice", "Упражнения"]
  };
  var KIND_LABEL = { theory: "Теория", practice: "Упражнения" };

  var state = { token: null, head: null, baseTree: null, tree: [], items: [] };

  function $(id) { return document.getElementById(id); }

  // ---------- хранение ключа ----------
  function loadToken() {
    try { return localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }
  function saveToken(t, remember) {
    try { (remember ? localStorage : sessionStorage).setItem(STORE_KEY, t); } catch (e) { /* приватный режим */ }
  }
  function forgetToken() {
    try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY); } catch (e) { /* ничего */ }
  }

  // ---------- GitHub API ----------
  async function gh(path, opts) {
    opts = opts || {};
    var headers = {
      "Authorization": "Bearer " + state.token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (opts.body) headers["Content-Type"] = "application/json";
    var res = await fetch(API + path, {
      method: opts.method || "GET", headers: headers, cache: "no-store",
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) {
      var err = new Error("GitHub " + res.status);
      err.status = res.status;
      try { err.detail = (await res.json()).message || ""; } catch (e) { err.detail = ""; }
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  function explain(e) {
    if (e.status === 401) return "Ключ не подходит или устарел. Создайте новый и войдите заново.";
    if (e.status === 403) return "У ключа нет права записи. При создании ключа нужно выбрать Contents: Read and write.";
    if (e.status === 404) return "Ключ не видит репозиторий " + REPO + ". Проверьте, что при создании ключа выбран именно он.";
    if (e.status === 409 || e.status === 422) return "Кто-то изменил сайт одновременно с вами. Обновите страницу и попробуйте ещё раз.";
    if (!e.status) return "Нет связи с GitHub. Проверьте интернет и попробуйте ещё раз.";
    return "Ошибка GitHub (" + e.status + ")" + (e.detail ? ": " + e.detail : "") + ".";
  }

  async function loadTree(commitSha) {
    if (!commitSha) commitSha = (await gh("/git/ref/heads/" + BRANCH)).object.sha;
    var commit = await gh("/git/commits/" + commitSha);
    var tree = await gh("/git/trees/" + commit.tree.sha + "?recursive=1");
    state.head = commitSha;
    state.baseTree = commit.tree.sha;
    state.tree = tree.tree || [];
  }

  function entry(path) {
    for (var i = 0; i < state.tree.length; i++) if (state.tree[i].path === path) return state.tree[i];
    return null;
  }
  function children(dir, type) {
    var prefix = dir + "/", out = [];
    state.tree.forEach(function (e) {
      if (e.type === type && e.path.indexOf(prefix) === 0 && e.path.slice(prefix.length).indexOf("/") === -1) {
        out.push({ path: e.path, name: e.path.slice(prefix.length), sha: e.sha, size: e.size });
      }
    });
    return out;
  }

  // ---------- текст и кодировки ----------
  function b64ToText(b64) {
    var bin = atob((b64 || "").replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  }
  async function readText(path) {
    var e = entry(path);
    if (!e) return "";
    return b64ToText((await gh("/git/blobs/" + e.sha)).content);
  }
  function fileToB64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1] || ""); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }
  function rows(text) {
    return text.split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(function (l) { return l && l.charAt(0) !== "#"; })
      .map(function (l) { return l.split("|").map(function (p) { return p.trim(); }); });
  }

  // ---------- имена — так же, как в build.py ----------
  function pretty(t) { return t.trim().replace(/\s+-\s+/g, " — "); }
  function splitOrder(name) {
    var m = name.match(/^\s*(\d+)\s*[.)]\s*(.+)$/);
    return m ? [parseInt(m[1], 10), m[2].trim()] : [999, name.trim()];
  }
  function splitKind(name) {
    var m = name.match(/^\s*([А-Яа-яЁё]+)\s*[—–-]\s*(.+)$/);
    if (m && KINDS[m[1].toLowerCase()]) { var k = KINDS[m[1].toLowerCase()]; return [k[0], k[1], pretty(m[2])]; }
    return ["theory", "Теория", pretty(name)];
  }
  function parseName(stem) {
    var o = splitOrder(stem), k = splitKind(o[1]);
    return { order: o[0], kind: k[0], label: k[1], title: k[2] };
  }
  function clean(text, max) {
    return text.replace(/:/g, " - ").replace(/[\\/?*"<>|\r\n\t]/g, " ").replace(/\s+/g, " ")
      .replace(/^[\s._]+/, "").trim().slice(0, max || 150);
  }
  function stemOf(name) { var i = name.lastIndexOf("."); return i > 0 ? name.slice(0, i) : name; }
  function extOf(name) { var i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; }

  // ---------- структура: классы, темы, материалы ----------
  function gradeDir(n) {
    var dirs = children(MAT, "tree");
    for (var i = 0; i < dirs.length; i++) {
      var m = dirs[i].name.match(/^\s*(\d+)/);
      if (m && parseInt(m[1], 10) === n) return dirs[i].path;
    }
    return MAT + "/" + n + " класс";
  }
  function topicsOf(n) {
    return children(gradeDir(n), "tree")
      .filter(function (d) { return d.name.charAt(0) !== "_" && d.name.charAt(0) !== "."; })
      .map(function (d) { var o = splitOrder(d.name); return { path: d.path, order: o[0], title: o[1] }; })
      .sort(function (a, b) { return a.order - b.order || a.title.localeCompare(b.title, "ru"); });
  }
  async function itemsOf(topicPath) {
    var notes = {};
    rows(await readText(topicPath + "/описания.txt")).forEach(function (r) {
      if (r.length >= 2) notes[parseName(r[0]).title.toLowerCase()] = r[1];
    });
    var items = children(topicPath, "blob")
      .filter(function (f) {
        var c = f.name.charAt(0);
        return c !== "_" && c !== "." && !SERVICE[f.name.toLowerCase()] && ALLOWED.indexOf(extOf(f.name)) !== -1;
      })
      .map(function (f) {
        var p = parseName(stemOf(f.name));
        p.path = f.path; p.size = f.size; p.isLink = false; p.format = extOf(f.name).toUpperCase();
        p.note = notes[p.title.toLowerCase()] || "";
        return p;
      });
    var linkText = await readText(topicPath + "/ссылки.txt");
    linkText.split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (!t || t.charAt(0) === "#") return;
      var parts = t.split("|").map(function (s) { return s.trim(); });
      if (parts.length < 2 || !/^https?:\/\//.test(parts[1])) return;
      var p = parseName(parts[0]);
      p.isLink = true; p.line = t; p.url = parts[1]; p.format = "Ссылка";
      p.note = parts[2] || notes[p.title.toLowerCase()] || "";
      items.push(p);
    });
    items.sort(function (a, b) { return a.order - b.order || a.title.localeCompare(b.title, "ru"); });
    return items;
  }
  function nextOrder(list) {
    var max = 0;
    list.forEach(function (x) { if (x.order < 999 && x.order > max) max = x.order; });
    return max + 1;
  }

  // ---------- запись: один коммит на действие ----------
  async function commitChanges(makeEntries, message) {
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var entries = await makeEntries();
        var tree = await gh("/git/trees", { method: "POST", body: { base_tree: state.baseTree, tree: entries } });
        var commit = await gh("/git/commits", { method: "POST", body: { message: message, tree: tree.sha, parents: [state.head] } });
        await gh("/git/refs/heads/" + BRANCH, { method: "PATCH", body: { sha: commit.sha } });
        await loadTree(commit.sha);
        return commit;
      } catch (e) {
        if (attempt === 0 && (e.status === 409 || e.status === 422)) { await loadTree(); continue; }
        throw e;
      }
    }
  }
  function textEntry(path, text) {
    return text.trim()
      ? { path: path, mode: "100644", type: "blob", content: text.replace(/\s+$/, "") + "\n" }
      : (entry(path) ? { path: path, mode: "100644", type: "blob", sha: null } : null);
  }

  // ---------- интерфейс ----------
  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "class") node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }
  function say(node, kind, parts) {
    node.textContent = "";
    node.className = "msg msg-" + kind;
    (Array.isArray(parts) ? parts : [parts]).forEach(function (p) {
      node.appendChild(typeof p === "string" ? document.createTextNode(p) : p);
    });
    node.hidden = false;
  }
  function busy(button, on, label) {
    button.disabled = on;
    if (label) button.textContent = label;
  }
  function radio(name) {
    var c = root.querySelector('input[name="' + name + '"]:checked');
    return c ? c.value : null;
  }
  function humanSize(b) {
    if (b == null) return "";
    return b < 1048576 ? Math.max(1, Math.round(b / 1024)) + " КБ" : (b / 1048576).toFixed(1).replace(".", ",") + " МБ";
  }

  var gradeSel = $("grade"), topicSel = $("topic");

  function fillGrades() {
    gradeSel.textContent = "";
    GRADES.forEach(function (n) { gradeSel.appendChild(el("option", { value: String(n), text: n + " класс" })); });
  }
  function fillTopics(selectPath) {
    var n = parseInt(gradeSel.value, 10);
    var topics = topicsOf(n);
    topicSel.textContent = "";
    topics.forEach(function (t) { topicSel.appendChild(el("option", { value: t.path, text: t.title })); });
    topicSel.appendChild(el("option", { value: "__new", text: "+ Новая тема…" }));
    if (selectPath && topics.some(function (t) { return t.path === selectPath; })) topicSel.value = selectPath;
    else if (!topics.length) topicSel.value = "__new";
    onTopic();
  }
  async function onTopic() {
    var isNew = topicSel.value === "__new";
    $("new-topic-field").hidden = !isNew;
    if (isNew) { $("list-card").hidden = true; state.items = []; return; }
    await renderList();
  }

  async function renderList() {
    var path = topicSel.value;
    var list = $("list");
    $("list-card").hidden = false;
    $("list-title").textContent = "Материалы в теме «" + topicSel.options[topicSel.selectedIndex].text + "»";
    list.textContent = "";
    list.appendChild(el("li", { class: "item", text: "Загружаю список…" }));
    try {
      state.items = await itemsOf(path);
    } catch (e) {
      list.textContent = "";
      list.appendChild(el("li", { class: "item", text: explain(e) }));
      return;
    }
    if (topicSel.value !== path) return;
    list.textContent = "";
    $("list-empty").hidden = state.items.length > 0;
    state.items.forEach(function (m, i) {
      var del = el("button", { class: "item-btn", type: "button", text: "Удалить" });
      del.addEventListener("click", function () { removeItem(m, del); });
      var tag = (KIND_LABEL[m.kind] || "") + " · " + m.format + (m.isLink ? "" : " · " + humanSize(m.size));
      list.appendChild(el("li", { class: "item" + (i === 0 ? " first-visible" : "") }, [
        el("div", { class: "item-main" }, [
          el("div", { class: "item-title", text: m.title }),
          m.note ? el("div", { class: "item-note", text: m.note }) : null
        ]),
        el("span", { class: "tag", text: tag }),
        del
      ]));
    });
  }

  function doneMessage(node, text) {
    var n = gradeSel.value;
    say(node, "ok", [
      text + " Сайт обновится примерно через 1–2 минуты: ",
      el("a", { href: SITE + "/klass/" + n + "/", target: "_blank", rel: "noopener", text: "открыть " + n + " класс" }),
      " · ",
      el("a", { href: "https://github.com/" + REPO + "/actions", target: "_blank", rel: "noopener", text: "ход публикации" })
    ]);
  }

  async function removeItem(m, button) {
    if (!window.confirm("Удалить «" + m.title + "» с сайта?")) return;
    var msg = $("add-msg");
    busy(button, true, "Удаляю…");
    var topicPath = topicSel.value;
    try {
      await commitChanges(async function () {
        var out = [];
        if (m.isLink) {
          var links = (await readText(topicPath + "/ссылки.txt")).split(/\r?\n/)
            .filter(function (l) { return l.trim() !== m.line; }).join("\n");
          out.push(textEntry(topicPath + "/ссылки.txt", links));
        } else {
          out.push({ path: m.path, mode: "100644", type: "blob", sha: null });
          var notesPath = topicPath + "/описания.txt";
          var original = await readText(notesPath);
          var kept = original.split(/\r?\n/).filter(function (l) {
            var t = l.trim();
            if (!t || t.charAt(0) === "#") return true;
            return parseName(t.split("|")[0].trim()).title.toLowerCase() !== m.title.toLowerCase();
          }).join("\n");
          if (kept.trim() !== original.trim()) out.push(textEntry(notesPath, kept));
        }
        return out.filter(Boolean);
      }, "Удалено: " + gradeSel.value + " класс / " + topicSel.options[topicSel.selectedIndex].text + " / " + m.title);
      doneMessage(msg, "«" + m.title + "» удалено.");
      fillTopics(topicPath);
    } catch (e) {
      say(msg, "err", explain(e));
      busy(button, false, "Удалить");
    }
  }

  function updateModeFields() {
    var mode = radio("mode");
    var files = $("file").files;
    var multi = mode === "file" && files && files.length > 1;
    $("file-field").hidden = mode !== "file";
    $("url-field").hidden = mode !== "link";
    $("single-fields").hidden = multi;
    $("multi-hint").hidden = !multi;
  }

  $("file").addEventListener("change", function () {
    var files = this.files;
    if (files && files.length === 1) {
      var title = $("title");
      if (!title.value || title.dataset.auto === "1") {
        title.value = parseName(stemOf(files[0].name)).title;
        title.dataset.auto = "1";
      }
    }
    updateModeFields();
  });
  $("title").addEventListener("input", function () { this.dataset.auto = ""; });
  root.querySelectorAll('input[name="mode"]').forEach(function (r) { r.addEventListener("change", updateModeFields); });
  gradeSel.addEventListener("change", function () { fillTopics(); });
  topicSel.addEventListener("change", onTopic);

  $("add-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var msg = $("add-msg"), button = $("submit");
    var mode = radio("mode"), kind = radio("kind"), label = KIND_LABEL[kind];
    var n = parseInt(gradeSel.value, 10);
    var isNew = topicSel.value === "__new";
    var newTopic = clean($("new-topic").value, 100);
    var files = Array.prototype.slice.call($("file").files || []);
    var single = mode === "link" || files.length <= 1;
    var title = clean($("title").value);
    var note = clean($("note").value, 200);
    var url = $("url").value.trim();

    if (isNew && !newTopic) return say(msg, "err", "Впишите название новой темы.");
    if (mode === "file") {
      if (!files.length) return say(msg, "err", "Выберите файл.");
      for (var i = 0; i < files.length; i++) {
        if (ALLOWED.indexOf(extOf(files[i].name)) === -1)
          return say(msg, "err", "Файл «" + files[i].name + "» в неподдерживаемом формате. Можно: " + ALLOWED.join(", ") + ".");
        if (files[i].size > MAX_MB * 1048576)
          return say(msg, "err", "Файл «" + files[i].name + "» больше " + MAX_MB + " МБ. Загрузите его на Яндекс Диск и добавьте ссылкой.");
      }
    } else if (!/^https?:\/\/\S+$/.test(url)) {
      return say(msg, "err", "Вставьте ссылку целиком, начиная с https://");
    }
    if (single && !title) return say(msg, "err", "Впишите название, как оно будет на сайте.");

    busy(button, true, "Загружаю…");
    say(msg, "info", mode === "file" ? "Отправляю файлы на GitHub…" : "Сохраняю ссылку…");
    try {
      var blobs = [];
      if (mode === "file") {
        for (var j = 0; j < files.length; j++) {
          say(msg, "info", "Отправляю «" + files[j].name + "» (" + (j + 1) + " из " + files.length + ")…");
          var blob = await gh("/git/blobs", { method: "POST", body: { content: await fileToB64(files[j]), encoding: "base64" } });
          blobs.push({ file: files[j], sha: blob.sha });
        }
      }
      var topicPath, topicTitle;
      var commit = await commitChanges(async function () {
        var out = [];
        if (isNew) {
          var existing = topicsOf(n);
          var same = existing.filter(function (t) { return t.title.toLowerCase() === newTopic.toLowerCase(); })[0];
          topicPath = same ? same.path : gradeDir(n) + "/" + nextOrder(existing) + ". " + newTopic;
          topicTitle = same ? same.title : newTopic;
        } else {
          topicPath = topicSel.value;
          topicTitle = topicSel.options[topicSel.selectedIndex].text;
        }
        var current = isNew && !entry(topicPath) ? [] : await itemsOf(topicPath);
        var order = nextOrder(current);
        if (mode === "file") {
          var taken = {};
          children(topicPath, "blob").forEach(function (f) { taken[f.name.toLowerCase()] = 1; });
          var noteLines = [];
          blobs.forEach(function (b) {
            var t = single ? title : clean(parseName(stemOf(b.file.name)).title);
            var base = order + ". " + label + " — " + (t || "Материал");
            var name = base + "." + extOf(b.file.name), k = 2;
            while (taken[name.toLowerCase()]) { name = base + " (" + k + ")." + extOf(b.file.name); k++; }
            taken[name.toLowerCase()] = 1;
            out.push({ path: topicPath + "/" + name, mode: "100644", type: "blob", sha: b.sha });
            if (single && note) noteLines.push(label + " — " + t + " | " + note);
            order++;
          });
          if (noteLines.length) {
            var notesText = await readText(topicPath + "/описания.txt");
            out.push(textEntry(topicPath + "/описания.txt", (notesText.trim() ? notesText.trim() + "\n" : "") + noteLines.join("\n")));
          }
        } else {
          var linksText = await readText(topicPath + "/ссылки.txt");
          var line = order + ". " + label + " — " + title + " | " + url + (note ? " | " + note : "");
          out.push(textEntry(topicPath + "/ссылки.txt", (linksText.trim() ? linksText.trim() + "\n" : "") + line));
        }
        return out.filter(Boolean);
      }, "Добавлено: " + n + " класс / " + (isNew ? newTopic : topicSel.options[topicSel.selectedIndex].text) + " / " +
         (single ? title : files.length + " файла(ов)"));

      var count = mode === "file" ? files.length : 1;
      doneMessage(msg, (count === 1 ? "Материал добавлен" : "Добавлено материалов: " + count) + " в тему «" + topicTitle + "».");
      $("file").value = ""; $("title").value = ""; $("title").dataset.auto = ""; $("note").value = ""; $("url").value = "";
      $("new-topic").value = "";
      updateModeFields();
      fillTopics(topicPath);
      return commit;
    } catch (e) {
      say(msg, "err", explain(e));
    } finally {
      busy(button, false, "Загрузить");
    }
  });

  // ---------- вход ----------
  async function signIn(token, remember, quiet) {
    var msg = $("login-msg"), button = $("login-btn");
    state.token = token;
    busy(button, true, "Проверяю…");
    try {
      await gh("");
      await loadTree();
      if (remember !== null) saveToken(token, remember);
      $("login-card").hidden = true;
      $("session-card").hidden = false;
      $("add-card").hidden = false;
      msg.hidden = true;
      fillGrades();
      fillTopics();
      updateModeFields();
    } catch (e) {
      state.token = null;
      if (quiet) forgetToken();
      say(msg, "err", explain(e));
    } finally {
      busy(button, false, "Войти");
    }
  }

  $("login-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var t = $("token").value.trim();
    if (!t) return say($("login-msg"), "err", "Вставьте ключ.");
    signIn(t, $("remember").checked, false);
    $("token").value = "";
  });
  $("logout").addEventListener("click", function () {
    forgetToken();
    state = { token: null, head: null, baseTree: null, tree: [], items: [] };
    $("login-card").hidden = false;
    $("session-card").hidden = true;
    $("add-card").hidden = true;
    $("list-card").hidden = true;
    $("add-msg").hidden = true;
  });

  var saved = loadToken();
  if (saved) signIn(saved, null, true);
})();
