# FDE 全球市场与全行业落地调研报告 (2026) — Wiki

把单一巨型 Markdown 调研报告（约 32 万字 / 4 篇 23 章 + 62 深度专题 + 附录）构建成 VitePress 分章节 wiki。
**原文文件从不被修改**，所有页面由 `scripts/split.mjs` 从 `source/` 只读拆分生成。

## 本地预览

```bash
npm install
npm run split    # 从 source/ 拆分生成 docs/*.md + 侧边栏/导航（改内容后重跑）
npm run dev      # http://localhost:5173
```

## 功能

- **分章节 wiki**：4 篇 → 23 章 → 62 深度专题（按 技术纵深 / 方法论 / 能力 三类折叠）+ 附录
- **中文全文搜索**（VitePress local search，CJK 已支持）
- **四篇导语页**（`/part1`…`/part4`）：侧边栏组标题可点
- **交叉链接**：正文里「第 N 章 / 专题X」自动转站内链接（490+ 处）
- **标签系统**：每页顶部 `#标签` 徽章（按 行业/技术/方法/能力/视角 五色），`/tags` 按标签浏览
- **暗色模式**、每页右侧本页目录（H2/H3）

## 内容更新

1. 替换 `source/FDE全球市场与全行业落地调研报告_2026.md`
2. `npm run split` → 自动重生成全部页面、交叉链接、侧边栏、导语页
3. 标签在 `docs/.meta/tags.json`（可手改，或重跑标签 workflow）

## 部署

生产构建产物：`docs/.vitepress/dist`（纯静态）。

### Vercel（推荐，零配置）

```bash
npm i -g vercel        # 首次
vercel                 # 按提示：Framework=VitePress, Build=npm run build, Output=docs/.vitepress/dist
# 或导入 GitHub 仓库，Vercel 自动识别
```
base 默认 `/`，无需改。

### Netlify

- Build command: `npm run split && npm run build`
- Publish directory: `docs/.vitepress/dist`

### GitHub Pages

仓库已含 `.github/workflows/deploy.yml`。推到 `main` 后自动构建部署。

- **自定义域名 / user.github.io 根站点**：base 默认 `/`，直接可用。
- **项目页 user.github.io/\<repo\>/**：在 workflow 里按注释设置 `VITEPRESS_BASE: /<repo>/`。
- 仓库 Settings → Pages → Source = GitHub Actions。

## 目录结构

```
FDE报告Wiki/
├─ source/                       # 原始报告（自包含，部署用）
├─ scripts/split.mjs             # 拆分+交叉链接+标签+导语页
├─ docs/
│  ├─ index.md … ch23.md … topic62.md … part1-4.md … tags.md
│  ├─ .meta/tags.json            # 标签数据
│  └─ .vitepress/
│     ├─ config.mjs              # 站点配置（base 可由 VITEPRESS_BASE 覆盖）
│     ├─ generated.mjs           # 自动生成的 sidebar+nav
│     └─ theme/{index.js,custom.css}   # 标签徽章（五色）
└─ .github/workflows/deploy.yml  # GitHub Pages CI
```
