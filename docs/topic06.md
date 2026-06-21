---
title: "深度专题六 模型部署与推理优化:vLLM、量化与生产级推理"
tags: ["推理优化", "成本容量", "边缘AI", "应用架构"]
---

> **专题定位**:把模型变成"可调用的服务",并让它在客户的算力/成本约束下跑得快、跑得省,是 FDE 的硬功夫。本专题深入推理服务化、量化、性能优化、成本控制。

## 一、推理服务化:从模型权重到生产 API

**模型权重(.safetensors)不能直接被业务调用,要变成"服务"。**

**推理服务的职责**
- 接收请求(HTTP/gRPC);
- 批处理(合并多个请求提升吞吐);
- 显存管理(KV cache);
- 负载均衡、限流、容错;
- 提供兼容接口(OpenAI API 兼容,业务零改动)。

**2026 主流推理框架对比**
- **vLLM**:事实标准,PagedAttention + 连续批处理,生态最广,几乎默认选择;
- **TGI(HuggingFace)**:易用,HF 生态好;
- **TensorRT-LLM(NVIDIA)**:极致性能,NVIDIA 官方优化,部署复杂、绑定 NV;
- **SGLang**:新兴,结构化生成与缓存优势。

**选型决策**
- 通用首选 vLLM;
- 已有 HF 栈 → TGI;
- 追求极致 + 全 NV → TensorRT-LLM;
- 结构化输出密集 → SGLang。

> **可照抄(vLLM 生产部署,OpenAI 兼容)**:
> ```bash
> vllm serve Qwen/Qwen2.5-14B-Instruct \
>   --host 0.0.0.0 --port 8000 \
>   --tensor-parallel-size 2 \
>   --max-model-len 16384 \
>   --gpu-memory-utilization 0.9 \
>   --enable-prefix-caching \
>   --enable-auto-tool-choice --tool-call-parser hermes
> ```

## 二、量化:用更少显存跑更大的模型

**量化是降低部署成本的最有效手段——FP16 → INT8 → INT4,显存与速度大幅优化,精度损失可控。**

**主流量化方案**
- **AWQ(Activation-aware Weight Quantization)**:激活感知,精度损失小,2026 最常用;
- **GPTQ**:基于二阶信息的权重量化,广泛支持;
- **bitsandbytes**:易用的 INT8/INT4(NF4);
- **GGUF(llama.cpp)**:CPU/边缘部署友好。

**量化选择**
- 追求精度 → AWQ;
- 边缘/CPU → GGUF/Q4_K_M;
- 快速实验 → bitsandbytes;
- 生产 → AWQ 或 GPTQ(已验证)。

> **可照抄(直接加载已量化模型,生产推荐)**:
> ```bash
> vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ --quantization awq --dtype half
> ```

**量化的代价**
- 精度损失(通常 INT4 比 FP16 掉 1—3 个点,可接受);
- 某些模型/任务对量化敏感(需评估);
- 量化模型与原模型行为略有差异(要重新评估)。

## 三、性能优化:吞吐与延迟的关键技术

**PagedAttention(vLLM 核心)**
- 把 KV cache 像操作系统管理虚拟内存一样分页管理;
- 大幅减少显存碎片,提升并发;
- vLLM 高吞吐的根本原因。

**连续批处理(Continuous Batching)**
- 不等一批齐,有请求就处理;
- 动态拼批,提升 GPU 利用率;
- 显著提升吞吐。

**前缀缓存(Prefix Caching)**
- 相同系统 prompt/上下文的请求,缓存前缀 KV;
- RAG/Agent 场景(系统 prompt 长)受益巨大;
- vLLM `--enable-prefix-caching`。

**投机解码(Speculative Decoding)**
- 用小模型先猜,大模型验证;
- 降低延迟(适合对延迟敏感场景)。

**KV Cache 优化**
- 量化 KV cache(节省显存);
- PagedAttention(碎片优化)。

## 四、GPU 选型与并行

**GPU 选型(2026)**
- 高端训练/大模型:H100/H200/B200(NVIDIA);
- 推理性价比:A10/A100/L40S;
- 国产:昇腾 910B、海光 DCU(信创场景);
- 边缘:Jetson、国产边缘盒。

**并行策略**
- **张量并行(Tensor Parallel)**:模型太大一张卡装不下,切分到多卡(vLLM `--tensor-parallel-size`);
- **流水线并行**:按层切分;
- **数据并行**:多副本提升吞吐;
- **专家并行(MoE)**:MoE 模型专用。

> **FDE 的现实**:客户的 GPU 往往有限(几张 A10/A100),FDE 要在有限算力下,靠量化+并行+批处理,跑起够用的模型。

## 五、部署形态:云、私有、边缘、信创

**云部署**
- 公有云 GPU 实例(阿里云/腾讯云/AWS);
- 弹性扩缩容;
- 适合:数据可上云、流量波动大。

**私有化部署**
- 客户自建 GPU 集群;
- 数据不出域;
- 适合:政企、金融、医疗(强合规)。

**边缘部署**
- 工厂/门店/设备端(Jetson、国产盒);
- 低延迟、断网可用;
- 适合:视觉质检、智能终端。

**信创部署(中国)**
- 昇腾/海光 + 麒麟/统信 + 国产模型;
- FDE 做全栈适配验证;
- 政务、金融、能源硬要求。

> **可照抄(docker-compose 一键起推理 + RAG 栈)**:
> ```yaml
> services:
>   vllm:
>     image: vllm/vllm-openai:latest
>     command: --model Qwen/Qwen2.5-7B-Instruct --port 8000 --enable-prefix-caching
>     deploy:
>       resources:
>         reservations:
>           devices: [{driver: nvidia, count: all}]
>   milvus:
>     image: milvusdb/milvus:latest
> ```

## 六、成本优化:推理很贵,FDE 要精打细算

**成本优化手段**
- **量化**:INT4/INT8 省显存省卡;
- **批处理**:提升吞吐,降低单请求成本;
- **前缀缓存**:RAG/Agent 场景省大量重复计算;
- **模型分级**:简单请求用小模型,复杂用大模型;
- **缓存结果**:热门查询缓存;
- **弹性扩缩容**:低峰缩容;
- **监控成本**:token/请求成本看板,异常告警。

## 七、监控与 SLO:推理服务要"可运维"

**关键指标**
- 延迟(P50/P95/P99 TTFT、TPOT);
- 吞吐(QPS、tokens/s);
- 错误率;
- GPU 利用率;
- 成本(每千 token / 每请求)。

**SLO 设定**
- P99 延迟 < X 秒;
- 可用性 > 99.5%;
- 错误率 < 0.1%。

**工具**
- vLLM 自带 metrics(Prometheus 格式);
- Grafana 看板;
- LangSmith/Langfuse(应用层)。

## 八、推理优化的 FDE 决策树

面对客户的推理需求,FDE 的决策路径:
1. 模型多大?→ 决定是否量化/并行;
2. 算力多少?→ 决定模型规模与量化级别;
3. 延迟要求?→ 决定批处理策略、是否投机解码;
4. 流量模式?→ 决定是否弹性、缓存策略;
5. 预算?→ 决定整体方案。

## 本专题小结

- 推理服务化:模型权重→生产 API,vLLM 是 2026 事实标准(TGI/TensorRT-LLM/SGLang 备选);
- 量化:AWQ(最常用)/GPTQ/bitsandbytes/GGUF,显存速度大幅优化,精度可控损失;
- 性能:PagedAttention、连续批处理、前缀缓存、投机解码、KV cache 优化;
- GPU:H100/A100/L40S/昇腾,张量/流水线/数据并行;
- 部署:云/私有/边缘/信创,docker-compose 一键起栈;
- 成本:量化+批处理+前缀缓存+模型分级+结果缓存+弹性;
- 监控:延迟/吞吐/错误/利用率/成本,vLLM metrics + Grafana;
- 决策树:模型大小→算力→延迟→流量→预算。

> **本专题来源**:vLLM/TensorRT-LLM/SGLang 文档、PagedAttention 论文、NVIDIA/昇腾文档、用户库《FDE工程化工具链》《fde-delivery 110-performance-optimization/120-deployment-runbook》、本书[第 9 章](/ch09)。
