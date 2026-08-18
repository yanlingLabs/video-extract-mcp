#!/usr/bin/env bash
# Optional pre-fetch. Since 0.10.0 the models are downloaded automatically the
# first time a video needs local transcription, and only the engine that video
# uses. Run this to fetch both ahead of time, or when
# VIDEO_EXTRACT_AUTO_FETCH_MODELS=0 has turned the automatic path off.
set -euo pipefail
BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
DIR="${1:-models}"
mkdir -p "$DIR" && cd "$DIR"

[ -f silero_vad.onnx ] || curl -L -O "$BASE/silero_vad.onnx"

if [ ! -d sherpa-onnx-whisper-small ]; then
  curl -L -O "$BASE/sherpa-onnx-whisper-small.tar.bz2"
  tar xjf sherpa-onnx-whisper-small.tar.bz2 && rm sherpa-onnx-whisper-small.tar.bz2
fi

SV="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"
if [ ! -d "$SV" ]; then
  curl -L -O "$BASE/$SV.tar.bz2"
  tar xjf "$SV.tar.bz2" && rm "$SV.tar.bz2"
fi
echo "models ready in $DIR"
