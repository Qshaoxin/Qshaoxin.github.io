const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");

const ROOT = __dirname;
const POSTS_DIR = path.join(ROOT, "source", "_posts");
const DATA_DIR = path.join(ROOT, "source", "_data");
const IMG_DIR = path.join(ROOT, "source", "img");
const ICON_DIR = path.join(IMG_DIR, "icons");
const PORT = 5177;

let yaml = null;
try { yaml = require(path.join(ROOT, "node_modules", "js-yaml")); } catch (e) { yaml = null; }

/* ---------- 通用工具 ---------- */
const now = () => {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const nowSlash = () => now().slice(0, 10).replace(/-/g, "/");
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function slugify(str) {
  let s = String(str || "").toLowerCase().replace(/[\\/:*?"<>|\s#]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s || /^-+$/.test(s)) s = "item";
  return s.slice(0, 60);
}
function safeName(f) {
  if (!f || !/^[\w一-龥.-]+\.md$/.test(f)) throw new Error("非法文件名");
  return f;
}
function readYaml(p) {
  if (!fs.existsSync(p)) return null;
  if (!yaml) throw new Error("缺少 js-yaml，请先在博客目录执行 npm install");
  return yaml.load(fs.readFileSync(p, "utf8"));
}
function writeYaml(p, d) {
  if (!yaml) throw new Error("缺少 js-yaml，请先在博客目录执行 npm install");
  fs.writeFileSync(p, yaml.dump(d, { lineWidth: -1, noRefs: true }), "utf8");
}
function run(cmd) {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60 * 1000 }); }
  catch (e) { throw new Error((e.stdout || "") + (e.stderr || "") + e.message); }
}
function detectWinProxy() {
  try {
    const reg = 'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ';
    const enabled = execSync(reg + "ProxyEnable", { encoding: "utf8" });
    if (!/0x1\b/.test(enabled)) return null;
    const out = execSync(reg + "ProxyServer", { encoding: "utf8" });
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}
function gitPush() {
  try { return run("git push"); }
  catch (e1) {
    const p = detectWinProxy();
    if (p) {
      try { return run(`git -c http.proxy=http://${p} push`); } catch (e2) { throw e1; }
    }
    throw e1;
  }
}
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
async function readJson(req) {
  const b = await readBody(req);
  try { return JSON.parse(b.toString("utf8") || "{}"); } catch { return {}; }
}

/* ---------- 文章 front-matter ---------- */
function parsePost(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, content: raw };
  const meta = {};
  let key = null, list = [];
  const flush = () => { if (key && list.length) meta[key] = list; key = null; list = []; };
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s+#/.test(line)) continue;
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      flush();
      key = kv[1];
      let v = kv[2].trim();
      if (!v) continue;
      if (/^\[.*\]$/.test(v)) { meta[key] = v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean); key = null; }
      else if (/^".*"$/.test(v) || /^'.*'$/.test(v)) meta[key] = v.slice(1, -1);
      else meta[key] = v;
    } else if (/^\s+-\s+/.test(line) && key) {
      list.push(line.replace(/^\s+-\s+/, "").trim());
    }
  }
  flush();
  return { meta, content: m[2] };
}
function buildPost(title, date, tags, categories, content, cover) {
  const fm = ["---", `title: ${title}`, `date: ${date}`];
  if (categories && categories.length) { fm.push("categories:"); categories.forEach(c => fm.push(`  - ${c}`)); }
  if (tags && tags.length) { fm.push("tags:"); tags.forEach(t => fm.push(`  - ${t}`)); }
  if (cover) fm.push(`cover: ${cover}`);
  fm.push("---", "");
  return fm.join("\n") + "\n" + content.replace(/\r\n/g, "\n");
}
function listPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const { meta } = parsePost(fs.readFileSync(path.join(POSTS_DIR, f), "utf8"));
      return {
        file: f, title: meta.title || f.replace(/\.md$/, ""), date: String(meta.date || ""),
        tags: Array.isArray(meta.tags) ? meta.tags : [], categories: Array.isArray(meta.categories) ? meta.categories : [],
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ---------- 闲言碎语 essay.yml ---------- */
const ESSAY_FILE = path.join(DATA_DIR, "essay.yml");
function getEssayData() {
  let d = readYaml(ESSAY_FILE);
  if (!d || !d.length) d = [{ title: "即刻", home_essay: true, subTitle: "闲言碎语", tips: "记录一闪而过的念头", buttonLink: "/", buttonText: "回到首页", limit: 10, essay_list: [] }];
  if (!d.some(x => x.home_essay)) d[0].home_essay = true;
  return d;
}
function essayList() {
  const d = getEssayData();
  const e = d.find(x => x.home_essay) || d[0];
  return (e.essay_list || []).map((it, i) => ({ id: i, content: it.content, date: it.date, image: it.image || [], from: it.from }));
}
function essayAdd({ content, images, from }) {
  const d = getEssayData();
  const e = d.find(x => x.home_essay) || d[0];
  e.essay_list = e.essay_list || [];
  e.essay_list.unshift({ content, date: now().slice(0, 16) + ":00", image: images && images.length ? images : undefined, from: from || "博客" });
  writeYaml(ESSAY_FILE, d);
}
function essayDelete(id) {
  const d = getEssayData();
  const e = d.find(x => x.home_essay) || d[0];
  e.essay_list.splice(Number(id), 1);
  writeYaml(ESSAY_FILE, d);
}

/* ---------- 相册集 album.yml ---------- */
const ALBUM_FILE = path.join(DATA_DIR, "album.yml");
function albumList() {
  const d = readYaml(ALBUM_FILE) || [];
  return d.map(a => ({
    class_name: a.class_name, path_name: a.path_name, description: a.description,
    cover: a.cover, type: a.type || 2,
    photos: (a.album_list || []).reduce((n, it) => n + (it.image || []).length, 0),
    album_list: (a.album_list || []).map((it, i) => ({ id: i, content: it.content, date: it.date, image: it.image || [] })),
  }));
}
function albumCreate({ name, description }) {
  const d = readYaml(ALBUM_FILE) || [];
  const slug = slugify(name);
  if (d.some(a => a.path_name === `/album/${slug}/`)) throw new Error("已有同名相册");
  d.push({
    class_name: name, path_name: `/album/${slug}/`, description: description || name,
    cover: `https://picsum.photos/seed/${slug}/640/360`,
    top_background: `https://picsum.photos/seed/${slug}-bg/1920/480`,
    type: 2, rowHeight: 220, limit: 24, album_list: [],
  });
  writeYaml(ALBUM_FILE, d);
  const dir = path.join(ROOT, "source", "album", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.md"),
    `---\ntitle: ${name}\ndate: ${now()}\ntype: album_detail\ntop_img: false\naside: false\n---\n`, "utf8");
}
function albumDelete(pathName) {
  let d = readYaml(ALBUM_FILE) || [];
  const a = d.find(x => x.path_name === pathName);
  if (!a) throw new Error("相册不存在");
  d = d.filter(x => x.path_name !== pathName);
  writeYaml(ALBUM_FILE, d);
  const slug = pathName.replace(/^\/album\/|\/$/g, "");
  fs.rmSync(path.join(ROOT, "source", "album", slug), { recursive: true, force: true });
}
function albumAddPhoto(pathName, { content, images }) {
  const d = readYaml(ALBUM_FILE) || [];
  const a = d.find(x => x.path_name === pathName);
  if (!a) throw new Error("相册不存在");
  a.album_list = a.album_list || [];
  a.album_list.unshift({ content: content || "", date: nowSlash(), image: images });
  if (a.album_list.length === 1) a.cover = images[0];
  writeYaml(ALBUM_FILE, d);
}
function albumDeletePhoto(pathName, itemId, imgIdx) {
  const d = readYaml(ALBUM_FILE) || [];
  const a = d.find(x => x.path_name === pathName);
  if (!a) throw new Error("相册不存在");
  const item = a.album_list[Number(itemId)];
  if (!item) throw new Error("照片组不存在");
  if (imgIdx === undefined || imgIdx === null || imgIdx === "") {
    a.album_list.splice(Number(itemId), 1);
  } else {
    item.image.splice(Number(imgIdx), 1);
    if (!item.image.length) a.album_list.splice(Number(itemId), 1);
  }
  writeYaml(ALBUM_FILE, d);
}

/* ---------- 页面编辑（保留原 front-matter，仅改 title 和正文） ---------- */
const PAGES = [
  { key: "about", file: "source/about/index.md", label: "关于本人" },
  { key: "comments", file: "source/comments/index.md", label: "留言板" },
];
function pageRead(key) {
  const p = PAGES.find(x => x.key === key);
  if (!p) throw new Error("页面不存在");
  const raw = fs.readFileSync(path.join(ROOT, p.file), "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const title = (m ? m[1] : "").match(/^title:\s*(.*)$/m);
  return { key, label: p.label, title: title ? title[1] : "", content: m ? m[2] : raw };
}
function pageSave(key, title, content) {
  const p = PAGES.find(x => x.key === key);
  if (!p) throw new Error("页面不存在");
  const fp = path.join(ROOT, p.file);
  const raw = fs.readFileSync(fp, "utf8");
  let out;
  if (/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(raw)) {
    out = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "---\n");
    out = raw.replace(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n)[\s\S]*$/, `$1$2${content.replace(/\r\n/g, "\n")}`);
    out = out.replace(/^(---\r?\n[\s\S]*?\r?\n---)/, h => h.replace(/^title:.*$/m, `title: ${title || p.label}`));
  } else {
    out = `---\ntitle: ${title || p.label}\n---\n\n${content}`;
  }
  fs.writeFileSync(fp, out, "utf8");
}

/* ---------- 站点设置 ---------- */
function replaceTopKey(text, key, value) {
  const re = new RegExp(`^${key}:.*$`, "m");
  if (!re.test(text)) return text + `\n${key}: ${value}\n`;
  return text.replace(re, `${key}: ${value}`);
}
function replaceInSection(text, section, key, value, indent) {
  const lines = text.split(/\r?\n/);
  let i = 0, out = [], replaced = false;
  while (i < lines.length) {
    const secMatch = lines[i].match(new RegExp(`^${section}:`));
    out.push(lines[i]); i++;
    if (secMatch) {
      while (i < lines.length && !/^\S/.test(lines[i])) {
        const kv = lines[i].match(new RegExp(`^${indent}${key}:.*$`));
        if (kv && !replaced) { out.push(`${indent}${key}: ${value}`); replaced = true; }
        else out.push(lines[i]);
        i++;
      }
      if (!replaced) { out.push(`${indent}${key}: ${value}`); replaced = true; }
    }
  }
  return out.join("\n");
}
function settingsRead() {
  const site = yaml.load(fs.readFileSync(path.join(ROOT, "_config.yml"), "utf8"));
  const theme = yaml.load(fs.readFileSync(path.join(ROOT, "_config.anzhiyu.yml"), "utf8"));
  const musicRaw = fs.readFileSync(path.join(ROOT, "source/music/index.md"), "utf8");
  const musicId = (musicRaw.match(/^\s+id:\s*(\S+)/m) || [])[1] || "";
  const ht = theme.home_top || {};
  return {
    site: { title: site.title, subtitle: site.subtitle, description: site.description, author: site.author },
    avatar: (theme.avatar && theme.avatar.img) || "",
    home_top: { title: ht.title || "", subTitle: ht.subTitle || "", siteText: ht.siteText || "" },
    categories: (ht.category || []).map(c => ({ name: c.name, path: c.path })),
    music: { id: musicId },
  };
}
function settingsSave(s) {
  let cfg = fs.readFileSync(path.join(ROOT, "_config.yml"), "utf8");
  ["title", "subtitle", "description", "author"].forEach(k => { if (s.site && s.site[k] !== undefined) cfg = replaceTopKey(cfg, k, s.site[k]); });
  fs.writeFileSync(path.join(ROOT, "_config.yml"), cfg, "utf8");

  let th = fs.readFileSync(path.join(ROOT, "_config.anzhiyu.yml"), "utf8");
  if (s.avatar) th = replaceInSection(th, "avatar", "img", s.avatar, "  ");
  if (s.home_top) {
    th = replaceInSection(th, "home_top", "title", s.home_top.title || "", "  ");
    th = replaceInSection(th, "home_top", "subTitle", s.home_top.subTitle || "", "  ");
    th = replaceInSection(th, "home_top", "siteText", s.home_top.siteText || "", "  ");
  }
  if (Array.isArray(s.categories) && s.categories.length) {
    const lines = th.split(/\r?\n/);
    const idxs = [];
    lines.forEach((l, i) => { if (/^    - name:/.test(l)) idxs.push(i); });
    idxs.forEach((li, n) => {
      const c = s.categories[n]; if (!c) return;
      lines[li] = `    - name: ${c.name || ""}`;
      for (let j = li + 1; j < lines.length; j++) {
        if (/^      path:/.test(lines[j])) { lines[j] = `      path: ${c.path || "/"}`; break; }
      }
    });
    th = lines.join("\n");
  }
  fs.writeFileSync(path.join(ROOT, "_config.anzhiyu.yml"), th, "utf8");

  if (s.music && s.music.id) {
    const mp = path.join(ROOT, "source/music/index.md");
    let raw = fs.readFileSync(mp, "utf8");
    raw = raw.replace(/^(\s*)id:.*$/m, `$1id: ${s.music.id}`);
    fs.writeFileSync(mp, raw, "utf8");
  }
}

/* ---------- 上传 ---------- */
async function handleUpload(req, url) {
  const rawName = url.searchParams.get("name") || "image.png";
  const ext = (path.extname(rawName) || ".png").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".png";
  const toIcons = url.searchParams.get("dir") === "icons";
  const slot = (url.searchParams.get("slot") || "").replace(/[^\w-]/g, "");
  const dir = toIcons ? ICON_DIR : IMG_DIR;
  const base = slot || (slugify(path.basename(rawName, path.extname(rawName))) || "image");
  const file = slot ? `${base}${ext}` : `${Date.now()}-${base}${ext}`;
  const buf = await readBody(req);
  if (!buf.length) throw new Error("空文件");
  if (buf.length > 15 * 1024 * 1024) throw new Error("图片超过 15MB");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf);
  return { url: (toIcons ? "/img/icons/" : "/img/") + file };
}

/* ---------- 外观定制 ---------- */
const APPEAR_FILE = path.join(DATA_DIR, "appearance.json");
const CUSTOM_CSS = path.join(ROOT, "source", "css", "custom.css");
function readAppearance() {
  try { return JSON.parse(fs.readFileSync(APPEAR_FILE, "utf8")); }
  catch (e) { return { color: "", bg: "", radius: "", hide: [], order: ["bbTimeList", "home_top", "recent-posts"], custom: "" }; }
}
function compileAppearance(a) {
  const css = [];
  if (a.color) css.push(`:root{--anzhiyu-main:${a.color}}`);
  if (a.bg) css.push(`#web_bg{background:url('${a.bg}') center / cover no-repeat fixed !important}`);
  if (a.radius) css.push(`.card,#page,.recent-post-item,.author-content,#album-swiper,#archive .article-sort-item{border-radius:${a.radius}px !important}`);
  const hide = a.hide || [];
  if (hide.includes("bbTimeList")) css.push("#bbTimeList{display:none !important}");
  if (hide.includes("home_top")) css.push("#home_top{display:none !important}");
  if (hide.includes("swiper")) css.push("#swiper_container_blog,#topPostGroup{display:none !important}");
  if (hide.includes("category")) css.push(".categoryGroup{display:none !important}");
  if (hide.includes("aside")) css.push("#aside-content{display:none !important}");
  if (Array.isArray(a.order) && a.order.length === 3) {
    css.push("#blog-container{display:flex;flex-direction:column}");
    a.order.forEach((id, i) => css.push(`#${id}{order:${i}}`));
  }
  if (a.custom) css.push(String(a.custom));
  return "/* 由博客后台外观定制生成 */\n" + css.join("\n") + "\n";
}
function writeAppearance(a) {
  fs.mkdirSync(path.dirname(APPEAR_FILE), { recursive: true });
  fs.writeFileSync(APPEAR_FILE, JSON.stringify(a, null, 2), "utf8");
  fs.mkdirSync(path.dirname(CUSTOM_CSS), { recursive: true });
  fs.writeFileSync(CUSTOM_CSS, compileAppearance(a), "utf8");
}

/* ---------- HTTP ---------- */
function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname.startsWith("/img/")) {
      const sub = decodeURIComponent(url.pathname.replace(/^\/img\//, ""));
      const inIcons = sub.startsWith("icons/");
      const base = path.basename(sub.replace(/^icons\//, "").replace(/[/\\]/g, ""));
      const fp = path.join(inIcons ? ICON_DIR : IMG_DIR, base);
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); return res.end(); }
      const ext = path.extname(fp).toLowerCase();
      const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp" }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(fp));
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    /* 文章 */
    if (req.method === "GET" && url.pathname === "/api/posts") return json(res, 200, { posts: listPosts() });
    if (req.method === "GET" && url.pathname === "/api/post") {
      const raw = fs.readFileSync(path.join(POSTS_DIR, safeName(url.searchParams.get("file"))), "utf8");
      const { meta, content } = parsePost(raw);
      return json(res, 200, { title: meta.title || "", date: String(meta.date || ""), cover: meta.cover || "", tags: meta.tags || [], categories: meta.categories || [], content });
    }
    if (req.method === "POST" && url.pathname === "/api/save") {
      const b = await readJson(req);
      const title = (b.title || "").trim() || "未命名文章";
      let file = b.file ? safeName(b.file) : null;
      if (!file) {
        const d = (b.date || now()).slice(0, 10).replace(/-/g, "");
        file = `${d}-${slugify(title)}.md`;
      }
      fs.writeFileSync(path.join(POSTS_DIR, file), buildPost(title, b.date || now(), b.tags || [], b.categories || [], b.content || "", b.cover || ""), "utf8");
      return json(res, 200, { ok: true, file });
    }
    if (req.method === "POST" && url.pathname === "/api/delete") {
      const b = await readJson(req);
      fs.unlinkSync(path.join(POSTS_DIR, safeName(b.file)));
      return json(res, 200, { ok: true });
    }
    /* 碎语 */
    if (req.method === "GET" && url.pathname === "/api/essays") return json(res, 200, { essays: essayList() });
    if (req.method === "POST" && url.pathname === "/api/essay/add") { essayAdd(await readJson(req)); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/essay/delete") { essayDelete((await readJson(req)).id); return json(res, 200, { ok: true }); }
    /* 相册 */
    if (req.method === "GET" && url.pathname === "/api/albums") return json(res, 200, { albums: albumList() });
    if (req.method === "POST" && url.pathname === "/api/album/create") { albumCreate(await readJson(req)); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/album/delete") { albumDelete((await readJson(req)).path_name); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/album/photo/add") { const b = await readJson(req); albumAddPhoto(b.path_name, { content: b.content, images: b.images }); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/album/photo/delete") { const b = await readJson(req); albumDeletePhoto(b.path_name, b.item, b.img); return json(res, 200, { ok: true }); }
    /* 页面 */
    if (req.method === "GET" && url.pathname === "/api/page") return json(res, 200, pageRead(url.searchParams.get("key")));
    if (req.method === "POST" && url.pathname === "/api/page/save") { const b = await readJson(req); pageSave(b.key, b.title, b.content); return json(res, 200, { ok: true }); }
    /* 设置 */
    if (req.method === "GET" && url.pathname === "/api/appearance") return json(res, 200, { appearance: readAppearance() });
    if (req.method === "POST" && url.pathname === "/api/appearance/save") {
      const b = await readJson(req);
      writeAppearance(b.appearance || {});
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/settings") return json(res, 200, settingsRead());
    if (req.method === "POST" && url.pathname === "/api/settings/save") { settingsSave((await readJson(req)).settings); return json(res, 200, { ok: true }); }
    /* 图片库 */
    if (req.method === "GET" && url.pathname === "/api/images") {
      const dir = fs.existsSync(IMG_DIR) ? fs.readdirSync(IMG_DIR) : [];
      const imgs = dir.filter(f => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f))
        .map(f => ({ url: "/img/" + f, name: f, size: fs.statSync(path.join(IMG_DIR, f)).size }))
        .sort((a, b) => b.name.localeCompare(a.name));
      return json(res, 200, { images: imgs });
    }
    /* 图标管理 */
    if (req.method === "GET" && url.pathname === "/api/icons") {
      const dir = fs.existsSync(ICON_DIR) ? fs.readdirSync(ICON_DIR) : [];
      return json(res, 200, { icons: dir.filter(f => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f)) });
    }
    if (req.method === "POST" && url.pathname === "/api/icon/delete") {
      const b = await readJson(req);
      const key = String(b.key || "").replace(/[^\w-]/g, "");
      if (!key) return json(res, 400, { error: "bad key" });
      const dir = fs.existsSync(ICON_DIR) ? fs.readdirSync(ICON_DIR) : [];
      dir.filter(f => f.replace(/\.[^.]+$/, "") === key).forEach(f => fs.unlinkSync(path.join(ICON_DIR, f)));
      return json(res, 200, { ok: true });
    }
    /* 上传 */
    if (req.method === "POST" && url.pathname === "/api/upload") return json(res, 200, await handleUpload(req, url));
    /* 状态与发布 */
    if (req.method === "GET" && url.pathname === "/api/status") {
      let dirty = 0, last = "";
      try { dirty = run("git status --short").trim().split("\n").filter(Boolean).length; } catch (e) {}
      try { last = run("git log -1 --pretty=format:%s"); } catch (e) {}
      return json(res, 200, { dirty, last });
    }
    if (req.method === "POST" && url.pathname === "/api/publish") {
      const b = await readJson(req);
      const msg = (b.message || "").trim() || `发布更新 ${now().slice(0, 16)}`;
      const st = run("git status --short");
      let unpushed = "";
      try { unpushed = run("git log @{u}..HEAD --oneline"); } catch (e) { unpushed = ""; }
      if (!st.trim() && !unpushed.trim()) return json(res, 200, { ok: true, output: "没有需要发布的变更，网站已是最新。", pushed: false });
      let commitInfo = "";
      if (st.trim()) {
        run("git add -A");
        run(`git commit -m "${msg.replace(/"/g, " ")}"`);
        commitInfo = "已提交新修改。";
      } else {
        commitInfo = "发现未推送的提交。";
      }
      const out = gitPush();
      return json(res, 200, { ok: true, output: commitInfo + (out || "推送完成。"), pushed: true });
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`博客后台已启动: http://127.0.0.1:${PORT}`);
  exec('start "" "http://127.0.0.1:' + PORT + '"', { shell: "cmd.exe" });
});

const PAGE = fs.readFileSync(path.join(__dirname, "admin-page.html"), "utf8");
