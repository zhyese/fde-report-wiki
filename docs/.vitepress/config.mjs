import { defineConfig } from 'vitepress';
import { sidebar, nav } from './generated.mjs';

// 配置说明：sidebar / nav 由 scripts/split.mjs 自动生成到 generated.mjs
// 改章节结构后，运行 `npm run split` 重新生成即可。
// 部署到子路径(如 GitHub Pages 项目页 https://<user>.github.io/<repo>/)时，
// 设环境变量 VITEPRESS_BASE=/<repo>/；默认 '/' 适用于 Vercel / Netlify / 自定义域名。
const base = process.env.VITEPRESS_BASE || '/';

// ---------- 中文本地搜索分词 ----------
// 问题：VitePress 本地搜索(MiniSearch)默认按空白/标点切词，中文连续字串会被当成
//   一整个 token(如正文"快速部署"存为整段 token "快速部署")。用户搜索"部署"时，
//   MiniSearch 的 prefix 仅匹配以"部署"开头的 term，而索引里 term 以"快速"开头 →
//   命中失败 → 中文几乎搜不到。
// 方案：自定义 tokenize，对中文做「单字 + 相邻双字(bigram)」切分，英文/数字按词。
//   构建期(Node)与查询期(前端)共用同一函数(VitePress 的 serializeFunctions 会把
//   themeConfig 中的函数序列化到前端并还原)，两端切词一致，AND 即可精准命中。
//   ⚠ 函数必须自包含：不得引用任何模块作用域变量(serializeFunctions 仅保留函数体源码，
//      前端用 new Function 还原，闭包丢失)。
function cjkTokenize(text) {
  if (!text) return [];
  const tokens = [];
  const matches = String(text).match(/[一-鿿]+|[a-z0-9]+/gi) || [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (/[一-鿿]/.test(m)) {
      for (let j = 0; j < m.length; j++) {
        tokens.push(m[j]);
        if (j < m.length - 1) tokens.push(m[j] + m[j + 1]);
      }
    } else {
      tokens.push(m.toLowerCase());
    }
  }
  return tokens;
}
function cjkProcessTerm(term) {
  return term == null ? null : String(term).toLowerCase();
}
export default defineConfig({
  base,
  title: 'FDE-Wiki',
  description: '2026 · 前沿部署工程师 (FDE) 全景调研 Wiki',
  lang: 'zh-CN',
  cleanUrls: true,
  ignoreDeadLinks: true,
  lastUpdated: false,

  markdown: {
    lineNumbers: false,
  },

  themeConfig: {
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '主题',

    nav: [{ text: '首页', link: '/' }, ...nav],

    sidebar,

    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: {
            tokenize: cjkTokenize,
            processTerm: cjkProcessTerm
          }
        },
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索'
          },
          modal: {
            displayDetails: '显示详情',
            resetButtonLabel: '清除查询',
            backButtonTitle: '返回',
            noResultsText: '没有结果',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭'
            }
          }
        }
      }
    },

    footer: {
      message: '本站由原始 Markdown 调研报告自动构建 · 原文未改动',
      copyright: 'FDE 调研报告 (2026)'
    },

    socialLinks: []
  }
});
