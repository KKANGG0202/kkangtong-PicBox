// Collect user images (ST media, AutoPic inline / tag / slot images) from chat messages.
import { postJson } from './settings.js';

export function imageKey(src) {
    try { return decodeURIComponent(new URL(src, location.origin).pathname); }
    catch { return String(src || ''); }
}

export function isUserImage(src) {
    return /^\/user\/images\/[^/]+\/.+/.test(imageKey(src));
}

/** "/user/images/<folder>/<file>" → { folder, file } */
export function splitKey(key) {
    const rest = key.replace(/^\/user\/images\//, '');
    const slash = rest.indexOf('/');
    return slash < 0 ? { folder: '', file: rest } : { folder: rest.slice(0, slash), file: rest.slice(slash + 1) };
}

function decodeEntities(text) {
    return String(text).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const IMG_SRC = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi;

/** Plain text of a message for the story view: no AutoPic blocks, no HTML, no code. */
export function messageExcerpt(text, limit = 2000) {
    let plain = String(text || '')
        .replace(/<autopic\b[\s\S]*?<\/autopic>/gi, ' ')
        .replace(/&lt;autopic\b[\s\S]*?&lt;\/autopic&gt;/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n\n')
        .trim();
    plain = decodeEntities(plain.replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    return plain.length > limit ? `${plain.slice(0, limit).trimEnd()}…` : plain;
}

let measureHost = null;

/**
 * The message text exactly as it shows on screen (translation, regex and theme hiding applied).
 * Current chat: read the rendered message. Other chats: render it the same way ST does, off screen.
 */
export function visibleText(item) {
    if (typeof item._visible === 'string') return item._visible;
    let text = null;
    try {
        if (item.isCurrent && Number.isInteger(item.mesId)) {
            const el = document.querySelector(`#chat .mes[mesid="${item.mesId}"] .mes_text`);
            if (el) text = el.innerText;
        }
        const format = SillyTavern.getContext().messageFormatting;
        if (text === null && typeof item.raw === 'string' && typeof format === 'function') {
            if (!measureHost) {
                measureHost = document.createElement('div');
                measureHost.id = 'pbx_measure';
                measureHost.setAttribute('aria-hidden', 'true');
                measureHost.style.cssText = 'position:absolute;left:-100000px;top:0;width:640px;pointer-events:none;';
                measureHost.innerHTML = `<div class="mes"><div class="mes_block"><div class="mes_text"></div></div></div>`;
            }
            document.body.appendChild(measureHost);
            const box = measureHost.querySelector('.mes_text');
            box.innerHTML = format(item.raw, item.speaker || '', false, !!item.isUser, item.mesId);
            text = box.innerText;
            box.replaceChildren();
            measureHost.remove();
        }
    } catch (error) {
        console.warn('[PicBox] visible text', error);
    }
    if (text === null) return item.excerpt || '';
    item._visible = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return item._visible;
}

/** Drop the chat header line returned by the chats API. */
export function stripHeader(messages) {
    if (!Array.isArray(messages)) return [];
    if (messages.length && messages[0] && !('mes' in messages[0]) && ('chat_metadata' in messages[0] || 'user_name' in messages[0])) {
        return messages.slice(1);
    }
    return messages;
}

/**
 * @param {object[]} messages chat messages without the header
 * @param {{chatFile?: string, charName?: string, avatar?: string, isCurrent?: boolean}} meta
 */
export function collectImages(messages, meta = {}) {
    const items = [];
    const seen = new Map();

    messages.forEach((message, mesId) => {
        if (!message || typeof message !== 'object') return;
        const extras = [message.extra, ...(message.swipe_info || []).map(info => info?.extra)].filter(Boolean);
        const prompts = {};
        const urls = [];

        for (const extra of extras) {
            for (const [key, text] of Object.entries(extra.autopic_images || {})) {
                if (typeof text === 'string' && text && !prompts[key]) prompts[key] = text;
            }
            for (const record of Object.values(extra.autopic_image_slots || {})) {
                if (record?.src) {
                    urls.push(record.src);
                    const key = imageKey(record.src);
                    if (record.editText && !prompts[key]) prompts[key] = record.editText;
                }
            }
            for (const media of Array.isArray(extra.media) ? extra.media : []) {
                if (media?.url && (!media.type || media.type === 'image')) urls.push(media.url);
            }
            if (Array.isArray(extra.image_swipes)) urls.push(...extra.image_swipes);
            if (typeof extra.image === 'string') urls.push(extra.image);
        }
        for (const text of [message.mes, ...(message.swipes || [])]) {
            if (typeof text !== 'string' || !text.includes('<img')) continue;
            for (const match of text.matchAll(IMG_SRC)) urls.push(decodeEntities(match[1]));
        }

        for (const raw of urls) {
            if (typeof raw !== 'string' || !isUserImage(raw)) continue;
            const key = imageKey(raw);
            const prompt = prompts[key] || '';
            if (seen.has(key)) {
                const existing = seen.get(key);
                if (!existing.prompt && prompt) existing.prompt = prompt;
                continue;
            }
            const { folder, file } = splitKey(key);
            const item = {
                key,
                url: key.split('/').map(part => encodeURIComponent(part)).join('/'),
                folder,
                file,
                mesId,
                prompt,
                // Chat Translation keeps the translated text in extra.display_text.
                excerpt: messageExcerpt(message.extra?.display_text || message.mes),
                raw: message.extra?.display_text || message.mes || '',
                isUser: !!message.is_user,
                speaker: message.name || '',
                date: message.send_date || '',
                chatFile: meta.chatFile || '',
                charName: meta.charName || folder,
                avatar: meta.avatar || '',
                isCurrent: !!meta.isCurrent,
            };
            seen.set(key, item);
            items.push(item);
        }
    });
    return items;
}

/** All chat file names (without .jsonl) of a character. */
export async function listCharacterChats(avatar) {
    const list = await postJson('/api/characters/chats', { avatar_url: avatar, simple: true });
    if (!Array.isArray(list)) return [];
    return list.map(item => String(item.file_name || item.file_id || '').replace(/\.jsonl$/, '')).filter(Boolean);
}

export async function loadCharacterChat(character, fileName) {
    const data = await postJson('/api/chats/get', { ch_name: character.name, file_name: fileName, avatar_url: character.avatar });
    return stripHeader(Array.isArray(data) ? data : []);
}

export async function loadGroupChat(id) {
    const data = await postJson('/api/chats/group/get', { id });
    return stripHeader(Array.isArray(data) ? data : []);
}

/** Every "/user/images/<folder>/<file>" reference inside any JSON-able value. */
export function findReferences(value, into = new Set()) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const match of text.matchAll(/user\/images\/([^"'\\<>)\]]+)/g)) {
        let path = match[1];
        try { path = decodeURIComponent(path); } catch { /* keep raw */ }
        into.add(path.split(/[?#]/)[0].trim());
    }
    return into;
}

/** A sortable time for an item: AutoPic file timestamp, else the message date. */
export function itemTime(item) {
    const stamp = item.file.match(/(?:^|_)(1\d{12})(?:_|\.)/);
    if (stamp) return Number(stamp[1]);
    const parsed = Date.parse(item.date);
    return Number.isFinite(parsed) ? parsed : 0;
}
