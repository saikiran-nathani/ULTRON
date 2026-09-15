import type {
  Roadmap,
  RoadmapPhase,
  RoadmapLayer,
  LayerToolGroup,
  LayerResource,
} from "./types";

/* ── Deterministic ids for seeded records ─────────────────────────────────
   These used to be `uid()`. That is correct for a record a user creates and
   wrong for one the app seeds, because the seed runs ONCE PER DEVICE: each
   device would bootstrap its own copy of this roadmap with different random
   ids, and the first sync would merge them into two of every phase, task,
   layer and resource. Duplicates that are indistinguishable from records
   someone meant to create.

   Deriving the id from the content makes the seed idempotent across devices —
   two devices seeding the same roadmap produce the same ids and converge onto
   one copy. It is the same reasoning as `completionId` for habit ticks.

   The id also carries a zero-padded ordinal, and that part is a correction to
   an earlier version of this comment, which argued for purely content-derived
   ids on the grounds that a positional id renumbers everything after an
   insertion. The measurement that changed it: the per-record sync layer keys
   records by id and rebuilds each array in ascending id order, because array
   *position* is not something that syncs — records arrive one at a time. With
   content-only ids, rebuilding this roadmap from sync reordered all five
   phases, all 34 tasks and every tool and resource group into hash order.
   `RoadmapTask` has no `sort`, no date, nothing else to order by, so the
   authored curriculum order was simply lost.

   The renumbering hazard the old comment guarded against needs a path that
   re-runs this seed over data that already exists, and there is none: the only
   caller is `makeDefaultData()`, for a store that is empty. New installs get
   new ids; existing installs keep theirs and never re-seed. And the content
   slug is still in the id, so a future "merge in new seed content" feature can
   match on that and ignore the ordinal.

   The general rule this follows: **mint ids in the order the records should be
   read.** `uid()` already does it — its `Date.now()` prefix is fixed-width
   until 2059, so user-created records sort into creation order for free. This
   gives seeded content the same property, which is what lets the sync layer
   treat ascending-id as the canonical order rather than an arbitrary one.

   The ordinal also makes uniqueness structural rather than a collision
   counter's job, so two identically-worded tasks can no longer collide at all.
   A test still asserts uniqueness, and another asserts the ordering. */

let nth = 0;

function seedId(kind: string, content: string): string {
  const slug =
    content
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "x";
  // Fixed width, or `seed:10:` would sort before `seed:9:` and the ordering
  // this exists to provide would be wrong past the ninth record.
  return `seed:${String(++nth).padStart(4, "0")}:${kind}:${slug}`;
}

const task = (text: string) => ({ id: seedId("task", text), text, done: false });
const phase = (
  title: string,
  period: string,
  start: string,
  end: string,
  goal: string,
  tasks: string[],
): RoadmapPhase => ({
  id: seedId("phase", title),
  title,
  period,
  start,
  end,
  goal,
  tasks: tasks.map(task),
});
const group = (g: string, items: string[]): LayerToolGroup => ({
  id: seedId("group", g),
  group: g,
  items,
});
const res = (label: string, url = ""): LayerResource => ({
  id: seedId("res", label),
  label,
  url,
});

const layer = (
  l: Omit<RoadmapLayer, "id" | "proficiency"> & { proficiency?: RoadmapLayer["proficiency"] },
): RoadmapLayer => ({ id: seedId("layer", l.name ?? ""), proficiency: "none", ...l });

/** The co-op roadmap + AI/ML stack reference, seeded from the source plan. */
export function makeRoadmapSeed(): Roadmap {
  // Reset the ordinal, or a second call in the same process would number every
  // record from where the first left off and produce a *different* seed than
  // the first — precisely the non-determinism this scheme exists to remove.
  nth = 0;
  return {
    deadline: "2026-09-01",
    principles: [
      "The real deadline is September 2026, not summer 2027. Co-op recruiting runs Oct–Feb and screens you on what already exists on your GitHub/résumé at apply time — not the skills you'll have by the time the co-op starts. The front end is the sprint; the back end (→ Aug 2028) is the slower full-time game.",
      "Depth + shipped artifacts beat buzzword breadth. \"Overkill for a co-op\" = 2–3 undeniable artifacts proving production-grade work, not 20 shallow skills. Ruthless prioritization is the strategy.",
    ],
    phases: [
      phase(
        "Ship the flagship + start the baseline",
        "Jul–Sep 2026",
        "2026-07-01",
        "2026-09-30",
        "Have undeniable artifacts live before applications open. This is the sprint that actually lands the co-op.",
        [
          "Flagship: design + build an agentic feature into Nexus (multi-step, real tool use)",
          "Flagship: build an eval harness — golden dataset, trajectory/step-level scoring, failure injection",
          "Flagship: add tracing/observability so failures are inspectable, not mysterious",
          "Flagship: write the failure-modes writeup (README or blog) — the differentiator, not the demo",
          "Flagship: make it photograph well — Copper-and-Obsidian design sense is an edge",
          "DL depth: re-derive backprop, optimization, attention by hand",
          "DL depth: build a transformer from scratch (nanoGPT-style)",
          "Baseline: start the DSA grind now — ~3–5 problems/week, patterns over volume",
          "Packaging: clean GitHub — pin the flagship, real READMEs, archive dead repos",
          "Packaging: rewrite résumé to lead with shipped artifacts + DL depth (1 page, no filler)",
          "Packaging: stand up a short portfolio/landing page",
        ],
      ),
      phase(
        "Applications + interviews",
        "Oct 2026 – Feb 2027",
        "2026-10-01",
        "2027-02-28",
        "Apply broadly, convert screens. DSA/system design is now the live gate.",
        [
          "Build target list (tier-2 core + reach + safety schools) and track it in Nexus",
          "Submit applications in waves starting October — don't wait until you feel \"ready\"",
          "DSA: ramp to interview intensity, timed mocks",
          "System design fundamentals: scalability, caching, queues, DB tradeoffs (SQL/NoSQL, OLAP/OLTP)",
          "ML system design: training/serving, data pipelines, eval-in-production",
          "Behavioral prep: STAR stories + the \"explain a complex system to a non-engineer\" drill",
          "Keep one project visibly committing — recruiters check commit history",
          "Log every application + outcome to build your funnel data",
        ],
      ),
      phase(
        "Offer in hand → pre-co-op ramp",
        "Feb – May 2027",
        "2027-02-01",
        "2027-05-31",
        "Add a second flagship + deepen toward your specific co-op's stack. This is where \"overkill\" gets real.",
        [
          "Second flagship — production/MLOps: containerize + serve a model end-to-end (Docker, vLLM, one cloud, CI/CD for ML)",
          "Post-training project (the flex): LoRA/QLoRA fine-tune with a proper eval; stretch to a small DPO or RLVR/GRPO experiment on a verifiable task",
          "Once you know your co-op's actual stack: pre-learn it so you arrive fluent",
          "Round out infra basics most students skip: Docker fluency, basic Kubernetes, cert-level knowledge of one cloud (AWS or GCP)",
        ],
      ),
      phase(
        "The co-op = full-time audition",
        "Summer 2027",
        "2027-06-01",
        "2027-08-31",
        "Own a real, shippable outcome. A return offer or strong reference here outweighs any single skill.",
        [
          "Identify a real, ownable outcome early; over-communicate scope with your manager",
          "Ship it end-to-end — own the problem, don't just close tickets",
          "Document impact in metrics",
          "Line up a manager reference",
          "Open the return-offer conversation explicitly before it ends",
        ],
      ),
      phase(
        "Runway to tier-2 full-time",
        "Sep 2027 – Aug 2028",
        "2027-09-01",
        "2028-08-31",
        "Build the deep stack in your chosen lane + convert or run a strong search.",
        [
          "Commit to a lane weighting: research/post-training vs applied/eval/reliability",
          "(Research lane) push RL/post-training work toward a publishable result or a serious OSS contribution",
          "(Applied lane) build a portfolio of production-grade systems with evals + observability",
          "Deepen DL/RL theory to research-grade: read papers, reproduce results",
          "Convert the co-op or run a full-time search from a position of evidence (fall 2027 cycle → Aug 2028 start)",
          "Keep Nexus evolving as your living portfolio piece",
        ],
      ),
    ],
    layers: [
      layer({
        name: "DL Depth",
        tag: "Foundation",
        target: "Solid",
        what: "The substrate: how neural nets actually learn — backprop, optimization, attention, the transformer. Not \"I call PyTorch\" but \"I can derive and reimplement the thing.\"",
        role: "Foundation and intellectual pull. Lets you re-tool in a weekend when the frontier moves, and it gates the research/post-training lane. Everything above is scaffolding around models you understand here.",
        tools: [
          group("Frameworks & libraries", ["PyTorch", "JAX / Flax", "Hugging Face Transformers", "PyTorch Lightning", "einops", "NumPy", "CUDA / Triton"]),
          group("Experiment tracking & viz", ["Weights & Biases (W&B)", "TensorBoard"]),
          group("Reference implementations", ["nanoGPT / minGPT (Karpathy)", "labml.ai annotated implementations"]),
        ],
        methods: ["backpropagation", "SGD / Adam / AdamW", "LR schedules", "multi-head attention", "transformer blocks", "LayerNorm / BatchNorm", "dropout", "embeddings", "BPE tokenization", "gradient clipping", "mixed-precision (bf16/fp16)", "distributed training (DDP, FSDP)"],
        resources: [res("Karpathy — Neural Networks: Zero to Hero", "https://karpathy.ai/zero-to-hero.html"), res("Dive into Deep Learning (d2l.ai)", "https://d2l.ai"), res("Stanford CS231n / CS224n"), res("fast.ai", "https://www.fast.ai")],
        demo: {
          name: "Build a GPT from scratch",
          tree: `nano-gpt/
├── data/
│   ├── prepare.py        # build tokenizer, write train.bin / val.bin
│   └── input.txt
├── model.py              # embeddings, MultiHeadAttention, Block, GPT
├── train.py              # batches, forward, loss, AdamW, eval, checkpoint
├── sample.py             # autoregressive generation
├── config.py             # hyperparams
└── out/                  # checkpoints + W&B logs`,
          flow: [
            "prepare.py tokenizes the corpus (BPE/char) → binary token arrays. (NumPy, tokenizer.)",
            "model.py: token + positional embeddings, stacked MHA + MLP blocks w/ LayerNorm + residuals, LM head. (PyTorch, einops.)",
            "train.py: sample batches → cross-entropy → backward → AdamW, grad clip, bf16 autocast; eval val loss + checkpoint. (PyTorch, W&B.)",
            "sample.py: load checkpoint, generate with temperature/top-k. (PyTorch.)",
            "Stretch: FSDP multi-GPU, or a fused attention kernel in Triton — the depth signal.",
          ],
        },
      }),
      layer({
        name: "Evals & Reliability",
        tag: "Differentiator",
        target: "One real harness shipped",
        what: "The discipline of proving a model/agent actually works: harnesses, golden datasets, scoring (rules + LLM-as-judge), trajectory checks, failure injection, and production tracing.",
        role: "Your differentiator. As model intelligence commoditizes, the scarce skill is making systems reliable and measurable. Rewards experimental rigor over model-building, and almost no intern has it.",
        tools: [
          group("Eval frameworks (pre-prod / CI)", ["DeepEval (\"Pytest for LLMs\")", "Ragas (RAG metrics)", "Promptfoo (YAML + red-team)", "lm-evaluation-harness (EleutherAI)", "MLflow LLM Evaluate", "TruLens"]),
          group("Observability & tracing", ["Langfuse (OSS, self-host, OTel)", "LangSmith (LangChain-native)", "Arize Phoenix (OTel, self-host)", "Braintrust (eval + obs + gateway)", "Helicone", "Comet Opik / W&B Weave / Galileo / Maxim / Datadog LLM"]),
          group("Guardrails & safety", ["Guardrails AI", "NeMo Guardrails", "DeepTeam / Promptfoo red teaming"]),
          group("Prompt optimization", ["DSPy (GEPA / MIPRO)"]),
        ],
        methods: ["golden datasets", "LLM-as-judge", "agent-as-judge", "human-in-the-loop annotation", "regression testing", "trajectory / step-level evaluation", "failure injection", "pairwise comparison", "RULER (LLM-elicited rewards, no labels)", "OpenTelemetry tracing"],
        resources: [res("Standard pattern: one CI framework (DeepEval/Ragas/Promptfoo) + one platform for annotation + dashboards (Braintrust/LangSmith/Arize)")],
        demo: {
          name: "Eval harness for an LLM feature",
          tree: `llm-evals/
├── dataset/golden.jsonl   # {input, expected_output, context}
├── metrics/scorers.py     # DeepEval metrics + LLM-as-judge rubric
├── tests/test_quality.py  # pytest asserting metric thresholds
├── tracing/instrument.py  # Langfuse spans around the feature
├── .github/workflows/evals.yml  # run on every PR (CI gate)
└── reports/               # regression history, failure clusters`,
          flow: [
            "Build a golden dataset of representative inputs w/ expected outputs/contexts. (JSONL.)",
            "Define scorers: deterministic checks + an LLM-as-judge rubric for open-ended quality. (DeepEval, Ragas for retrieval.)",
            "pytest asserts each metric clears a threshold; wire into CI so a regression blocks the PR. (DeepEval + GitHub Actions.)",
            "Instrument the live feature with tracing to capture every call/step. (Langfuse.)",
            "Pull prod traces, cluster failures, annotate, fold hard cases back into golden.jsonl — the improvement loop.",
            "Differentiator: add failure injection (corrupt a tool response, drop context) and assert graceful recovery.",
          ],
        },
      }),
      layer({
        name: "Agentic Systems",
        tag: "Differentiator",
        target: "One real agent shipped",
        what: "LLMs that plan, use tools, observe results, and adjust over multiple steps — single- or multi-agent — rather than answering one prompt.",
        role: "Your differentiator (paired with evals). It's the current product frontier; a real agent with an eval harness is a far stronger artifact than a chatbot demo.",
        tools: [
          group("Agent frameworks", ["LangGraph (state graph; most battle-tested)", "Claude Agent SDK (hooks, MCP, skills, subagents)", "OpenAI Agents SDK (low-overhead)", "CrewAI (role-based multi-agent)", "AutoGen / AG2", "Google ADK", "LlamaIndex agents (retrieval-first)", "Pydantic AI (type-safe)", "Smolagents (HF)", "OpenAgents (MCP + A2A interop)"]),
          group("Protocols", ["MCP (Model Context Protocol)", "A2A (Agent-to-Agent)"]),
          group("Retrieval / RAG", ["Pinecone / Weaviate / Qdrant / Chroma / pgvector", "LlamaIndex / LangChain retrievers", "(shift toward agentic/tool-driven search over vector RAG)"]),
          group("Memory & extras", ["function/tool calling", "structured outputs (JSON schema)", "MCP servers", "agent memory (mem0, Zep)", "voice: Pipecat / Vapi / OpenAI Realtime"]),
        ],
        methods: ["ReAct (reason+act) loop", "planning / decomposition", "tool use", "reflection / self-critique", "multi-agent orchestration (handoffs / group chat / hierarchical)", "human-in-the-loop approval", "checkpointing & resume"],
        resources: [res("Observability shared with Evals: LangSmith / Langfuse / Braintrust for agent traces")],
        demo: {
          name: "Multi-step research/coding agent (LangGraph)",
          tree: `research-agent/
├── state.py              # TypedDict: messages, plan, scratchpad, results
├── nodes/
│   ├── planner.py        # decompose goal into steps
│   ├── retriever.py      # tool-driven search (web/grep/vector)
│   ├── executor.py       # call tools / run code
│   └── critic.py         # check result, continue vs finish
├── tools/mcp_servers.py  # tools via MCP (search, file I/O, code-run)
├── graph.py              # wire nodes + conditional edges + checkpointer
├── evals/                # (L2) trajectory eval on agent runs
└── app.py                # entry + streaming + human approval hook`,
          flow: [
            "Define graph state that accumulates as the agent works. (LangGraph TypedDict.)",
            "planner decomposes the goal into a step plan. (LLM call.)",
            "retriever gathers context via tool-driven search / vector store. (MCP tools; Qdrant/pgvector.)",
            "executor calls tools/runs code; critic inspects + routes via conditional edge — the ReAct loop made explicit.",
            "Checkpointer persists state so long runs resume; HITL gate approves risky actions. (PostgresSaver + interrupt.)",
            "Pair with L2: trajectory eval over recorded runs + trace everything (DeepEval + Langfuse) — the artifact that beats a demo.",
            "For Nexus: slots in as a local agentic feature; expose tools as MCP servers, run the model locally.",
          ],
        },
      }),
      layer({
        name: "Production / MLOps",
        tag: "Working knowledge",
        target: "Working knowledge (notebook → prod)",
        what: "Everything that turns a model into a reliable, served system: serving engines, containers, orchestration, pipelines, monitoring.",
        role: "The \"notebook → prod\" flip. Most students skip it, so it's disproportionately valuable; FDE/applied roles screen hard for it.",
        tools: [
          group("Serving / inference", ["vLLM (production default)", "SGLang (RadixAttention, agentic/prefix-heavy)", "Ollama (local, Mac-friendly)", "llama.cpp (GGUF, offline)", "MLX / mlx-lm (Apple Silicon)", "TensorRT-LLM (NVIDIA peak)", "LM Studio"]),
          group("Orchestration & scaling", ["Docker / Kubernetes", "Ray Serve", "NVIDIA Triton / Dynamo", "KServe / Seldon"]),
          group("Gateways / routing", ["LiteLLM", "Braintrust AI Gateway / Helicone / OpenRouter"]),
          group("MLOps platforms", ["MLflow", "Weights & Biases", "BentoML", "DVC", "Kubeflow / Metaflow / ZenML"]),
          group("Data & pipelines", ["Airflow / Prefect / Dagster", "Spark / Databricks", "Feast (feature store)"]),
          group("Infra / IaC / compute", ["Terraform", "GitHub Actions", "Modal / RunPod", "Together / Fireworks / Replicate", "AWS (SageMaker/Bedrock) / GCP (Vertex) / Azure ML"]),
        ],
        methods: ["PagedAttention", "RadixAttention", "continuous batching", "KV cache", "prefix caching", "speculative decoding", "chunked prefill", "quantization (FP8/INT4/AWQ/GPTQ/GGUF)", "tensor/pipeline/expert/context parallelism", "FlashAttention"],
        resources: [res("Monitoring: Prometheus + Grafana, OpenTelemetry, Datadog")],
        demo: {
          name: "Serve a fine-tuned model behind a production API",
          tree: `model-serving/
├── model/                # merged weights or LoRA adapter + base
├── server/launch.sh      # vLLM serve → OpenAI-compatible endpoint
├── gateway/main.py       # FastAPI: auth, validation, routing
├── Dockerfile
├── docker-compose.yml    # model + gateway + db
├── k8s/                  # deployment.yaml (GPU, autoscale) + service.yaml
├── .github/workflows/deploy.yml  # build → test → push → roll out
└── monitoring/dashboards # Grafana: TTFT, tokens/s, cost, errors`,
          flow: [
            "Serve with vLLM (or SGLang for agent/chat) → OpenAI-compatible endpoint, quantized to fit the GPU. (Mac: MLX/Ollama.)",
            "FastAPI gateway in front for auth, validation, routing. (FastAPI + LiteLLM fallbacks.)",
            "Containerize both; docker-compose locally, deploy via K8s with GPU requests + autoscaling.",
            "CI/CD: build → smoke + eval tests → push → rolling deploy. (GitHub Actions; reuse L2 evals as a release gate.)",
            "Monitor TTFT, tokens/s, cost, errors; alert on regressions. (Prometheus + Grafana, OTel.)",
            "Track model version + metrics in a registry so rollbacks are clean. (MLflow.)",
          ],
        },
      }),
      layer({
        name: "Post-Training",
        tag: "Flex",
        target: "One project",
        what: "Adapting a base model after pretraining: supervised fine-tuning, preference optimization, RL with verifiable rewards, distillation.",
        role: "Your flex — both DL-deep and scarce (interns almost never touch RL post-training). The natural extension of your UG DL work into research-grade territory.",
        tools: [
          group("Training libraries", ["TRL (HF — SFT/DPO/KTO/ORPO/GRPO/Reward)", "Unsloth (single-GPU speed + VRAM king)", "Axolotl (config-driven, multi-GPU)", "LLaMA-Factory (GUI, lowest barrier)", "TorchTune (PyTorch-native)", "verl / OpenRLHF (RL infra at scale)", "MLX-LoRA (Apple Silicon)"]),
          group("Inference during RL", ["vLLM generates rollouts fast inside the loop"]),
        ],
        methods: ["SFT", "LoRA / QLoRA", "DPO", "ORPO", "KTO", "RLHF (PPO)", "RLVR + GRPO", "RULER (LLM-judge reward, no labels)", "knowledge distillation", "QAT"],
        resources: [res("Data: ChatML, preference pairs, 500–2,000 curated examples"), res("Base models: Llama 3, Qwen 3, Gemma 4, Mistral"), res("Decision rule: Prompt → RAG → Fine-tune → Distill. Fine-tune for form, not facts. SFT usually enough; GRPO only for verifiable-reward reasoning.")],
        demo: {
          name: "LoRA fine-tune + a GRPO reasoning experiment",
          tree: `finetune-lab/
├── data/sft.jsonl + prep.py   # ChatML pairs; clean, format, split
├── configs/sft_lora.yaml + grpo.yaml
├── train_sft.py               # TRL SFTTrainer + Unsloth (LoRA)
├── train_grpo.py              # TRL GRPOTrainer + reward fn
├── reward.py                  # verifiable reward (tests/answer) or RULER
├── eval/                      # (L2) base vs tuned on a golden set
├── merge.py                   # merge adapter → base; export (HF / MLX 4-bit)
└── serve/                     # (L4) vLLM / Ollama`,
          flow: [
            "Prep data into ChatML pairs; split train/val.",
            "SFT with LoRA on a 4-bit base (QLoRA), single GPU. (TRL + Unsloth; MLX-LoRA on Mac.)",
            "Evaluate base vs tuned on a golden set — the eval makes it a credible artifact, not just a training run. (DeepEval, reuse L2.)",
            "GRPO: define a verifiable reward (code passes tests / math matches) or RULER; train with GRPOTrainer, rollouts via vLLM.",
            "Merge adapter → base, export (HF, or MLX 4-bit for Mac).",
            "Serve behind an API (hand off to L4).",
            "Writeup: reward curve, what it learned, failure modes — the narrative is the differentiator.",
          ],
        },
      }),
      layer({
        name: "CS Interview Baseline",
        tag: "Gate",
        target: "In active prep",
        what: "The algorithmic + system-design competence every SWE/ML loop screens on, regardless of how good your AI work is.",
        role: "The unglamorous gate. Bomb the algo screen and none of Layers 1–5 get evaluated. Easy to under-weight when you're deep in RL.",
        tools: [
          group("DSA practice", ["NeetCode (curated roadmap + patterns)", "LeetCode (problem bank)", "Codeforces / HackerRank (reps + speed)"]),
          group("System design", ["Designing Data-Intensive Applications (Kleppmann)", "System Design Primer (GitHub)", "ByteByteGo (Alex Xu)", "Excalidraw (sketch)"]),
          group("ML system design", ["ML System Design Interview (Aminian & Xu)", "Designing ML Systems (Chip Huyen)"]),
        ],
        methods: ["arrays/strings, hashmaps, two pointers, sliding window, binary search", "trees & graphs (BFS/DFS), DP, heaps, tries, backtracking", "load balancing, caching, sharding, queues, CAP, SQL vs NoSQL, rate limiting, replication", "ML: data pipeline, feature eng, model selection, training infra, serving + eval-in-prod, drift, A/B", "Behavioral: STAR + \"explain a complex system to a non-engineer\""],
        resources: [res("NeetCode", "https://neetcode.io"), res("System Design Primer", "https://github.com/donnemartin/system-design-primer"), res("ByteByteGo", "https://bytebytego.com")],
        demo: {
          name: "ML system design: LLM-powered docs search/Q&A",
          tree: `Structure under interview pressure:
requirements → data → model → serving → eval → scaling
(with explicit tradeoffs at each step)`,
          flow: [
            "Clarify requirements — scale (QPS, corpus), latency, freshness, accuracy bar, budget.",
            "Data — ingestion, chunking, indexing; how often the corpus updates.",
            "Retrieval + model — embedding/vector vs agentic/tool-driven search; which LLM; grounding to cut hallucination.",
            "Serving — engine (vLLM/SGLang), caching, continuous batching, autoscaling; API shape.",
            "Eval & monitoring — offline golden-set, online quality signals, faithfulness, drift — close the loop (your L2 edge).",
            "Scaling & tradeoffs — cost vs latency vs quality; what you'd cut first; failure modes + fallbacks.",
          ],
        },
      }),
    ],
    lane: "Default weighting that keeps maximum co-op optionality while feeding the research interest: DL depth as the foundation, evals + agentic + production as the broadly-hireable differentiator, one post-training project as the flex. If you become certain about the research-engineer lane, shift weight toward the RL/post-training work + a research artifact and accept a narrower-but-deeper profile.",
    realityCheck: "Even tier-2 is competitive in this entry-level market, so the \"overkill\" instinct is calibrated, not paranoid. Executed, this stack plausibly overshoots tier-2 — but no plan guarantees an offer, and the Phase 3 co-op conversion moves your odds more than any extra skill. Optimize for evidence, not for collecting techniques.",
    throughLine: "The strongest artifacts cut across layers: Build a GPT (L1) → fine-tune with LoRA/GRPO (L5) → wrap it in an agent (L3) → prove it with an eval harness (L2) → serve it in production (L4) — and narrate the whole pipeline in an ML-design interview (L6). That one connected project is worth more than six isolated ones, and Nexus is a natural home for the agent + serving + eval pieces.",
  };
}
