# Local Chrome Test Guide
1. Mock backend chalao: `eval\venv\Scripts\python.exe eval\mock_backend.py --port 8000`
2. Chrome mein `chrome://extensions` kholo aur LiveSub extension reload karo.
3. Extension popup kholo, Backend URL mein `ws://127.0.0.1:8000/ws` save karo.
4. YouTube video (jaise `https://www.youtube.com/watch?v=dQw4w9WgXcQ`) kholo aur play karo.
5. Popup mein switch "ON" karo; YouTube player ke top-left par Debug HUD badge dikhega.
6. Expected normal HUD: `ext_loaded=true`, `capture_state=capturing`, `ws_state=connected`, `overlay_present=true`.
7. Telemetry growth: `chunks_sent` har second badhega aur backend se `results_received` badhega.
8. Overlay par "mock" subtitle text render hoga (`overlay_present=true`).
9. HUD diagnosis: `ws_state=error` (backend band/galat URL), `chunks_sent=0` (tabCapture block), `overlay_present=false` (player DOM attach fail).
