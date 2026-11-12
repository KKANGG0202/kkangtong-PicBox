// Keep only the most recent N image messages expanded in the chat view.
// Older generated images are folded behind a small button and lose their src,
// so the browser neither downloads nor keeps them decoded. Chat data is never modified.
import { getSettings, isMobileDevice, currentChatId } from './settings.js';

const expanded = new Set();
let observer = null;
let scheduled = 0;

function isActive() {
    const s = getSettings();
    if (!s.foldEnabled) return false;
    if (s.foldMobileOnly && !isMobileDevice()) return false;
    return true;
}

function keyFor(mesId) {
    return `${currentChatId() ?? ''}:${mesId}`;
}

/** Generated / attached images only. Decorative images in HTML cards are left alone. */
function isTargetImage(img) {
    if (img.closest('.mes_media_wrapper')) return true;
    if (img.hasAttribute('data-autopic-id') || img.hasAttribute('data-autopic-slot')) return true;
    const src = img.getAttribute('data-pbx-src') || img.getAttribute('src') || '';
    return src.includes('/user/images/');
}

function getTargetImages(mes) {
    return [...mes.querySelectorAll('.mes_media_wrapper img, .mes_text img')].filter(isTargetImage);
}

const getToggle = mes => mes.querySelector('.pbx-fold-toggle');

function ensureToggle(mes, text) {
    let toggle = getToggle(mes);
    if (!toggle) {
        const anchor = mes.querySelector('.mes_text');
        if (!anchor) return;
        toggle = document.createElement('div');
        toggle.className = 'pbx-fold-toggle';
        toggle.setAttribute('role', 'button');
        toggle.tabIndex = 0;
        anchor.after(toggle);
    }
    if (toggle.textContent !== text) toggle.textContent = text;
}

function foldMessage(mes, images) {
    mes.classList.add('pbx-folded');
    for (const img of images) {
        const src = img.getAttribute('src');
        // Another extension may set a new src on a folded image; keep the latest one.
        if (src) {
            img.setAttribute('data-pbx-src', src);
            img.removeAttribute('src');
        }
        const srcset = img.getAttribute('srcset');
        if (srcset) {
            img.setAttribute('data-pbx-srcset', srcset);
            img.removeAttribute('srcset');
        }
    }
    ensureToggle(mes, `🖼 그림 보기 (${images.length}장)`);
}

function unfoldMessage(mes, images, showCollapse) {
    mes.classList.remove('pbx-folded');
    for (const img of images) {
        const saved = img.getAttribute('data-pbx-src');
        if (saved !== null) {
            if (!img.getAttribute('src')) img.setAttribute('src', saved);
            img.removeAttribute('data-pbx-src');
        }
        const savedSet = img.getAttribute('data-pbx-srcset');
        if (savedSet !== null) {
            img.setAttribute('srcset', savedSet);
            img.removeAttribute('data-pbx-srcset');
        }
    }
    if (showCollapse) ensureToggle(mes, '🖼 그림 접기');
    else getToggle(mes)?.remove();
}

export function applyFold() {
    scheduled = 0;
    const chat = document.getElementById('chat');
    if (!chat) return;

    const messages = [...chat.querySelectorAll('.mes[mesid]')]
        .map(mes => ({ mes, id: Number(mes.getAttribute('mesid')), images: getTargetImages(mes) }))
        .filter(item => Number.isFinite(item.id));

    if (!isActive()) {
        for (const item of messages) {
            if (item.mes.classList.contains('pbx-folded') || getToggle(item.mes)) unfoldMessage(item.mes, item.images, false);
        }
        observer?.takeRecords();
        return;
    }

    const keep = Math.max(0, Number(getSettings().foldKeep) || 0);
    const withImages = messages.filter(item => item.images.length > 0).sort((a, b) => b.id - a.id);

    withImages.forEach((item, index) => {
        if (index < keep) unfoldMessage(item.mes, item.images, false);
        else if (expanded.has(keyFor(item.id))) unfoldMessage(item.mes, item.images, true);
        else foldMessage(item.mes, item.images);
    });

    // Messages whose images disappeared (swipe, edit) must not keep a stale button.
    for (const item of messages) {
        if (item.images.length === 0 && (item.mes.classList.contains('pbx-folded') || getToggle(item.mes))) {
            item.mes.classList.remove('pbx-folded');
            getToggle(item.mes)?.remove();
        }
    }

    // Drop the mutations this pass caused so the observer does not loop.
    observer?.takeRecords();
}

function scheduleFold() {
    if (scheduled) return;
    scheduled = setTimeout(applyFold, 80);
}

function onToggle(event) {
    const toggle = event.target.closest?.('.pbx-fold-toggle');
    if (!toggle) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    const mes = toggle.closest('.mes[mesid]');
    if (!mes) return;
    const key = keyFor(mes.getAttribute('mesid'));
    if (mes.classList.contains('pbx-folded')) expanded.add(key);
    else expanded.delete(key);
    applyFold();
}

export function initFold() {
    document.addEventListener('click', onToggle, true);
    document.addEventListener('keydown', onToggle, true);
    const start = () => {
        const chat = document.getElementById('chat');
        if (chat && !observer) {
            observer = new MutationObserver(scheduleFold);
            observer.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        }
        scheduleFold();
    };
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.CHAT_CHANGED, () => { expanded.clear(); start(); });
    start();
}

/** Lets the gallery reveal a folded message before jumping to it. */
export function expandMessage(mesId) {
    expanded.add(keyFor(mesId));
    applyFold();
}
