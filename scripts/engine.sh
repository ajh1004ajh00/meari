#!/bin/bash
# Soft memory ceiling for the engine (cgroup v2 memory.high). While loading, vLLM maps ~10 GB of the 21.5 GB
# model file at once; mapped pages are page cache that drop_caches cannot free, so WSL hit its 15 GB cap and
# Windows fell under 1 GB free. Above memory.high the kernel reclaims those clean file pages itself (no kill).
# Only for loading: the app (server.py cache_trimmer) sets it back to max once the engine answers, because the
# engine's own (anonymous) memory grows to ~5.3 GB when ready. ENGINE_MEM_HIGH=max turns it off.
CG=/sys/fs/cgroup/meari-engine
if mkdir -p "$CG" 2>/dev/null && echo "${ENGINE_MEM_HIGH:-6G}" > "$CG/memory.high" 2>/dev/null; then
  echo $$ > "$CG/cgroup.procs" && echo "[engine] memory.high=$(cat "$CG/memory.high") ($CG)"
fi
# Paths (see docs/SETUP-WSL.md): NeMo Speech checkout with its .venv, and the downloaded model folder.
MEARI_NEMO_DIR=${MEARI_NEMO_DIR:-/root/nemo-speech}
MEARI_MODEL=${MEARI_MODEL:-/root/models/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-NVFP4}
cd "$MEARI_NEMO_DIR"
source .venv/bin/activate
export PATH=$PWD/.venv/lib/python3.13/site-packages/nvidia/cu13/bin:$PATH
export CUDA_HOME=$PWD/.venv/lib/python3.13/site-packages/nvidia/cu13
export VLLM_PLUGINS=nemo_speechlm
export VLLM_WSL_UMA_USE_CUDA_FREE=1
export VLLM_MAX_AUDIO_DECODE_DURATION_S=3600
export VLLM_MAX_AUDIO_CLIP_FILESIZE_MB=180
export VLLM_USE_V2_MODEL_RUNNER=0
export VLLM_DISABLED_KERNELS=FlashInferFP8ScaledMMLinearKernel
exec vllm serve "$MEARI_MODEL" \
  --host 127.0.0.1 --port 8010 \
  --served-model-name nemotron-transcribe \
  --safetensors-load-strategy lazy --trust-remote-code --dtype bfloat16 --kv-cache-dtype fp8 --gpu-memory-utilization ${GPU_UTIL:-0.40} \
  --max-model-len 65536 --max-num-batched-tokens 4096 --max-num-seqs ${MAX_SEQS:-8} \
  --enable-chunked-prefill --no-enable-prefix-caching \
  --use-replayssm --mamba-backend flashinfer --mamba-cache-mode none \
  --mm-processor-cache-gb 0 --no-async-scheduling \
  --limit-mm-per-prompt '{"audio":{"count":1,"length":57600000}}' \
  --speculative-config '{"method":"mtp","num_speculative_tokens":8}' \
  --reasoning-parser nemotron_v3 --trust-request-mm-kwargs \
  --middleware nemo.collections.speechlm2.vllm.salm.ctc_serving.ctc_timestamp_middleware
