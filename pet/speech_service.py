"""Local speech recognition; audio stays in memory unless JINGJING_ASR_DEBUG=1 saves each segment for debugging."""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
import os
from pathlib import Path
import wave

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import numpy as np
import sherpa_onnx
import uvicorn

ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path(os.environ.get("JINGJING_ASR_MODEL_DIR", str(
    ROOT.parent / "Open-LLM-VTuber" / "models" /
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
)))
DEBUG_DIR = ROOT / "asr_debug"
ASR_DEBUG = os.environ.get("JINGJING_ASR_DEBUG") == "1"
SAMPLE_RATE = 16000
MAX_AUDIO_BYTES = SAMPLE_RATE * 30 * 4
recognizer = None
recognitionLock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app):
    global recognizer
    modelPath = MODEL_DIR / "model.int8.onnx"
    tokensPath = MODEL_DIR / "tokens.txt"
    if not modelPath.is_file() or not tokensPath.is_file():
        raise RuntimeError("Local SenseVoice model files are missing")
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(modelPath), tokens=str(tokensPath), num_threads=4,
        sample_rate=SAMPLE_RATE, use_itn=True, provider="cpu", language="zh",
    )
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/health")
async def health():
    return {"ready": recognizer is not None, "engine": "SenseVoice", "sampleRate": SAMPLE_RATE}


def recognizeAudio(samples):
    stream = recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    recognizer.decode_streams([stream])
    return stream.result.text.strip()


def saveDebugSegment(samples, text):
    DEBUG_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    wavPath = DEBUG_DIR / f"{stamp}.wav"
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(wavPath), "wb") as wavFile:
        wavFile.setnchannels(1)
        wavFile.setsampwidth(2)
        wavFile.setframerate(SAMPLE_RATE)
        wavFile.writeframes(pcm.tobytes())
    wavPath.with_suffix(".txt").write_text(f"{text}\n", encoding="utf-8")


@app.post("/transcribe")
async def transcribe(request: Request):
    audioBytes = bytearray()
    async for chunk in request.stream():
        audioBytes.extend(chunk)
        if len(audioBytes) > MAX_AUDIO_BYTES:
            return JSONResponse({"error": "录音不能超过 30 秒。"}, status_code=413)
    if not audioBytes or len(audioBytes) % 4:
        return JSONResponse({"error": "音频格式不正确。"}, status_code=400)
    samples = np.frombuffer(audioBytes, dtype="<f4").copy()
    if not np.isfinite(samples).all() or np.max(np.abs(samples)) > 1.01:
        return JSONResponse({"error": "音频采样值不正确。"}, status_code=400)
    if len(samples) < SAMPLE_RATE // 5 or float(np.sqrt(np.mean(samples ** 2))) < 0.002:
        return {"text": ""}
    async with recognitionLock:
        text = await asyncio.to_thread(recognizeAudio, samples)
    if ASR_DEBUG:
        await asyncio.to_thread(saveDebugSegment, samples, text)
    return {"text": text}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("ASR_PORT", "8791")), log_level="warning")
