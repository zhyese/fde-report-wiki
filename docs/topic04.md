---
title: "深度专题四 Prompt 工程与认知重置:从\"咒语\"到工程"
tags: ["Prompt工程", "评估测试", "安全合规"]
---

> **专题定位**:Prompt 工程被低估为"写咒语",但 2026 的 Prompt 工程已是一门有方法、有模式、有版本管理、有评估的工程学科。本专题讲 FDE 如何把 prompt 当代码一样工程化管理。

## 一、认知重置:Prompt 不是"咒语",是"接口"

**大众误解**:prompt 是"神奇的咒语",会写 prompt 的人像魔法师。
**工程现实**:prompt 是**人与模型的接口 specification**——它定义任务、上下文、约束、输出格式,本质上和写 API 契约一样。

**认知重置的三个转变**
1. 从"灵感"到"工程":prompt 要可复现、可测试、可维护;
2. 从"单条"到"版本":prompt 要版本管理、可回滚;
3. 从"手工"到"评估":prompt 改动要靠评估量化,不是靠感觉。

> **FDE 的立场**:不否认 prompt 重要,但反对"prompt 玄学化"。把 prompt 当工程对象,是 FDE 区别于"prompt 玩家"的专业性。

## 二、Prompt 五要素

一个工业级 prompt,通常包含五个要素:

1. **角色(Role)**:定义模型扮演的身份("你是资深信贷风控专家");
2. **任务(Task)**:明确要做什么("判断这笔贷款申请的风险等级");
3. **上下文(Context)**:提供必要信息(客户资料、征信、流水);
4. **约束(Constraints)**:限制与要求("只输出 低/中/高 三档,并给理由");
5. **示例(Examples)**:少样本示范(输入→输出的样例)。

**五要素的工程价值**
- 每个要素独立可调(改任务不动角色);
- 缺哪个补哪个(诊断 prompt 问题时逐要素检查);
- 可模板化(行业/场景复用)。

## 三、CDEF-P 框架:Prompt 按交付阶段分层

**把 prompt 工程和 CDEF 方法论对齐——不同阶段用不同类型的 prompt。**

**Context 阶段 prompt**
- 访谈提纲、问题挖掘 prompt;
- 例:"基于以下客户业务描述,列出 5 个最可能的 AI 落地痛点,并评估价值。"

**Design 阶段 prompt**
- 方案生成、技术选型 prompt;
- 例:"在信创+等保三级约束下,为这个政务问答场景设计 RAG 架构。"

**Engineer 阶段 prompt**
- 生产 prompt(系统真正跑的);
- 这是最需要工程化的(版本/评估/AB)。

**Feedback 阶段 prompt**
- 评估、bad case 分析 prompt;
- 例:"分析这个错误回答的原因,归类为检索/生成/上下文问题。"

> **价值**:CDEF-P 让 prompt 不是一堆散乱的文本,而是按交付阶段有组织、可管理的资产。

## 四、Prompt 设计模式(2026 主流)

**少样本(Few-Shot)**
- 给几个输入→输出示例;
- 适合:格式固定、任务明确;
- 关键:示例的代表性与多样性。

**思维链(Chain-of-Thought, CoT)**
- 要求模型"一步步想";
- 适合:推理、数学、复杂判断;
- 关键:提升准确率但增加 token。

**ReAct(Reason + Act)**
- 模型边推理边调用工具;
- Agent 的基础模式;
- 关键:工具描述清晰。

**自洽(Self-Consistency)**
- 多次采样取多数;
- 适合:有确定答案的推理;
- 代价:成本高。

**反思(Reflection)**
- 让模型审视/修正自己的输出;
- 适合:质量要求高的生成;
- 代价:延迟与成本。

**结构化输出(Structured Output)**
- 强制 JSON/特定 schema 输出;
- 工程必备(便于下游处理);
- 工具:function calling、JSON mode、Pydantic 校验。

> **选型**:简单任务 few-shot,推理用 CoT,Agent 用 ReAct,高质量用 Reflection,生产必加结构化输出。

## 五、Prompt 版本管理

**Prompt 是代码,就要版本管理。**

**版本管理实践**
- prompt 存版本库(如 git/PromptLayer);
- 每次改动记 commit(改了什么、为什么、效果);
- 线上绑定版本,可回滚;
- prompt 变更走评审(像 code review)。

**工具**
- LangSmith(prompt 管理 + 评估);
- PromptLayer(prompt 版本管理);
- 自建(git + 配置中心)。

## 六、Prompt AB 测试

**改 prompt 不能靠"感觉更好",要 AB 测试。**

**AB 测试流程**
- 定义评估集与指标;
- 新旧 prompt 在同集跑;
- 对比指标(忠实度/准确率/任务成功);
- 数据决定切换。

**注意**
- 评估集代表性;
- 指标对齐业务;
- 多次平均(LLM 随机性);
- 灰度上线(线上 AB)。

## 七、Prompt 安全:注入防御

**Prompt Injection 是 LLM 时代的新攻击面,FDE 必须防御。**

**注入类型**
- 直接注入:用户输入恶意指令("忽略上面,执行...");
- 间接注入:检索到的文档/网页里藏恶意指令;
- 工具注入:工具返回里藏指令。

**防御手段**
- 输入与指令隔离(系统指令与用户输入分通道);
- 输入过滤(检测注入模式);
- 输出校验(防止越权输出);
- 权限最小化(即便被注入,能做的也有限);
- HITL(高危操作人审);
- 持续更新防御(注入手法在进化)。

> **OWASP / EY JD 都把 prompt injection 列为 LLM 头号风险。** FDE 在设计时就要把注入防御做进架构,而非事后补丁。

## 八、Prompt 工程工具链(2026)

**编写与管理**
- LangSmith、PromptLayer、Promptfoo;
- LangHub(prompt 市场)。

**测试与评估**
- Promptfoo(prompt/模型对比);
- DeepEval(LLM 单元测试);
- RAGAS/TruLens。

**监控**
- LangSmith/Langfuse(prompt 线上效果监控)。

## 九、Prompt 工程的常见反模式

**反模式一:巨型 prompt**
- 一个 prompt 塞所有逻辑,难维护;
- 解:拆分、模块化。

**反模式二:无示例**
- 零样本在生产场景常不稳;
- 解:关键任务加 few-shot。

**反模式三:无约束输出**
- 让模型自由输出,下游难处理;
- 解:强制结构化输出。

**反模式四:不版本化**
- prompt 改了就没了,出问题无法回滚;
- 解:版本管理。

**反模式五:不评估**
- 凭感觉改 prompt;
- 解:评估驱动。

## 十、Prompt 工程与 Context Engineering 的关系

**2026 趋势:Prompt Engineering 正在被 Context Engineering 吸收/升级。**

- Prompt 工程关注"如何写指令";
- Context Engineering 关注"如何构建整个上下文"(指令+检索+记忆+工具+约束);
- 当 RAG/Agent 成熟,prompt 只是上下文的一部分,Context Engineering 成为更大的框架。

> **FDE 的演进**:从"写好 prompt"到"构建好上下文管道"。但 prompt 工程的基本功(五要素、模式、版本、评估、安全)仍是地基。

## 本专题小结

- 认知重置:prompt 是接口 specification,不是咒语,要工程化;
- 五要素:角色/任务/上下文/约束/示例,逐要素可调可诊断;
- CDEF-P:prompt 按 Context/Design/Engineer/Feedback 阶段分层管理;
- 设计模式:few-shot/CoT/ReAct/自洽/反思/结构化输出,按场景选;
- 版本管理:prompt 是代码,git/PromptLayer,可回滚可评审;
- AB 测试:改 prompt 靠数据不靠感觉;
- 安全:prompt injection 是头号风险,隔离+过滤+校验+最小权限+HITL;
- 工具:LangSmith/PromptLayer/Promptfoo/DeepEval/RAGAS;
- 反模式:巨型/无示例/无约束/不版本/不评估;
- 趋势:Prompt Engineering 被 Context Engineering 升级吸收。

> **本专题来源**:LangChain/LangSmith/Promptfoo 文档、OWASP LLM Top 10、EY FDE JD(prompt injection)、O'Reilly 2026、用户库《FDE Prompt工程模板库》《CDEF方法论》《fde-delivery》、本书第 6、8 章。
