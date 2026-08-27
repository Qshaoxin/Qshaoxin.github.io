const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");

const ROOT = __dirname;
const POSTS_DIR = path.join(ROOT, "source", "_posts");
const PORT = 5177;

/* ---------- front-matter ---------- */
function parsePost(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, content: raw };
  const meta = {};
  let key = null, list = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s+#/.test(line)) continue;
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      if (key && list.length) meta[key] = list;
      key = kv[1]; list = [];
      let v = kv[2].trim();
      if (!v) continue;
      if (/^\[.*\]$/.test(v)) { meta[key] = v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean); key = null; }
      else if (/^".*"$/.test(v) || /^'.*'$/.test(v)) meta[key] = v.slice(1, -1);
      else meta[key] = v;
      if (meta[key] !== undefined && key) key = key; // keep
    } else if (/^\s+-\s+/.test(line) && key) {
      list.push(line.replace(/^\s+-\s+/, "").trim());
    }
  }
  if (key && list.length) meta[key] = list;
  return { meta, content: m[2] };
}

function buildPost(title, date, tags, categories, content) {
  const fm = ["---", `title: ${title}`, `date: ${date}`];
  if (categories && categories.length) {
    fm.push("categories:");
    categories.forEach(c => fm.push(`  - ${c}`));
  }
  if (tags && tags.length) {
    fm.push("tags:");
    tags.forEach(t => fm.push(`  - ${t}`));
  }
  fm.push("---", "");
  return fm.join("\n") + "\n" + content.replace(/\r\n/g, "\n");
}

function listPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const raw = fs.readFileSync(path.join(POSTS_DIR, f), "utf8");
      const { meta } = parsePost(raw);
      return {
        file: f,
        title: meta.title || f.replace(/\.md$/, ""),
        date: String(meta.date || ""),
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        categories: Array.isArray(meta.categories) ? meta.categories : [],
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function slugify(title, date) {
  const d = (date || "").slice(0, 10).replace(/-/g, "");
  let s = title.toLowerCase().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s || /^-*$/.test(s)) s = "post";
  return `${d || "draft"}-${s}`.slice(0, 80) + ".md";
}

/* ---------- git ---------- */
function run(cmd) {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60 * 1000 }); }
  catch (e) { throw new Error((e.stdout || "") + (e.stderr || "") + e.message); }
}

/* ---------- api ---------- */
function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && url.pathname === "/api/posts") return json(res, 200, { posts: listPosts() });
    if (req.method === "GET" && url.pathname === "/api/post") {
      const f = url.searchParams.get("file");
      if (!f || !/^[\w一-龥.-]+\.md$/.test(f)) return json(res, 400, { error: "bad file" });
      const raw = fs.readFileSync(path.join(POSTS_DIR, f), "utf8");
      const { meta, content } = parsePost(raw);
      return json(res, 200, { file: f, title: meta.title || "", date: String(meta.date || ""), tags: meta.tags || [], categories: meta.categories || [], content });
    }
    if (req.method === "POST" && url.pathname === "/api/save") {
      const b = await readBody(req);
      const title = (b.title || "").trim() || "未命名文章";
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const date = b.date || nowStr;
      const tags = (b.tags || []).map(s => s.trim()).filter(Boolean);
      const categories = (b.categories || []).map(s => s.trim()).filter(Boolean);
      let file = b.file;
      if (file && !/^[\w一-龥.-]+\.md$/.test(file)) return json(res, 400, { error: "bad file" });
      if (!file) file = slugify(title, date);
      fs.writeFileSync(path.join(POSTS_DIR, file), buildPost(title, date, tags, categories, b.content || ""), "utf8");
      return json(res, 200, { ok: true, file });
    }
    if (req.method === "POST" && url.pathname === "/api/delete") {
      const b = await readBody(req);
      if (!b.file || !/^[\w一-龥.-]+\.md$/.test(b.file)) return json(res, 400, { error: "bad file" });
      fs.unlinkSync(path.join(POSTS_DIR, b.file));
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      let dirty = "";
      try { dirty = run("git status --short"); } catch (e) { dirty = ""; }
      let last = "";
      try { last = run("git log -1 --pretty=format:%s"); } catch (e) { last = ""; }
      return json(res, 200, { dirty: dirty.trim().split("\n").filter(Boolean).length, last });
    }
    if (req.method === "POST" && url.pathname === "/api/publish") {
      const b = await readBody(req);
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const msg = (b.message || "").trim() || `发布更新 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const st = run("git status --short");
      if (!st.trim()) return json(res, 200, { ok: true, output: "没有需要发布的变更，网站已是最新。", pushed: false });
      run("git add -A");
      run(`git commit -m "${msg.replace(/"/g, " ")}"`);
      const out = run("git push");
      return json(res, 200, { ok: true, output: out || "推送完成。", pushed: true });
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`博客编辑器已启动: http://127.0.0.1:${PORT}`);
  exec('start "" "http://127.0.0.1:' + PORT + '"', { shell: "cmd.exe" });
});

/* ---------- page ---------- */
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>博客编辑器</title>
<style>
:root {
  --main: #425aef;
  --main-hover: #1f3bd8;
  --bg: #f7f9fe;
  --card: #fff;
  --text: #363636;
  --text-light: #8992a6;
  --border: #e3e8f7;
  --shadow: 0 8px 16px -6px rgba(28, 44, 63, .08);
  --radius: 12px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; }

/* 顶部导航 */
#nav {
  position: sticky; top: 0; z-index: 100;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px; height: 60px;
  background: rgba(255,255,255,.85); backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; font-size: 1.15rem; font-weight: 600; }
.brand .logo {
  width: 34px; height: 34px; border-radius: 10px;
  background: linear-gradient(120deg, #425aef, #7a5cf0);
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 17px;
}
.nav-right { display: flex; align-items: center; gap: 14px; }
#dirty-dot { font-size: .82rem; color: var(--text-light); }
#dirty-dot.has { color: #f0a020; font-weight: 600; }

.btn {
  border: none; cursor: pointer; font-family: var(--font);
  border-radius: 10px; padding: 9px 20px; font-size: .92rem;
  transition: all .25s ease; display: inline-flex; align-items: center; gap: 6px;
}
.btn-main { background: var(--main); color: #fff; box-shadow: 0 4px 12px -4px rgba(66,90,239,.5); }
.btn-main:hover { background: var(--main-hover); transform: translateY(-1px); }
.btn-main:disabled { background: #a9b5f0; cursor: wait; transform: none; }
.btn-ghost { background: transparent; color: var(--main); border: 1.5px solid var(--main) !important; }
.btn-ghost:hover { background: rgba(66,90,239,.07); }
.btn-danger-ghost { background: transparent; color: #e05a5a; border: 1.5px solid #e05a5a !important; }
.btn-danger-ghost:hover { background: rgba(224,90,90,.07); }
.btn-sm { padding: 6px 13px; font-size: .84rem; border-radius: 8px; }

/* 布局 */
.wrap { display: grid; grid-template-columns: 320px 1fr; gap: 20px; max-width: 1280px; margin: 24px auto; padding: 0 24px; }
@media (max-width: 960px) { .wrap { grid-template-columns: 1fr; } }

.card {
  background: var(--card); border-radius: var(--radius);
  box-shadow: var(--shadow); border: 1px solid rgba(227,232,247,.6);
  padding: 20px;
}
.card-title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
.card-title .tip { color: var(--main); font-size: .78rem; font-weight: 700; letter-spacing: 2px; }
.card-title h2 { font-size: 1.05rem; }

/* 文章列表 */
#post-list { display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 220px); overflow-y: auto; }
.post-item {
  padding: 12px 14px; border-radius: 10px; cursor: pointer;
  border: 1.5px solid transparent; transition: all .2s ease;
  background: #fafbff;
}
.post-item:hover { border-color: rgba(66,90,239,.4); }
.post-item.active { border-color: var(--main); background: rgba(66,90,239,.06); }
.post-item .t { font-weight: 600; font-size: .95rem; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.post-item .d { font-size: .78rem; color: var(--text-light); display: flex; gap: 8px; align-items: center; }
.new-btn { width: 100%; justify-content: center; margin-bottom: 14px; }

/* 编辑区 */
#editor-card { min-height: calc(100vh - 130px); display: flex; flex-direction: column; }
#empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-light); gap: 12px; padding: 60px 0; }
#empty .big { font-size: 3rem; }
.ed-row { display: flex; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
.ed-row.grow-1 { flex: 1; min-width: 200px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: .8rem; color: var(--text-light); font-weight: 600; }
input[type=text] {
  font-family: var(--font); border: 1.5px solid var(--border); border-radius: 10px;
  padding: 9px 13px; font-size: .92rem; color: var(--text); background: #fafbff;
  transition: border-color .2s; outline: none; width: 100%;
}
input[type=text]:focus { border-color: var(--main); }
#title { font-size: 1.15rem !important; font-weight: 600; }

.editor-body { flex: 1; display: flex; gap: 14px; min-height: 380px; }
#content {
  flex: 1; font-family: "Cascadia Code", Consolas, "JetBrains Mono", monospace;
  font-size: .9rem; line-height: 1.75; border: 1.5px solid var(--border); border-radius: 10px;
  padding: 14px 16px; resize: none; outline: none; background: #fafbff; color: var(--text);
  transition: border-color .2s; min-height: 100%;
}
#content:focus { border-color: var(--main); }
#preview {
  flex: 1; overflow-y: auto; border: 1.5px dashed var(--border); border-radius: 10px;
  padding: 14px 20px; background: #fff;
}
#preview.hidden { display: none; }
#preview h1, #preview h2, #preview h3 { margin: .8em 0 .5em; }
#preview h1 { font-size: 1.5rem; } #preview h2 { font-size: 1.25rem; } #preview h3 { font-size: 1.08rem; }
#preview p { margin: .5em 0; line-height: 1.8; }
#preview pre { background: #282c34; color: #abb2bf; padding: 14px; border-radius: 10px; overflow-x: auto; margin: .7em 0; }
#preview code { font-family: Consolas, monospace; font-size: .86em; }
#preview :not(pre) > code { background: rgba(66,90,239,.1); color: var(--main); padding: 2px 6px; border-radius: 5px; }
#preview blockquote { border-left: 4px solid var(--main); background: rgba(66,90,239,.05); padding: 10px 16px; border-radius: 0 8px 8px 0; margin: .7em 0; color: #5a6478; }
#preview ul, #preview ol { padding-left: 1.6em; margin: .5em 0; line-height: 1.8; }
#preview a { color: var(--main); }
#preview img { max-width: 100%; border-radius: 10px; }
#preview hr { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
#preview table { border-collapse: collapse; margin: .7em 0; }
#preview th, #preview td { border: 1px solid var(--border); padding: 6px 12px; }

.ed-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; gap: 10px; flex-wrap: wrap; }
.ed-footer .left { display: flex; gap: 10px; }
#save-hint { font-size: .82rem; color: #52c41a; opacity: 0; transition: opacity .3s; }
#save-hint.show { opacity: 1; }

/* 发布弹层 */
#mask {
  position: fixed; inset: 0; background: rgba(30, 38, 60, .45); backdrop-filter: blur(4px);
  display: none; align-items: center; justify-content: center; z-index: 200;
}
#mask.show { display: flex; }
.pub-box {
  background: #fff; border-radius: 16px; padding: 34px 40px; width: min(520px, 90vw);
  box-shadow: 0 20px 60px rgba(0,0,0,.25); text-align: center;
}
.spinner {
  width: 46px; height: 46px; margin: 0 auto 18px;
  border: 4px solid rgba(66,90,239,.18); border-top-color: var(--main);
  border-radius: 50%; animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.pub-box h3 { margin-bottom: 8px; }
.pub-box .out {
  margin-top: 16px; text-align: left; background: #f6f8fd; border-radius: 10px;
  padding: 12px 14px; font-size: .8rem; font-family: Consolas, monospace;
  max-height: 220px; overflow-y: auto; white-space: pre-wrap; color: #5a6478;
  display: none;
}
.pub-box .actions { margin-top: 20px; display: none; }
.pub-box.done .spinner { display: none; }
.pub-box.done .actions, .pub-box.done .out { display: block; }
.pub-box.done::before { content: "✅"; font-size: 46px; display: block; margin-bottom: 12px; }
.pub-box.fail.done::before { content: "❌"; }
</style>
</head>
<body>

<nav id="nav">
  <div class="brand"><div class="logo">✎</div>博客编辑器<span style="font-size:.75rem;color:var(--text-light);font-weight:400;margin-left:2px">qshaoxin.github.io</span></div>
  <div class="nav-right">
    <span id="dirty-dot"></span>
    <button class="btn btn-main" id="btn-publish" onclick="publish()">🚀 一键发布</button>
  </div>
</nav>

<div class="wrap">
  <div class="card">
    <button class="btn btn-ghost new-btn" onclick="newPost()">＋ 新建文章</button>
    <div class="card-title"><span class="tip">ARCHIVES</span><h2>全部文章</h2><span id="post-count" style="color:var(--text-light);font-size:.82rem"></span></div>
    <div id="post-list"></div>
  </div>

  <div class="card" id="editor-card">
    <div id="empty">
      <div class="big">📝</div>
      <div>选择左侧文章开始编辑，或点「新建文章」</div>
    </div>
    <div id="editor" style="display:none;flex:1;flex-direction:column">
      <div class="ed-row">
        <div class="field grow-1"><label>标题</label><input type="text" id="title" placeholder="文章标题"></div>
        <div class="field" style="width:170px"><label>分类（逗号分隔）</label><input type="text" id="categories" placeholder="随笔"></div>
        <div class="field" style="width:190px"><label>标签（逗号分隔）</label><input type="text" id="tags" placeholder="开始, 博客"></div>
      </div>
      <div class="editor-body">
        <textarea id="content" placeholder="在这里用 Markdown 写文章…" oninput="renderPreview()"></textarea>
        <div id="preview" class="hidden"></div>
      </div>
      <div class="ed-footer">
        <div class="left">
          <button class="btn btn-ghost btn-sm" id="btn-preview" onclick="togglePreview()">👁 预览</button>
          <button class="btn btn-danger-ghost btn-sm" onclick="delPost()">🗑 删除</button>
        </div>
        <span id="save-hint">✓ 已保存</span>
        <button class="btn btn-main" onclick="save()">💾 保存</button>
      </div>
    </div>
  </div>
</div>

<div id="mask">
  <div class="pub-box" id="pub-box">
    <div class="spinner"></div>
    <h3 id="pub-title">正在发布…</h3>
    <div style="color:var(--text-light);font-size:.85rem">提交并推送到 GitHub，之后网站约 1 分钟后自动更新</div>
    <div class="out" id="pub-out"></div>
    <div class="actions"><button class="btn btn-main" onclick="closePub()">好的</button></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script>
let currentFile = null;
const $ = id => document.getElementById(id);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

async function refresh() {
  const d = await api("/api/posts");
  const list = $("post-list");
  list.innerHTML = "";
  d.posts.forEach(p => {
    const el = document.createElement("div");
    el.className = "post-item" + (p.file === currentFile ? " active" : "");
    el.innerHTML = '<div class="t"></div><div class="d"><span></span></div>';
    el.querySelector(".t").textContent = p.title;
    el.querySelector(".d span").textContent = (p.date ? p.date.slice(0, 10) : "") + (p.categories.length ? " · " + p.categories.join("/") : "");
    el.onclick = () => openPost(p.file);
    list.appendChild(el);
  });
  $("post-count").textContent = d.posts.length ? "(" + d.posts.length + ")" : "";
  const s = await api("/api/status");
  const dot = $("dirty-dot");
  dot.textContent = s.dirty ? "● " + s.dirty + " 处未发布修改" : (s.last ? "✓ 已是最新" : "");
  dot.className = s.dirty ? "has" : "";
}

async function openPost(file) {
  if (!await confirmDiscard()) return;
  const d = await api("/api/post?file=" + encodeURIComponent(file));
  currentFile = file;
  $("empty").style.display = "none";
  $("editor").style.display = "flex";
  $("title").value = d.title;
  $("categories").value = (d.categories || []).join(", ");
  $("tags").value = (d.tags || []).join(", ");
  $("content").value = d.content;
  renderPreview();
  refresh();
}

function newPost() {
  if (!confirmDiscard()) return;
  currentFile = null;
  $("empty").style.display = "none";
  $("editor").style.display = "flex";
  $("title").value = "";
  $("categories").value = "";
  $("tags").value = "";
  $("content").value = "";
  renderPreview();
  refresh();
  $("title").focus();
}

let dirty = false;
["title", "categories", "tags", "content"].forEach(id => {
  $(id).addEventListener("input", () => dirty = true);
});

function confirmDiscard() {
  if (!dirty) return Promise.resolve(true);
  return Promise.resolve(confirm("当前文章有未保存的修改，确定放弃吗？"));
}

async function save() {
  const d = await api("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file: currentFile,
      title: $("title").value,
      categories: $("categories").value.split(",").map(s => s.trim()).filter(Boolean),
      tags: $("tags").value.split(",").map(s => s.trim()).filter(Boolean),
      content: $("content").value,
    }),
  });
  currentFile = d.file;
  dirty = false;
  $("save-hint").classList.add("show");
  setTimeout(() => $("save-hint").classList.remove("show"), 1600);
  refresh();
}

async function delPost() {
  if (!currentFile) return;
  if (!confirm("确定删除这篇文章吗？删除后需发布才会同步到网站。")) return;
  await api("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: currentFile }),
  });
  currentFile = null;
  $("editor").style.display = "none";
  $("empty").style.display = "flex";
  dirty = false;
  refresh();
}

let previewOn = false;
function togglePreview() {
  previewOn = !previewOn;
  $("preview").classList.toggle("hidden", !previewOn);
  $("btn-preview").textContent = previewOn ? "🙈 关闭预览" : "👁 预览";
  renderPreview();
}
function renderPreview() {
  if (!previewOn) return;
  const raw = $("content").value;
  $("preview").innerHTML = window.marked ? marked.parse(raw) : "<pre>" + raw.replace(/</g, "&lt;") + "</pre>";
}

async function publish() {
  if (dirty && !confirm("当前文章有未保存的修改，发布前不会包含这些修改。继续发布吗？")) return;
  const box = $("pub-box");
  box.className = "pub-box";
  $("pub-title").textContent = "正在发布…";
  $("pub-out").textContent = "";
  $("mask").classList.add("show");
  $("btn-publish").disabled = true;
  try {
    const d = await api("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    box.classList.add("done");
    box.classList.toggle("fail", !d.ok);
    $("pub-title").textContent = d.pushed ? "发布成功！" : "没有新变更";
    $("pub-out").textContent = d.output || "";
    dirty = false;
    refresh();
  } catch (e) {
    box.classList.add("done", "fail");
    $("pub-title").textContent = "发布失败";
    $("pub-out").textContent = String(e.message || e);
  }
  $("btn-publish").disabled = false;
}
function closePub() { $("mask").classList.remove("show"); }

refresh();
</script>
</body>
</html>`;
