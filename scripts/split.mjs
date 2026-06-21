// scripts/split.mjs
// 把单一巨型 Markdown 报告拆成 VitePress 多页 wiki。
// 功能：
//   1) 围栏感知地按 篇/章/专题/附录 切片（原文件只读，从不修改）
//   2) 交叉链接：正文里的「第 N 章」「专题X」自动转站内链接
//   3) 标签：读 docs/.meta/tags.json，注入 frontmatter + 生成 /tags 索引页
//   4) 四篇导语页：生成 part1-4.md，侧边栏组标题可点
// 改章节结构后，运行 `npm run split` 重新生成。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.resolve(ROOT, 'docs');
const META = path.resolve(DOCS, '.meta');
const TAGS_FILE = path.resolve(META, 'tags.json');
const GEN = path.resolve(DOCS, '.vitepress/generated.mjs');

// 源文件：优先用仓库内 source/（自包含、可部署），否则回退到上级 MD文件汇总（本地联动）
const SOURCE_NAME = 'FDE全球市场与全行业落地调研报告_2026.md';
const SRC_LOCAL = path.resolve(ROOT, 'source', SOURCE_NAME);
const SRC_PARENT = path.resolve(ROOT, '../MD文件汇总', SOURCE_NAME);
const SRC = fs.existsSync(SRC_LOCAL) ? SRC_LOCAL : SRC_PARENT;

fs.mkdirSync(DOCS, { recursive: true });
fs.mkdirSync(META, { recursive: true });
fs.mkdirSync(path.dirname(GEN), { recursive: true });

const raw = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n').split('\n');

// ---------- 标题正则（仅在围栏外匹配） ----------
const PART_RE  = /^#\s+第[一二三四五六七八九十百千]+篇/;
const CH_RE    = /^##\s+第\s*(\d+)\s*章/;
const TOPIC_RE = /^#\s+深度专题/;
const APP_RE   = /^#\s+附录\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const HASH_RE  = /^#+\s*/;
const titleOf = (line) => line.replace(HASH_RE, '').trim();
const pad = (n) => String(n).padStart(2, '0');

// ---------- 四篇导语 ----------
const PART_INTRO = [
  { title: '第一篇 · 范式与市场全景', desc: 'FDE 是什么、从哪里来（伊拉克战场 → 2026 AI 焦点）、全球市场多大、薪酬与人才缺口、头部公司模式（Palantir / OpenAI / Anthropic / Databricks / IBM / 国内云），以及它与相邻岗位的区别。这是决策者建立认知的入口。' },
  { title: '第二篇 · 工作方法论与最新工作方式', desc: 'Echo-Delta-Dev 三角编队、Discovery-first 与 CDEF 四阶段方法论、AI Agent 时代的人机混合作战单元与 MCP、驻场工程化技术栈（LLM/RAG/Agent/推理/可观测）、交付节奏与现场生存。管理者和执行者的方法论主线。' },
  { title: '第三篇 · 全行业落地', desc: '金融、医疗健康、制造业、政务与公共服务、零售电商、物流供应链、能源、电信媒体、法律/教育/农业——九大行业的 FDE 落地现状、标杆案例与打法。执行者照做行业落地。' },
  { title: '第四篇 · 能力、商业与未来', desc: 'FDE 能力模型与培养体系、商业模式与 ROI 衡量、合规安全与数据治理（OWASP MCP / 等保 / 个保法 / 数安法）、未来 3—5 年趋势与组织变革。' }
];

// ---------- 中文数字 → 阿拉伯（支持到 99） ----------
const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cn2num(s) {
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return (a ? CN[a] : 1) * 10 + (b ? CN[b] : 0);
  }
  let n = 0;
  for (const ch of s) n = n * 10 + (CN[ch] ?? 0);
  return n;
}

// ---------- 交叉链接 ----------
// 把正文里的「第 N 章」「专题X」转成站内链接；跳过标题行与代码围栏内的行；
// 顺带修掉 `` `python> `` 这类非法代码语言标记（消除构建警告）。
function crossLink(body) {
  const lines = body.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^#{1,6}\s/.test(line)) continue; // 不在标题里加链接
    line = line.replace(/第\s*(\d{1,2})\s*章/g, (m, d) => {
      const n = parseInt(d, 10);
      return (n >= 1 && n <= 23) ? `[第 ${n} 章](/ch${pad(n)})` : m;
    });
    line = line.replace(/专题([一二三四五六七八九十]{1,3})/g, (m, cn) => {
      const n = cn2num(cn);
      return (n >= 1 && n <= 62) ? `[专题${cn}](/topic${pad(n)})` : m;
    });
    lines[i] = line;
  }
  let result = lines.join('\n');
  result = result.replace(/```([a-zA-Z0-9+#.-]+)>/g, '```$1'); // 修 `` `python> `` → `` `python ``
  return result;
}

// ---------- Pass 1: 围栏感知的边界检测 ----------
let inFence = false;
const bounds = [];
for (let i = 0; i < raw.length; i++) {
  const line = raw[i];
  if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
  if (inFence) continue;
  if (PART_RE.test(line))        bounds.push({ kind: 'part', line: i });
  else if (CH_RE.test(line))     bounds.push({ kind: 'chapter', line: i, num: parseInt(line.match(CH_RE)[1], 10), title: titleOf(line) });
  else if (TOPIC_RE.test(line))  bounds.push({ kind: 'topic', line: i, title: titleOf(line) });
  else if (APP_RE.test(line))    bounds.push({ kind: 'appendix', line: i, title: titleOf(line) });
}

// ---------- Pass 2: 边界 → 页面区间 ----------
const pages = [];
let curPart = null;
let cur = null;
const close = (end) => { if (cur) { cur.end = end; pages.push(cur); cur = null; } };
for (const b of bounds) {
  if (b.kind === 'part') {
    close(b.line);
    curPart = titleOf(raw[b.line]);
  } else {
    close(b.line);
    cur = { kind: b.kind, part: curPart, title: b.title, num: b.num, start: b.line + 1, end: null };
  }
}
close(raw.length);

// ---------- 标签侧车 ----------
let tagsMap = {};
if (fs.existsSync(TAGS_FILE)) {
  try { tagsMap = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8')); } catch (e) { tagsMap = {}; }
}
const slugTitle = {};

const matter = (title, slug) => {
  const tags = (slug && tagsMap[slug]) || null;
  const out = ['---', 'title: ' + JSON.stringify(title)];
  if (tags && tags.length) out.push('tags: [' + tags.map((t) => JSON.stringify(t)).join(', ') + ']');
  out.push('---', '');
  return out.join('\n') + '\n';
};

// ---------- 首页 ----------
const firstBound = bounds.length ? bounds[0].line : raw.length;
const homeBody = crossLink(raw.slice(0, firstBound).join('\n').trim().replace(/^#\s+.*\n+/, ''));
fs.writeFileSync(
  path.join(DOCS, 'index.md'),
  '---\ntitle: FDE 全球市场与全行业落地调研报告 (2026)\nlayout: doc\n---\n\n' + homeBody + '\n'
);

// ---------- 逐页写出 ----------
const partGroups = new Map();
const topicItems = [];
let appendixLink = null;
let topicCount = 0;

// 62 专题三级分类（以原文总目录为权威；专题十五漏列，按标题归技术纵深）
const TECH = new Set([1,2,3,4,5,6,7,8,9,10,15,17,20,21,22,25,30,31,32,33,34,39,41,42,46,50,54,62]);
const METHOD = new Set([11,13,14,23,24,26,28,29,35,36,37,38,40,43,44,47,48,59,60]);
const topicBuckets = {
  tech:   { collapsed: true, items: [] },
  method: { collapsed: true, items: [] },
  skill:  { collapsed: true, items: [] },
};

for (const p of pages) {
  const body = crossLink(raw.slice(p.start, p.end).join('\n').trim());
  let slug;
  if (p.kind === 'chapter') {
    slug = 'ch' + pad(p.num);
    fs.writeFileSync(path.join(DOCS, slug + '.md'), matter(p.title, slug) + body + '\n');
    slugTitle[slug] = p.title;
    if (p.part) {
      if (!partGroups.has(p.part)) partGroups.set(p.part, { items: [], order: partGroups.size });
      partGroups.get(p.part).items.push({ text: p.title, link: '/' + slug });
    }
  } else if (p.kind === 'topic') {
    topicCount++;
    slug = 'topic' + pad(topicCount);
    fs.writeFileSync(path.join(DOCS, slug + '.md'), matter(p.title, slug) + body + '\n');
    slugTitle[slug] = p.title;
    topicItems.push({ text: p.title, link: '/' + slug });
    const cat = TECH.has(topicCount) ? 'tech' : (METHOD.has(topicCount) ? 'method' : 'skill');
    topicBuckets[cat].items.push({ text: p.title, link: '/' + slug });
  } else if (p.kind === 'appendix') {
    slug = 'appendix';
    fs.writeFileSync(path.join(DOCS, slug + '.md'), matter(p.title || '附录', slug) + body + '\n');
    slugTitle[slug] = p.title || '附录';
    appendixLink = '/' + slug;
  }
}

// ---------- 标签索引页 /tags ----------
const tagIndex = new Map();
for (const [slug, tags] of Object.entries(tagsMap)) {
  for (const t of (tags || [])) {
    if (!tagIndex.has(t)) tagIndex.set(t, []);
    tagIndex.get(t).push({ text: slugTitle[slug] || slug, link: '/' + slug });
  }
}
const sortedTags = [...tagIndex.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh'));
let tagsMd = '---\ntitle: 按标签浏览\nlayout: doc\n---\n\n# 按标签浏览\n\n> 共 ' + sortedTags.length + ' 个标签，覆盖 ' + Object.keys(tagsMap).length + ' 个页面。点击条目直达。\n\n';
if (!sortedTags.length) {
  tagsMd += '_（暂无标签。运行标签 workflow 生成 docs/.meta/tags.json 后重跑 npm run split。）_\n';
}
for (const [tag, items] of sortedTags) {
  tagsMd += '## ' + tag + '\n\n';
  for (const it of items) tagsMd += '- [' + it.text + '](' + it.link + ')\n';
  tagsMd += '\n';
}
fs.writeFileSync(path.join(DOCS, 'tags.md'), tagsMd);

// ---------- 四篇导语页 + 侧边栏 ----------
const orderedParts = [...partGroups.entries()].sort((a, b) => a[1].order - b[1].order);
for (let idx = 0; idx < orderedParts.length; idx++) {
  const [partTitle, g] = orderedParts[idx];
  const pslug = 'part' + (idx + 1);
  const intro = PART_INTRO[idx];
  let pmd = '---\ntitle: ' + JSON.stringify(partTitle) + '\nlayout: doc\n---\n\n';
  pmd += '> ' + (intro ? intro.desc : partTitle) + '\n\n## 本篇章节\n\n';
  for (const it of g.items) pmd += '- [' + it.text + '](' + it.link + ')\n';
  pmd += '\n';
  fs.writeFileSync(path.join(DOCS, pslug + '.md'), pmd);
  slugTitle[pslug] = partTitle;
  g.link = '/' + pslug;
}

const sidebar = [{ text: '📑 总目录（首页）', link: '/' }];
for (const [partTitle, g] of orderedParts) {
  sidebar.push({ text: partTitle, collapsed: false, link: g.link, items: g.items });
}
if (topicItems.length) {
  sidebar.push({
    text: '深度专题（共 ' + topicItems.length + ' 篇 · 分 3 类）', collapsed: true, items: [
      { text: '技术纵深（' + topicBuckets.tech.items.length + ' 篇 · RAG/Agent/推理/数据/安全/架构）', collapsed: true, items: topicBuckets.tech.items },
      { text: '方法论与交付（' + topicBuckets.method.items.length + ' 篇）', collapsed: true, items: topicBuckets.method.items },
      { text: '能力与职业（' + topicBuckets.skill.items.length + ' 篇）', collapsed: true, items: topicBuckets.skill.items },
    ],
  });
}
sidebar.push({ text: '🏷 按标签浏览', link: '/tags' });
if (appendixLink) sidebar.push({ text: '附录', link: appendixLink });

// ---------- 导航 ----------
const shortPart = (t) => (t.split('·')[1] || t).trim();
const nav = [];
for (const [partTitle, g] of orderedParts) {
  if (g.link) nav.push({ text: shortPart(partTitle), link: g.link });
}
if (topicItems.length) nav.push({ text: '深度专题', link: topicItems[0].link });
nav.push({ text: '🏷 标签', link: '/tags' });
if (appendixLink) nav.push({ text: '附录', link: appendixLink });

// ---------- 写 generated.mjs ----------
fs.writeFileSync(
  GEN,
  '// AUTO-GENERATED by scripts/split.mjs — 请勿手改。改章节结构后重跑 npm run split。\n' +
  'export const sidebar = ' + JSON.stringify(sidebar, null, 2) + ';\n\n' +
  'export const nav = ' + JSON.stringify(nav, null, 2) + ';\n'
);

// ---------- 汇总 ----------
const chapCount = pages.filter((p) => p.kind === 'chapter').length;
const taggedCount = Object.keys(tagsMap).length;
console.log('✅ 拆分完成（源: ' + (SRC === SRC_LOCAL ? 'source/（自包含）' : '../MD文件汇总（联动）') + '）');
console.log('   页面: 首页1 + 导语' + orderedParts.length + ' + 章节' + chapCount + ' + 专题' + topicCount + ' + 附录' + (appendixLink ? 1 : 0) + ' + 标签页1');
console.log('   交叉链接: 已对「第N章 / 专题X」启用；代码语言标记已清洗');
console.log('   标签: ' + (taggedCount ? '已加载 ' + taggedCount + ' 页 → ' + sortedTags.length + ' 个标签' : '未找到 tags.json'));
console.log('   输出: ' + DOCS);
