# FisioClin — servicio de visión, para desplegar en Render/Railway/Fly.io.
#
# libgl1/libglib2.0-0/libsm6/libxext6/libxrender1 no son opcionales: mediapipe
# y opencv-python-headless los necesitan en tiempo de ejecución aunque sean
# "headless", y python:3.11-slim no los trae. Sin ellos el import falla recién
# al primer request, no al build.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py geometria.py ocr_carnet.py ./
COPY fisioclin_clases.json configuracion_ejercicios.json ./

# Render/Railway inyectan PORT en runtime; 8000 es solo el valor local.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
