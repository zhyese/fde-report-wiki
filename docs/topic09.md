---
title: "深度专题九 MLOps 与持续交付（LLM 应用的工程化）"
tags: ["MLOps", "可观测性", "评估测试", "云原生"]
---

## 9.1 为什么传统 MLOps 框架在 LLM 时代失灵

把一个 GPT-4o 或 Qwen-Max 接进业务，看上去只是"调一次 API"，但只要它进了生产链路，就会立刻撞上和传统 ML 流水线完全不同的几条事实：

> **核心论断：传统 MLOps 管的是"模型权重 + 特征"，LLM MLOps 管的是"prompt + 检索 + 评估 + 模型版本"四元组，且评估本身比训练更贵。**

二者差异可以从下表看清：

| 维度 | 传统 MLOps（以 XGBoost/ResNet 为例） | LLM MLOps（以 RAG/Agent 为例） |
| --- | --- | --- |
| 制品主体 | 模型权重（`.pkl`/`.onnx`/`.pt`） | prompt 模板 + 检索索引 + 模型版本 + 评估集 |
| 数据形态 | 结构化特征表 / 标注图片 | 非结构化语料 + 指令对 + 业务文档 |
| 训练 vs 调用 | 训练贵、推理便宜 | 训练极贵（常被供应商包掉）、调用按 token 计费 |
| 漂移类型 | 特征漂移、标签漂移 | 输入分布漂移、语义漂移、prompt 漂移、上游模型静默升级 |
| 评估方式 | 离线指标（AUC/F1/RMSE）即可上线 | 离线 LLM-as-Judge + 在线人工抽检 + 业务指标三件套 |
| 回滚单位 | 切回上一版权重 | 切回 (prompt, retriever, model, guardrail) 组合 |
| 坏例来源 | 阈值卡边、特征缺失 | 幻觉、拒答、越狱、上下文丢失、token 截断 |

一个被反复验证的经验值：在 LLM 应用里，**评估集和评估代码的维护成本，往往超过应用代码本身**。Honeycomb 工程团队在 2024 年公开复盘其自然语言查询功能时承认，他们写 Promptfoo 评估用例的代码量，是写查询生成逻辑的两倍。这是 FDE 在客户现场必须提前打预防针的事实——"上线一周就会到改不动 prompt 的状态"是常态，不是异常。

## 9.2 LLM 应用的完整生命周期

把 LLM 应用当成一个有版本、有审计、可回滚的工程制品，需要覆盖六段闭环：

1. **版本（Version）**——prompt、检索语料、模型 checkpoint、guardrail 规则、评估集，五者各自独立版本化，并打上一个组合 commit hash。
2. **实验（Experiment）**——任何一次 prompt 改动或换模型，都作为一次实验记录参数、指标、产物。
3. **注册（Registry）**——通过评估门禁的组合进入模型注册表，标记 `Staging` / `Production` / `Archived`。
4. **部署（Deploy）**——按流量比例灰度，配合影子流量（shadow）跑离线评估。
5. **监控（Monitor）**——延迟 P95、token 成本、坏例率、用户负反馈率、prompt 变更频次。
6. **回滚（Rollback）**——一键切回上一个 `Production` 组合，TTL 内可追溯每一次切换的责任人。

这六段不是线性流程，而是一个以"评估门禁"为枢纽的循环：监控发现坏例 → 进入评估集 → 触发新实验 → 通过门禁才允许注册 → 灰度部署 → 继续监控。FDE 在客户现场的第一周，往往不是写功能，而是把这六段的最小骨架先搭出来，否则后期任何一次改动都会变成"上线即背锅"。

## 9.3 版本管理：模型、数据与 prompt 三条独立轨道

### 9.3.1 模型与数据：DVC + MLflow

对自托管/微调场景，**DVC** 管数据和 checkpoint 的内容寻址存储，**MLflow** 管实验元数据。下面是一个真实可复刻的 DVC + Git 协同示例：

```bash
# 初始化 DVC，把数据/模型放到对象存储
dvc init
dvc remote add -d my_s3 s3://my-bucket/dvc-store
dvc remote modify my_s3 endpointurl https://cos.ap-shanghai.myqcloud.com

# 把训练语料纳入版本管理
dvc add data/finetune_corpus.jsonl
git add data/finetune_corpus.jsonl.dvc .gitignore
git commit -m "feat: add finetune corpus v1 (12k examples)"

# 切回历史版本的数据
git checkout v0.3.0
dvc checkout            # 把 data/ 恢复成 v0.3.0 时刻的内容
```

`dvc.yaml` 定义可复现的 pipeline，是交付文档里"可复刻"硬红线的落地形式：

```yaml
stages:
  prepare:
    cmd: python src/prepare.py --in data/raw.jsonl --out data/train.jsonl
    deps: [src/prepare.py, data/raw.jsonl]
    outs: [data/train.jsonl]
  finetune:
    cmd: python src/finetune.py --base Qwen/Qwen2.5-7B --out models/v1
    deps: [data/train.jsonl, src/finetune.py]
    outs: [models/v1]
  evaluate:
    cmd: python src/evaluate.py --model models/v1 --set eval/golden.jsonl
    metrics: [metrics/eval.json]
```

`dvc exp run` 会按依赖图重跑，并把指标写进 `metrics/eval.json`，再被 MLflow 拉走展示。

### 9.3.2 prompt 版本：PromptLayer / Promptfoo / LangSmith

prompt 是 LLM 应用里变更最频繁、也最容易出事的制品。社区主流三种做法：

- **PromptLayer**：把 prompt 当数据库表存，每次调用自动落库，支持按 prompt hash 回放历史请求。
- **Promptfoo**：用 YAML 写 prompt 矩阵 + 断言，CI 里跑出红绿报告。
- **LangSmith**：LangChain 官方，prompt + dataset + run 一体化，trace 可视化。

下面是 Promptfoo 的评估配置，可以直接塞进 GitHub Actions 当门禁：

```yaml
# promptfooconfig.yaml
prompts:
  - file://promposes/extract_clause.txt
providers:
  - id: openai:chat:gpt-4o-mini
    config: { temperature: 0 }
  - id: anthropic:claude-3-5-sonnet
tests:
  - vars: { clause: "甲方应在收到发票后 30 日内付款" }
    assert:
      - type: contains-json
      - type: equals
        value: { deadline_days: 30 }
  - vars: { clause: "本协议自签字之日起生效，有效期一年" }
    assert:
      - type: javascript
        value: output.duration_days === 365
```

`promptfoo eval` 会在 CI 里输出每个 provider × 每个 test 的通过率，低于阈值的 PR 直接拦截。这是把 prompt 改动"工程化"最廉价的一步。

## 9.4 实验追踪：MLflow 与 Weights & Biases

实验追踪解决一个问题：**两个月后回头看，这次微调到底改了什么、效果如何**。下面是一段真实可跑的 MLflow 记录一次 LLM 评估实验的代码：

```python
import mlflow
from mlflow.metrics.genai import make_genai_metric

# 定义一个 LLM-as-Judge 指标：答案是否引用了原文
faithfulness = make_genai_metric(
    name="faithfulness",
    definition="输出是否每条结论都能在 context 中找到依据，1 或 0",
    grading_prompt="{{context}}\n\n答案：{{prediction}}",
    model="endpoints:/databricks-llama-4-70b",
    examples=[],
)

mlflow.set_experiment("合同条款抽取-v2")
with mlflow.start_run(run_name="qwen2.5-7b-ft-v3"):
    mlflow.log_params({
        "base_model": "Qwen/Qwen2.5-7B",
        "lora_r": 16, "epochs": 3, "lr": 2e-4,
        "prompt_version": "git:a1b2c3d",
        "eval_set_version": "dvc:v5",
    })
    results = mlflow.evaluate(
        model=lambda row: predictor(row["clause"]),
        data=eval_df,
        targets="gold",
        extra_metrics=[faithfulness, mlflow.metrics.latency()],
    )
    mlflow.log_metric("faithfulness", results.metrics["faithfulness/score"])
    mlflow.register_model(
        "runs:/<run_id>/model", "ContractClauseExtract",
        tags={"stage": "staging", "owner": "fde-team"},
    )
```

> 一个实战提醒：把 `prompt_version` 和 `eval_set_version` 都用 git commit / dvc tag 写进 `log_params`，否则排查"为什么这次评估分数掉了"时会回到裸奔状态。

**MLflow vs W&B 选型**：

| 维度 | MLflow | Weights & Biases |
| --- | --- | --- |
| 部署 | 开源自托管，零 License | SaaS 为主，企业版较贵 |
| LLM 评估 | 原生 `mlflow.evaluate` + GenAI metrics | W&B Evaluations，强可视化 |
| 模型注册 | 内置 Model Registry | 需配合 W&B Artifacts |
| 生态绑定 | 厂商中立 | 偏训练场景 |
| 适合 | 客户内网、合规优先 | 研究/算法团队、看图说话 |

FDE 在金融、政务客户的默认选择是 MLflow 自托管，原因只有一个：**模型元数据不出网**。

## 9.5 模型注册与发布：Staging / Production 的真实含义

模型注册表不是"存模型的目录"，而是**一条带门禁的流水线**。MLflow Model Registry 把每个注册模型分成 `None → Staging → Production → Archived` 四态，每次状态迁移都带审批人、时间戳和 `version`。

但 LLM 场景下，"模型版本"经常是个伪命题——因为调用的是供应商 API，权重随时可能被静默替换。所以注册表里真正要管的是 **配置组合**：

```yaml
# registered_combinations/contract-extract-v3.yaml
model:
  provider: openai
  name: gpt-4o-mini
  api_version: "2024-08-01"   # 锁版本，避免供应商静默升级
prompt:
  repo: contract-bot
  commit: a1b2c3d
retriever:
  index_version: "2026-06-15T08:00"
  top_k: 5
guardrail:
  rules_version: "2026-06-10"
eval:
  faithfulness: 0.94   # 通过门禁的基线
  p95_latency_ms: 1800
```

这套配置才是"可回滚"的最小单位。回滚时不是换权重，而是把 `Production` 指针指回上一份 `registered_combinations/contract-extract-v2.yaml`。OpenAI 在 2024 年引入 `api_version` 锁定后，这种做法成为可能；在阿里云百炼、火山方舟等国内平台，则要用"模型别名 + 灰度比例"的官方机制来近似实现。

## 9.6 持续部署：CI/CD for LLM，评估即门禁

LLM 应用的 CI/CD 多出来的关键一环是**评估门禁**。一个可复刻的 GitHub Actions 片段：

```yaml
# .github/workflows/llm-cd.yml
name: LLM CD
on: { pull_request: { paths: ["prompts/**", "eval/**"] } }
jobs:
  eval-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install promptfoo mlflow
      - name: Run eval
        env: { OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }} }
        run: |
          promptfoo eval -c promptfooconfig.yaml \
            --output eval_report.json \
            --share
          python scripts/check_gate.py eval_report.json \
            --min-pass 0.90 --max-regression 0.02
      - if: success()
        run: mlflow deployments create --target staging ...
```

`check_gate.py` 的逻辑只有三条：整体通过率不低于基线、单项回归不超过阈值、新增坏例为 0。三条全过才允许进入 `Staging`，再由人工/定时任务把 `Staging` 提升到 `Production`。

> 这一步是 LLM 工程化和"脚本侠"的分水岭。没有评估门禁，prompt 改一行就上线，三天后客户投诉才发现幻觉率翻倍——这是 FDE 现场最常见的返工来源。

## 9.7 监控：漂移、延迟、成本、坏例

线上 LLM 应用的监控四件套：

1. **输入分布漂移**：用 embedding 把用户 query 向量化，计算与基线分布的余弦距离均值或 Wasserstein 距离，超阈值告警。LangSmith 和 Phoenix（Arize）都内置这个能力。
2. **延迟**：记录首 token 延迟（TTFT）和总延迟 P95。vLLM 自托管时还要盯 batch 大小、KV cache 命中率。
3. **成本**：按 `prompt_tokens × 单价 + completion_tokens × 单价` 实时累加，按租户/会话维度切片。一个常见坑：长上下文把 prompt token 推到 30k+，单次成本比预期高一个量级。
4. **坏例**：用户负反馈（"点踩"按钮）+ 抽样人工标注 + LLM-as-Judge 三路汇总，命中即进评估集。

下面是一段把 vLLM 自托管推理接入 Prometheus 的真实配置片段：

```yaml
# 启动 vLLM 并暴露 metrics
# vllm serve Qwen/Qwen2.5-7B \
#   --tensor-parallel-size 2 \
#   --enable-prefix-caching \
#   --uvicorn-log-level info
# vLLM 在 /metrics 暴露 Prometheus 格式指标
```

关键指标包括 `vllm:num_requests_running`、`vllm:num_requests_waiting`、`vllm:time_to_first_token_seconds`、`vllm:e2e_request_latency_seconds`、`vllm:request_inference_time_seconds`。配合 Grafana 看 queue 是否堆积，比看 QPS 更能反映容量瓶颈。

漂移检测的一个最小实现（用 scikit-learn + numpy）：

```python
import numpy as np
from scipy.stats import wasserstein_distance

baseline = np.load("emb_baseline.npy")        # 上线时存好的参考分布
current  = np.load("emb_current_week.npy")    # 本周线上 query 的 embedding
for d in range(baseline.shape[1] // 16):
    dist = wasserstein_distance(baseline[:, d], current[:, d])
    if dist > 0.15:   # 经验阈值，需按业务校准
        print(f"dim {d} drift: {dist:.3f}")
```

> 一个被低估的信号：**用户 query 平均长度**。RAG 应用里，如果它从 12 字慢慢漂到 35 字，多半是用户在反复补上下文——意味着检索质量在悄悄下降。

## 9.8 回滚机制

回滚要满足三个条件：**可一键、可审计、可追溯数据**。落地方式：

- **配置回滚**：CI 把每次 `Production` 组合 push 进一个 `release-history/` 目录，回滚 = `git revert` + 重新部署配置，模型权重不变。
- **流量回滚**：用 Seldon Core 或 BentoML 的灰度比例，从 100% 新版本切回 100% 旧版本，秒级生效。
- **数据回滚**：检索索引按时间戳快照，回滚 = 切回上一个 index 版本号，配合 embedding 模型版本一起回退（否则维度不一致会崩）。

```bash
# BentoML 一键回滚（假设部署名为 contract-bot）
bentoml deployment update contract-bot \
  --bento-version contract_bot:20260615.0   # 指回上一个稳定版本
```

Seldon Core 在 Kubernetes 上用的是 `SeldonDeployment` CRD，配合 Argo Rollups 做 canary：

```yaml
# argo-rollout canary for seldon
strategy:
  canary:
    steps:
      - setWeight: 10
      - pause: { duration: 30m }
      - analysis:
          templates: [{ templateName: llm-eval-gate }]
      - setWeight: 50
      - pause: { duration: 1h }
      - setWeight: 100
```

`llm-eval-gate` 这个 AnalysisTemplate 会去查 MLflow 或 Prometheus 里 `faithfulness` 指标，低于 0.85 自动把 rollout 标记为失败并回退。这是把"评估门禁"嵌进 Kubernetes 调度循环的标准做法。

## 9.9 工具栈对比

| 工具 | 定位 | 优势 | 短板 | 何时选 |
| --- | --- | --- | --- | --- |
| MLflow | 实验 + 注册 + 部署 API | 开源、自托管、生态广 | UI 朴素，LLM trace 弱 | 合规优先、内网交付 |
| Kubeflow | K8s 原生 ML 平台 | 与 K8s 深度集成、pipelines 强 | 重、运维门槛高 | 已有 K8s 团队的大型客户 |
| Seldon Core | K8s 推理 + 灰度 | canary/影子流量、指标丰富 | 学习曲线陡 | 自托管大模型推理 |
| BentoML | 打包 + 部署一体化 | 对 Python 友好、yatai 简单 | 多租户弱 | 中小规模自托管 |
| vLLM | 推理引擎 | PagedAttention、高吞吐 | 只管推理，不管生命周期 | 自托管开源大模型 |
| LangSmith | LLM trace + 评估 | trace 可视化、与 LangChain 无缝 | 绑定 LangChain，数据出网 | 快速迭代期、原型阶段 |
| Phoenix (Arize) | 开源 LLM 可观测 | 自托管、漂移检测 | 部署文档较少 | 内网可观测需求 |
| Promptfoo | prompt 评估门禁 | CI 友好、断言式 | 不做部署 | 门禁环节 |

一个被反复验证的组合：**自托管客户 = DVC（数据）+ MLflow（实验+注册）+ Seldon/BentoML（部署）+ vLLM（推理）+ Phoenix（可观测）+ Promptfoo（门禁）**；**云原生客户 = LangSmith + LiteLLM + BentoML**。FDE 在选型时，先问一句"数据能不能出网"，答案直接砍掉一半候选。

## 9.10 FDE 在客户现场搭 MLOps 的现实挑战

把上面这套搬到客户机房，真正难的不是工具，是约束：

1. **网络隔离**：金融、政务客户生产网不通外网，MLflow Tracking Server、模型权重、pip 包全要走内网镜像。`pip install` 经常要在能联网的跳板机 `pip download` 再 `scp` 进去。DVC remote 要对接客户的对象存储（如腾讯云 COS、华为 OBS），endpoint 配错一个字符能调一天。
2. **GPU 资源稀缺**：客户给到的卡往往只有 2×A100，但要跑 7B 微调 + vLLM 推理 + 评估三件事。FDE 必须把这三件事做成可调度的任务（Kubeflow Pipelines 或简单的 K8s Job），避免互相抢占导致推理延迟爆表。
3. **评估集是政治问题**：业务方往往不愿意花人天标"金标答案"，理由是"忙"。FDE 的做法是先从线上日志里捞 200 条，自己用 LLM-as-Judge 跑一遍，再把可疑的 50 条丢给业务方确认——把人工成本压到 4 人时内，才能拿到第一版评估集。
4. **供应商模型静默升级**：OpenAI、Anthropic、阿里通义都曾不通知就换权重。FDE 要在 prompt 里嵌一个"模型指纹"问题（一个对版本敏感的固定问题），每天跑一次，答案变了立刻告警。这是没有文档能教的现场经验。
5. **审计要求**：金融客户要求每次模型调用可追溯到 prompt 版本、检索版本、操作员。这要求把 `git commit` / `index_version` / `user_id` 写进每次请求的 metadata，并落进不可篡改的日志（如 Elasticsearch 配 WORM 存储）。MLflow 的 run_id 要和业务日志做关联，FDE 经常要写一个中间层把两边打通。
6. **组织接受度**：业务团队第一次接触"评估门禁"会觉得是阻碍上线。FDE 的妥协方案是先只做"只读门禁"——评估跑挂只发企微告警，不拦 PR，跑两周让团队看到价值，再切到"硬门禁"。这是工程之外的组织节奏控制。

## 9.11 一条最小可落地的 LLM MLOps 骨架

如果客户只给一周时间，FDE 应该优先搭出下面这条最小骨架（按优先级排序）：

1. prompt + evalset 进 Git，用 Promptfoo 在 CI 跑评估门禁（半天）。
2. MLflow 自托管，记录每次实验的参数和指标（半天）。
3. 把"金标评估集"和"线上抽检集"分开存，后者每周从线上采样补充（1 天）。
4. 推理层用 BentoML 或 vLLM，灰度比例硬编码先跑通（1 天）。
5. 监控先上 P95 延迟 + token 成本 + 用户负反馈率三个指标（1 天）。
6. 回滚脚本写好，每月演练一次（半天）。

这六步跑通，才谈得上加漂移检测、LLM-as-Judge、Seldon canary 这些进阶能力。先有骨架，再加肌肉——顺序反了，客户现场就会变成 demo 工程的墓地。

## 本专题小结

- 传统 MLOps 管"权重+特征"，LLM MLOps 管"prompt+检索+模型+评估"四元组，且评估成本高于训练之外的任何环节。
- 生命周期六段（版本/实验/注册/部署/监控/回滚）以"评估门禁"为枢纽循环，监控发现坏例回流为评估集是新实验的起点。
- 版本管理三条独立轨道：DVC 管数据与 checkpoint，MLflow 管实验元数据，Promptfoo/PromptLayer 管 prompt。
- 模型注册表的真正管理对象是"配置组合"而非权重，回滚的最小单位也是这个组合。
- CI/CD 多出来的关键一环是评估门禁，Promptfoo + GitHub Actions 是最低成本落地形式。
- 监控四件套：漂移、延迟、成本、坏例；首 token 延迟和 query 平均长度是被低估的信号。
- 工具栈分两派：自托管（MLflow+Seldon+vLLM+Phoenix）与云原生（LangSmith+LiteLLM+BentoML），选型由"数据能否出网"决定。
- FDE 在客户现场的真实约束是网络、GPU、评估集、供应商静默升级、审计、组织接受度六件事，骨架要先于进阶能力。

## 本专题来源

- MLflow 官方文档：`mlflow.org`（GenAI metrics、Model Registry、`mlflow.evaluate`）。
- DVC 官方文档与 `dvc.yaml` pipeline 规范：`dvc.org/doc`。
- Promptfoo 官方文档与 `promptfooconfig.yaml` 配置：`promptfoo.dev`。
- Weights & Biases 官方文档：`docs.wandb.ai`。
- Seldon Core 与 Argo Rollouts 的 canary + AnalysisTemplate 实践：`docs.seldon.io`、`argoproj.github.io/rollouts`。
- BentoML 部署与版本管理：`docs.bentoml.com`。
- vLLM Prometheus metrics 列表：`docs.vllm.ai`（`/metrics` endpoint）。
- LangSmith trace 与评估：`docs.smith.langchain.com`。
- Arize Phoenix 开源 LLM 可观测：`phoenix.arize.com`。
- Honeycomb 团队公开复盘（2024）关于自然语言查询功能评估代码量的工程实践。
- OpenAI API `api_version` 锁定机制（2024 引入）与供应商模型版本稳定性政策。
- CDEF 方法论中 Engineer 阶段对"可追溯、可复刻、可回滚"的工程化要求作为本专题方法学锚点。
