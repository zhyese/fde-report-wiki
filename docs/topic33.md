---
title: "深度专题三十三 FDE 的云原生与基础设施"
tags: ["云原生", "推理优化", "可观测性", "成本容量", "安全合规"]
---

> 一句话定位：FDE 把 AI 系统塞进客户机房的那一刻，"模型好不好"就退居二线，"GPU 调度得动不动、Pod 起得来不起来、向量库撑不撑得住"才决定项目能不能活。云原生与基础设施是 FDE 在 Engineer 阶段绕不开的硬骨头，也是国产化/信创浪潮下最容易被客户"卡脖子"的环节。本专题把传统应用基础设施与 AI 基础设施的差异、容器编排、GPU 共享、服务治理、可观测、信创替代、私有化权衡一次讲透，并落到 FDE 在客户机房的真实困境。

## 33.1 AI 基础设施需求：与传统应用的根本差异

传统 Web/微服务应用的资源画像很温和：CPU 利用率均值 20%–40%、内存稳定、网络流量可预测、扩缩容以请求 QPS 为驱动。AI 系统则把这张画像彻底撕碎，差异集中在四类资源：

**1. GPU：稀缺、昂贵、调度粒度粗。** 一台 8×H100 SXM 服务器 2024 年公开报价区间在 30 万–40 万美元，国内受出口管制只能拿到 H20（显存 96GB、算力约为 H100 的 1/3），单卡溢价更高。传统应用几乎不需要 GPU，而 AI 推理/训练对 GPU 是硬依赖——没有卡，Pod 永远 Pending。问题在于 Kubernetes 原生调度器只认识"整数张卡"：申请 `nvidia.com/gpu: 1` 就独占整张卡，哪怕模型只跑 7B 推理、显存占用不到 10GB，剩下的 70GB 也被锁死。FDE 在现场最常见的浪费就是"一模型一卡"，8 卡机只能并发 8 路请求，资源利用率常年在 15%–25% 徘徊。

**2. 存储：海量、高吞吐、读多写少。** 训练数据集动辄几十 TB（ImageNet 1.5TB、CommonCrawl 切片数十 TB），模型 checkpoint 单文件几十到上百 GB（Llama-3-70B 的 bf16 权重约 140GB）。传统应用的对象存储主要存头像、附件，吞吐要求低；AI 训练要求 checkpoint 写入 >2GB/s，否则一个 epoch 的等待时间被 I/O 吃掉一半。向量库场景下，10 亿条 768 维向量的原始体积约 3TB，要求毫秒级近邻查询，对磁盘随机读和内存极敏感。

**3. 网络：东西向流量爆炸、对延迟敏感。** 分布式训练的 all-reduce 通信在节点间反复搬运梯度，8 卡 NVLink 内部带宽 900GB/s，但跨节点走 InfiniBand 200Gb/s 或 RoCE，若网络配置不佳（PFC 不生效、ECN 阈值错误），训练吞吐能从理论 90% 掉到 40%。传统应用几乎不存在这种"网络抖一下就掉一半性能"的耦合。

**4. 弹性：分层弹性而非无状态水平扩展。** 传统应用扩容靠 HPA 拉起无状态副本，秒级生效；AI 推理扩容要先等 GPU 节点开机（裸金属 3–5 分钟、虚拟化 GPU 实例 1–2 分钟），再等模型权重加载（70B 模型从对象存储加载到显存约 40–90 秒），整条链路 5–10 分钟才真正就绪。FDE 必须把"冷启动延迟"作为 SLO 的一部分设计进去，而不是假装扩容是瞬时的。

> 差异小结：传统应用基础设施优化的是"成本与稳定性的平衡"，AI 基础设施优化的是"稀缺资源（GPU）的极限榨取 + 海量数据的高效搬运"。FDE 切入客户现场，第一步就是问清楚这两件事的现状。

## 33.2 容器化与 Kubernetes 编排：AI 栈的标准化底座

容器化对 AI 的价值不仅是"环境一致"，更是"把 CUDA、cuDNN、驱动版本、Python 依赖这套脆弱组合固化成镜像，避免在客户机房重现'在我机器上能跑'"。一个生产可用的 PyTorch 推理镜像典型 Dockerfile 片段：

```dockerfile
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y python3.10 python3-pip
COPY requirements.txt .
RUN pip install --no-cache-dir torch==2.3.0+cu124 \
    --index-url https://download.pytorch.org/whl/cu124
RUN pip install --no-cache-dir fastapi==0.111 uvicorn==0.30 transformers==4.41
COPY app/ /app/
WORKDIR /app
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

镜像尺寸通常 6–10GB，必须用多阶段构建 + 镜像仓库（Harbor）+分层缓存，否则每次拉取都要几分钟，客户机房带宽又窄。FDE 在现场会用 `docker save | gzip` 离线打包镜像，再 `docker load` 灌进内网仓库。

**多容器 AI 栈用 docker-compose 串起来**是 PoC 阶段最朴素的方案，下面是一个典型的"推理 + 向量库 + 网关"三件套：

```yaml
version: "3.9"
services:
  llm-inference:
    image: registry.internal/llm-server:2.3.0-cu124
    runtime: nvidia
    environment:
      - NVIDIA_VISIBLE_DEVICES=0,1
      - MODEL_PATH=/models/qwen2-7b
    volumes:
      - /data/models:/models:ro
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 2
              capabilities: [gpu]
    ports: ["8000:8000"]

  milvus:
    image: milvusdb/milvus:v2.4.6
    command: ["milvus", "run", "standalone"]
    environment:
      - ETCD_ENDPOINTS=etcd:2379
      - MINIO_ADDRESS=minio:9000
    volumes:
      - milvus-data:/var/lib/milvus
    depends_on: [etcd, minio]

  etcd:
    image: quay.io/coreos/etcd:v3.5.5
    environment:
      - ETCD_AUTO_COMPACTION_RETENTION=1000
    command: etcd -advertise-client-urls=http://etcd:2379 -listen-client-urls=http://0.0.0.0:2379

  minio:
    image: minio/minio:RELEASE.2024-08-17T01-24-54Z
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
    command: server /data
    volumes:
      - minio-data:/data

  gateway:
    image: registry.internal/api-gateway:1.2.0
    ports: ["80:8080"]
    depends_on: [llm-inference, milvus]

volumes:
  milvus-data:
  minio-data:
```

到了生产规模，docker-compose 的单机限制（无原生 HA、无滚动升级、无 GPU 调度策略）就暴露无遗，必须迁移到 Kubernetes。K8s 部署 AI 推理栈的典型清单包含：NVIDIA Device Plugin（让 kubelet 上报 `nvidia.com/gpu` 资源）、GPU Operator（自动化驱动/CUDA/DCGM 安装）、DCGM-Exporter（GPU 指标采集）。一个推理 Deployment 的核心片段：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-inference
spec:
  replicas: 3
  selector:
    matchLabels: {app: llm-inference}
  template:
    metadata:
      labels: {app: llm-inference}
    spec:
      containers:
      - name: server
        image: registry.internal/llm-server:2.3.0-cu124
        resources:
          limits:
            nvidia.com/gpu: 1
            memory: 32Gi
          requests:
            nvidia.com/gpu: 1
            memory: 32Gi
        readinessProbe:
          httpGet: {path: /health, port: 8000}
          periodSeconds: 10
        livenessProbe:
          httpGet: {path: /health, port: 8000}
          initialDelaySeconds: 120
```

FDE 必须注意：`readinessProbe` 的 `initialDelaySeconds` 要按"模型加载时间 + 20% 余量"设，70B 模型加载 60 秒就设 90 秒，否则 Pod 还没就绪就被 K8s 判死重启，进入 CrashLoopBackOff 死循环——这是现场最高频的"莫名重启"根因。

## 33.3 GPU 调度与共享：榨干稀缺算力的三件套

整卡独占是 K8s 默认行为，但生产里几乎没人能接受这种浪费。FDE 必须掌握三种共享机制，并知道各自的适用边界：

**1. 时间分片（Time-Slicing）。** NVIDIA 官方插件 `nvidia.com/gpu.sharing-strategy=time-slicing` 把一张物理卡在驱动层切成 N 个虚拟实例，多个 Pod 轮流使用。配置示例（ConfigMap 形式喂给 GPU Operator）：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
data:
  H100: |-
    version: v1
    sharing:
      timeSlicing:
        resources:
        - name: nvidia.com/gpu
          replicas: 4
    devices: ["0", "1"]
```

时间分片优点是零侵入、任何框架都能用；缺点是**没有隔离**——一个 Pod 的 CUDA kernel 会把整张卡占住，其他 Pod 排队等，且显存是共享的，一个 OOM 全军覆没。适合**低 QPS、可容忍毛刺的批处理**，不适合延迟敏感的在线推理。

**2. MIG（Multi-Instance GPU）。** A100/H100 硬件级分区，一张卡切成最多 7 个实例（1g.10gb、2g.20gb、3g.40gb、4g.40gb、7g.80gb 等规格），每个实例有独立的显存和计算核心，硬件级隔离。配置命令：

```bash
# 在 GPU 节点上开启 MIG 模式（需要重启或 nvidia-smi -mig 1 即时生效）
sudo nvidia-smi -i 0 -mig 1
# 创建 7 个 1g.10gb 实例
sudo nvidia-smi mig -cgi 19,19,19,19,19,19,19 -C
# 验证
sudo nvidia-smi mig -lgi
```

MIG 优点是硬隔离、延迟可预测；缺点是**分区静态、切换需停机**，且只有 A100/H100 部分型号支持（A30、L40、H100 PCI/e 支持度不一）。FDE 在金融/政企现场常用 MIG 把一张 H100 切给 3–4 个租户，每租户独享计算单元，互不干扰。

**3. MPS（Multi-Process Service）。** 客户端进程级共享，多个 CUDA 上下文通过 MPS daemon 共享 GPU，上下文切换开销低于时间分片。适合**同构推理服务多副本**。但 MPS 同样没有显存硬隔离，且 daemon 挂了所有客户端跟着挂，生产用得少。

> FDE 选型经验：在线延迟敏感优先 MIG（有硬件支持）；批处理/容忍毛刺用时间分片；MPS 仅在纯推理同构场景做最后榨取。三者不互斥，可以一台机器 MIG 切主推理，时间分片跑后台批量 Embedding 任务。

## 33.4 服务化：API 网关、负载均衡、限流熔断

AI 推理服务对外暴露的入口必须是 API 网关，而不是直接暴露模型服务的 8000 端口。FDE 在现场用得最多的是 **APISIX / Kong / Higress**（国产化场景下 Higress 越来越主流，阿里开源、兼容 Ingress、原生支持 WASM 插件）。网关层要解决四件事：

**路由与协议转换。** 大模型推理用 SSE/WebSocket 流式返回，网关必须支持长连接和流式透传，超时配置要按 token 上限 × 单 token 生成时间设上限（如 4096 token × 50ms = 204 秒，配置成 240 秒）。Nginx 默认 60 秒会直接掐断流式响应，是现场高频坑。

**负载均衡。** 不能用 round-robin，因为推理副本的负载差异巨大（一个在生成 4K 长文，一个在处理 100 token 问答）。必须用 **least-connections** 或自定义**显存感知**调度——通过 DCGM-Exporter 拉到每个副本的显存占用，路由到最空闲的副本。Triton Inference Server / vLLM 内置的 `--tensor-parallel-size` 也影响均衡策略，FDE 要画清楚"请求 → 网关 → 推理副本 → GPU"的拓扑。

**限流。** LLM 推理的限流维度与传统 API 不同，要同时控：QPS、并发连接数、**token/分钟**（防止一个用户一个 8K prompt 把整张卡打满 30 秒）。APISIX 的 `limit-req` + 自定义 token-counter 插件是常见组合。Sentinel（阿里）也能做，但要写自定义 slot 统计 token。

**熔断。** 推理服务 OOM、显存泄漏、CUDA error 后会陷入"半死"状态——健康检查通过但请求全超时。熔断器（Resilience4j / Sentinel）要在连续 N 次超时后直接短路，把流量切到备用副本，并触发 K8s 重启不健康 Pod。FDE 要预设：**单副本连续 5 次 P99 > 30 秒 → 熔断 60 秒 → 触发自愈**。

## 33.5 高可用与弹性：让 AI 服务"挂了能自愈、洪峰能扛住"

**多副本 + 反亲和。** 推理 Deployment 至少 3 副本，且必须配置 `podAntiAffinity` 让副本分散到不同 GPU 节点，否则一台机器宕机全副本陪葬：

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels: {app: llm-inference}
      topologyKey: kubernetes.io/hostname
```

**自动扩缩容（HPA + KEDA）。** K8s 原生 HPA 只能按 CPU/内存扩容，对 GPU 无效——AI 服务 CPU 常年 5% 但 QPS 已经打满。必须用 **KEDA**（CNCF 项目，支持自定义指标 scaler），按 Prometheus 里的"推理 QPS / 活跃并发"扩容：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: llm-scaler
spec:
  scaleTargetRef:
    name: llm-inference
  minReplicaCount: 2
  maxReplicaCount: 8
  pollingInterval: 30
  cooldownPeriod: 300
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus:9090
      metricName: inference_active_requests
      threshold: "20"
      query: sum(inference_active_requests{model="qwen2-7b"})
```

FDE 必须把 `cooldownPeriod` 调大到 300 秒以上——推理 Pod 启动慢（含模型加载），扩缩容太敏感会引发"刚扩容又缩容"的抖动。

**多可用区。** 云上部署要把 GPU 节点池分散到 2–3 个 AZ，节点池配置 `topologySpreadConstraints` 强制副本跨 AZ。私有化场景没有 AZ 概念，但要有"跨机柜/跨 PDU"意识——FDE 在某省政务云见过一台 PDU 跳闸带走半个机柜 4 张 H100，整条推理链路全挂的事故。

**断路降级。** 主模型挂了要有 fallback：重请求降级到更小的蒸馏模型，或直接返回缓存结果。这是 FDE 设计阶段就要画进架构图的"优雅降级"路径，不是事后补救。

## 33.6 存储与数据：对象存储、向量库、特征平台、缓存

**对象存储（MinIO / Ceph / S3 兼容）。** AI 数据的底座。FDE 在私有化现场几乎一律部署 MinIO（轻量、S3 兼容、单二进制起），用作模型权重仓、训练数据湖、checkpoint 归档。生产配置要注意：启用纠删码（EC 4+2）而非副本以省 50% 空间、把元数据放 SSD 加速 list 操作、bucket 按"模型版本 + 数据集"分离避免热点。

**向量库。** 主流选项：Milvus（分布式、强一致、适合 10 亿级）、Qdrant（Rust 写、单机性能好、中等规模）、Weaviate、PGVector（PostgreSQL 扩展、小规模够用）。FDE 选型看三点：规模（百万级 PGVector 够，十亿级必须 Milvus）、检索延迟要求（<50ms 选 HNSW 索引）、是否要标量过滤（Milvus 的 hybrid search 强）。Milvus 生产部署至少要 etcd + MinIO + Pulsar/Kafka 三件套，资源开销不小，客户机房要预留 16C 64GB 给 Milvus 控制面。

**特征平台。** 推理时需要的"用户画像/历史行为"特征，不能每次实时算（延迟爆炸），也不能全塞向量库。Feast（开源特征平台）或自建 Redis + 离线特征表是常见方案。FDE 在风控/推荐场景必做特征离线/在线一致性校验，否则离线训练 AUC 0.85 上线变 0.72。

**缓存层。** LLM 场景三层缓存：①**语义缓存**（GPTCache / LangChain Cache）对相似问题返回历史答案，命中率 15%–40% 能省大量算力；②**Prompt 前缀缓存**（vLLM 的 `--enable-prefix-caching`）对相同 system prompt 的请求共享 KV cache，首 token 延迟降 60%–80%；③**Redis 结果缓存**对结构化查询（如"今天天气"）秒回。FDE 要把这三层缓存写进架构图并标注命中率 SLO。

## 33.7 可观测基础设施：Prometheus + Grafana + 日志 + 追踪

AI 系统的可观测比传统应用多两个维度：**GPU 指标**和**模型质量指标**。完整栈包含：

**指标（Metrics）。** Prometheus + DCGM-Exporter 采集 GPU 指标（`DCGM_FI_DEV_GPU_UTIL`、`DCGM_FI_DEV_FB_USED` 显存、`DCGM_FI_DEV_GPU_TEMP` 温度、`DCGM_FI_PROF_PIPE_TENSOR_ACTIVE` 张量核心利用率）；自定义业务指标通过 `/metrics` 暴露（推理 QPS、P50/P99 延迟、token/秒、显存碎片率）。FDE 现场经验：**张量核心利用率**比 `GPU_UTIL` 更能反映真实负载——后者只要有任何 CUDA 调用就显示 100%，前者才反映矩阵乘法密度。

**Grafana 看板。** 至少三块面板：①GPU 资源总览（每张卡的利用率/显存/温度/功耗）；②推理服务 SLO（QPS、延迟分位、错误率、熔断次数）；③成本面板（token 消耗、调用方分布、按租户的成本分摊）。Grafana 官方有 NVIDIA DCGM dashboard 模板（ID 12239）可直接导入。

**日志（Logs）。** Loki（轻量、与 Grafana 原生集成）或 ELK（功能全但重）。AI 日志的痛点是单条请求日志巨大（一个 prompt + 4K 生成 token 几十 KB），必须采样 + 截断，否则日志存储爆炸。FDE 规范：DEBUG 全量只保留最近 1 天，INFO 保留 7 天，ERROR 永久；prompt 内容脱敏后再写日志（PII 必须 mask）。

**追踪（Traces）。** Tempo / Jaeger。一次 RAG 请求的链路：网关 → embedding → 向量检索 → rerank → LLM 推理 → 后处理，每跳的延迟都要可视化。FDE 用 trace 定位"为什么 P99 突然 30 秒"——80% 的情况是某一跳（通常是 rerank 或向量检索）出了热点。

> 信创场景下 Prometheus/Grafana/Loki/Tempo 这套 CNCF 栈本身是开源的，没有"卡脖子"问题，但要注意 Grafana Labs 的企业版功能（SSO、审计）要替换成开源等价物。

## 33.8 信创云原生：国产 K8s、国产容器、国产监控

信创要求下，FDE 经常被客户要求"全栈国产化"，需要在每一层找替代：

**容器运行时。** Docker 受美国 EAR 管辖（虽为开源），客户常要求替换。替代：**containerd**（CNCF 毕业，开源无管制）是事实标准；进一步国产化有 **iSulad**（华为开源，openEuler 默认）、**Podman**（Red Hat，无 daemon）。K8s 1.24+ 已弃用 dockershim，containerd 是默认选择，迁移成本不高。

**K8s 发行版。** 选项：**华为 CCE / CCE Turbo**（公有云 + 私有化双形态）、**阿里 ACK / ACK Pro / 注册集群**、**腾讯 TKE**、**火山引擎 VKE**。纯私有化发行版：**KubeSphere**（青云开源，国内最活跃的 PaaS）、**KubeCube**（网易）、**Rancher 中文版**（SUSE 收购，但有外商背景）、**BFE/Kosmos** 等多集群方案。FDE 在央国企现场最常见组合是 **openEuler OS + iSulad + KubeSphere + 华为昇腾 NPU**（昇腾 910B 通过 Volcano 调度，`ascend.kubectl.kubernetes.io/gpu` 资源名）。

**国产 GPU/NPU 调度。** 昇腾（华为）有官方 K8s 插件 `ascend-docker-runtime`，资源名 `huawei.com/Ascend910B`；寒武纪 MLU 通过 `cambricon.com/mlu`；海光 DCU 走 ROCm 兼容层。FDE 必须了解：国产卡的 CUDA 兼容性参差，昇腾用 CANN（非 CUDA），模型要从 PyTorch CUDA 版本移植到 CANN 版本，部分算子要手写替换，迁移工作量常被低估为"几天"实际是"几周"。

**国产监控。** Prometheus/Grafana 开源无管制，但客户常要"国产监控品牌"，替代：**夜莺监控（Nightingale）**（滴滴开源，融合 Prometheus 生态）、**博睿数据 Bonree One**、**云杉网络 DeepFlow**（eBPF 可观测）。日志侧 **PLG**（Promtail + Loki + Grafana）开源可用，国产有 **腾讯 CLS、阿里 SLS** 的私有化版本。

> FDE 在信创项目的核心动作是"逐层替换 + 兼容性验证"，每替换一层都要跑一次完整推理链路回归，不能用"开源等价"四个字蒙混过关——昇腾 CANN 与 CUDA 的算子差异、KubeSphere 与原生 K8s 的 CRD 兼容性都是踩坑重灾区。

## 33.9 私有化 vs 公有云：基础设施的真实权衡

FDE 给客户做方案选型时，"上不上云"不是技术问题而是合规与成本问题。权衡矩阵：

| 维度 | 公有云（阿里云/腾讯云/AWS） | 私有化（客户机房） |
|---|---|---|
| GPU 获取 | 弹性强，H20/A10 按小时租（H20 约 30–50 元/卡·小时） | 一次性采购，H20 单卡 12 万–18 万元，回本周期 2–3 年 |
| 数据合规 | 数据出境/跨境受限，金融医疗多拒上公有云 | 数据完全自控，合规无障碍 |
| 启动速度 | 1 天能拉起集群 | 采购 + 入场 + 部署 1–3 个月 |
| 运维 | 厂商托管 K8s/存储/网络，FDE 专注应用 | 全栈自维，FDE 要兼运维 |
| 弹性 | 洪峰秒级扩容 | 受限于采购的固定算力 |
| 成本可预测性 | 按量计费，长期跑训练可能比自建贵 2–3 倍 | 固定投入，跑满 3 年后单卡成本低于云 |
| 模型选择 | 云厂商有 MaaS（通义/盘古/文心可直接调用） | 必须自部署开源模型（Qwen/DeepSeek/GLM） |

**FDE 的典型建议：** 数据敏感（金融、政务、医疗）→ 私有化；流量波动大且数据不敏感（互联网 C 端）→ 公有云；混合模式（核心数据私有化 + 突发流量溢出到云）→ 成本最高但最灵活，需 FDE 设计跨云调度。一个常被低估的事实：私有化 3 年总持有成本（TCO）在中高负载（GPU 利用率 >50%）下低于公有云，但低负载（<20%）下公有云更划算——FDE 要用客户的真实利用率画像做 TCO 测算，而不是拍脑袋。

## 33.10 FDE 在客户机房的真实基础设施挑战

教科书里的云原生是干净的，客户机房是脏的。FDE 在 Engineer 阶段要面对的现实困境：

**1. 老旧硬件与新栈不兼容。** 客户机房常见的 GPU 是 V100（2020 年采购）、T4、甚至 P40。V100 还能用 CUDA 12，但 **T4 不支持 MIG、不支持 bf16**，跑 Qwen2-7B 必须降到 fp16，显存 16GB 装 70B 模型要 8 卡张量并行，性能还不如一张 H20。FDE 要做"硬件资产盘点"，把每张卡的型号、显存、驱动版本、CUDA 能力版本（compute capability）列成表，再决定模型选型——这往往要推翻 Design 阶段的模型假设。

**2. 网络受限、无外网。** 客户机房普遍物理隔离，没有公网出口。FDE 不能 `docker pull`、不能 `pip install`、不能 `git clone`。必须在干净的离线环境把镜像、依赖、模型权重全量打包（`docker save` + `pip download` + 模型 tar），用光盘/U盘/专网摆渡进去。一次部署常因为少打包一个依赖（如某个 `libc` 版本）现场卡半天。FDE 的离线清单要列到 `apt` 包级别。

**3. 受限权限。** 客户不给你 root，不给 sudo，K8s 集群是只读 kubeconfig。FDE 要部署一个新服务，要走变更工单 → 审批 → 客户运维代执行，一周起步。这倒逼 FDE 把"现场变更"压缩到最少——PoC 验证充分后再进场，进场只做"换镜像 + 改 ConfigMap"这类最小操作。

**4. 散热与供电。** 8×H100 SXM 满载功耗 10kW+，传统机房单机柜 5–8kW 供电跟不上，必须改造供电（增加 PDU、升级 UPS）和散热（行级空调、冷热通道隔离）。FDE 进场第一件事是问机房 PUE 和单机柜功率上限，否则机器进场开不了机。

**5. 备件与故障。** 客户机房 H20 坏一张卡，备件采购 2–4 周，期间推理服务降级。FDE 必须设计"N+1 卡冗余"，并在 K8s 节点上配置 `nvidia.com/gpu` 失败自动驱逐（Node Problem Detector + cluster-autoscaler）。

**6. 国产化硬指标。** 央国企项目常要求"国产化率 X%"，OS 要 openEuler/麒麟，数据库要 OceanBase/GaussDB/TDSQL，中间件要东方通/宝兰德。FDE 要在 Design 阶段就把"国产替代矩阵"画出来，每个组件标注"是否有国产等价物 + 迁移工作量"，否则 Engineer 阶段才发现某组件无国产替代，整个方案被推翻。

> 现场心法：FDE 不是在真空中做架构，而是在"老旧硬件 + 受限权限 + 国产化硬指标 + 无外网"的四面墙里做架构。能在四面墙里跑通的最小可行交付，比 PPT 上的完美架构有价值十倍。

## 本专题小结

AI 系统的基础设施需求与传统应用有本质差异：GPU 是稀缺且调度粗粒度的核心资源，存储要扛 TB 级 checkpoint 高吞吐，网络东西向流量爆炸，弹性受冷启动延迟制约。FDE 必须掌握容器化（Docker + docker-compose 离线打包）与 K8s 编排（GPU Operator、DCGM、反亲和、KEDA 自定义指标扩缩容），并精通 GPU 共享三件套（时间分片零侵入但无隔离、MIG 硬隔离但静态、MPS 同构榨取）。服务化层用 APISIX/Higress 做网关，按 QPS/并发/token 三维限流，配合熔断器应对推理服务的"半死"状态。存储栈以 MinIO + Milvus + Redis 为底座，三层缓存（语义缓存、前缀缓存、结果缓存）是降本关键。可观测栈是 Prometheus + DCGM-Exporter + Grafana + Loki + Tempo，张量核心利用率比 GPU_UTIL 更能反映真实负载。信创场景下要逐层替换（containerd/iSulad → KubeSphere → 昇腾 CANN → 夜莺监控），每一层替换都要跑完整回归。私有化与公有云的权衡看数据合规与 GPU 利用率画像，中高负载私有化 TCO 更优。FDE 在客户机房面对老旧硬件、无外网、受限权限、散热供电、备件短缺、国产化硬指标六大现实困境，能在这些约束下跑通的最小可行交付才是真本事。

## 本专题来源

- NVIDIA 官方文档：GPU Time-Slicing、MIG、MPS 配置指南（docs.nvidia.com/datacenter/cloud-native）
- Kubernetes 官方文档：GPU 调度、Device Plugin、GPU Operator（kubernetes.io、github.com/NVIDIA/gpu-operator）
- CNCF 项目文档：KEDA ScaledObject、Volcano 调度器、DCGM-Exporter
- 开源项目实测：Milvus 2.4 部署文档、vLLM `--enable-prefix-caching` 说明、Triton Inference Server 架构
- 国产化生态：openEuler/iSulad 文档、华为昇腾 CANN 开发者指南、KubeSphere 文档、夜莺监控 Nightingale、寒武纪 MLU K8s 插件
- FDE 现场实践：金融/政务/医疗私有化部署的离线打包清单、GPU 资产盘点表、信创替代矩阵、TCO 测算模板
- 公有云资料：阿里云 ACK、腾讯云 TKE、华为云 CCE 的 GPU 节点池与竞价实例定价（2024–2025 公开报价）
