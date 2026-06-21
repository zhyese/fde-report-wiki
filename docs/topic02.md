---
title: "深度专题二 Agent 编排实战:六种拓扑、HITL、状态契约与故障应对"
tags: ["Agent", "可观测性", "成本容量", "应用架构"]
---

> **专题定位**:Agent 编排是 2026 年 FDE 的核心技能(本书[第 8 章](/ch08)),但"知道有哪些框架"和"能在客户现场把多 Agent 系统跑稳"是两回事。本专题深入编排拓扑、状态契约、HITL 设计、故障应对的实战细节。

## 一、从"调一个 LLM"到"编排一群 Agent"

单次 LLM 调用是"一问一答",Agent 编排是"让多个 LLM 调用 + 工具调用 + 人工节点,按一定拓扑协作完成复杂任务"。FDE 在客户现场搭建的,几乎都是后者。

**Agent 编排的本质挑战**
- **状态管理**:多步、多 Agent 之间要共享和传递状态;
- **控制流**:顺序、并行、循环、条件分支,要能灵活组合;
- **可靠性**:任何一步可能失败,要能重试、降级、回滚;
- **可观测**:多步链路要能追踪、归因;
- **人在环(HITL)**:关键节点要能插入人工审核;
- **成本控制**:多 Agent 容易烧 token,要设上限。

> **2026 共识**:O'Reilly 指出企业 Agent 部署仍以 DIY 为主,FDE 在编排上有巨大自主权;LinkedIn 判断"从 agentic prompts 到 stateful orchestration 是 2026 决定性变化"。**有状态、可审计**是生产级编排的硬要求。

## 二、六种典型编排拓扑

FDE 设计 Agent 系统时,先选拓扑。常见的六种:

**拓扑一:线性/管道(Pipeline)**
- Agent A → B → C 顺序执行;
- 适合:步骤清晰、无分支的流程(如:抽取 → 校验 → 入库);
- 优势:简单、可控、易调试;
- 框架:任何框架都能做。

**拓扑二:路由器(Router)**
- 一个路由 Agent 根据输入,分发给不同专职 Agent;
- 适合:客服分诊、工单派发(如 12345);
- 优势:可扩展(加新专职 Agent 即可);
- 关键:路由准确度。

**拓扑三:并行扇出/扇合(Fan-out/Fan-in)**
- 一个任务拆成多个子任务并行执行,再合并结果;
- 适合:多源调研、批量处理;
- 优势:快;
- 关键:合并策略。

**拓扑四:规划-执行(Planner-Executor)**
- 规划 Agent 拆解步骤,执行 Agent 逐步执行;
- 适合:复杂任务(研究、尽调);
- 代表:ReAct、Plan-and-Execute 模式;
- 关键:规划质量 + 执行可控。

**拓扑五:辩论/多角色(Debate/Multi-persona)**
- 多个不同视角的 Agent 辩论/讨论,得出更稳健结论;
- 适合:高风险决策、创意发散;
- 代价:成本高。

**拓扑六:层级/主管(Hierarchical / Supervisor)**
- 一个主管 Agent 管理多个子 Agent,动态分配;
- 适合:复杂、动态任务;
- 代表:CrewAI 的 crew、LangGraph 的 supervisor;
- 关键:主管的调度能力。

> **选型经验**:简单场景别上复杂拓扑——大部分企业场景,线性/路由/规划-执行就够。复杂拓扑的调试和成本代价,只有在确实需要时才值得。

## 三、状态契约:Agent 间如何"对齐"

多 Agent 协作,最大隐患是"状态对不齐"——A 输出的格式 B 接不住。**状态契约**是解法。

**状态契约的要素**
- **数据结构**:用 Pydantic/TypedDict 定义状态 schema;
- **字段约定**:每个字段的类型、含义、必填;
- **版本管理**:状态 schema 变更要版本化;
- **校验**:每个节点入口校验状态合法性。

**LangGraph 的 State 实现**
- LangGraph 用 TypedDict/Pydantic 定义 Graph State;
- 每个节点接收 state、返回 state 更新;
- 框架负责 state 在节点间的传递与合并(reducer);
- 支持 checkpointing(状态持久化、可恢复)。

> **可照抄(LangGraph 状态定义)**:
> ```python
> from typing import TypedDict, Annotated
> from langgraph.graph import StateGraph
> import operator
>
> class AgentState(TypedDict):
>     query: str
>     retrieved_docs: Annotated[list, operator.add]  # 多节点追加
>     answer: str
>     needs_human: bool
>
> graph = StateGraph(AgentState)
> # 节点接收/返回 state,框架管理传递
> ```

## 四、HITL 设计:把人嵌进 Agent 链路

**HITL 不是"Agent 不行才叫人",而是架构设计的一等公民。**

**HITL 的设计维度**
- **在哪插**:按风险等级,在高风险节点插(支付、删除、对外发送);
- **怎么插**:Agent 暂停 → 人审核 → Agent 继续(interrupt/resume);
- **审什么**:给审核人足够上下文(输入、检索、Agent 推理);
- **反馈回流**:人的审核决策要记录,用于优化 Agent。

**LangGraph 的 HITL**
- 用 `interrupt()` 暂停 graph;
- 状态持久化(checkpointer);
- 人审核后 `Command(resume=...)` 继续;
- 支持超时、升级。

> **可照抄(LangGraph HITL)**:
> ```python
> def review_node(state):
>     # 暂停等待人工审核
>     return interrupt({"draft": state["answer"], "action": "approve?"})
>
> # 编译时配置 checkpointer(持久化状态)
> app = graph.compile(
>     checkpointer=MemorySaver(),
>     interrupt_before=["review_node"]
> )
> ```

## 五、工具与 MCP:让 Agent 能"动手"

**Agent 的能力边界 = 它能调用的工具。** MCP 让工具接入标准化。

**工具设计原则**
- **单一职责**:一个工具做一件事;
- **描述清晰**:工具描述决定 Agent 会不会用对;
- **参数 schema 严格**:用 Pydantic 约束;
- **错误友好**:工具出错要返回 Agent 能理解的错误信息;
- **幂等与安全**:危险操作要幂等 + 二次确认。

**MCP 化(企业系统接入)**
- 把企业系统(ERP/CRM/HIS/MES)包成 MCP server;
- Agent 即插即用调用;
- 统一权限、审计、限流。

> **SB Energy 模式**:FDE 的核心工作之一就是"把企业系统 MCP 化",让 Agent 能直接操作业务系统。

## 六、护栏(Guardrails):给 Agent 设边界

**没有护栏的 Agent 是危险的——它可能调用危险工具、输出有害内容、被注入劫持。**

**护栏类型**
- **输入护栏**:过滤恶意/越界输入(prompt injection 检测);
- **输出护栏**:过滤有害/违规/幻觉输出;
- **工具护栏**:限制工具调用(白名单、参数约束);
- **行为护栏**:限制 Agent 行为(不许循环超过 N 次、不许烧超过 X token)。

**工具**
- Guardrails AI、NeMo Guardrails、Lakera;
- 也可自研(规则 + 小模型)。

## 七、故障模式与韧性设计

**Agent 系统的故障,比传统软件更复杂、更隐蔽。** FDE 必须设计韧性。

**典型故障与应对**
- **LLM 调用失败**(超时/限流)→ 重试 + 指数退避 + 降级(换模型);
- **工具调用失败**(参数错/系统挂)→ 重试 + 降级(规则) + 告警;
- **死循环/烧 token**→ 步数上限 + token 上限 + 熔断;
- **幻觉/错误输出**→ 输出护栏 + 事实校验 + HITL;
- **被注入**→ 输入护栏 + 权限最小化 + 沙箱;
- **级联失败**(一个 Agent 错连累全链)→ 隔离 + 熔断 + 降级。

**韧性模式**
- **超时与重试**:每步设超时,失败重试;
- **降级**:Agent 不行 → 规则/人工;
- **熔断**:错误率超阈值熔断,保护系统;
- **隔离**:Agent 故障不影响其他;
- **可观测**:全链路追踪,快速归因;
- **回滚**:状态 checkpoint,出错可回滚。

## 八、可观测:多 Agent 链路要能"看清楚"

**多 Agent 系统不观测,出问题就是黑盒。**

**可观测要素**
- **追踪(tracing)**:每个请求的完整链路(LLM 调用、工具调用、状态变化);
- **指标(metrics)**:每步延迟、成功率、token、成本;
- **日志(logging)**:关键事件、错误;
- **回放(replay)**:能复现某次执行。

**工具**
- LangSmith(LangChain 生态,深度追踪);
- Langfuse(开源);
- Phoenix(Arize);
- OpenTelemetry(通用标准)。

## 九、成本控制:Agent 容易"烧钱"

**多 Agent 系统成本可能指数级增长,FDE 要主动控制。**

**成本控制手段**
- **模型分级**:简单步骤用小模型,复杂步骤用大模型;
- **缓存**:相同输入缓存结果;
- **token 上限**:每个任务/Agent 设 token 预算;
- **步数上限**:限制 Agent 循环次数;
- **批处理**:合并请求;
- **监控告警**:成本超阈值告警。

## 十、框架选型再深入

**LangGraph(生产首选)**
- 优势:有状态、可审计、HITL 原生、checkpoint、灵活拓扑;
- 适合:生产级复杂编排;
- 代价:学习曲线。

**CrewAI(快速原型)**
- 优势:多角色协作开箱即用、上手快;
- 适合:原型、中小规模;
- 代价:可控性、可观测不如 LangGraph。

**OpenAI Agents SDK**
- 优势:OpenAI 官方、轻量;
- 适合:已用 OpenAI 栈;
- 代价:生态绑定。

**自研**
- 优势:极致定制;
- 代价:重复造轮子,除非特殊需求不推荐。

> **选型建议**:生产用 LangGraph,原型用 CrewAI,绑定生态用官方 SDK,特殊需求才自研。

## 本专题小结

- Agent 编排本质挑战:状态/控制流/可靠性/可观测/HITL/成本;
- 六种拓扑:线性/路由/扇出扇合/规划执行/辩论/层级,按需选,别过度设计;
- 状态契约:Pydantic schema + 校验 + 版本,LangGraph State 典型;
- HITL:按风险插、interrupt/resume、反馈回流,是一等公民非补丁;
- 工具/MCP:工具单一职责+严格 schema,MCP 化企业系统(SB Energy 模式);
- 护栏:输入/输出/工具/行为四类,防 injection 与越界;
- 韧性:超时重试/降级/熔断/隔离/可观测/回滚;
- 可观测:追踪/指标/日志/回放,LangSmith/Langfuse/Phoenix;
- 成本:模型分级/缓存/token 上限/步数上限/批处理/告警;
- 框架:生产 LangGraph,原型 CrewAI。

> **本专题来源**:O'Reilly《AI Agents Stack 2026》、LangGraph/CrewAI/OpenAI SDK 文档、Alice Labs(18+ 生产部署)、StackOne/Uvik、OWASP MCP Top 10、SB Energy FDE JD、Anthropic MCP、用户库《FDE_Agent》《FDE_Agent混合作战单元》《fde-delivery 90/95》、本书[第 8 章](/ch08)。
