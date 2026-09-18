#!/usr/bin/env node
// bench-ollama.mjs - Local Ollama benchmark for the 2GB GeForce 840M.
//
// Modes:
//   single    cold + warm single-shot timings (load, prompt-eval, eval tok/s)
//   concurrency [N]  parallel requests while sampling VRAM + journalctl
//   ctxsweep  find the highest num_ctx that loads without CUDA OOM
//
// Usage: node scripts/bench-ollama.mjs [single|concurrency 2|ctxsweep]
// Talks directly to the Ollama API on OLLAMA_BASE_URL (default localhost:11434).
//
// Every measurement is appended as one JSON line to a results file (JSONL),
// default data/bench-results.jsonl, override with BENCH_RESULTS_FILE=/path.
// Each line is self-describing (ts, run_id, model, num_gpu, num_ctx, ...), so
// runs from different days/configs can be diffed directly (e.g. CPU vs GPU).
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import process from 'node:process';

const BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const NUM_GPU = Number(process.env.OLLAMA_NUM_GPU || 24);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE =
  process.env.BENCH_RESULTS_FILE || path.join(HERE, '..', 'data', 'bench-results.jsonl');
const RUN_ID = new Date().toISOString(); // groups all records from this invocation

const IGNORE_COUNT = 2; // static warm-up runs, excluded from concurrency timing

function api(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    return r.json();
  });
}

function nvidiaInfo() {
  try {
    return execSync(
      'nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader',
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return 'nvidia-smi unavailable';
  }
}

function fmtMs(ns) {
  return ns != null ? `${(Number(ns) / 1e6).toFixed(0)}ms` : '-';
}

function round(n, d = 2) {
  return Number(n).toFixed(d);
}

function toks(count, ns) {
  return count && ns > 0 ? round(count / (Number(ns) / 1e9)) : 0;
}

async function generate({
  num_ctx = 4096,
  num_predict = 64,
  prompt = 'Write a short story about a robot learning to paint.',
}) {
  const res = await api('/api/generate', {
    model: MODEL,
    prompt,
    stream: false,
    keep_alive: -1,
    options: { num_predict, num_ctx, num_gpu: NUM_GPU, temperature: 0.7 },
  });
  const loadNs = res.load_duration ?? 0;
  const ttftNs = res.prompt_eval_duration ?? 0;
  const totalNs = res.total_duration ?? 0;
  const evalNs = res.eval_duration ?? 0;
  const promptTok = res.prompt_eval_count ?? 0;
  const evalTok = res.eval_count ?? 0;
  return {
    stats: {
      model: MODEL,
      num_gpu: NUM_GPU,
      num_ctx,
      num_predict,
      prompt_chars: (prompt ?? '').length,
      load_ms: Math.round(Number(loadNs) / 1e6),
      ttft_ms: Math.round(Number(ttftNs) / 1e6),
      total_ms: Math.round(Number(totalNs) / 1e6),
      prompt_tokens: promptTok,
      prompt_tok_s: Number(toks(promptTok, ttftNs)),
      eval_tokens: evalTok,
      eval_tok_s: Number(toks(evalTok, evalNs)),
    },
    // display fields (kept for console output; stats.* hold the raw numbers)
    loadMs: fmtMs(loadNs),
    ttftMs: fmtMs(ttftNs),
    promptTok: promptTok,
    promptTokS: toks(promptTok, ttftNs),
    evalTok: evalTok,
    evalTokS: toks(evalTok, evalNs),
    totalMs: fmtMs(totalNs),
  };
}

async function sampleVram({ seconds, intervalMs = 1000 }) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    samples.push(nvidiaInfo());
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return samples;
}

function persist(records) {
  try {
    mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
    appendFileSync(
      RESULTS_FILE,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );
    console.log(
      `\nresults saved to ${RESULTS_FILE} (${
        records.length
      } record${records.length === 1 ? '' : 's'}, run ${RUN_ID})`
    );
  } catch (e) {
    console.error(`\nWARN: could not save results to ${RESULTS_FILE}: ${e.message}`);
  }
}

// A self-describing base record. `opts` fills in the run options (num_ctx, ...).
function baseRecord(mode, phase, opts = {}) {
  return {
    run_id: RUN_ID,
    ts: new Date().toISOString(),
    model: MODEL,
    num_gpu: NUM_GPU,
    mode,
    phase,
    num_ctx: opts.num_ctx,
    num_predict: opts.num_predict,
    prompt_chars: opts.prompt_chars,
  };
}

// Record for a completed generate(): flattens stats + outcome.
function generateRecord(mode, phase, opts, r) {
  return {
    ...baseRecord(mode, phase, opts),
    outcome: 'OK',
    ...r.stats,
  };
}

async function singleShot() {
  console.log(`\n=== single-shot, ${MODEL} @ num_gpu=${NUM_GPU}, num_ctx=4096 ===`);
  const records = [];
  console.log('cold:');
  let r = await generate({ num_ctx: 4096 });
  console.log(r);
  records.push(generateRecord('single', 'cold', { num_ctx: 4096, num_predict: 64 }, r));
  console.log('warm (same profile):');
  r = await generate({ num_ctx: 4096 });
  console.log(r);
  records.push(generateRecord('single', 'warm', { num_ctx: 4096, num_predict: 64 }, r));
  persist(records);
}

async function concurrent(n) {
  // Prompt sized so the run actually computes (~20 tokens in, 128 out).
  const prompt = 'List the first ten US presidents and their terms in office. ' + 'x '.repeat(200);
  console.log(`\n=== concurrency=${n} parallel /api/generate (num_ctx 4096, num_gpu ${NUM_GPU}) ===`);
  const warmupOpts = { num_ctx: 4096, num_predict: 8, prompt: 'hi' };
  for (let i = 0; i < IGNORE_COUNT; i++) await generate(warmupOpts);

  const start = Date.now();
  const promises = Array.from({ length: n }, () => generate({ num_ctx: 4096, num_predict: 128, prompt }));
  const results = await Promise.allSettled(promises);
  const wall = ((Date.now() - start) / 1000).toFixed(1);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  for (const r of ok) {
    console.log(`  tok/s=${r.value.evalTokS}  tok=${r.value.evalTok}  ttft=${r.value.ttftMs}  total=${r.value.totalMs}`);
  }
  for (const r of failed) console.log(`  FAILED: ${r.reason.message}`);
  console.log(`wall=${wall}s  ok=${ok.length}  failed=${failed.length}`);

  // Sample VRAM while the batch settles — flat means no per-query GPU growth.
  const vram = await sampleVram({ seconds: 6 });

  const opts = { num_ctx: 4096, num_predict: 128, prompt_chars: prompt.length };
  const records = ok.map((r, i) =>
    generateRecord('concurrency', `parallel-${i + 1}`, opts, r.value)
  );
  records.push({
    ...baseRecord('concurrency', 'summary', opts),
    outcome: failed.length ? 'PARTIAL' : 'OK',
    wall_s: Number(wall),
    ok: ok.length,
    failed: failed.length,
    vram_samples: vram,
    errors: failed.map((r) => r.reason.message.slice(0, 300)),
  });
  console.log('VRAM samples:', vram.join(' | '));
  persist(records);
}

async function ctxSweep() {
  const levels = [2048, 4096, 8192, 16384];
  console.log(`\n=== context sweep (num_gpu ${NUM_GPU}) — find load-time OOM ceiling ===`);
  const records = [];
  for (const ctx of levels) {
    const opts = { num_ctx: ctx, num_predict: 8, prompt_chars: 2 };
    const probe = { num_ctx: ctx, num_predict: 8, prompt: 'hi' };
    let outcome;
    let error;
    let r;
    try {
      r = await generate(probe);
      outcome = 'loaded OK';
      console.log(`num_ctx=${ctx}  ${outcome}`);
    } catch (e) {
      outcome = 'FAILED';
      error = e.message.split('\n')[0].slice(0, 300);
      console.log(`num_ctx=${ctx}  ${outcome}: ${error}`);
    }
    const rec = r ? generateRecord('ctxsweep', `probe-${ctx}`, opts, r) : baseRecord('ctxsweep', `probe-${ctx}`, opts);
    records.push({ ...rec, outcome, ...(error ? { error } : {}) });
    // Unload between levels so each load starts from scratch.
    await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, keep_alive: 0, prompt: '' }),
    }).catch(() => {});
  }
  persist(records);
}

const cmd = process.argv[2] || 'single';
if (cmd === 'single') await singleShot();
else if (cmd === 'concurrency') await concurrent(Number(process.argv[3] || 2));
else if (cmd === 'ctxsweep') await ctxSweep();
else console.error('unknown mode: use single | concurrency N | ctxsweep');
process.exit(0);