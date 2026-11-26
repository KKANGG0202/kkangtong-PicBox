// A photo the character texted to the user: AutoPic drew it, and the picture's tags live in the message's saved data,
// not in its text, so the AI (and anything that reads what the AI reads) would not know what was sent.
// Only for texting replies (the 톡톡톡 script's [[톡 …]] tag): ordinary scene illustrations are not something the
// character sent. The notes go into the prompt as one extension prompt (other extensions that mirror the AI's
// context read it too); the saved chat itself is never changed.
import { getSettings, ctx, LOG } from './settings.js';
import { visibleWords } from './draw.js';

const KEY = 'picbox_sent_photos';
const IN_CHAT = 1, SYSTEM = 0;   // extension_prompt_types.IN_CHAT, extension_prompt_roles.SYSTEM
const LIMIT = 6;                 // the latest photos only
const TEXTING = /\[\[\s*(?:톡|talk|text)(?!\s*끝)(?!\s*end)(?:\s[^\]]*)?\]\]/i;

/** The current swipe's AutoPic picture prompts of one message. */
function pictureBlocks(message) {
    const extra = message?.extra || {};
    const blocks = Object.values(extra.autopic_images || {}).filter(text => typeof text === 'string' && text.trim());
    for (const record of Object.values(extra.autopic_image_slots || {})) if (record?.editText) blocks.push(String(record.editText));
    return [...new Set(blocks)];
}

/** A few words of the message, so the note can say which text the photo came with. */
function firstWords(text) {
    const plain = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
    return plain.length > 40 ? `${plain.slice(0, 40)}…` : plain;
}

function buildNote() {
    const c = ctx();
    const chat = c.chat || [];
    const user = String(c.name1 || 'the user');
    const lines = [];
    for (let i = chat.length - 1; i >= 0 && lines.length < LIMIT; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string' || !TEXTING.test(message.mes)) continue;
        const seen = pictureBlocks(message).map(visibleWords).filter(Boolean);
        if (!seen.length) continue;
        const who = String(message.name || c.name2 || 'The character');
        const with_ = firstWords(message.mes);
        lines.unshift(`- #${i}: ${who} sent ${user} ${seen.length > 1 ? `${seen.length} photos` : 'a photo'}${with_ ? ` with the text "${with_}"` : ''}. What can be seen: ${seen.join(' | ')}.`);
    }
    if (!lines.length) return '';
    return `[Photos sent in texting]\n${lines.join('\n')}\nThese photos are already in the chat as the sender's own photos; they are not new scenes, so never draw them again or reuse them for a new picture.`;
}

function update() {
    try {
        const c = ctx();
        const text = getSettings().sentNote === false ? '' : buildNote();
        c.setExtensionPrompt(KEY, text, IN_CHAT, 4, false, SYSTEM);
    } catch (error) {
        console.warn(LOG, 'sent-photo note', error);
    }
}

export function initSentNote() {
    const { eventSource } = ctx();
    const event_types = ctx().event_types || ctx().eventTypes;
    for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'GENERATION_STARTED']) {
        if (event_types?.[name]) eventSource.on(event_types[name], update);
    }
    update();
}
export { update as updateSentNote };
