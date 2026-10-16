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
