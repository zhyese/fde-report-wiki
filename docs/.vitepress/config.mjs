import { defineConfig } from 'vitepress';
import { sidebar, nav } from './generated.mjs';

// 配置说明：sidebar / nav 由 scripts/split.mjs 自动生成到 generated.mjs
// 改章节结构后，运行 `npm run split` 重新生成即可。
// 部署到子路径(如 GitHub Pages 项目页 https://<user>.github.io/<repo>/)时，
// 设环境变量 VITEPRESS_BASE=/<repo>/；默认 '/' 适用于 Vercel / Netlify / 自定义域名。
const base = process.env.VITEPRESS_BASE || '/';
export default defineConfig({
  base,
  title: 'FDE 全球市场与全行业落地调研报告',
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
