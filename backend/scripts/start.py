import os
import socket
import sys
from pathlib import Path

# Add backend root directory to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

import uvicorn
from app.config import HOST, PORT, STT_PROVIDER, TRANSLATION_PROVIDER


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def print_banner():
    local_ip = get_local_ip()
    print("=" * 70)
    print("   LiveSub Backend — Role C Hackathon Service Launcher")
    print("=" * 70)
    print(f"  * Host / Port           : {HOST}:{PORT}")
    print(f"  * Active STT Provider   : {STT_PROVIDER.upper()}")
    print(f"  * Active Translation    : {TRANSLATION_PROVIDER.upper()}")
    print("-" * 70)
    print("  CONNECTIVITY ENDPOINTS:")
    print(f"  * Local Health Check    : http://127.0.0.1:{PORT}/health")
    print(f"  * Local Server Info     : http://127.0.0.1:{PORT}/info")
    print(f"  * Local WebSocket (dev) : ws://127.0.0.1:{PORT}/ws")
    print(f"  * LAN WebSocket (test)  : ws://{local_ip}:{PORT}/ws")
    print("-" * 70)
    print("  PUBLIC TUNNEL (Optional for Judges & Remote Extension Testing):")
    print("  * Using Cloudflare Tunnel (recommended, no sign-up needed):")
    print(f"      cloudflared tunnel --url http://127.0.0.1:{PORT}")
    print("  * Using Localtunnel (npm):")
    print(f"      npx localtunnel --port {PORT}")
    print("  * Using Ngrok:")
    print(f"      ngrok http {PORT}")
    print("=" * 70)
    print("\nStarting Uvicorn Server...\n")


if __name__ == "__main__":
    print_banner()
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=True)
