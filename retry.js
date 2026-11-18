// "다시 그리기" button on replies whose <autopic> block never became a picture
// (generation failed, key expired, server down...). One click draws it with AutoPic's settings.
import { ctx } from './settings.js';
import { generateImage, autopicSettings } from './autopic.js';
import { imageKey, isUserImage } from './collect.js';

// AutoPic may still be drawing the newest reply. We watch its image requests so the button
// appears as soon as it has finished (or failed), instead of waiting a fixed time.
const GRACE_MS = 2 * 60 * 1000;     // only used for a reply that arrived before this page loaded
const SETTLE_MS = 4000;             // quiet time after the reply / last image request
const GENERATING_LIMIT_MS = 5 * 60 * 1000;
const IMAGE_URL = /\/api\/plugins\/autopic\/|\/api\/sd\/|\/api\/novelai\/generate-image|\/api\/horde\/generate-image|\/api\/openai\/generate-image|\/api\/images\/upload/i;
const BLOCK = /<autopic\b[\s\S]*?<\/autopic>|&lt;autopic\b[\s\S]*?&lt;\/autopic&gt;/i;
const running = new Set();
let scheduled = 0;
let inflight = 0;
let lastActivity = 0;   // last time an image request started or ended
let lastReply = 0;      // last time the newest reply finished or was swiped
let generatingSince = 0;

function later() {
    setTimeout(scheduleRetry, SETTLE_MS + 200);
}

function watchFetch() {
    if (window.fetch?.pbxWatched) return;
    const original = window.fetch;
    const wrapped = function (input, init) {
        const url = typeof input === 'string' ? input : (input?.url || String(input || ''));
        const promise = original.call(window, input, init);
        if (!IMAGE_URL.test(url)) return promise;
        inflight++;
        lastActivity = Date.now();
        const done = () => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); later(); };
        promise.then(done, done);
        scheduleRetry();
        return promise;
    };
    wrapped.pbxWatched = true;
    window.fetch = wrapped;
}

/** True while the newest reply may still be streaming or getting its picture. */
function newestBusy(message) {
    const now = Date.now();
    if (generatingSince && now - generatingSince < GENERATING_LIMIT_MS) return true;
    if (inflight > 0) return true;
    if (now - Math.max(lastActivity, lastReply) < SETTLE_MS) return true;
    if (!lastReply) return now - (Date.parse(message.send_date) || 0) < GRACE_MS;
    return false;
}

function decode(text) {
    const area = document.createElement('textarea');
    area.innerHTML = String(text ?? '');
    return area.value;
}

function hasPicture(message) {
    const media = message.extra?.media;
    if (Array.isArray(media) && media.some(m => isUserImage(m?.url || ''))) return true;
    return /<img\b[^>]*src=["'][^"']*\/user\/images\//i.test(message.mes || '');
}

function needsRetry(message, mesId, chat) {
    if (!message || message.is_user || typeof message.mes !== 'string') return null;
    const match = message.mes.match(BLOCK);
    if (!match) return null;
    if (hasPicture(message)) return null;
    if (mesId === chat.length - 1 && newestBusy(message)) return null;
    return match[0];
}

function buttonFor(mes) {
    return mes.querySelector('.pbx-retry');
}

export function applyRetry() {
    scheduled = 0;
    const chat = ctx().chat || [];
    for (const mes of document.querySelectorAll('#chat .mes[mesid]')) {
        const mesId = Number(mes.getAttribute('mesid'));
        const block = needsRetry(chat[mesId], mesId, chat);
        let button = buttonFor(mes);
        if (!block) { button?.remove(); continue; }
        if (!button) {
            const anchor = mes.querySelector('.mes_text');
            if (!anchor) continue;
            button = document.createElement('div');
            button.className = 'pbx-retry';
            button.setAttribute('role', 'button');
            button.tabIndex = 0;
            anchor.after(button);
        }
        const text = running.has(mesId) ? '🎨 그리는 중…' : '🎨 그림이 안 그려졌어요 · 같은 태그로 다시 그리기';
        if (button.textContent !== text) button.textContent = text;
    }
}

function scheduleRetry() {
    if (scheduled) return;
    scheduled = setTimeout(applyRetry, 150);
}

async function retry(mesId) {
    const c = ctx();
    const chat = c.chat || [];
    const message = chat[mesId];
    const block = needsRetry(message, mesId, chat) || (message?.mes || '').match(BLOCK)?.[0];
    if (!block || running.has(mesId)) return;
    running.add(mesId);
    applyRetry();
    try {
        const src = await generateImage(decode(block));
        // The chat may have changed while drawing.
        if (ctx().chat !== chat || chat[mesId] !== message) { toastr.info('그림은 저장됐지만 채팅이 바뀌어서 붙이지 않았어요. 갤러리 관리 탭에서 볼 수 있어요.'); return; }
        const key = imageKey(src);
        message.extra ??= {};
        message.extra.autopic_images ??= {};
        message.extra.autopic_images[key] = decode(block);
        if (autopicSettings()?.insertType === 'replace') {
            // Same as AutoPic's "태그 치환": the picture takes the block's place in the text.
            const tag = `<img src="${src}" data-autopic-id="tag-pbx-${Date.now()}" title="AutoPic">`;
            message.mes = message.mes.replace(block, () => tag);
        } else {
            message.mes = message.mes.replace(block, '').trim();
            if (!Array.isArray(message.extra.media)) message.extra.media = [];
            message.extra.media.push({ url: src, type: 'image', title: 'AutoPic', source: 'generated' });
            message.extra.media_index = message.extra.media.length - 1;
            message.extra.media_display ??= 'gallery';
            message.extra.inline_image = true;
        }
        if (Array.isArray(message.swipes) && message.swipes[message.swipe_id ?? 0] !== undefined) {
            message.swipes[message.swipe_id ?? 0] = message.mes;
        }
        c.updateMessageBlock(mesId, message);
        const element = $(`#chat .mes[mesid="${mesId}"]`);
        element.find('.mes_media_wrapper').empty();
        c.appendMediaToMessage(message, element);
        await c.saveChat();
        toastr.success('그림을 그렸어요.');
    } catch (error) {
        toastr.error(error?.message || '그림을 그리지 못했어요.', '픽박스');
    } finally {
        running.delete(mesId);
        applyRetry();
    }
}

function onClick(event) {
    const button = event.target.closest?.('.pbx-retry');
    if (!button) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    const mes = button.closest('.mes[mesid]');
    if (mes) retry(Number(mes.getAttribute('mesid')));
}

export function initRetry() {
    watchFetch();
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onClick, true);
    const { eventSource, eventTypes } = ctx();
    for (const name of ['CHAT_CHANGED', 'MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], scheduleRetry);
    }
    const replied = () => { generatingSince = 0; lastReply = Date.now(); scheduleRetry(); later(); };
    if (eventTypes.GENERATION_STARTED) {
        eventSource.on(eventTypes.GENERATION_STARTED, (_type, _options, dryRun) => {
            if (dryRun) return;
            generatingSince = Date.now();
            scheduleRetry();
        });
    }
    for (const name of ['MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], replied);
    }
    if (eventTypes.MESSAGE_SWIPED) eventSource.on(eventTypes.MESSAGE_SWIPED, () => { lastReply = Date.now(); later(); });
    if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, () => { generatingSince = 0; });
    // Backup check in case an event is missed.
    setInterval(scheduleRetry, 10_000);
    scheduleRetry();
}
