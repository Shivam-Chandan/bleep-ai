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
import { execSync } from 'node:child_process';
import process from 'node:process';

const BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const NUM_GPU = 24;

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

async function generate({ num_ctx = 4096, num_predict = 64, prompt }) {
  const res = await api('/api/generate', {
    model: MODEL,
    prompt: prompt ?? 'Write a short story about a robot learning to paint.',
    stream: false,
    keep_alive: -1,
    options: { num_predict, num_ctx, num_gpu: NUM_GPU, temperature: 0.7 },
  });
  return {
    loadMs: fmtMs(res.load_duration),
    ttftMs: fmtMs(res.prompt_eval_duration),
    promptTok: res.prompt_eval_count,
    promptTokS: round(res.prompt_eval_count / (Number(res.prompt_eval_duration) / 1e9)),
    evalTok: res.eval_count ?? '-',
    evalTokS: round(res.eval_count / (Number(res.eval_duration) / 1e9)),
    totalMs: fmtMs(res.total_duration),
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

async function singleShot() {
  console.log(`\n=== single-shot, ${MODEL} @ num_gpu=${NUM_GPU}, num_ctx=4096 ===`);
  console.log('cold:');
  console.log(await generate({ num_ctx: 4096 }));
  console.log('warm (same profile):');
  console.log(await generate({ num_ctx: 4096 }));
}

async function concurrent(n) {
  // Prompt sized so the run actually computes (~20 tokens in, 128 out).
  const prompt = 'List the first ten US presidents and their terms in office. ' + 'x '.repeat(200);
  console.log(`\n=== concurrency=${n} parallel /api/generate (num_ctx 4096, num_gpu ${NUM_GPU}) ===`);
  for (let i = 0; i < IGNORE_COUNT; i++) await generate({ num_ctx: 4096, num_predict: 8, prompt: 'hi' });

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
  console.log('VRAM samples:', vram.join(' | '));
}

async function ctxSweep() {
  const levels = [2048, 4096, 8192, 16384];
  console.log(`\n=== context sweep (num_gpu ${NUM_GPU}) — find load-time OOM ceiling ===`);
  for (const ctx of levels) {
    let outcome;
    try {
      await generate({ num_ctx: ctx, num_predict: 8, prompt: 'hi' });
      outcome = 'loaded OK';
    } catch (e) {
      outcome = `FAILED: ${e.message.split('\n')[0].slice(0, 80)}`;
    }
    console.log(`num_ctx=${ctx}  ${outcome}`);
    // Unload between levels so each load starts from scratch.
    await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, keep_alive: 0, prompt: '' }),
    }).catch(() => {});
  }
}

const cmd = process.argv[2] || 'single';
if (cmd === 'single') await singleShot();
else if (cmd === 'concurrency') await concurrent(Number(process.argv[3] || 2));
else if (cmd === 'ctxsweep') await ctxSweep();
else console.error('unknown mode: use single | concurrency N | ctxsweep');
process.exit(0);