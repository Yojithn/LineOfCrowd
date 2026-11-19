FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# model + optional crowd videos (cameras without a video use the simulated feed)
COPY models ./models
COPY videos ./videos
COPY *.py ./

RUN useradd --uid 10001 --no-create-home cam
USER 10001

CMD ["python", "worker.py"]
