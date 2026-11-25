# syntax=docker/dockerfile:1
# Local OCR and speech recognition. The runtime has no network, service keys or database mount.
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake g++ make \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ADD --checksum=sha256:870ba21409cdf66697dc4db15ebdb13bc67037d76c7cc63756c81471d8f1731a \
 https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.8.3 /tmp/whisper.tar.gz
RUN tar -xzf /tmp/whisper.tar.gz --strip-components=1 \
 && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build build --target whisper-cli --parallel 2

FROM python:3.14-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-eng tesseract-ocr-kor \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o 10000 -g 10000 -m 0770 /run/knowledge-media
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
WORKDIR /opt/media
COPY worker.py test_worker.py ./
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_THREAD_LIMIT=2
RUN python -B -m unittest test_worker && rm test_worker.py
USER 10000:10000
CMD ["python", "worker.py"]
