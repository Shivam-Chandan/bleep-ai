# Benchmarking

Local-model benchmarking notes for the box-side Ollama setup.

Hardware: NVIDIA GeForce 840M (2 GB VRAM), 7.7 GB RAM, 2C/4T CPU.
Raw per-run JSON: `data/bench-results.jsonl`.

## 2026-09-20 — qwen2.5:3b → qwen2.5:7b swap

### Chosen model

- **qwen2.5:7b** (7.6B params, Q4_K_M, 4.7 GB) — best summarization + chat model
  in the 5–8B range that fits this box.
- Runs as the derived tag **`qwen2.5:7b-ngl6`** — same weights, with
  `num_gpu 6` and `num_thread 2` baked in via Modelfile
  (`ollama create qwen2.5:7b-ngl6 -f ...`). The 7B's auto GPU-split crashes
  here (see tuning below), so the constraint is pinned so every caller
  (warm script, digest worker, chat API) loads reliably without passing
  `num_gpu` themselves.
- `qwen2.5:3b` was unloaded and repointed everywhere so it can never re-wake:
  - `/etc/systemd/system/ollama-warm.service` → `OLLAMA_MODELS=qwen2.5:7b-ngl6`
  - `scripts/warm-ollama.sh` → `NUM_GPU` default 6 (was hardcoded 24, which
    OOMs the 7B)
  - `.env.local` `OLLAMA_MODEL` / `OLLAMA_MODELS` → `qwen2.5:7b-ngl6`
  - No remaining `qwen2.5:3b` references in the repo (grepped).

### GPU offload tuning (max layers that fit in 2 GB VRAM)

| num_ctx | num_gpu=8 | num_gpu=6 | num_gpu=4 | notes |
|--------|-----------|-----------|-----------|-------|
| 1024   | OK        |           |           | probe |
| 4096   | FAIL OOM  | OK        | OK        | bench default |
| 8192   | –         | OK        | OK        | digest ctx ceiling, matches `DIGEST_CONTEXT_WINDOW` |
| 16384  |           | FAIL OOM  |           | hard ceiling is 8192 |

`num_gpu=6` is the stable maximum. 6/28 layers on GPU, ~22/28 on CPU → the 7B
is CPU-bound (28% GPU util once resident).

### Thread tuning (2C/4T box — raising threads makes it WORSE)

A/B on the resident model (64 tokens, num_ctx 4096, 2 runs each):

| num_thread | eval tok/s (avg) | note |
|-----------:|------------------:|------|
| 2 (physical cores) | **2.00** | optimal |
| 4 (hyperthreads)   | **1.05** | ~half the decode speed |

On this 2C/4T Haswell, 4 threads contend for 2 physical cores and saturate
the CPU / DDR3 bandwidth; hyperthreading slows llama.cpp decode. Keep
`num_thread=2` everywhere. This is why the earlier numbers below were
misleading — see "Session corrections".

### Token throughput (bench-ollama.mjs, 64 tokens, num_ctx 4096, num_thread=2)

| phase | load | TTFT | prompt tok/s | eval tok/s | total |
|-------|-----:|-----:|-------------:|-----------:|------:|
| cold  | 10282 ms | 8514 ms | – | **2.03** | 50425 ms |
| warm  | 3 ms | 473 ms | – | **2.02** | 32266 ms |

Previous qwen2.5:3b (num_gpu=24, 2026-09-18): cold eval 2.18 tok/s / warm 2.74
tok/s, cold TTFT 3519 ms / warm 369 ms. **The 7B at num_thread=2 is only
~8–25% slower on eval decode than the 3B**, and cold TTFT is driven by the
CPU-bound prefill.

Context sweep: 2048 / 4096 / 8192 load OK; 16384 CUDA OOM → **ceiling = 8192**
(which is exactly what the digest worker and warm script pin).

Concurrency 2 (128 tokens each, ran at the pre-fix 4-thread default): 1 OK
(0.80 tok/s, TTFT 12.5 s), 1 failed (`fetch failed` ~300 s). 2C/4T can't feed
two generations in parallel; not a supported scenario (app is single-user
chat). VRAM flat at 1843/2048 MiB during the batch.

### RAM during benchmarks (opencode footprint)

- Before: 5.9 GiB available; opencode ~680 MB.
- Model resident: 5.5 GiB available (box used 1.9 GiB total);
  `llama-server` RSS 4321 MB (mmap of the 4.7 GB weights — file-backed,
  evictable); opencode ~650 MB.
- During ingest: load avg ~5.5, llama-server ~146% CPU, opencode ~666 MB.

opencode RSS (~650 MB, this session) is the largest non-model consumer; it
does not prevent the model from loading and left >4.9 GiB free throughout,
so benchmarks were not RAM-contended.

### Vercel

`scripts/vercel-sync.sh` upserted `OLLAMA_MODEL` / `OLLAMA_MODELS` =
`qwen2.5:7b-ngl6` (HTTP 201) and triggered a production redeploy
(`dpl_H8EvPxoN1fCBVyUe3F85U7b93QvT`). UI untouched — model name is the only
change.

### Daily ingest (digest) run on the new model

Background reran the real 2026-09-19 briefing (10 items: 6 gmail, 3 zoom,
1 slack) through the exact production path
(`digest-worker → digestCore.buildDigestPrompt → callDigestModel`, ctx 8192,
temp 0.4, up to 1536 output tokens). The previous 3B run row for that day was
removed first (unique `user_id,day` constraint); summary written to a /tmp
backup that was later purged by a tmpfiles clean — **old 3B output text lost;
only its duration/length survive** in this log.

| model | generation time | output |
|-------|----------------:|-------:|
| qwen2.5:3b (2026-09-19)  | 177.6 s (3 min) | 1482 chars |
| qwen2.5:7b-ngl6 (2026-09-20) | 773.1 s (12.9 min) | 1774 chars |

7B: **4.35x slower, ~20% longer output.**

Response-time reality for the production chat path is dominated by prefill
(~10–30 s on a cold 5–26K-char prompt) plus decode at ~2 tok/s. The model is
kept warm by `ollama-warm.timer`, so subsequent calls skip load. Production
paths already used `num_thread=2` (`src/lib/agent.ts`, `digestCore.mjs`), so
real chat/digest latency never suffered from the bench config issue below.

> **Session corrections (thread config).** The numbers first recorded in this
> run used `bench-ollama.mjs` without a `num_thread` option, so Ollama ran the
> request on its 4-thread default — that's why the initial pass showed 0.81–
> 0.87 tok/s (~80 s for 64 tokens). Fixes applied after the A/B above:
> - `scripts/bench-ollama.mjs`: now passes `num_thread` (env `OLLAMA_NUM_THREAD`,
>   default 2) — re-recorded single numbers are the ones in this file.
> - `src/app/api/warm/route.ts`: hardcoded `num_gpu: 24` (an OOM on a 7B)
>   → `OLLAMA_NUM_GPU` (default 6), added to `src/lib/ollama.ts`.
> - `scripts/warm-ollama.sh` and `src/lib/ollama.ts` already capped threads at
>   2; verified unchanged.
> The digest (ingest) run below already ran on `num_thread=2` and is unaffected.

### Quality (7B output, compared against the prompt's ground rules)

Strong overall:
- Correct 5-section structure and order (Follow-ups → Schedule → Needs reply
  → Worth knowing → Top priorities).
- No invented data: empty calendar correctly reported as "Nothing on your
  calendar today."; zoom action items with owners (James, John, Gayatri,
  Shivam); real meeting time carried through (R&D All Hands, Oct 6, 6–7:30 PM
  IST); JAMS meeting cancellation noted rather than stated as scheduled.
- Decisive, no hedging, concrete names/times.

Minor polish issues:
- `**Worth knowing:**` label repeated on every bullet (redundant).
- "Why it matters" placed above the sender/subject line instead of as a
  trailing one-liner per item.
- Section headings are inline-bold paragraphs rather than `##` headings
  (note the prompt requests "in markdown" with five sections).

### Follow-ups / open items

- Evaluate **qwen3:8b** as the user requested (later pass; 8B Q4 ~4.9 GB →
  ~3 GB CPU RAM, likely still fits but tighter, and its thinking mode would
  require UI handling).
- Not touched (pre-existing): `bleep-ai-app.service` local Next.js standalone
  unit is in a `failed` state.
- Don't store durable backups under `/tmp` (tmpfiles-clean purged it mid-run).