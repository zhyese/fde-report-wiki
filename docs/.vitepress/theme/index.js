import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';
import { h } from 'vue';
import './custom.css';

// 标签 → 类别映射（与受控词表一致）。未命中的归 other。
const TAG_CAT = {
  // 行业
  '金融': 'industry', '医疗': 'industry', '制造': 'industry', '政务': 'industry',
  '零售电商': 'industry', '物流供应链': 'industry', '能源': 'industry', '电信媒体': 'industry',
  '法律': 'industry', '教育': 'industry', '农业': 'industry',
  // 技术
  'RAG': 'tech', 'Agent': 'tech', 'LLM选型': 'tech', '模型微调': 'tech', '推理优化': 'tech',
  '数据工程': 'tech', 'MLOps': 'tech', '安全合规': 'tech', '可观测性': 'tech', '边缘AI': 'tech',
  '知识图谱': 'tech', '多模态': 'tech', '成本容量': 'tech', '应用架构': 'tech', '性能调优': 'tech',
  '系统测试': 'tech', '可解释性': 'tech', '隐私计算': 'tech', '云原生': 'tech', '评估测试': 'tech',
  // 方法
  '项目交付': 'method', '需求工程': 'method', 'ROI': 'method', '合规伦理': 'method',
  '售前招投标': 'method', '客户成功': 'method', '组织变革': 'method', '产品化': 'method',
  '国际化': 'method', '知识管理': 'method', 'Prompt工程': 'method', '沙盘培养': 'method',
  // 能力
  '团队': 'skill', '职业发展': 'skill', '沟通': 'skill', '写作': 'skill', '演示汇报': 'skill',
  '财务素养': 'skill', '持续学习': 'skill', '思维模型': 'skill', '跨职能': 'skill',
  '可持续健康': 'skill', '失败复盘': 'skill', '案例研究': 'skill',
  // 视角
  '中国市场': 'angle', '海外模式': 'angle', '行业大模型': 'angle', '工具箱': 'angle'
};
const catOf = (t) => TAG_CAT[t] || 'other';

// 读取 frontmatter.tags，在正文上方渲染 #标签 徽章（按类别配色），点击跳 /tags。
const TagBadges = {
  setup() {
    const { frontmatter } = useData();
    return () => {
      const tags = frontmatter.value.tags;
      if (!tags || !tags.length) return null;
      return h(
        'div',
        { class: 'tag-badges' },
        tags.map((t) =>
          h('a', { class: 'tag-badge tag-' + catOf(t), href: '/tags#' + encodeURIComponent(t) }, '#' + t)
        )
      );
    };
  }
};

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'doc-before': () => h(TagBadges)
    })
};
