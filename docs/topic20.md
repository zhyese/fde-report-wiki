---
title: "深度专题二十 AI 系统可观测性与 SRE"
tags: ["可观测性", "MLOps", "性能调优", "成本容量"]
---

传统软件系统的 SRE 方法论（Google SRE 一书奠定的 SLI/SLO、错误预算、runbook、事故复盘体系）经过二十年沉淀已相当成熟。但当被运维的对象从"确定性函数"变成"概率性语言模型"时，这套方法论必须被重新校准：同样的指标名（延迟、错误率、吞吐）含义发生了漂移，还必须新增一整层"语义层"指标（幻觉率、拒答率、上下文召回率）。本专题站在 FDE/FDSE 驻场视角，回答两个问题：AI 系统的可观测性到底要观测什么，以及如何把 SRE 实践真正落到一个跑着 RAG + 工具调用 + 多模型的线上系统里。

## 20.1 为什么 AI 系统比传统软件更难运维

可观测性的本质是"从外部行为推断内部状态"。传统微服务之所以好观测，是因为它满足三个前提：输入确定则输出确定、单次请求成本可忽略、错误是二值的（要么抛异常要么不抛）。这三个前提在 LLM 系统里全部失效。

第一，**非确定性**。同一个 prompt 在 temperature=0 下仍可能因为浮点累加顺序、batch 调度、模型版本热更新而产出不同结果。这意味着"重放请求"这条传统排障手段失效——你无法用同样的输入复现一个线上幻觉。更棘手的是，错误的形态从"异常"扩展为连续光谱：完全正确、部分正确、格式错误、事实错误、有害输出、拒答。一个 HTTP 200 的响应可能携带严重幻觉，传统 APM（Datadog、New Relic）对此完全无感。

第二，**成本与延迟强耦合且非线性**。传统服务的延迟主要来自下游 RPC 与 DB，成本主要来自机器规格，二者近似解耦。LLM 服务中，延迟与成本都正比于 token 数，且 token 数在请求到达前不可精确预测（取决于 prompt 长度、检索召回量、模型自生成的推理长度）。一个 o1/R1 类推理模型单次请求可能消耗数万 reasoning token，成本与延迟同时爆炸，而 P99 延迟可能是 P50 的 10 倍以上。这让"按 QPS 容量规划"的传统思路失效。

第三，**幻觉是第一类故障**。传统系统的 bug 通常是确定可复现的代码缺陷；LLM 的幻觉是概率性、上下文相关的语义缺陷。更糟糕的是用户往往无法判断输出是否正确——这正是落地场景（医疗、法律、金融）最危险的失败模式。一个"99% 可用、0 异常"的系统可能在第 1% 的回答里给出致命错误的事实。

> 一句话：传统系统观测"它有没有坏"，AI 系统要观测"它坏的时候坏成了什么样、坏给了谁、为什么坏"。

FDE 在客户现场反复看到的真实落差是：客户的运维团队拿着 Datadog 看板，上面 HTTP 200 率 99.9%、P99 延迟达标，但业务方投诉不断——因为看板对幻觉、对上下文召回失败、对工具调用错配完全失明。补齐这一层语义观测，是 AI 系统真正能上生产的前提。

## 20.2 可观测三件套在 AI 系统的延伸

经典可观测三件套（Logs、Traces、Metrics）在 AI 系统仍然成立，但每一件都要向"语义层"延伸，并新增一类"LLM 专用证据"（prompt、检索片段、工具调用、模型输出）。

**日志（Logs）**：除标准结构化日志（request_id、user_id、timestamp、latency_ms）外，必须持久化每一次 LLM 调用的完整证据链——system prompt、user prompt、完整 messages 数组、模型名与版本、temperature/max_tokens 等采样参数、输入输出 token 数、原始输出文本。这是事后归因幻觉、复现 bug、回流训练数据的唯一原料。注意合规边界：PII 脱敏、用户授权、数据驻留（境内场景数据不出境）必须在采集层就处理，不能事后补救。建议采样而非全量（按错误率、按低分评价、按随机 1%-5%）以控制存储成本。

**追踪（Traces）**：这是 AI 可观测性最核心的一环。传统 trace 的 span 是 RPC 调用；AI trace 的 span 是一次"思考步骤"。一次用户请求可能穿越：输入预处理 → 意图分类（小模型）→ 查询改写（LLM）→ 向量检索 → 重排（reranker）→ 上下文压缩 → 主 LLM 生成 → 工具调用（可能多轮 ReAct）→ 输出后处理 → 安全审核。每个 span 要记录输入、输出、耗时、token、成本、模型版本。没有全链路 trace，RAG 与 Agent 的排障等同于盲人摸象。

**指标（Metrics）**：在 RED（Rate、Errors、Duration）与 USE（Utilization、Saturation、Errors）之上，AI 系统新增四个维度——延迟细分（TTFT、TPOT、总延迟）、成本（token/请求/用户/租户）、质量（幻觉率、拒答率、用户负反馈率）、检索（召回率、上下文相关性、命中率）。指标要支持按 model、prompt_version、tenant、use_case 多维下钻，否则定位不了"是哪个 prompt 版本引入的回归"。

**LLM 专用证据**：这是区别于传统 APM 的根本。每一次 LLM 调用的 prompt/completion 全文、每一次检索召回的 chunk 及其分数、每一次工具调用的入参出参，都必须作为可查询的"证据"留存，并支持按 trace_id 串联。这部分通常占到 LLM 可观测平台 80% 的存储与查询负载。

## 20.3 关键 SLI/SLO：从延迟到幻觉

SLI（服务等级指标）是可量化观测的代理量，SLO（服务等级目标）是 SLI 的目标值。AI 系统的 SLI/SLO 设计要同时覆盖"性能、成本、质量"三轴，任何一轴缺位都会导致线上事故被业务方先发现、运维后知后觉。

**延迟类 SLI**。LLM 服务必须把延迟拆成至少三段，因为它们的优化手段完全不同：

| 指标 | 定义 | 典型 SLO 目标 | 优化杠杆 |
|------|------|--------------|---------|
| TTFT（Time To First Token） | 从请求到达到首个 token 流出的时间 | P95 < 500ms-1s | 模型加载、KV cache 命中、首 token 调度 |
| TPOT / ITL（Time Per Output Token / Inter-Token Latency） | 生成阶段平均每个 token 的间隔 | P95 < 30-50ms | batch size、量化、推测解码 |
| E2E Latency | 用户请求到完整响应的总耗时 | 按 use_case 分档 | 全链路，含检索与工具 |

注意 TTFT 与 TPOT 不可混为一谈：一个 TTFT 达标但 TPOT 飙升的系统，用户会看到"首字很快、之后卡顿"，体验仍差。学术上已有更严格的 TBT（Time Between Tokens）指标，能捕捉 TPOT 平均值掩盖的局部停顿，适合对体验敏感的 C 端场景。对推理类模型（o1/R1），还要单独追踪 reasoning token 时长与生成时长的比例。

**吞吐类 SLI**：requests/s、tokens/s、并发会话数。注意 LLM 的吞吐与延迟存在强 trade-off（增大 batch 提升吞吐会抬高单请求延迟），容量规划必须同时设吞吐 SLO 和延迟 SLO，否则会出现"吞吐达标但 P99 延迟超标"的假合格。

**错误率 SLI**：这里要细分。HTTP 层错误（5xx、超时、限流 429）与传统含义一致；但 AI 系统还有一类"语义错误"——模型返回了 200 但内容是拒答、格式不符 JSON schema、工具调用参数非法、安全审核拦截。建议把错误率拆成 `http_error_rate`、`parse_error_rate`、`safety_block_rate`、`tool_call_error_rate` 四个独立 SLI，分别设 SLO，否则一个高拒答率的模型会被"零异常"掩盖。

**token 成本 SLI**：`cost_per_request`、`cost_per_user`、`cost_per_tenant`、`daily_token_spend`。这是传统系统没有的维度，却往往是 AI 项目亏损的元凶。一个未设上限的 Agent 循环、一个被 prompt injection 触发的长上下文，都可能在几小时内烧掉一个月预算。SLO 形态通常是"日成本上限"+"租户配额"。

**幻觉与质量 SLI**：这是最难也最关键的一类。常用代理量包括：用户负反馈率（踩/赞比，最直接但滞后）、LLM-as-Judge 自动评分（用更强模型给线上输出打分，覆盖率高但有自身偏差）、引用准确率（RAG 场景下输出引用是否能被召回片段支持）、人工抽检不合格率（最准但成本高）。一个务实的组合是：线上全量跑 LLM-as-Judge 做粗筛，对低分样本人工抽检做校准，同时采集用户负反馈做兜底。幻觉 SLO 通常按 use_case 分档——闲聊可放宽到 5%，法律/医疗/金融问答必须收紧到 1% 以下。

> 经验法则：如果一个 AI 系统的 SLO 只设了延迟和错误率，那它本质上还没准备好上生产。

**Goodput** 是近年学术与工业界推广的复合 SLO：定义为"同时满足所有 SLO（延迟、错误、质量）的请求占比"。Goodput 比 P99 延迟更贴近真实用户体验——一个 P99 延迟达标但 20% 请求触发幻觉的系统，Goodput 只有 80%，用户感知到的"好用率"远低于可用率指标。建议把 Goodput 作为北极星 SLO，单维度 SLO 作为下钻诊断。

## 20.4 LLM 专用可观测工具对比与接入

这一层是传统 APM 覆盖不到的空白市场，目前主流选择有四家，定位与商业模式差异显著。

**LangSmith**（LangChain 官方）：与 LangChain/LangGraph 深度绑定，对 LangGraph 的 Agent 状态机有原生可视化。闭源云服务，按用量计费（2024 年起收费），适合已经重度使用 LangChain 生态的团队。短板是供应商锁定强、自托管需企业版、对非 LangChain 框架支持一般。

**Langfuse**：MIT 协议开源，支持完全自托管（Docker 一键起），同时提供托管云。这是数据驻留要求严格（境内合规、医疗金融）场景的首选——你可以把所有 prompt/输出留在自己的 VPC 内。提供 trace、evaluation、prompt management、annotation 全套功能，框架无关（OpenAI SDK、LiteLLM、LangChain、LlamaIndex 都有官方集成）。社区活跃，是目前自托管赛道事实标准。

**Arize Phoenix**：Apache 2.0 开源，定位 LLM 评测+可观测，与 Arize Cloud（企业版）配套。强项在 evaluation 与漂移检测，对 RAG 评估（检索质量、上下文相关性）有开箱即用的指标。支持本地 notebook 内运行，适合数据科学团队做离线分析。短板是 trace 采集生态不如 Langfuse 广。

**Arize AI（Cloud）/ Helicone / Lunary / Braintrust** 等：商业云服务，开箱即用、免运维，按用量计费。适合快速验证或中小团队不想自托管。Braintrust 偏 eval+实验管理，与可观测交叉。

选型决策矩阵：

| 维度 | 数据驻留要求高 | 已用 LangChain | 重离线 eval 分析 | 想最小化运维 |
|------|:---:|:---:|:---:|:---:|
| Langfuse 自托管 | ✓ | | | |
| LangSmith | | ✓ | | ✓ |
| Phoenix | | | ✓ | |
| 商业云 | | | | ✓ |

接入示例（Langfuse，OpenAI Python SDK，OpenTelemetry 风格自动埋点）：

```python
from langfuse.openai import openai  # 替换官方 openai import 即可自动 trace
import os

os.environ["LANGFUSE_PUBLIC_KEY"] = "pk-lf-..."
os.environ["LANGFUSE_SECRET_KEY"] = "sk-lf-..."
os.environ["LANGFUSE_HOST"] = "https://cloud.langfuse.com"  # 自托管填自有域名

resp = openai.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "用一句话解释 SRE"}],
    metadata={"tenant": "acme", "use_case": "qa"},  # 自动进入多维下钻
)
```

对于不依赖特定框架、想统一接入多模型的场景，推荐 LiteLLM + Langfuse 集成：LiteLLM 在网关层统一鉴权、计费、限流，Langfuse 在观测层统一 trace 与 eval，二者解耦，是 FDE 在客户现场最常落的组合。接入后务必验证三件事：trace 是否完整覆盖检索与工具调用 span、cost 字段是否按真实价目表计算（很多平台默认价目表过时）、PII 脱敏规则是否在采集前生效。

## 20.5 全链路追踪：一次请求的解剖

以一个典型 RAG + 工具调用 Agent 为例，一次用户请求的理想 trace 结构如下：

```
trace_id=root
├── span: input_guardrail (50ms)         # 输入安全审核
├── span: intent_classify (120ms)        # 小模型分类
├── span: query_rewrite (300ms, 80 tok)  # LLM 改写查询
├── span: retrieval
│   ├── span: embed (40ms)
│   ├── span: vector_search (60ms)       # 记录 top_k、分数
│   └── span: rerank (90ms)              # 记录重排前后顺序
├── span: context_compress (200ms, 200 tok)
├── span: llm_generate (1800ms, 1500 tok)
│   ├── span: tool_call: search_db (400ms)
│   └── span: tool_call: calc (30ms)
├── span: output_guardrail (80ms)        # 输出安全+格式校验
└── span: llm_judge (600ms, 300 tok)     # 异步质量评分
```

每个 span 记录 input、output、duration、token、cost、model_version、status。trace 树形结构让排障可以二分定位：是检索召回差（retrieval span 看分数），还是 LLM 没用上召回（llm_generate span 看 prompt 里上下文是否到位），还是工具调用错配（tool_call span 看入参）。这种"分而治之"的排障能力，是把 RAG/Agent 从黑盒变白盒的关键。

工程上有两个坑：一是 span 采样策略，全量 trace 存储成本高，建议"错误请求 100% 采样 + 正常请求 1%-5% 采样"；二是异步 span（如 llm_judge）要用 `trace_id` 关联但不要阻塞主链路，否则会把延迟拉高一倍。

## 20.6 成本可观测：token 是新的计费单位

成本失控是 AI 项目从 PoC 走向生产最常见的死法。一个未观测的 Agent 循环、一个被 prompt injection 注入超长上下文的攻击、一个租户突然暴涨的用量，都可能在数小时内烧掉季度预算。成本可观测必须做到四层粒度：单请求（用于归因）、单用户（用于配额）、单租户（用于计费）、单 use_case（用于产品决策）。

最小可行的成本看板应包含：实时 token 消耗曲线（按模型分）、成本 Top10 租户/用户/use_case、成本异常检测（环比/同比突增告警）、成本-质量-延迟的联合散点图（识别"贵但差"的 use_case）。预算告警建议设两级：80% 预算触发 Slack 通知，100% 触发自动降级（切换到更便宜模型或限流）。LiteLLM 网关层天然支持按租户/用户/模型的预算与限流，是落地这层的事实标准。

一个常被忽略的点：reasoning 模型（o1/R1）的"思考 token"往往占成本大头且不可控。必须单独追踪 reasoning token 与 generation token 的比例，并为 reasoning token 设独立预算上限，否则一次复杂问题可能消耗数十美元。

## 20.7 幻觉与坏例监控：从被动到回流

幻觉监控的目标不是消除幻觉（不可能），而是让幻觉"可见、可归因、可回流"。一个闭环的坏例系统包含四个环节：

**采集**：触发采集的信号有三类——用户负反馈（踩、纠错、重新提问）、LLM-as-Judge 低分（异步全量打分）、规则触发（引用无法被召回片段支持、JSON schema 校验失败、安全审核拦截）。建议三类信号 union 后去重入库，每条记录关联完整 trace。

**归因**：对每条坏例，沿 trace 链路归因到根因。常见根因桶：检索召回失败（召回片段不含答案）、上下文压缩丢信息、模型能力不足（召回对了但生成错）、prompt 设计缺陷、工具调用错配、安全策略误杀。归因最好由 LLM-as-Judge 辅助+人工校准，避免纯人工吃不消、纯自动不靠谱。

**回流**：归因后的坏例按用途分流——可作 eval set 补充回归集、可作微调样本（需人工标注目标输出）、可作 prompt 优化输入（few-shot 示例）。坏例库是 AI 系统持续迭代的燃料，没有它的系统注定随模型版本漂移而劣化。

**看板**：幻觉率按 use_case、model_version、prompt_version 下钻的趋势图，是判断"这次模型升级是变好还是变坏"的核心依据。建议每次模型/prompt 发布前对比回归 eval set，发布后对比线上幻觉率，双闸把关。

## 20.8 SRE 实践：错误预算、告警、runbook、复盘

SRE 的核心思想——用错误预算平衡稳定性与迭代速度——在 AI 系统同样适用，但需针对 AI 特性调整。

**错误预算**：若 SLO 是"Goodput ≥ 95%"，则 5% 是错误预算。预算耗尽时冻结发布（feature freeze），优先修稳定性。AI 系统的特殊性在于错误来源多元——延迟、错误、幻觉都消耗预算，建议为质量类 SLO 单独设预算，避免"延迟达标掩盖幻觉恶化"。

**告警**：遵循"可执行"原则，每条告警都要对应一个 runbook 动作。典型告警阈值：TTFT P95 > 1s 持续 5 分钟、错误率 > 2%、日成本 > 预算 80%、幻觉率环比上升 50%、单租户用量异常。避免告警风暴——用多窗口多燃烧率算法（如 1h 窗口烧 2% 或 6h 窗口烧 5% 才告警）替代单阈值。

**Runbook**：每个告警配套 SOP，包含症状、诊断步骤（查哪个 trace、看哪个 span）、处置动作（切换模型、回滚 prompt、限流、降级）、升级路径。AI 系统的 runbook 要特别覆盖三类高频事故：模型供应商故障（切备用模型）、prompt 回归（回滚 prompt 版本）、成本爆炸（触发限流+降级）。

**事故复盘**： blameless 文化，每起 P0/P1 事故产出 timeline、根因、改进项。AI 事故的根因常落在"模型行为漂移 + 监控盲区"组合上，改进项要同时覆盖模型层（加固 prompt、加 guardrail）与观测层（补 SLI、调阈值）。

## 20.9 高可用架构：限流、熔断、降级、多模型热备

AI 系统的可用性依赖外部模型供应商（OpenAI、Anthropic、国内厂商），单供应商 = 单点故障。高可用架构要在四层兜底。

**限流**：网关层（LiteLLM、Kong、自研）按 tenant/user/ip 维度限流，防止恶意调用与租户间互相挤占。注意 LLM 限流单位是 token 而非 QPS——一个超长 prompt 单请求就可能耗尽下游配额，必须按 token 估算限流。

**熔断**：对下游模型 API 设熔断器（如连续 N 次 5xx 或 P99 超阈则熔断 30s），避免雪崩。熔断后自动切换备用模型或返回降级响应。

**降级**：预设降级链路。主模型（GPT-4o）故障或超时→切次模型（Claude/Gemini/国产）→再失败→切小模型（GPT-4o-mini）+ 模板回复→最后兜底缓存/默认答案。降级要在用户体验可接受范围内，且降级路径本身要有观测（不能静默降级导致质量下滑无人知）。

**多模型热备**：关键链路配置多供应商热备，健康检查+自动故障转移。国内合规场景注意数据驻留——境内/境外模型切换不能导致数据跨境。多模型还会带来 prompt 兼容性问题（不同模型对 system prompt、tool calling 格式支持不一），建议抽象统一的 prompt 模板层。

> 架构原则：把模型当不可靠外部依赖，永远假设它会挂、会慢、会变贵、会说谎。

## 本专题小结

AI 系统的可观测性与 SRE 不是传统 SRE 的简单扩展，而是新增了"语义层"——观测对象从"有没有坏"变成"坏成了什么样、坏给了谁、为什么坏"。落地要点：延迟拆成 TTFT/TPOT/E2E 三段分别设 SLO；成本按请求/用户/租户/use_case 四层粒度看板+预算告警；幻觉用 LLM-as-Judge 全量粗筛+人工校准+坏例回流闭环；工具选型上数据驻留敏感选 Langfuse 自托管，生态绑定选 LangSmith，重 eval 选 Phoenix；全链路 trace 是把 RAG/Agent 从黑盒变白盒的核心能力；高可用架构把模型当不可靠依赖，限流按 token、熔断+降级+多模型热备四层兜底。FDE 在客户现场的第一件事往往不是写代码，而是先补齐这一层观测——没有观测的 AI 系统，所有迭代都是瞎子摸象，所有事故都是事后诸葛亮。

## 本专题来源

- Google SRE 系列著作（《Site Reliability Engineering》《The Site Reliability Workbook》）关于 SLI/SLO、错误预算、runbook、事故复盘的经典框架
- Langfuse 官方文档与开源仓库（MIT 协议，自托管 LLM 可观测平台）https://langfuse.com
- Arize Phoenix 官方文档（Apache 2.0，LLM 评测与可观测）https://docs.arize.com/phoenix
- LangSmith 官方文档（LangChain 官方可观测平台）https://docs.smith.langchain.com
- Pydantic Logfire《AI Observability Pricing Comparison》https://pydantic.dev/articles/ai-observability-pricing-comparison ——Logfire/LangSmith/Langfuse/Phoenix 计费模型横向对比
- arXiv 2410.14257《Revisiting SLO and Goodput Metrics in LLM Serving》——TBT vs TPOT、Goodput 复合 SLO 的学术定义
- NVIDIA NIM Benchmarking 文档 https://docs.nvidia.com/nim/benchmarking ——ITL/TPOT、TTFT 推理指标基准
- Anyscale LLM Metrics 文档 https://docs.anyscale.com/llm/serving/benchmarking/metrics ——TTFT、inter-token latency、throughput SLO 实践
- Braintrust《What is LLM monitoring?》https://www.braintrust.dev/articles/what-is-llm-monitoring ——质量/成本/延迟/漂移四维监控
- LiteLLM 官方文档 https://docs.litellm.ai ——多模型网关、按 token 限流、成本追踪的事实标准实现
- BentoML《Key metrics for LLM inference》https://bentoml.com/llm/llm-inference-basics/llm-inference-metrics
- FDE 驻场交付实践（CDEF 方法论 Engineer/Feedback 阶段）中对客户线上 AI 系统的可观测改造与事故复盘经验
