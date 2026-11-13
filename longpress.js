// Long-press a picture in the chat to open it in the PicBox viewer.
// A normal tap/click is left alone, so SillyTavern's own zoom still works.
import { ctx, getSettings, currentChatId, currentCharacter } from './settings.js';
import { collectImages, imageKey, isUserImage } from './collect.js';
import { openViewer } from './grid.js';

const HOLD_MS = 500;
const MOVE_PX = 10;

let timer = 0;
let start = null;
let fired = false;

function targetImage(element) {
    const img = element?.closest?.('#chat .mes img');
    if (!img || img.closest('.avatar')) return null;
    const src = img.getAttribute('src') || '';
    return src && isUserImage(src) ? img : null;
}

function cancel() {
    clearTimeout(timer);
    timer = 0;
    start = null;
}

function openFor(img) {
    const character = currentCharacter();
    const items = collectImages(ctx().chat || [], {
        chatFile: currentChatId(), charName: character?.name, avatar: character?.avatar, isCurrent: true,
    });
    const key = imageKey(img.getAttribute('src'));
    // Show this message's neighbours in chat order so swiping walks through the chat.
    items.sort((a, b) => (a.mesId ?? 0) - (b.mesId ?? 0));
    const index = items.findIndex(item => item.key === key);
    if (index < 0) return false;
    openViewer(items, index, { closeAll: () => {} });
    return true;
}

function onDown(event) {
    fired = false;
    if (!getSettings().longPressViewer) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const img = targetImage(event.target);
    if (!img) return;
    fired = false;
    start = { x: event.clientX, y: event.clientY, img };
    clearTimeout(timer);
    timer = setTimeout(() => {
        if (!start) return;
        fired = openFor(start.img);
        if (fired) navigator.vibrate?.(15);
        cancel();
    }, HOLD_MS);
}

function onMove(event) {
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > MOVE_PX || Math.abs(event.clientY - start.y) > MOVE_PX) cancel();
}

/** Swallow the click / context menu that follows a long press that opened the viewer. */
function swallow(event) {
    if (!fired) return;
    fired = false;
    if (!targetImage(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

export function initLongPress() {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', cancel, true);
    document.addEventListener('pointercancel', cancel, true);
    document.addEventListener('scroll', cancel, true);
    document.addEventListener('click', swallow, true);
    // Android (and a right-click on PC) raise a context menu on long press, sometimes
    // cancelling the pointer first; treat it as the long press itself.
    document.addEventListener('contextmenu', event => {
        if (!getSettings().longPressViewer) return;
        const img = targetImage(event.target);
        if (!img) return;
        event.preventDefault();
        if (!document.getElementById('pbx_viewer')) fired = openFor(img);
        cancel();
    }, true);
    syncLongPressClass();
}

/** iOS shows its own callout menu on long press; hide it while the feature is on. */
export function syncLongPressClass() {
    document.body.classList.toggle('pbx-longpress', !!getSettings().longPressViewer);
}
