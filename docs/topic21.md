---
title: "深度专题二十一 知识图谱与 GraphRAG 深度实战"
tags: ["知识图谱", "RAG", "可解释性", "案例研究"]
---

> 一句话定位:向量 RAG 回答"哪段话和问题最像",GraphRAG 回答"这些实体之间到底有什么关系、整份资料讲了什么"。前者是语义检索,后者是结构化推理。

## 一、为什么向量 RAG 不够

过去两年,基于向量嵌入(embedding)+ 相似度检索的 RAG 已经成为企业 AI 落地的标配。它的逻辑很简单:把文档切成 chunk,每个 chunk 算一个向量,提问时把最像的 top-k 个 chunk 塞进 prompt。这套机制在"找段落"类问题上很好用,但在真实业务里频频翻车,原因集中在三类问题上。

**第一类:多跳关系(multi-hop)。** 当答案需要跨越多个实体、按关系链条推理时,向量 RAG 几乎无能为力。一个典型金融问题:"A 公司的董事长配偶控股的 B 公司,其主要供应商 C,是否曾被监管处罚?" 这需要至少四次跳转:董事长 → 配偶 → 控股关系 → 供应商 → 处罚记录。每一次跳转都是一次语义检索,而向量相似度无法保证把整条关系链上的 chunk 同时召回到同一个上下文里。Neo4j 的多跳推理基准测试显示,随着跳数增加,向量 RAG 的准确率快速衰减,而图增强检索的准确率曲线则平缓得多。

**第二类:全局摘要(global summarization)。** 当用户问的是"这批 5000 份合同里,关于数据跨境的条款整体趋势如何"这种全局性问题,向量 RAG 只能取 top-k,本质上是在用局部样本推断全局,会系统性漏掉低频但重要的信息。微软研究院在 GraphRAG 论文里专门把这类问题称为 "query-focused summarization over entire corpus",并指出传统 RAG 在这类问题上接近随机。

**第三类:实体推理与一致性。** 同一个实体在不同文档里可能有不同写法("阿里巴巴""阿里集团""Alibaba"),向量检索会把它当成三个不同东西,导致上下文重复或冲突。而知识图谱通过实体对齐(entity resolution)把它们合并成同一个节点,推理时天然一致。

> 结论:向量 RAG 解决的是"找得到",GraphRAG 解决的是"想得通"。前者适合事实查询,后者适合关系推理与全局综合。

## 二、知识图谱基础:实体、关系、属性与 schema

在谈 GraphRAG 之前,必须先理解它的底座——知识图谱(Knowledge Graph, KG)。

**三元组是基本单元。** 一条知识被表示为 `<主体, 关系, 客体>`,例如 `<阿里巴巴, 投资, 蚂蚁集团>`、`<张三, 任职于, 字节跳动>`。实体是节点,关系是边。每个实体和关系还可以挂属性,比如投资关系上挂"金额:50亿、时间:2024年"。

**本体(ontology / schema)定义"能说什么"。** schema 规定了有哪些实体类型(公司、人、产品)、哪些关系类型(投资、任职、供应)、每种关系的定义域和值域(投资关系的主体必须是公司类实体)。schema 可以很严格(如医疗 SNOMED CT、金融 FIBO),也可以很松(开放 schema,边抽边定义)。松 schema 灵活但容易脏,严 schema 干净但前期建模成本高。实践中通常先用轻量 schema 跑通,再逐步收紧。

**图数据库 Neo4j 是事实标准。** Neo4j 用属性图模型(property graph),节点和边都可以带任意属性,查询语言 Cypher 直观可读。一个典型的多跳查询:

```cypher
MATCH (c:Company {name:'A公司'})-[:HAS_CHAIRMAN]->(p:Person)
      -[:SPOUSE]->(s:Person)-[:CONTROLS]->(b:Company)
      -[:SUPPLIED_BY]->(supplier:Company)
WHERE supplier.flagged = true
RETURN supplier.name, supplier.violation
```

这条 Cypher 一句话就能表达向量 RAG 需要四轮检索才能拼凑的关系链。除了 Neo4j,生态里还有 TigerGraph(擅长大图分析)、Amazon Neptune(托管)、阿里 GDB、华为云图引擎、开源 NebulaGraph。选型上,中小规模与生态最全选 Neo4j;超大规模多跳分析选 TigerGraph;云原生托管选 Neptune/GDB。

## 三、用 LLM 自动构建知识图谱

手工建模一两个实体容易,面对几万份文档人工抽实体根本不现实。LLM 让"自动建图"第一次变得工程可行。核心流水线分四步。

**第一步,实体抽取(NER)。** 给 LLM 一个 chunk,prompt 要求它输出实体列表,每个实体带类型。关键是限制类型集合并要求归一化(同名实体合并)。微软 GraphRAG 用 GPT-4 级模型,设定 `entity_types = [organization, person, geo, event]`,并在 prompt 里要求"如果提到'阿里集团'和'阿里巴巴',归并为同一个实体,使用规范名"。

**第二步,关系抽取。** 在同一 chunk 内,要求 LLM 枚举实体对之间的关系,带关系类型和描述:`(source, target, description, weight)`。权重通常是 LLM 自评的"这条关系有多强"(1-10)。这里最容易踩的坑是 LLM 幻觉——它会编造 chunk 里不存在的关系。工程上通常加一道校验:让另一个 LLM 或规则检查每条关系能否在原文里找到证据句,找不到就丢弃。

**第三步,图构建与社区发现。** 把所有 chunk 抽出的实体和关系合并成一张大图。然后跑社区发现算法——微软 GraphRAG 默认用 **Leiden 算法**(比 Louvain 更稳定的层次化社区发现),把图划分成一层层的社区(communities):第一层是大社区(比如"金融圈""科技圈"),往下细分到小社区。每一层社区都会被 LLM 总结成一段 community summary。

**第四步,构建层次摘要。** 自底向上,LLM 把每个最底层社区里的实体和关系总结成一段话;再把这些话聚合成上层社区的摘要。最终得到一棵"社区摘要树",叶子是具体实体,根节点是整份语料的总摘要。这棵树就是 GraphRAG 做"全局问题"的检索基础。

> 微软 GraphRAG 框架(开源,github.com/microsoft/graphrag)把上述四步封装成了 `python -m graphrag.index` 一条命令,配置 `settings.yaml` 指定 LLM、embedding、chunk 大小、entity_types,即可对本地文档目录自动建图。它是当前最权威的 GraphRAG 参考实现,也是 FDE 做知识图谱 PoC 的首选脚手架。

## 四、GraphRAG 检索机制:局部、全局、混合

GraphRAG 的检索不是"一种",而是三种模式,对应不同问题类型。理解这点是用好 GraphRAG 的关键。

**Local Search(局部检索)——面向具体实体的问题。** 用户问"阿里巴巴的董事长是谁、投资了哪些公司",系统先定位到"阿里巴巴"这个实体节点,然后取它的 k 跳邻居(相关实体、关系、所在社区的摘要),一起喂给 LLM 生成答案。本质上是"以实体为中心的小子图检索 + 向量补充",延迟低、成本低,适合点查询。

**Global Search(全局检索)——面向整份语料的综合问题。** 用户问"这批财报里,科技公司对 AI 的投入整体趋势如何",系统走 map-reduce:把所有顶层社区的摘要分批发给 LLM,每批生成一个中间答案(带置信分),再把所有中间答案 reduce 成最终答案。这种方式能在几十秒内"读完"几万页文档给出全局结论,是向量 RAG 做不到的。2024 年 11 月微软又推出了 **Dynamic Community Selection**,根据问题动态挑选相关社区,而不是无脑扫全部,大幅降低了 global search 的 token 成本。

**Hybrid / DRIFT Search(混合检索)。** 实践中大部分问题是"既要点查询又要全局综合",于是出现了混合模式:先用向量检索找锚点 chunk,再用图遍历扩展相关实体,最后用社区摘要补全背景。微软 GraphRAG 0.4+ 内置的 DRIFT 检索就是这个思路。arXiv 上的基准研究(2507.03608)显示,在复杂推理任务上 Hybrid GraphRAG 全面优于纯向量 RAG,且问题越复杂,优势越大。

## 五、GraphRAG vs 向量 RAG:何时用哪个(决策树)

不是所有场景都该上 GraphRAG。它建图成本高、维护复杂,用错地方就是烧钱。给一线交付一个简明决策树:

```
问:答案需要跨多个实体按关系推理吗(多跳)?
├─ 是 → 优先 GraphRAG
└─ 否 → 进下一步
问:问题需要综合整份语料做全局判断吗(全局摘要)?
├─ 是 → 优先 GraphRAG
└─ 否 → 进下一步
问:实体之间关系是业务核心(股权/供应链/家谱/因果)?
├─ 是 → 优先 GraphRAG
└─ 否 → 用向量 RAG(更快、更便宜、够用)
```

补充一张对比表,便于和客户对齐:

| 维度 | 向量 RAG | GraphRAG |
|---|---|---|
| 擅长 | 事实查找、段落问答 | 多跳推理、全局综合、关系问答 |
| 建设成本 | 低(切 chunk + embed) | 高(LLM 抽实体关系 + 建图) |
| 查询延迟 | 秒级 | 秒级(local)到几十秒(global) |
| 可解释性 | 弱(给段落) | 强(给关系路径) |
| 增量更新 | 简单(加 chunk 重 embed) | 复杂(需要局部重建图) |
| 典型场景 | 客服 FAQ、文档问答 | 反欺诈、尽调、医疗诊断 |

> FDE 经验法则:先用向量 RAG 两周跑通 MVP,如果客户真实问题里有 30% 以上是"多跳/全局"类,再投入做 GraphRAG,否则就是过度工程。

## 六、行业应用

**金融:股权穿透、供应链、反欺诈关联。** 这是 GraphRAG 价值最直观的赛道。反洗钱(AML)的核心是关系链:账户 → 受益人 → 控股公司 → 关联交易。AWS 在 2025 年发布过一个完整方案——Amazon Bedrock Knowledge Bases + Neptune Analytics 构建 GraphRAG 反欺诈系统,能在毫秒级追踪"一个设备先后登录多个账户,随后发生欺诈交易"这种跨实体模式。FraudRAG(SSRN 论文)进一步给出了实时财报欺诈检测的生产架构。股权穿透和供应链尽调同理,一次查询就能拉出完整的关联方图谱,这是传统关系型数据库要写十几层 JOIN 才能勉强做到的。

**医疗:疾病-药物-基因三角。** 医疗知识图谱天然是多关系结构:疾病有症状、有致病基因,基因表达蛋白,蛋白是药物靶点,药物有相互作用。一个临床问题"携带 BRCA1 突变的患者,可用哪些靶向药,与正在服用的华法林是否有相互作用",需要穿过 突变 → 靶点 → 药物 → 相互作用 四跳。向量 RAG 召回不出完整链条,GraphRAG 配合 UMLS、DrugBank 这类现成本体,可以稳定给出带证据链的答案,且每一步关系都可追溯——这在医疗合规里是硬需求。

**政务:人-企-事关联。** 政务数据高度碎片化:工商登记、税务、社保、司法、不动产分属不同系统。GraphRAG 把"人—企业—地址—事件—许可证"织成一张图,支撑"这个人名下有几家公司、是否存在一址多照、是否牵涉未结案件"这类穿透式查询。某省"一网通办"试点里,用知识图谱把 14 个委办局数据打通,办一个营业执照关联查询从 5 天降到 10 分钟。

**法律:案例-法条-判决关联。** 法律推理本质是"本案事实 → 类似先例 → 适用法条 → 判决"的关系遍历。GraphRAG 把法条、司法解释、判决书、当事人构造成图,律师问"类似案情近五年判赔区间",系统先定位相似案件节点,再沿"引用同一法条"的边扩展,给出带案号的证据链。相比纯向量检索只返回"看起来像的判决书",GraphRAG 给的是结构化的判赔分布。

## 七、工程化挑战:图构建成本、增量更新、查询性能、幻觉

GraphRAG 不是"装上就能跑"的银弹,生产化有四个硬骨头。

**挑战一:图构建的 token 成本。** GraphRAG 建图要给每个 chunk 调一次 LLM 抽实体关系,token 消耗是纯向量 RAG 的 10 倍以上。业界流传一个标志性数字:2024 年初微软演示 GraphRAG,索引一个中等规模数据集花了约 33000 美元;到 2025 年中通过模型降级(GPT-4o-mini 抽取、GPT-4o 只做摘要)、prompt 精简、缓存命中,同一份数据降到约 33 美元——18 个月降了三个数量级。但对动辄几十万文档的企业库,成本仍是真实约束。优化手段:用便宜模型做抽取、用 composite index 减少重复 LLM 调用、对低信息密度 chunk 跳过抽取。

**挑战二:增量更新。** 这是目前 GraphRAG 最痛的工程问题。新增一批文档,理论上只需对新增 chunk 抽实体关系并 merge 到现有图;但社区发现是全局算法,新节点进来会改变社区结构,导致 community summary 失效,严格做法要重算社区+重生成摘要,等于半重建。社区里讨论(GitHub #511)和学术方案(如 EraRAG)都在攻这个问题,FDE 落地时常见折中:对增量文档只做 local search 可用的实体级 merge,定期(周/月)全量重算社区摘要。必须把"增量更新策略"写进交付方案,否则客户数据一更新系统就退化。

**挑战三:查询性能。** Global search 的 map-reduce 串行调用 LLM,首字延迟可能到 30-60 秒,体验差。优化方向:Dynamic Community Selection 减少扫描社区数、并行化 batch、对高频问题缓存答案、对 global 类问题做异步预计算。Local search 性能不是问题,毫秒到秒级即可。

**挑战四:幻觉与脏数据。** LLM 抽关系会编造,合并图会有冲突(同一对实体在不同 chunk 里关系描述不一致)。工程上必须加:(1)关系抽取的证据句校验,要求每条关系回指到原文;(2)冲突检测与人工或二次 LLM 仲裁;(3)答案生成时强制引用图路径,让输出可追溯。在金融、医疗这类强合规场景,没有证据链的 GraphRAG 不能上生产。

## 八、GraphRAG 的成本与何时该用——给 FDE 的落地清单

把成本和决策浓缩成一份可对客户的清单:

**成本三层。** (1)一次性建图成本:按文档量 × 平均 chunk 数 × 单 chunk LLM token 估算,1 万页文档用 GPT-4o-mini 级别大约几十到几百美元;(2)查询成本:local 几乎可忽略,global 因 map-reduce 较贵,单次几美分到几角;(3)维护成本:增量更新 + schema 演进 + 人工校验,通常占 TCO 的大头,容易被低估。

**该用的四类信号。** 客户问题里高频出现"关联、穿透、链路、影响、原因";数据本身是关系密集型(交易、股权、家谱、基因);需要可解释可追溯的答案(合规、审计);需要全局综合判断而非单点查询。命中两条以上,GraphRAG 就值得投入。

**不该用的三类信号。** 文档是平铺式知识(产品手册、FAQ)且查询就是找段落;数据量小(几百篇以内)直接塞全文;预算与运维能力不足以支撑图数据库和 LLM 抽取流水线。这些场景上 GraphRAG 是用大炮打蚊子,纯向量 RAG 更合适。

**PoC 路径建议。** 第一周,用微软 GraphRAG 开源版 + 客户 200-500 篇真实文档跑通,重点验证抽取质量(实体召回率、关系准确率)。第二周,准备 20 个客户真实问题,对比向量 RAG 与 GraphRAG 答案,用关系推理与全局综合类问题证明增量价值。第三周,把成本与增量更新方案讲清楚,决定是否进入工程化。三周出结论,不恋战。

## 本专题小结

GraphRAG 不是向量 RAG 的替代,而是它的进化形态:把"语义相似"升级为"关系推理 + 全局综合",代价是更高的建设与维护成本。它的价值在多跳关系、全局摘要、可解释推理这三类向量 RAG 做不好的问题上,而在事实查找类问题上并不比向量 RAG 更好。FDE 落地时,关键是判断客户问题结构——关系密集、需要穿透、需要全局判断,才值得投入 GraphRAG;否则用向量 RAG 两周交付更务实。工程上最大的坑是增量更新与建图成本,必须写进方案。微软 GraphRAG 开源框架 + Neo4j/Neptune 图数据库是当前最成熟的参考栈。

## 本专题来源

- Microsoft Research, *Project GraphRAG* 官方页面与开源实现 github.com/microsoft/graphrag
- Edge et al., *From Local to Global: A Graph RAG Approach to Query-Focused Summarization*, arXiv:2404.16130(2024)
- Microsoft Research Blog, *GraphRAG: Improving Global Search via Dynamic Community Selection*(2024-11-15)
- Neo4j, *How to Improve Multi-Hop Reasoning with Knowledge Graphs and LLMs*;*What is GraphRAG?*
- arXiv:2507.03608, *Benchmarking Vector, Graph and Hybrid Retrieval Augmented Generation*
- AWS Machine Learning Blog, *Combat Financial Fraud with GraphRAG on Amazon Bedrock Knowledge Bases*(2025)
- FraudRAG 论文,SSRN 6714178
- Microsoft Azure AI Blog, *GraphRAG Costs Explained: What You Need to Know*
- Medium / Graph Praxis, *The GraphRAG Cost Cliff: How $33,000 Became $33*;*Cutting GraphRAG Token Costs by 90% in Production*
- EraRAG, arXiv:2506.20963(增量更新方向)
- TigerGraph、Datavid、Chimera Technologies 关于金融/AML 知识图谱应用的技术博客
