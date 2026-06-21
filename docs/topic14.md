---
title: "深度专题十四 LLM 选型与微调实战(LoRA/QLoRA/DPO)"
tags: ["模型微调", "LLM选型", "RAG", "数据工程", "中国市场"]
---

微调(fine-tuning)是 FDE 在客户现场最容易"踩过头"的环节。许多团队第一次拿到私有数据就上 LoRA,两周后模型回答风格对、但事实错;或者一上来就全参微调 7B,把预算烧在显存租赁上。本专题不堆理论,只回答一个问题:在某客户的具体场景里,**到底要不要微调、怎么微、微完怎么验**。所有命令均面向 2025—2026 年国产开源主流栈(Qwen2.5/Qwen3 系、LLaMA-Factory、PEFT、TRL),可照抄。

## 14.1 第一个决策:微调 vs RAG vs 换模型

90% 的"模型不够好"问题,不是微调能解决的。先用决策树收口:

```
是否需要"新知识 / 私有文档"?
├─ 是 → 优先 RAG(向量库 + 重排),知识可更新、可溯源
│       仅当:检索后仍无法注入"风格 / 格式 / 推理范式"时,才考虑微调
└─ 否 → 是否"输出格式 / 风格 / 任务范式"不满足?
        ├─ 是 → 先试 prompt engineering + few-shot,再试换更大/更新的模型
        │       都不够,才进入微调评估
        └─ 否 → 多半是部署/调用问题,与模型能力无关
```

三类目标的边界要划清:

| 目标 | 正确手段 | 典型错误 |
|---|---|---|
| 注入私有知识(产品手册、合同条款) | RAG | 用微调硬背,导致幻觉 + 无法更新 |
| 固定输出格式(JSON schema、SQL 方言、表单) | SFT 或强 prompt + function calling | 用 RAG 拼 prompt,格式漂移 |
| 改变行为范式(拒答边界、语气、口吻) | SFT + DPO | 仅靠 prompt,稳定性差 |
| 提升推理能力(数学、代码) | 换更强的基座 | 微调弱模型,能力天花板仍在 |

> 经验法则:微调改变的是"怎么说",不是"知道什么"。把知识塞进权重等于把数据库编译进可执行文件——更新一次就要重新编译。

## 14.2 微调方法全景与代价

主流方法按"改多少参数、怎么改"分层:

| 方法 | 改动参数量 | 显存(7B 基座,fp16) | 适用场景 | 主要代价 |
|---|---|---|---|---|
| 全参微调(Full) | 100% | ≥80GB(需梯度+优化器状态) | 领域基座模型、有算力有数据 | 灾难性遗忘重、易过拟合 |
| 冻结微调(Freeze) | 仅末层几 % | 30—40GB | 轻量领域适配 | 收益边际,多数情况不如 LoRA |
| LoRA | 0.1%—1%(低秩矩阵) | 20—28GB(可训 7B) | SFT 首选、性价比最高 | 复杂推理提升有限 |
| QLoRA | 同 LoRA,基座 4bit 量化 | 8—12GB(可单卡训 7B) | 显存受限、消费级 24G 卡 | 训练慢约 30%、合并部署需注意 |
| SFT(监督微调) | 上述任一为载体 | 取决于载体 | 教"标准答案" | 数据质量 > 数量 |
| DPO | 在 SFT 模型上继续 | 同 SFT | 偏好对齐、风格收敛 | 需 (chosen, rejected) 对 |
| RLHF(PPO) | 全参或 LoRA | 高 + 额外 reward/critic | 前沿对齐研究 | 工程复杂、不稳,工业界少用 |

> 工业落地 90% 路径:**Qwen 基座 → LoRA/QLoRA 做 SFT → DPO 做偏好对齐**。RLHF 留给实验室。

## 14.3 LoRA / QLoRA 实战(Qwen + LLaMA-Factory)

### 14.3.1 原理一句话

LoRA 假设权重更新矩阵是低秩的:冻结原权重 `W`,旁路学习 `W + ΔW = W + BA`,其中 `B∈R^{d×r}, A∈R^{r×k}`,秩 `r` 通常取 8/16/32。QLoRA 在此基础上把 `W` 量化到 4bit(NF4)+ 双量化,只对 `BA` 留 fp16/bf16 梯度,从而把 7B 的可训显存压到单张 24G 卡。

### 14.3.2 环境

```bash
# 建议用 conda 隔离
conda create -n sft python=3.10 -y && conda activate sft
git clone https://github.com/hiyouga/LLaMA-Factory.git
cd LLaMA-Factory
pip install -e ".[torch,metrics]"
# 验证 GPU
python -c "import torch; print(torch.cuda.get_device_name(0), torch.cuda.get_device_properties(0).total_memory/1e9, 'GB')"
```

### 14.3.3 数据格式(Sharegpt / Alpaca 二选一)

`data/my_sft.json`,并在 `data/dataset_info.json` 注册:

```json
{
  "my_sft": {
    "file_name": "my_sft.json",
    "formatting": "sharegpt",
    "columns": {"messages": "conversations"},
    "tags": {"role_tag": "from", "content_tag": "value", "user_tag": "human", "assistant_tag": "gpt"}
  }
}
```

数据本身(sharegpt):

```json
[
  {"conversations": [
    {"from": "human", "value": "把这段设备告警翻译成工单摘要。"},
    {"from": "gpt", "value": "【告警】… 摘要:…"}
  ]}
]
```

### 14.3.4 QLoRA 训练配置 `examples/train_qlora/qwen2_5_qlora_sft.yaml`

```yaml
### model
model_name_or_path: Qwen/Qwen2.5-7B-Instruct
quantization_bit: 4
quantization_method: nf4          # QLoRA 用 nf4,bnb 也可
### method
stage: sft
do_train: true
finetuning_type: lora
lora_rank: 16
lora_alpha: 32
lora_target: q_proj,k_proj,v_proj,o_proj
### dataset
dataset: my_sft
template: qwen                    # Qwen 系列专用 chat template
cutoff_len: 2048
max_samples: 100000
overwrite_cache: true
### output
output_dir: saves/qwen25-7b-qlora
logging_steps: 10
save_steps: 500
### train
per_device_train_batch_size: 2
gradient_accumulation_steps: 8    # 等效 batch=16
learning_rate: 1.0e-4
num_train_epochs: 3.0
lr_scheduler_type: cosine
warmup_ratio: 0.03
bf16: true                        # A 系/H100 用 bf16;V100 改 fp16
flash_attn: fa2
```

启动:

```bash
llamafactory-cli train examples/train_qlora/qwen2_5_qlora_sft.yaml
```

### 14.3.5 关键超参取舍

- `lora_rank`:通用对话 8—16;领域重写/SQL 16—32;再大边际收益骤降且过拟合风险上升。
- `lora_target`:Qwen/LLaMA 系至少覆盖 attention 的 `q,k,v,o`;追求更强可加 `up_proj,down_proj,gate_proj`(又称 "all-linear"),但显存和遗忘风险上升。
- `learning_rate`:LoRA 通常 `5e-5 ~ 2e-4`;全参则降到 `1e-5 ~ 5e-5`。学习率过大典型症状:loss 在前 50 步掉到极低然后开始震荡,验证集 BLEU/格式准确率反而下降。
- `cutoff_len`:别盲目拉长。长样本显存按平方增长,且多数 SFT 数据的有效信号在前 1024 token。

### 14.3.6 合并与导出

QLoRA 产物是 adapter,部署前一般要合并回完整权重:

```bash
llamafactory-cli export examples/merge_lora/qwen2_5_lora_export.yaml
# export.yaml 关键项:
#   model_name_or_path: Qwen/Qwen2.5-7B-Instruct
#   adapter_name_or_path: saves/qwen25-7b-qlora
#   template: qwen
#   finetuning_type: lora
#   export_dir: models/qwen25-7b-sft
```

> 注意:4bit 量化基座合并后默认导出为 fp16 全精度;若要重新量化部署(vLLM/AWQ/GPTQ),在推理侧单独做。

## 14.4 SFT 数据准备:质量大于数量

这是微调成败真正的分水岭。三条硬经验:

1. **500 条人工精标 > 50000 条弱标注/蒸馏**。LIMA 论文已证明 1k 高质量样本足以让风格收敛。垃圾进、垃圾出在 SFT 上被放大十倍。
2. **格式必须 100% 一致**。若要 JSON 输出,训练集里 assistant 回答必须是合法 JSON,且不要混入"解释性自然语言前缀"。一个反例污染整批。
3. **去重 + 去泄露**。对 prompt 做 MinHash 去重;把评估集从训练集里严格剔除(按 prompt 的 SHA256 黑名单),否则评估全是假象。

清洗脚本片段(去重 + 长度过滤):

```python
import hashlib, json
from collections import defaultdict
seen, dedup = set(), []
for ex in json.load(open("raw.json", encoding="utf-8")):
    key = hashlib.sha256(ex["conversations"][0]["value"].encode()).hexdigest()[:16]
    if key in seen: continue
    if not (8 <= len(ex["conversations"][0]["value"]) <= 2000): continue
    seen.add(key); dedup.append(ex)
json.dump(dedup, open("my_sft.json","w",encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"{len(dedup)} 条保留")
```

> 数据配比:通用能力保留用 10—20% 通用 SFT 数据(如 alpaca-zh 子集)混入,可显著缓解灾难性遗忘。

## 14.5 DPO 偏好对齐实战

SFT 教"标准答案",但真实场景里同一 prompt 有多个可接受回答,DPO 用 (chosen, rejected) 对告诉模型"哪个更好",直接优化偏好,跳过显式 reward 模型。

### 14.5.1 数据格式(ChatML,TRL)

```json
{"prompt": [{"role":"user","content":"总结这段会议纪要。"}],
 "chosen": [{"role":"assistant","content":"【结论】…\n【行动项】…"}],
 "rejected":[{"role":"assistant","content":"好的,这是总结:…(无结构、口语化)"}]}
```

### 14.5.2 训练代码(TRL)

```python
from datasets import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOConfig, DPOTrainer

model_id = "models/qwen25-7b-sft"   # 上一步 SFT 合并后的模型
tok = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype="bfloat16", attn_implementation="flash_attention_2")
ds = Dataset.from_json("data/dpo.json")

def fmt(x):
    return {
        "prompt":   tok.apply_chat_template(x["prompt"],   tokenize=False, add_generation_prompt=True),
        "chosen":   tok.apply_chat_template(x["chosen"],   tokenize=False),
        "rejected": tok.apply_chat_template(x["rejected"], tokenize=False),
    }
ds = ds.map(fmt)

cfg = DPOConfig(
    output_dir="saves/dpo",
    beta=0.1,                       # KL 正则强度,过大会让训练退化为 SFT
    learning_rate=5e-7,             # DPO 学习率要比 SFT 小一个数量级
    per_device_train_batch_size=2,
    gradient_accumulation_steps=8,
    num_train_epochs=2,
    bf16=True, max_length=2048, max_prompt_length=1024,
)
trainer = DPOTrainer(model=model, ref_model=None, args=cfg,
                     train_dataset=ds, processing_class=tok)
trainer.train()
```

> 要点:`ref_model=None` 时 TRL 自动用 adapter disable 或 deepcopy 做 reference;`beta=0.1` 是社区默认,偏好数据噪声大时降到 0.05 更稳。学习率超 `1e-6` 经常把模型带崩。

## 14.6 微调后评估:专用评估集 + 防过拟合

评估是微调最容易被忽略、却最致命的一环。要建三层评估:

1. **格式准确率**:正则解析输出,若要 JSON 就验 schema 通过率(目标 ≥ 98%)。
2. **领域任务集**:人工标注 100—300 条客户真实 prompt 的黄金答案,用 LLM-as-judge(配 rubric)+ 关键字段 F1 双轨评估。
3. **通用能力回归集**:用 C-Eval / MMLU 子集或自有 50 条通用题,确认风格收敛的同时没把基座能力训废。

防过拟合信号判读:

| 现象 | 判定 | 处置 |
|---|---|---|
| 训练 loss 持续降,验证 loss 第 1 epoch 后回升 | 过拟合 | 减 epoch 到 1—2;加 dropout;减少数据 |
| 格式准确率训练集 99% / 验证集 70% | 分布偏移 | 训练集多样性不足,补数据 |
| 通用回归集掉点 >5% | 灾难性遗忘 | 混入通用 SFT 数据;降学习率;缩窄 lora_target |
| 输出风格对但事实错率上升 | 知识被"风格覆盖" | 这是 RAG 该干的,别用微调 |

> 铁律:**任何微调结果都必须在通用回归集上跑一遍**。不跑就交付,等于把过拟合风险转嫁给客户。

## 14.7 工程化:算力、显存、分布式

显存粗算(7B,bf16,batch=1,seq=2048):

- 推理:≈14GB(权重)+ KV cache
- LoRA 训练:≈24GB(权重 + 激活 + 优化器)
- QLoRA 训练:≈10GB(4bit 权重 + 激活)
- 全参训练:≈80GB(权重×2 + Adam 状态×2 + 激活,需 ZeRO-2/3)

实战命令参考:

```bash
# 单机 8 卡,LLaMA-Factory 内置加速
llamafactory-cli train examples/train_lora/qwen2_5_lora_sft.yaml \
  --per_device_train_batch_size 4 --gradient_accumulation_steps 4 \
  --ddp_find_unused_parameters false
# 多机用 deepspeed 需配 ds_config,典型 zero-2:
#   deepspeed --num_gpus 8 --num_nodes 2 src/train.py ...
```

成本直觉(2025 国内云):一张 A100 80G 按需约 ¥10—15/小时;QLoRA 训 7B 3 epoch / 1 万条数据,单卡约 4—8 小时,成本几十到一两百元。全参 7B 同样规模要 8 卡、十几小时,成本差一个数量级——这就是 LoRA 成主流的根本原因。

## 14.8 真实陷阱与处置

### 14.8.1 灾难性遗忘(Catastrophic Forgetting)

表现:微调后模型不会做数学题、不会写通用代码、拒答变多。根因:SFT 数据分布过窄,权重被拉偏。处置:混入 10—20% 通用数据;降学习率;用 LoRA 而非全参;必要时只调 adapter 不合并,部署时动态加载/卸载。

### 14.8.2 过拟合(尤其小数据集)

表现:训练 loss 极低、训练集完美但验证集塌方。处置:`num_train_epochs` 默认从 3 降到 1—2;样本量 < 2000 时 `lora_rank` 别超过 16;early stopping 监控验证 loss。

### 14.8.3 数据泄露与评估造假

表现:评估集指标虚高,上线翻车。处置:评估集 prompt 哈希黑名单写入训练管线;评估集人工标注、不放仓库公共目录;交付报告里注明评估集来源和数量。

### 14.8.4 Chat Template 不匹配

表现:微调后模型答非所问、重复 prompt。根因:训练用的 template 和推理服务(vLLM/SGLang)不一致。处置:统一用模型官方 `apply_chat_template`,**不要手拼 `<|im_start|>`**;合并权重后用同款 tokenizer 验证一次。

### 14.8.5 DPO 把模型训崩

表现:DPO 后输出变短、拒答、胡言乱语。根因:学习率过大、`beta` 过小、`rejected` 质量过差(与 chosen 差异过大或本身就是乱码)。处置:学习率压到 `5e-7` 以内;`beta` 起步 0.1;偏好对差异要"细而正确",不是"好 vs 烂",而是"好 vs 还行"。

## 14.9 国产模型微调生态

| 基座 | 官方/社区工具链 | 备注 |
|---|---|---|
| Qwen2.5 / Qwen3 系 | LLaMA-Factory、PEFT、TRL、阿里 ModelScope + ms-swift | 生态最完整,template=`qwen`,首选基座 |
| ChatGLM 系列 | 官方 `AgentTuning` + `ptuning`、LLaMA-Factory 部分 | ptuning-v2 已过时,优先 LoRA |
| DeepSeek-V3 / R1 | LLaMA-Factory、TRL | 蒸馏 + LoRA 用于领域推理,显存吃紧 |
| InternLM | 官方 `xtuner`、LLaMA-Factory | xtuner 对 InternLM 适配最深 |
| 通用加速 | Liger-Kernel、Unsloth | Unsloth 可让 LoRA 训练提速 2×、显存降 50% |

ms-swift(魔搭社区)对国产模型集成度最高,适合不愿自己折腾 chat template 的团队:

```bash
pip install 'ms-swift[all]' -U
swift sft --model Qwen/Qwen2.5-7B-Instruct \
  --dataset custom.jsonl --lora_target_modules ALL \
  --output_dir output --num_train_epochs 2
```

> 选型建议:PoC 阶段一律 QLoRA + Qwen2.5-7B,理由是单卡可跑、迭代快、生态稳;确认有效后再决定是否上 LoRA/全参 + 更大基座。永远不要在 PoC 阶段为"看起来更专业"而上全参。

## 本专题小结

微调是放大器,不是银弹。它能放大你的数据质量(好数据 → 风格收敛、格式稳定),也能放大你的数据缺陷(脏数据 → 幻觉、遗忘、过拟合)。FDE 在现场的正确姿态是:**先用 RAG + prompt + 换模型排到天花板,确实碰到"格式/风格/范式"瓶颈再上微调;上微调首选 QLoRA + Qwen + LLaMA-Factory;数据 500 条精标胜过 5 万条弱标;评估必须含通用回归集;DPO 用小学习率收口**。把这条链路跑通,微调就是可控工程;跳过 RAG 直接全参,大概率是把客户预算变成一次昂贵的过拟合实验。

## 本专题来源

- LLaMA-Factory 官方仓库与 `examples/` 配置:https://github.com/hiyouga/LLaMA-Factory
- Qwen 官方训练文档(LLaMA-Factory 集成):https://qwen.readthedocs.io/en/latest/training/llama_factory.html
- HuggingFace TRL DPOTrainer 文档:https://huggingface.co/docs/trl/dpo_trainer
- Phil Schmid《RLHF in 2024 with DPO & TRL》:https://www.philschmid.de/dpo-align-llms-in-2024-with-trl
- 魔搭社区 ms-swift:https://github.com/modelscope/swift
- Hu et al., LoRA: Low-Rank Adaptation of Large Language Models, arXiv:2106.09685
- Dettmers et al., QLoRA: Efficient Finetuning of Quantized LLMs, arXiv:2305.14314
- Rafailov et al., Direct Preference Optimization, arXiv:2305.18290
- Zhou et al., LIMA(Less Is More for Alignment), arXiv:2305.11206
- Unsloth 加速库:https://github.com/unslothai/unsloth
