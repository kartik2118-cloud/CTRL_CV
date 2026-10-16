/**
 * popup.js — LiveSub popup controller (all phases complete)
 * Sends Demo / Clear commands to the active YouTube tab via content-script messaging.
 */
'use strict';

async function sendToActiveTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
        await chrome.tabs.sendMessage(tab.id, message);
    } catch (e) {
        console.warn('[LiveSub Popup] Could not reach content script:', e.message);
    }
}

document.getElementById('btn-demo').addEventListener('click', () => {
    sendToActiveTab({
        action: 'SHOW_SUBTITLE',
        text: 'आज हम पनीर टिक्का बनाएंगे।',
        translation: 'Today we will make paneer tikka.'
    });
});

document.getElementById('btn-clear').addEventListener('click', () => {
    sendToActiveTab({ action: 'CLEAR_SUBTITLE' });
});

document.getElementById('btn-export-log')?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
        const resp = await chrome.tabs.sendMessage(tab.id, { action: 'EXPORT_CUE_LOG' });
        if (resp && resp.cueLog) {
            const blob = new Blob([JSON.stringify(resp.cueLog, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cue_log_${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    } catch (e) {
        console.warn('[LiveSub Popup] Could not export cue log:', e.message);
    }
});
