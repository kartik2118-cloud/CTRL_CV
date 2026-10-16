1. Open chrome://extensions and enable Developer mode in the top-right corner.
2. Click "Load unpacked" and select the repository's extension/ folder.
3. Open any YouTube video and click the LiveSub extension icon in the toolbar.
4. Verify the "Cloud Audio Notice" banner is displayed at the top of the popup.
5. Backend WebSocket URL is baked into extension/config.js (storage override optional).
6. Ensure the main streaming switch is toggled ON to begin capture and live overlay.
7. Observe live subtitle cues rendered synchronously on the YouTube video overlay.
8. Caption path status: MISSING (DOM overlay used; video.textTracks is untouched).
9. Toggle switch to OFF to verify audio capture stops and subtitles clear.
10. Toggle back ON, stream audio, click "Export cue log", validate via python eval/validate_log.py.
