FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Expose server port
EXPOSE $PORT

# Run server with shell interpolation for PORT
CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}
