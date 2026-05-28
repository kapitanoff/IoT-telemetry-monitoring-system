FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY emulator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY emulator/emulator.py .
ENTRYPOINT ["python", "emulator.py"]
