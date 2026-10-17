"""
backend/server.py
Self-contained runner for LiveSub FastAPI server on port 8000.
Ensures correct path resolution and runs continuously.
"""
import sys
import os

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        app_dir=backend_dir,
        log_level="info"
    )
