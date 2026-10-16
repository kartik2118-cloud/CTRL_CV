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
from app.config import HOST, PORT, STT_PROVIDER, TRANSLATION_PROVIDER, IS_MOCK


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

    # Task 2: Loud warning banner if running in mock mode
    if IS_MOCK or STT_PROVIDER == "mock" or TRANSLATION_PROVIDER == "mock":
        print("!" * 70)
        print("  WARNING: RUNNING IN MOCK PROVIDER MODE (SYNTHETIC SUBTITLES)")
        print("  Do not use mock mode for live scoring by judges.")
        print("  Set real API keys and providers (sarvam/groq) in .env before evaluation.")
        print("!" * 70)

    # Task 5: Auth token warning
    from app.config import AUTH_TOKEN
    if not AUTH_TOKEN:
        print("  NOTICE: AUTH_TOKEN is not set. WebSocket server is open to unauthorized access.")
    else:
        print("  SECURITY: AUTH_TOKEN enforcement is ENABLED.")

    print("-" * 70)
    print("  CONNECTIVITY ENDPOINTS:")
    print(f"  * Local Health Check    : http://127.0.0.1:{PORT}/health")
    print(f"  * Local Server Info     : http://127.0.0.1:{PORT}/info")
    print(f"  * Local WebSocket (dev) : ws://127.0.0.1:{PORT}/ws")
    print(f"  * LAN WebSocket (test)  : ws://{local_ip}:{PORT}/ws")
    print("-" * 70)
    print("  PRODUCTION DEPLOYMENT & WSS REQUIREMENT (CRITICAL FOR JUDGES):")
    print("  * YouTube runs exclusively on HTTPS. Chrome security STRICTLY BLOCKS")
    print("    plain ws:// connections due to mixed-content / CSP restrictions.")
    print("  * A secure wss:// endpoint is MANDATORY for live evaluation on YouTube.")
    print("  * Plain ws://127.0.0.1 ONLY works if testing on local non-HTTPS pages.")
    print("  * Tunnels (Cloudflare / ngrok) are temporary FALLBACKS ONLY (URLs change on restart).")
    print("  * For judges / evaluation, deploy to Render / Railway for a stable wss:// URL.")
    print("=" * 70)
    print("\nStarting Uvicorn Server...\n")


if __name__ == "__main__":
    print_banner()
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=True)
