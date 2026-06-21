---
title: "深度专题四十二 FDE 现场工具箱(可照抄的命令/脚本/模板速查)"
tags: ["工具箱", "推理优化", "RAG", "可观测性", "项目交付"]
---

> 本专题是给 FDE/FDSE 在客户现场"开干"用的速查手册。所有命令、脚本、配置均来自真实交付经验,可直接复制粘贴到任意一台装好基础环境的 Linux/GPU 机器上跑。原则:**先跑通,再优化;先把客户问题压住,再谈架构美化。**

## 一、环境与部署:从一台裸机到 vLLM 可用

### 1.1 GPU 检测与显存体检

```bash
# 基础一次性查看
nvidia-smi

# 持续监控(每 2 秒刷新,排查显存泄漏/训练-推理混跑占用)
watch -n 2 nvidia-smi

# 只看显存占用百分比与进程 PID(写脚本时常用)
nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu --format=csv

# 看是哪个进程在吃显存(拿到 PID 后)
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv

# 驱动/CUDA 版本核对(客户现场最常见的"为什么跑不起来"根因)
nvidia-smi | grep -E "Driver Version|CUDA Version"
nvcc --version          # CUDA toolkit 版本,需与 PyTorch 编译版本匹配
```

> 经验:客户现场的"模型跑不起来",80% 是 CUDA 驱动版本 < 535(跑不了新架构 H100/H200)、x86 容器没装 `nvidia-container-toolkit`、或 PyTorch 的 CUDA build 与系统 CUDA 不匹配。先核这三项。

### 1.2 Python 环境隔离:conda 与 venv

```bash
# conda(推荐,能锁 CUDA 版本)
conda create -n fde python=3.11 -y
conda activate fde
# 锁定 cudatoolkit 版本,避免和服务端 CUDA 冲突
conda install -c nvidia cuda-runtime=12.1 -y

# venv(轻量,客户机器不想装 conda 时)
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip

# 导出/复刻环境(交付物必备)
pip freeze > requirements.txt
pip install -r requirements.txt
# 更稳的锁法
pip install pip-tools
pip-compile requirements.in        # 生成带 hash 的 requirements.txt
pip-sync requirements.txt
```

### 1.3 Docker + nvidia-container-toolkit(生产部署标配)

```bash
# Ubuntu 22.04 安装 nvidia-container-toolkit
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 验证容器内能看见 GPU
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
```

### 1.4 docker-compose 起 vLLM + Milvus + Redis(一套现场 RAG 底座)

```yaml
# docker-compose.yml —— 客户内网一套起
version: "3.9"
services:
  vllm:
    image: vllm/vllm-openai:v0.6.3
    runtime: nvidia
    environment:
      - HUGGING_FACE_HUB_TOKEN=${HF_TOKEN}
    volumes:
      - ./models:/models
      - ./hf-cache:/root/.cache/huggingface
    command:
      - --model=/models/Qwen2.5-14B-Instruct
      - --served-model-name=qwen2.5-14b
      - --tensor-parallel-size=2
      - --gpu-memory-utilization=0.90
      - --max-model-len=8192
      - --quantization=gptq
      - --trust-remote-code
    ports: ["8000:8000"]
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 2
              capabilities: [gpu]

  etcd:
    image: quay.io/coreos/etcd:v3.5.5
    environment:
      - ETCD_AUTO_COMPACTION_MODE=revision
      - ETCD_AUTO_COMPACTION_RETENTION=1000
    command: etcd -advertise-client-urls=http://etcd:2379 -listen-client-urls http://0.0.0.0:2379

  minio:
    image: minio/minio:RELEASE.2024-09-13T20-26-02Z
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: minio server /minio_data --console-address ":9001"

  milvus:
    image: milvusdb/milvus:v2.4.13
    command: ["milvus", "run", "standalone"]
    environment:
      ETCD_ENDPOINTS: etcd:2379
      MINIO_ADDRESS: minio:9000
    depends_on: [etcd, minio]
    ports: ["19530:19530"]

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 2gb --maxmemory-policy allkeys-lru
    ports: ["6379:6379"]
```

```bash
docker compose up -d
docker compose logs -f vllm            # 看模型加载日志,卡在 90%+ 是正常(权重到显存)
curl http://localhost:8000/v1/models   # 验证 OpenAI 兼容接口
```

### 1.5 离线/内网依赖打包(客户现场无外网时的命根子)

```bash
# 在有网的机器上下载全部 wheel + 模型
mkdir -p offline/{wheels,models,hf}
pip download -r requirements.txt -d offline/wheels

# 用 huggingface-cli 把模型整包拉下来(避免 lazy load 时回源)
pip install -U "huggingface_hub[cli]"
hf download Qwen/Qwen2.5-14B-Instruct --local-dir offline/models/Qwen2.5-14B-Instruct
# 或走镜像(国内/内网 HF 镜像)
HF_ENDPOINT=https://hf-mirror.com hf download Qwen/Qwen2.5-14B-Instruct --local-dir offline/models/Qwen2.5-14B-Instruct

# 打成 tar.zst 拷贝进客户内网
tar --use-compress-program='zstd -19 -T0' -cf offline.tar.zst offline/

# 内网安装
tar -xf offline.tar.zst
pip install --no-index --find-links=offline/wheels -r requirements.txt
# 模型:设置 HF_HUB_OFFLINE=1 走本地缓存
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
```

## 二、推理服务:vLLM 启动、量化、压测

### 2.1 vLLM 启动参数速查(按场景)

```bash
# 场景 A:FP16 单卡,Qwen2.5-7B,中等并发
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --port 8000 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --enforce-eager            # 关闭 CUDA Graph,冷启动更快,适合 PoC

# 场景 B:双卡张量并行 + AWQ 4bit 量化(省显存提并发)
vllm serve Qwen/Qwen2.5-14B-Instruct-AWQ \
  --tensor-parallel-size 2 \
  --quantization awq \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.92 \
  --swap-space 8             # CPU 交换空间 GB,缓解 KV cache 压力

# 场景 C:对接外部 Embedding 走 RAG,需要长上下文
vllm serve Qwen/Qwen2.5-32B-Instruct-AWQ \
  --tensor-parallel-size 4 \
  --quantization awq \
  --max-model-len 32768 \
  --max-num-seqs 64          # 长上下文下,批次并发别拉太高

# 场景 D:OpenAI 兼容 + 多模型同卡(SkyPilot/LiteLLM 风格)
vllm serve meta-llama/Meta-Llama-3-8B-Instruct \
  --served-model-name llama3-8b \
  --api-key sk-fde-local \
  --disable-log-requests     # 生产环境关请求日志,磁盘别被刷爆
```

> 关键参数取舍:`--gpu-memory-utilization` 实测 0.88–0.92 是甜区,过低浪费、过高触发 OOM;`--max-model-len` 直接决定 KV cache 上限,长上下文是显存大头;`--max-num-seqs` 在长输出场景应下调。

### 2.2 离线量化(GPTQ/AWQ/llama.cpp)

```bash
# AutoGPTQ 对 HF 模型做 GPTQ 4bit
pip install auto-gptq optimum
python - <<'PY'
from transformers import AutoTokenizer
from auto_gptq import AutoGPTQForCausalLM, BaseQuantizeConfig
model_id = "Qwen/Qwen2.5-7B-Instruct"
quant_conf = BaseQuantizeConfig(bits=4, group_size=128, desc_act=True)
tokenizer = AutoTokenizer.from_pretrained(model_id)
# 准备 128-256 条校准样本(业务真实问答对,别用 wikitext)
calib = [tokenizer("用户问:...\n助手:...") for _ in calibration_texts]
model = AutoGPTQForCausalLM.from_pretrained(model_id, quant_conf)
model.quantize(calib)
model.save_quantized("./Qwen2.5-7B-gptq", use_safetensors=True)
PY

# llama.cpp 转 GGUF(给 CPU/边缘端用)
git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp
pip install -r requirements.txt
python convert_hf_to_gguf.py /models/Qwen2.5-7B --outfile qwen25-7b.gguf
./llama-quantize qwen25-7b.gguf qwen25-7b-Q4_K_M.gguf Q4_K_M
```

### 2.3 压测:看清你的真实 QPS/TTFT/TPOT

```bash
# vLLM 自带 benchmark_serving(最有用,跑真实业务 prompt 分布)
python -m vllm.entrypoints.openai.api.benchmark_serving \
  --backend vllm --base-url http://localhost:8000 \
  --model qwen2.5-14b \
  --dataset-name random --random-input-len 1024 --random-output-len 512 \
  --num-prompts 500 --request-rate 10 \
  --save-result --result-dir ./bench

# 关键指标解读:
#   TTFT (Time To First Token) < 800ms 才像样
#   TPOT (Time Per Output Token) < 50ms/tok
#   成功率 > 99% (低于此值说明 PagedAllocator 在打架)

# Locust 做业务流量回放
pip install locust
cat > locustfile.py <<'PY'
from locust import HttpUser, task, between
import json, random
PROMPTS = ["帮我总结这份合同","这段代码有 bug 吗","..."]
class ChatUser(HttpUser):
    wait_time = between(1, 3)
    @task
    def chat(self):
        self.client.post("/v1/chat/completions", json={
            "model": "qwen2.5-14b",
            "messages": [{"role":"user","content": random.choice(PROMPTS)}],
            "max_tokens": 512, "temperature": 0.3,
        }, timeout=120)
PY
locust --headless -u 50 -r 5 -H http://localhost:8000 --run-time 5m
```

## 三、RAG 全链路:解析 → 切分 → 嵌入 → 入库 → 重排

### 3.1 文档解析:Unstructured 与 Marker

```bash
pip install "unstructured[pdf,docx,pptx]" marker-pdf
```

```python
# Unstructured:适合混合格式办公文档
from unstructured.partition.auto import partition
elements = partition("contracts/甲方合同.pdf", strategy="hi_res",
                     infer_table_structure=True)
chunks_text = [e.text for e in elements if e.text.strip()]

# Marker:对扫描件/复杂版式 PDF 召回更好,直接出 Markdown
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
converter = PdfConverter(artifact_dict=create_model_dict())
md = converter("contracts/扫描件.pdf").markdown
```

### 3.2 切分:递归 + 表格保护

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter
splitter = RecursiveCharacterTextSplitter(
    chunk_size=512, chunk_overlap=64,
    separators=["\n\n", "\n", "。", ";", " ", ""],
)
# 表格单独成块,不要被句子切分打散
def smart_split(text, tables):
    base = splitter.split_text(text)
    return base + [t.to_markdown() for t in tables]
```

### 3.3 嵌入与入库 Milvus

```python
from FlagEmbedding import FlagModel
from pymilvus import MilvusClient

embedder = FlagModel("BAAI/bge-large-zh-v1.5",
                     query_instruction_for_retrieval="为这个句子生成表示用于检索相关文章:")
client = MilvusClient("http://localhost:19530")
client.create_collection("rag", dimension=1024, metric_type="COSINE")

# 批量入库(别一条一条 insert)
vectors = embedder.encode(chunks)
data = [{"id": i, "vector": v, "text": chunks[i]} for i, v in enumerate(vectors)]
client.insert("rag", data)
```

### 3.4 检索 + bge-reranker 重排

```python
# 一阶段:向量粗召回 top-30
q_vec = embedder.encode_queries([query])[0]
hits = client.search("rag", [q_vec], limit=30, output_fields=["text"])

# 二阶段:Cross-encoder 精排 top-5
from FlagEmbedding import FlagReranker
reranker = FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=True)
pairs = [[query, h["entity"]["text"]] for h in hits[0]]
scores = reranker.compute_score(pairs, normalize=True)
top5 = [h for _, h in sorted(zip(scores, hits[0]), reverse=True)[:5]]
```

> 经验:**粗召回收 30 条,重排留 5 条**是性价比最高的配置。只走向量召回在多义词/同义改写下召回掉得厉害,加一层 reranker 几乎没有副作用,延迟 +100ms 换准确率 +15%。

## 四、Agent 框架:LangGraph / CrewAI / MCP / HITL

### 4.1 LangGraph 最小可跑图(带条件路由)

```python
from langgraph.graph import StateGraph, END
from typing import TypedDict, Annotated
import operator

class S(TypedDict):
    query: str
    retrieved: Annotated[list, operator.add]
    answer: str

def retrieve(s): return {"retrieved": top5(s["query"])}
def grade(s):
    # 命中关键词则直接答,否则转工具
    return "answer" if any(k in s["retrieved"][0] for k in ["合同","条款"]) else "tool"
def answer(s):  return {"answer": llm(s["retrieved"], s["query"])}
def call_tool(s): return {"answer": llm_with_tools(s["query"])}

g = StateGraph(S)
g.add_node("retrieve", retrieve); g.add_node("answer", answer); g.add_node("tool", call_tool)
g.set_entry_point("retrieve")
g.add_conditional_edges("retrieve", grade, {"answer":"answer","tool":"tool"})
g.add_edge("answer", END); g.add_edge("tool", END)
app = g.compile()
print(app.invoke({"query":"合同里违约金是多少","retrieved":[]}))
```

### 4.2 CrewAI 多 Agent 协作

```python
from crewai import Agent, Task, Crew, Process

researcher = Agent(role="行业研究员",
    goal="收集客户所在行业数字化现状", backstory="...", llm="qwen2.5-14b", tools=[search])
analyst = Agent(role="方案分析师",
    goal="把研究产出转成可落地建议", backstory="...", llm="qwen2.5-14b")

c = Crew(agents=[researcher, analyst], process=Process.sequential,
         tasks=[
           Task(description="调研 {company} 所在行业", agent=researcher, expected_output="结构化报告"),
           Task(description="基于研究产出给 3 条落地建议", agent=analyst, expected_output="建议清单"),
         ])
c.kickoff(inputs={"company":"某城投"})
```

### 4.3 MCP Server 最小实现(把客户内部 API 暴露成工具)

```python
# pip install "mcp[cli]"
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("fde-tools")

@mcp.tool()
def query_oa_system(ticket_id: str) -> str:
    """根据工单号查询 OA 系统进度"""
    return call_internal_oa(ticket_id)   # 客户内部接口

@mcp.resource("config://{key}")
def get_config(key: str) -> str:
    return load_client_config(key)

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

### 4.4 HITL:人在回路打断审批

```python
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt, Command

def human_approve(s):
    decision = interrupt({"draft": s["answer"], "ask":"确认发送邮件吗?(yes/no)"})
    if decision == "yes":
        send_email(s["answer"])
        return {"answer":"已发送"}
    return {"answer":"已取消"}

graph = builder.compile(checkpointer=MemorySaver())
config = {"configurable":{"thread_id":"t1"}}
# 第一次调用会在 human_approve 处 interrupt
result = graph.invoke({"query":"帮我回客户邮件"}, config)
# 拿到用户输入后,用 Command 续跑
result = graph.invoke(Command(resume="yes"), config)
```

## 五、数据质量与同步

### 5.1 Great Expectations 数据质量门禁

```python
import great_expectations as gx
ctx = gx.get_context()
ds = ctx.data_sources.add_pandas("ds")
asset = ds.add_dataframe_asset("orders")
batch = asset.add_batch_definition_whole_dataframe().get_batch(batch_parameters={"df": df})

# 期望套件(客户现场必备:非空、唯一、范围、外键)
batch.expect_column_values_to_not_be_null("order_id")
batch.expect_column_values_to_be_unique("order_id")
batch.expect_column_values_to_be_between("amount", 0, 1_000_000)
batch.expect_column_values_to_be_in_set("status", ["paid","shipped","refunded"])

result = batch.validate()
assert result.success, f"数据质量门禁失败: {result}"
```

### 5.2 CDC 增量同步(MySQL → Kafka → 特征/索引)

```yaml
# Debezium 连接器配置(精简)
database.hostname: mysql-prod
database.server.id: 184054
database.allowPublicKeyRetrieval: true
database.user: debezium
database.password: ***
table.include.list: orders,customers
topic.prefix: cdc_fde
```

特征增量计算(Flink/Spark Structured Streaming 任选):

```python
# 简化版:从 Kafka 流式聚合,落特征存储
from pyspark.sql import functions as F
df = (spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers","kafka:9092")
        .option("subscribe","cdc_fde.orders").load())
agg = (df.selectExpr("CAST(value AS STRING) as json")
         .selectExpr("get_json_object(json,'$.after.customer_id') as cid",
                     "get_json_object(json,'$.after.amount') as amt")
         .groupBy("cid").agg(F.sum("amt").alias("total_30d")))
agg.writeStream.format("redis").option("checkpointLocation","/ckpt").start()
```

## 六、评估:RAGAS 与 LLM-as-judge

### 6.1 RAGAS 跑一次端到端评估

```python
from ragas import evaluate
from ragas.metrics import faithfulness, answer_relevancy, context_precision, context_recall
from datasets import Dataset

ds = Dataset.from_dict({
    "question":   ["合同违约金多少？","数据出境需要哪些审批？"],
    "answer":     [gen1, gen2],
    "contexts":   [[retrieved1], [retrieved2]],
    "ground_truth":["按日万分之五","需经网信办+省级网信办评估"],
})
result = evaluate(ds, metrics=[faithfulness, answer_relevancy,
                               context_precision, context_recall],
                  llm=evaluator_llm, embeddings=eval_emb)
print(result)        # {'faithfulness':0.82, 'context_recall':0.76, ...}
```

### 6.2 LLM-as-judge 批量打分脚本

```python
JUDGE_PROMPT = """你是严格评审。根据参考答案打分。
问题:{q}
参考答案:{ref}
模型答案:{pred}
评分维度:正确性(0-5)、完整性(0-5)、简洁性(0-5)。只输出 JSON:{{"correct":x,"complete":y,"concise":z}}"""

def judge(q, ref, pred):
    resp = openai.chat.completions.create(
        model="qwen2.5-14b",
        messages=[{"role":"user","content":JUDGE_PROMPT.format(q=q,ref=ref,pred=pred)}],
        temperature=0)
    return json.loads(resp.choices[0].message.content)

# 批量跑,结果落 CSV 形成回归基线
import pandas as pd
df = pd.DataFrame([judge(**r) for r in eval_set])
df.to_csv("judge_baseline.csv", index=False)
```

## 七、可观测:Langfuse + Prometheus

```python
# Langfuse OpenAI 包装(三行接入)
from langfuse.openai import openai
resp = openai.chat.completions.create(model="qwen2.5-14b",
    messages=[{"role":"user","content":query}], metadata={"customer":"acme","user":uid})
# 自动记录:prompt、completion、token、延迟、cost,按 trace_id 串起 RAG 各步
```

```yaml
# Prometheus 抓取 vLLM 指标
scrape_configs:
  - job_name: vllm
    metrics_path: /metrics
    static_configs: [{targets: ["vllm:8000"]}]
# 关键指标(配 Grafana 告警):
#   vllm:num_requests_running    运行中请求数
#   vllm:num_requests_waiting    排队数 >0 说明吞吐到顶
#   vllm:gpu_cache_usage_perc    KV cache 占用率,接近 1.0 要扩容
#   vllm:e2e_request_latency_seconds  P95 延迟
```

## 八、安全:输入护栏与注入检测

```python
# 轻量关键词 + 正则护栏(不上 LLM 也能挡住 80% 注入)
import re
BLOCK_PATTERNS = [
    r"忽略(以上|前面|之前).{0,10}(指令|提示|规则)",
    r"(reveal|show|print).{0,10}(system|secret|api[_-]?key)",
    r"<\|im_start\|>|</?script>",
]
PII_PATTERNS = {
    "phone": r"1[3-9]\d{9}",
    "idcard": r"\d{17}[\dXx]",
    "bankcard": r"\d{16,19}",
}

def guard(input_text: str) -> tuple[bool, str]:
    for p in BLOCK_PATTERNS:
        if re.search(p, input_text, re.I):
            return False, f"命中注入模式:{p}"
    masked = input_text
    for k, p in PII_PATTERNS.items():
        masked = re.sub(p, f"[{k}]", masked)
    return True, masked

# 输出侧同样跑一遍护栏 + 敏感词,防止模型泄露训练数据中的密钥
```

```python
# 进阶:用小模型做指令注入分类(BERT/护栏 LLM)
from transformers import pipeline
clf = pipeline("text-classification", model="protectai/deberta-v3-base-prompt-injection-v2")
if clf(query)[0]["label"] == "INJECTION":
    reject(query)
```

## 九、运维:日志、显存溢出、回滚

```bash
# 排查 vLLM 日志(过滤掉健康检查噪音)
docker compose logs vllm | grep -vE "/health|GET /v1/models" | tail -200

# OOM 经典三连查
dmesg -T | grep -iE "killed process|out of memory"     # 系统级 OOM
docker stats --no-stream                                # 容器内存
nvidia-smi --query-gpu=memory.used,memory.total --format=csv  # 显存

# 模型回滚(镜像 tag 即版本,生产禁用 latest)
docker compose down
# 改 image tag 到上一个稳定版本,例如 v0.6.3 -> v0.6.2
docker compose up -d
# 如需回滚模型权重(保存多版本目录)
ln -sfn /models/Qwen2.5-14B-r3 /models/current   # 软链切版本,秒级回滚
```

> 显存溢出处理顺序:**降 max-model-len → 降 max-num-seqs → 降 gpu-memory-utilization → 换量化版本(AWQ/GPTQ) → 加卡张量并行**。优先调参数,最后才加硬件。

## 十、客户现场常用排查命令合集

```bash
# 网络:模型/API 通不通
curl -w "\n%{http_code} %{time_total}s\n" -o /dev/null -s http://localhost:8000/v1/models
nc -zv milvus 19530
nslookup hf-mirror.com

# 磁盘:HF 缓存爆盘是常事
du -sh ~/.cache/huggingface /models
df -h

# 端口占用(8000 被占是高频事故)
ss -lntp | grep :8000

# GPU 进程残留(训推混跑导致 OOM)
fuser -v /dev/nvidia*

# 看模型到底用了几个 GPU、batch 多大
curl -s http://localhost:8000/metrics | grep -E "num_requests_running|gpu_cache_usage"

# 一次性把客户机器全貌输出成报告(交付文档附录必备)
{
  echo "## 主机"; hostname; uname -a; cat /etc/os-release | head -2
  echo "## CPU/内存"; nproc; free -h
  echo "## 磁盘"; df -h | grep -v tmpfs
  echo "## GPU"; nvidia-smi --query-gpu=index,name,driver_version,memory.total --format=csv
  echo "## Docker"; docker --version; docker compose version
  echo "## Python"; python3 --version; pip --version
} > env_snapshot.txt
```

## 本专题小结

FDE 在客户现场真正缺的不是"理论",而是一份能照着敲就能跑通的命令清单。本专题按 **环境 → 推理 → RAG → Agent → 数据 → 评估 → 可观测 → 安全 → 运维 → 排查** 十个现场最高频场景,给出了可直接复制的命令、脚本与配置。三条贯穿性原则:其一,**先跑通再优化**,所有命令默认配的是稳妥参数,而不是极限参数;其二,**离线优先**,内网交付场景下 wheel 包、模型权重、HF 镜像三件套必须提前备好;其三,**可观测优先**,Langfuse + Prometheus + 环境快照三件套,既是运维抓手,也是交付文档的真实数据来源。把这份手册打印贴在客户机房墙上,比任何架构图都管用。

## 本专题来源

- vLLM 官方文档与 `benchmark_serving` 实践参数(v0.6.x)
- Hugging Face `transformers`、`auto-gptq`、`FlagEmbedding`(bge/reranker)官方示例
- Milvus 2.4.x Standalone 部署文档与 `pymilvus` API
- LangGraph(条件路由、interrupt/HITL)、CrewAI、Model Context Protocol Python SDK 官方示例
- Great Expectations 1.x、Debezium MySQL CDC、Spark Structured Streaming 文档
- RAGAS、Langfuse OpenAI 集成、Prometheus vLLM metrics 指标定义
- 作者在政企/金融/制造客户内网交付现场整理的可照抄版本,已脱敏
