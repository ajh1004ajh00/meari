# 엔진 설치 (WSL · vLLM · Nemotron 3.5 Transcribe)

메아리의 받아쓰기 엔진은 WSL 안에서 vLLM으로 돌아요. Windows on ARM + RTX Spark 조합에서 이 엔진을 띄울 때
막혔던 지점과 우회 방법을 정리했어요. 아래 버전 조합에서 동작을 확인했어요(2026-11).

> 이 문서는 "한 대의 노트북에서 실제로 된 방법"의 기록이에요. 다른 버전에서는 패치가 필요 없거나 다른 곳이 막힐 수 있어요.

## 확인한 환경

| 항목 | 버전 |
|---|---|
| 기기 | RTX Spark(N1X) 노트북, 통합 메모리 128GB (Windows가 약 30GB, GPU가 96GB) |
| OS | Windows 11 (ARM64) + WSL2 `Ubuntu-24.04` (aarch64) |
| Python | 3.13 (uv) |
| NeMo Speech | `NVIDIA-NeMo/Speech` 소스 체크아웃 (`nemo_toolkit 3.1.0`, commit `205cb6a`) |
| vLLM | 0.32.0 (aarch64), NeMo 플러그인 `VLLM_PLUGINS=nemo_speechlm` |
| torch | 2.13.0 + CUDA 13.0 |
| flashinfer | `flashinfer-python` / `flashinfer-cubin` / `flashinfer-jit-cache` 0.7.0.post1 (cu130) |
| nvcc | `nvidia-cuda-nvcc` 13.0.88 |
| 모델 | NVIDIA Nemotron 3.5 Transcribe 30B-A4B **NVFP4** (safetensors 약 21.5GB) |

## 순서

설치 순서(WSL, NeMo Speech + vLLM, 모델 받기, 앱 패키지)는 [README의 설치](../README.md#설치)를 따라 주세요.
여기서는 그 사이에 넣어야 하는 **WSL 대응 패치**와 메모리 설정을 설명해요.

- 배포판 이름이 `Ubuntu-24.04`가 아니면 `MEARI_WSL_DISTRO`(데스크톱 앱)와 `launch.vbs`의 `DISTRO`를 바꾸세요.
- NeMo Speech나 모델 위치를 바꾸면 `MEARI_NEMO_DIR`, `MEARI_MODEL`을 설정하세요.
- 확인: 패치 후 `bash scripts/engine.sh`를 실행하고 `curl http://127.0.0.1:8010/v1/models`가 응답하면 성공이에요.
  시작 로그에 `quantization=modelopt_mixed`가 보여야 해요. 처음에는 커널 컴파일로 몇 분 더 걸려요.

## WSL 대응 패치

`V=/root/nemo-speech/.venv/lib/python3.13/site-packages`일 때:

### 1. 통합 메모리 판정 (vLLM `mem_utils.py`)
vLLM은 통합 메모리 GPU에서 "남은 GPU 메모리"를 `psutil`(리눅스 RAM)로 계산해요.
WSL 안의 리눅스 RAM은 15GB뿐이라, 96GB GPU에서도 메모리가 부족하다고 판단하고 시작을 거부해요.
환경 변수가 있으면 원래대로 `cudaMemGetInfo`를 쓰게 바꿔요.

```bash
cd $V && patch -p0 --backup < /path/to/meari/docs/patches/vllm-0.32-mem_utils-wsl-uma.patch
```
`scripts/engine.sh`가 `VLLM_WSL_UMA_USE_CUDA_FREE=1`을 켜요.

### 2. CUDA 13.0 nvcc와 라이브러리 경로
flashinfer JIT 컴파일이 torch의 CUDA(13.0)와 같은 nvcc를 찾아야 해서 nvcc를 13.0으로 맞추고,
`lib64` 경로를 기대하는 빌드를 위해 링크를 만들어요.

```bash
uv pip install "nvidia-cuda-nvcc==13.0.88" "flashinfer-jit-cache==0.7.0.post1" \
  --extra-index-url https://flashinfer.ai/whl/cu130     # jit-cache는 flashinfer의 cu130 인덱스(설치 문서 참고)
C=$V/nvidia/cu13
mkdir -p $C/lib64/stubs
ln -sf $C/lib/libcudart.so.13 $C/lib64/libcudart.so
ln -sf /usr/lib/wsl/lib/libcuda.so $C/lib64/stubs/libcuda.so
```
`scripts/engine.sh`가 `CUDA_HOME`과 `PATH`를 이 경로로 잡아요.

## 메모리 (WSL 기본 한도 15GB)

이 노트북은 Windows가 쓰는 RAM이 약 30GB이고, WSL은 그 절반인 약 15GB까지 써요.
엔진이 모델을 읽을 때 WSL이 한도를 다 채우면 Windows 여유 메모리가 1GB 아래로 떨어지고 WSL 전체가 꺼질 수 있어요.
메아리는 `.wslconfig`를 건드리지 않고 다음 세 가지로 막아요.

| 장치 | 어디 | 하는 일 |
|---|---|---|
| `--safetensors-load-strategy lazy` | `engine.sh` | 모델을 필요한 만큼만 읽음 |
| cgroup `memory.high=6G` (켜지는 동안만) | `engine.sh`, `server.py` | 매핑된 모델 페이지를 커널이 회수하게 함. 준비되면 `max`로 풂 |
| 캐시 정리 (켜지는 동안 2초, 평소 20초마다) | `server.py` `cache_trimmer` | 매핑되지 않은 페이지 캐시를 비움 |

측정 결과(같은 노트북, 엔진 켜기): WSL 최대 **15.2GB → 9.2GB**, Windows 여유 메모리 최저 **0.97GB → 5.3GB**.
