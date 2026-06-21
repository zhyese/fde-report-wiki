---
title: "深度专题十七 多 Agent 编排代码级实战"
tags: ["Agent", "应用架构", "可观测性", "MLOps"]
---

> 当单 Agent 跑通一个 demo 之后，下一个真正的工程难题是：怎么把多个 Agent 串成一条可控、可观测、可中断、可回滚的流水线。本专题不谈概念图，全部以可运行代码呈现：从 LangGraph 的最小骨架，到三 Agent 协作、HITL 中断恢复、CrewAI 角色编排、MCP 工具暴露、状态契约、护栏与可观测，最后给框架选型对照表。

## 17.1 为什么"编排"比"模型"更难

把一个 LLM 调用包装成 API 谁都会；真正的成本集中在三件事上：

1. **状态管理**——多个 Agent 之间要传结构化数据，中途任何一步出错都要能恢复；
2. **流程控制**——条件分支、循环、人工介入、超时降级，这些在传统工作流引擎里是标配，在 Agent 场景里几乎是裸奔；
3. **可观测性**——一条链路调了几个模型、各花多少 token、哪一步返回了什么、为什么走到这个分支，事后必须能复盘。

LangGraph、CrewAI、AutoGen、Llama Agents 这些框架的存在意义，就是把上述三件事从"你自己拿 if/else 糊"变成"框架原生支持"。本专题以 LangGraph（显式状态机派）和 CrewAI（角色协作派）为代表，给出代码级对照。

## 17.2 LangGraph 核心概念与最小骨架

LangGraph 把整条 Agent 流水线建模成一张**显式状态图**，五个核心概念必须吃透：

| 概念 | 本质 | 你需要记住的一句话 |
|---|---|---|
| **State** | 全局共享数据结构（`TypedDict` 或 Pydantic） | 每个节点读它、写它；框架负责合并 |
| **Node** | 一个 Python 函数，签名是 `state -> state 的部分更新` | 业务逻辑全在这里 |
| **Edge** | 节点间的连线 | 静态边或条件边（返回下一个节点名） |
| **Checkpoint** | 把 State 持久化到 SQLite/Postgres | 支持回滚、断点续跑 |
| **Interrupt** | 在指定节点之前暂停，等外部输入 | 实现 HITL 的基石 |

> 关键心智模型：**State 是单一数据源**，节点之间不直接传参，一切通信走 State。这让回滚、重放、调试都变得可能。

下面是最小可运行骨架（依赖 `pip install langgraph langchain-openai`）：

```python
from typing import TypedDict, Annotated
from operator import add
from langgraph.graph import StateGraph, START, END

# 1. 定义状态契约
class State(TypedDict):
    messages: Annotated[list, add]   # 用 add 做 reducer，列表自动拼接
    counter: int

# 2. 定义节点：返回部分更新，框架自动合并
def greet(state: State) -> dict:
    return {"messages": ["hello"], "counter": 1}

def bye(state: State) -> dict:
    return {"messages": [f"bye (count={state['counter']})"]}

# 3. 连图
g = StateGraph(State)
g.add_node("greet", greet)
g.add_node("bye", bye)
g.add_edge(START, "greet")
g.add_edge("greet", "bye")
g.add_edge("bye", END)

app = g.compile()
print(app.invoke({"messages": [], "counter": 0}))
# {'messages': ['hello', 'bye (count=1)'], 'counter': 1}
```

注意 `Annotated[list, add]` 这一行——它告诉框架"对这个字段用列表拼接而不是覆盖"。这是 LangGraph 的 reducer 机制，是多 Agent 写同一个字段而不互相覆盖的关键。

## 17.3 实战一：规划-执行-审核三 Agent 系统

这是 FDE 现场最常见的编排模式：一个 Agent 拆任务，一个 Agent 干活，一个 Agent 验收。如果验收不通过，回到规划阶段重做。

```python
from typing import TypedDict, Literal
from langgraph.graph import StateGraph, START, END
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

class PlanExecState(TypedDict):
    task: str
    plan: str
    result: str
    review: str
    pass_: bool
    retries: int

# —— 规划 Agent ——
def planner(state: PlanExecState) -> dict:
    prompt = f"你是项目经理。把下面任务拆成 3-5 个可执行步骤，用编号列表。\n任务：{state['task']}"
    return {"plan": llm.invoke(prompt).content}

# —— 执行 Agent ——
def executor(state: PlanExecState) -> dict:
    prompt = f"按下面计划执行，直接给最终交付物，不要复述计划。\n计划：\n{state['plan']}"
    return {"result": llm.invoke(prompt).content}

# —— 审核 Agent ——
def reviewer(state: PlanExecState) -> dict:
    prompt = (
        f"你是 QA。判断交付物是否满足原始任务。只输出 JSON："
        f'{{"pass": true/false, "comment": "..."}}\n'
        f"任务：{state['task']}\n交付物：{state['result']}"
    )
    import json, re
    raw = llm.invoke(prompt).content
    m = re.search(r'\{.*\}', raw, re.S)
    data = json.loads(m.group(0)) if m else {"pass": False, "comment": "解析失败"}
    return {"review": data["comment"], "pass_": bool(data["pass"]),
            "retries": state["retries"] + 1}

# —— 条件路由：审核通过就结束，否则回规划 ——
def route(state: PlanExecState) -> Literal["planner", "__end__"]:
    if state["pass_"] or state["retries"] >= 3:
        return END
    return "planner"

g = StateGraph(PlanExecState)
g.add_node("planner", planner)
g.add_node("executor", executor)
g.add_node("reviewer", reviewer)
g.add_edge(START, "planner")
g.add_edge("planner", "executor")
g.add_edge("executor", "reviewer")
g.add_conditional_edges("reviewer", route)   # 条件边
app = g.compile()

out = app.invoke({"task": "写一段 200 字的产品介绍，关于一款给老年人用的智能药盒",
                  "plan": "", "result": "", "review": "", "pass_": False, "retries": 0})
print(out["result"])
```

这段代码的工程价值在于：**循环逻辑被声明成了一条边**，而不是埋在某个函数的 while 里。重试上限、审核失败回滚，都在图结构里看得见，事后排查不需要翻业务代码。

## 17.4 实战二：HITL（Human-in-the-Loop）中断与恢复

现场交付里，"全自动"几乎都是 demo 阶段的幻觉。真实场景里，生成报告、给客户发邮件、修改订单，这些动作必须有人在中间确认。LangGraph 的 `interrupt` 就是干这个的。

```python
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt, Command
from langchain_openai import ChatOpenAI
import uuid

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

class HitlState(TypedDict):
    draft: str
    feedback: str

def write_draft(state: HitlState) -> dict:
    return {"draft": llm.invoke("写一封给客户的合同初稿，200 字").content}

# —— 关键：在这里中断，等人工输入 ——
def human_review(state: HitlState) -> dict:
    user_input = interrupt({
        "prompt": "请审核以下草稿，输入修改意见或输入 OK 放行：",
        "draft": state["draft"]
    })
    return {"feedback": user_input}

def revise(state: HitlState) -> dict:
    if state["feedback"].strip().upper() == "OK":
        return {}
    prompt = f"根据反馈修改：\n原稿：{state['draft']}\n反馈：{state['feedback']}"
    return {"draft": llm.invoke(prompt).content}

def route(state: HitlState) -> str:
    return END if state["feedback"].strip().upper() == "OK" else "revise"

g = StateGraph(HitlState)
g.add_node("write_draft", write_draft)
g.add_node("human_review", human_review)
g.add_node("revise", revise)
g.add_edge(START, "write_draft")
g.add_edge("write_draft", "human_review")
g.add_conditional_edges("human_review", route)
g.add_edge("revise", "human_review")    # 改完再让人审一遍

# 必须用 checkpointer 才能支持 interrupt/resume
app = g.compile(checkpointer=MemorySaver())

# —— 第一次调用：会在 human_review 处停下来 ——
thread = {"configurable": {"thread_id": str(uuid.uuid4())}}
result = app.invoke({"draft": "", "feedback": ""}, config=thread)
# 此时 result 因 interrupt 而暂停，state 里能拿到 draft

# —— 取出待审核内容（实际场景下推到前端 / 飞书 / 钉钉） ——
snapshot = app.get_state(thread)
print("待审草稿：", snapshot.values.get("draft"))

# —— 人工输入后恢复执行 ——
human_says = "把价格改成 ¥9800，并加上保密条款"
final = app.invoke(Command(resume=human_says), config=thread)
print("最终稿：", final["draft"])
```

三个工程要点必须强调：

1. **`interrupt` 不是 `input()`**——它把当前 state 落盘到 checkpointer，进程可以重启、机器可以换，只要 `thread_id` 一致就能恢复；
2. **resume 用 `Command(resume=...)`**——这是 0.2+ 版本的写法，老的 `invoke(human_input)` 已废弃；
3. **生产环境把 `MemorySaver` 换成 `PostgresSaver` 或 `SqliteSaver`**——内存版重启即丢，只适合单测。

## 17.5 实战三：CrewAI 多角色 Crew 快速搭建

CrewAI 走的是另一条路线：**不画状态图，而是声明角色（Agent）、任务（Task）、流程（Process）**，框架自己决定谁先谁后。适合那种"我不知道具体怎么串，但我知道需要哪几个角色"的场景。

```python
# pip install crewai crewai-tools
from crewai import Agent, Task, Crew, Process

researcher = Agent(
    role="市场研究员",
    goal="收集某产品的市场数据与竞品信息",
    backstory="你是一名严谨的行业分析师，擅长从公开资料中提炼结构化结论。",
    llm="gpt-4o-mini",
    verbose=True,
)

writer = Agent(
    role="技术文案",
    goal="把研究结论改写成客户能看懂的产品白皮书段落",
    backstory="你写过的白皮书超过 100 份，从不堆术语。",
    llm="gpt-4o-mini",
)

reviewer = Agent(
    role="合规审核",
    goal="确保文案不含夸大宣传和绝对化用语",
    backstory="你在广告法领域工作 10 年，对违禁词高度敏感。",
    llm="gpt-4o-mini",
)

t1 = Task(description="研究 2025 年智能药盒市场规模与 Top3 竞品",
          expected_output="300 字结构化摘要", agent=researcher)
t2 = Task(description="基于研究输出一段产品白皮书（200 字）",
          expected_output="200 字白皮书正文", agent=writer, context=[t1])
t3 = Task(description="审核白皮书，标记违禁词并修订",
          expected_output="修订后的白皮书 + 修订说明", agent=reviewer, context=[t2])

crew = Crew(agents=[researcher, writer, reviewer],
            tasks=[t1, t2, t3],
            process=Process.sequential,   # 顺序执行；Process.hierarchical 可托管给 manager
            verbose=True)

result = crew.kickoff()
print(result.raw)
```

CrewAI 的甜区是**角色边界清晰、流程线性、不需要复杂条件分支**的协作。一旦你需要"审核失败回规划"这种循环，或者要在中途插人工确认，CrewAI 的表达力就明显不如 LangGraph——这也是为什么大型 FDE 项目普遍倾向 LangGraph 作为骨架，CrewAI 用于快速 PoC。

## 17.6 把企业工具暴露给 Agent：MCP server 最小实现

Agent 要真正干活，必须能调企业内部工具（查订单、发邮件、读知识库）。Model Context Protocol（MCP）是 Anthropic 提的开放标准，本质是"给工具加一层标准化外壳"，让任何 Agent 客户端都能复用同一套工具。

```python
# pip install "mcp[cli]"
from mcp.server.fastmcp import FastMCP
import httpx

mcp = FastMCP("enterprise-tools")

@mcp.tool()
def get_order(order_id: str) -> dict:
    """根据订单号查询订单状态与金额。"""
    r = httpx.get(f"https://erp.internal/api/orders/{order_id}",
                  timeout=10, headers={"X-API-Key": "..."})
    r.raise_for_status()
    return r.json()

@mcp.tool()
def search_kb(query: str, top_k: int = 3) -> list[dict]:
    """在企业知识库中检索，返回 top_k 条相关文档片段。"""
    # 实际接 RAG / Elasticsearch
    return [{"title": "...", "snippet": "...", "score": 0.87}]

@mcp.tool()
def send_email(to: str, subject: str, body: str) -> str:
    """发送内部邮件，返回 message_id。"""
    # 接 SMTP / 企业邮件 API
    return f"queued for {to}"

if __name__ == "__main__":
    mcp.run(transport="stdio")   # 也可 transport="sse" 跑成 HTTP 服务
```

在 Claude Desktop、Cursor、或任何兼容 MCP 的客户端里，只要在配置里指这个 server，Agent 就能直接调用 `get_order`、`search_kb`、`send_email`，**不用改 Agent 一行代码**。这是 FDE 交付时把"客户内部系统"和"通用 Agent 框架"解耦的关键一招：现场只需要写 MCP server，工具层和模型层完全可独立演进。

## 17.7 状态契约设计：TypedDict vs Pydantic

状态契约是编排系统的地基。两种主流写法：

```python
# 方案 A：TypedDict（LangGraph 默认，轻量）
from typing import TypedDict, Annotated
from operator import add

class StateA(TypedDict):
    messages: Annotated[list, add]
    step: int

# 方案 B：Pydantic（强校验、自动文档）
from pydantic import BaseModel, Field
from typing import Annotated

def concat(a: list, b: list) -> list:
    return a + b

class StateB(BaseModel):
    messages: Annotated[list, concat] = Field(default_factory=list)
    step: int = Field(default=0, ge=0)
    risk_score: float = Field(default=0.0, ge=0.0, le=1.0)

graph = StateGraph(StateB)  # LangGraph 0.2+ 完整支持
```

选型经验：

- **PoC / 内部脚本**：用 TypedDict，少写代码，IDE 补全够用；
- **生产 / 跨团队**：用 Pydantic，字段约束（`ge=0`、`le=1.0`）在图编译时就会被校验，非法 state 进不来，能拦掉一大类"模型瞎填字段"的 bug；
- **reducer 必须显式声明**——`messages` 字段不写 `Annotated[..., add]` 就会被覆盖，这是新手最常踩的坑。

## 17.8 护栏集成：规则 + 模型双层

Agent 落地的硬底线是"不能闯祸"。护栏分两层：**硬规则**（必拦，如泄密词、绝对化用语、PII）和**软规则**（可降级，如风格、长度）。硬规则用正则或 `guardrails-ai`，软规则用 LLM judge。

```python
import re
from guardrails import Guard
from guardrails.hub import ProfanityFree, ToxicLanguage

# —— 硬规则：纯正则，零延迟 ——
PII_PATTERNS = [
    (r'\b\d{15,18}[Xx]?\b', '【身份证已脱敏】'),     # 身份证
    (r'1[3-9]\d{9}', '【手机号已脱敏】'),             # 手机号
]

def hard_guard(text: str) -> str:
    for pat, repl in PII_PATTERNS:
        text = re.sub(pat, repl, text)
    if any(w in text for w in ["最佳", "第一", "国家级", "绝对"]):
        raise ValueError("触发广告法违禁词，已拦截")
    return text

# —— 软规则：guardrails-ai 跑 ToxicLanguage 模型 ——
guard = Guard().use_many(ProfanityFree(), ToxicLanguage())

def soft_guard(text: str) -> str:
    try:
        return guard.validate(text).validated_output
    except Exception:
        return "（内容未通过质量审核，已替换为占位说明）"

# 在 LangGraph 节点里组合
def safe_output(state) -> dict:
    cleaned = soft_guard(hard_guard(state["draft"]))
    return {"draft": cleaned}
```

> FDE 现场铁律：**硬规则不能省，软规则可灰度**。涉及客户 PII、金融承诺、医疗建议的输出，必须先过 `hard_guard` 再发给用户，模型再聪明也不能跳过。

## 17.9 编排的可观测：LangSmith 与 Langfuse 接入

没有可观测的 Agent 系统等于黑盒，出了问题无从复盘。两条主流路线：

```python
# —— 方案 A：LangSmith（LangChain 官方，0 代码接入） ——
import os
os.environ["LANGSMITH_TRACING"] = "true"
os.environ["LANGSMITH_API_KEY"] = "ls__***"
os.environ["LANGSMITH_PROJECT"] = "fde-poc-clientA"
# 之后所有 LangGraph / LangChain 调用自动上报 trace，无需改业务代码

# —— 方案 B：Langfuse（开源、可自托管） ——
from langfuse.callback import CallbackHandler
langfuse_handler = CallbackHandler(
    public_key="pk-lf-***", secret_key="sk-lf-***",
    host="https://langfuse.internal",
)
# 在 invoke 时传入
app.invoke(initial_state, config={"callbacks": [langfuse_handler]})
```

生产环境必须盯的五个指标：

1. **每条 trace 的总 token 与成本**——最容易超预算的地方；
2. **每个节点的 P95 延迟**——LLM 调用慢会指数级放大整体延迟；
3. **循环类图的平均重试次数**——重试 >2 次基本说明 prompt 或工具出了问题；
4. **`interrupt` 的平均等待时长**——人工环节是流程瓶颈的强信号；
5. **护栏拦截率**——拦截率突然飙升通常意味着上游 prompt 变质了。

## 17.10 框架选型对照表

| 维度 | LangGraph | CrewAI | AutoGen | 自研 |
|---|---|---|---|---|
| 心智模型 | 显式状态图 | 角色协作 | 对话式多 Agent | 你自己定 |
| HITL 中断 | 原生支持 | 需手撸 | 弱 | 全靠你 |
| 状态持久化 | Checkpointer 一行接入 | 弱 | 弱 | 自己写 |
| 复杂条件分支 | 强 | 弱 | 中 | 强 |
| 上手速度 | 中（要懂图） | 快（声明式） | 中 | 慢 |
| 生产可观测 | LangSmith 开箱即用 | 一般 | 一般 | 全靠你 |
| 适合场景 | 现场交付、长期系统 | PoC、角色清晰 | 研讨、辩论类 | 特殊约束 |

> FDE 现场经验法则：**PoC 用 CrewAI 三天出活，交付用 LangGraph 撑三年**。两者不互斥——很多项目用 CrewAI 做第一版验证可行性，定下来后用 LangGraph 重写生产版。

## 17.11 把它串起来：一个最小生产骨架

一个真实的 FDE 交付项目，骨架通常长这样：

```
[MCP 工具层]   get_order / search_kb / send_email   ← 客户内部系统
      ↑
[Agent 层]     planner / executor / reviewer        ← 业务逻辑
      ↑
[编排层]       LangGraph StateGraph + Checkpointer  ← 流程控制 + HITL
      ↑
[护栏层]       hard_guard(正则) + soft_guard(LLM)    ← 合规底线
      ↑
[可观测层]     LangSmith / Langfuse trace            ← 复盘
      ↑
[客户端]       飞书 bot / Web / MCP client           ← 用户入口
```

每一层都可以独立替换、独立测试、独立演进。这种分层是 FDE 在客户现场能把"AI 项目"做成"可交付系统"的核心结构——它让模型升级、工具新增、流程调整都不会牵一发动全身。

## 本专题小结

多 Agent 编排的本质，是用一张显式状态图把"模型调用 + 工具调用 + 人工确认 + 异常恢复"统一管理。LangGraph 用 State/Node/Edge/Checkpoint/Interrupt 五件套提供了完整骨架，CrewAI 用角色声明换来了快速搭建的甜区，MCP 把企业工具变成可复用的标准件。无论选哪条路线，五件事必须做扎实：状态契约、流程控制、护栏、可观测、断点恢复。**代码可运行、状态可追溯、人在环里、护栏在线**——这十六个字是 Agent 系统能从 demo 走向生产的全部秘密。

## 本专题来源

- LangGraph 官方文档与示例：`langchain-ai.github.io/langgraph/`
- CrewAI 官方文档：`docs.crewai.com/`
- Anthropic Model Context Protocol 规范：`modelcontextprotocol.io/`
- Guardrails AI Hub：`hub.guardrailsai.com/`
- LangSmith / Langfuse 官方文档
- FDE 现场交付实践（脱敏），2024–2025
