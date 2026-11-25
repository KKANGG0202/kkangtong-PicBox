// A photo the character texted to the user: AutoPic drew it, and AutoPic keeps the picture's tags out of the
// message text, so on the next turn the AI no longer knows what it sent. Only for texting replies (the
// 톡톡톡 script's [[톡 …]] tag): ordinary scene illustrations are not something the character sent.
// The note goes only into the prompt being built (a copy of that message), never into the saved chat.
import { getSettings, ctx, LOG } from './settings.js';
import { visibleWords } from './draw.js';

const TEXTING = /\[\[\s*(?:톡|talk|text)(?!\s*끝)(?!\s*end)(?:\s[^\]]*)?\]\]/i;

/** The current swipe's AutoPic picture prompts of one message. */
function pictureBlocks(message) {
    const extra = message?.extra || {};
    const blocks = Object.values(extra.autopic_images || {}).filter(text => typeof text === 'string' && text.trim());
    for (const record of Object.values(extra.autopic_image_slots || {})) if (record?.editText) blocks.push(String(record.editText));
    return [...new Set(blocks)];
}

function sentNote(message, blocks) {
    const who = String(message.name || ctx().name2 || 'The character');
    const user = String(ctx().name1 || 'the user');
    const seen = blocks.map(visibleWords).filter(Boolean);
    const one = seen.length < 2;
    return `<!-- ${who} sent ${user} ${one ? 'a photo' : `${seen.length} photos`} in this text.${seen.length ? ` What can be seen in ${one ? 'it' : 'them'}: ${seen.join(' | ')}.` : ''} ${one ? 'It is' : 'They are'} already in the chat; not a new scene, so never draw ${one ? 'it' : 'them'} again or reuse ${one ? 'it' : 'them'} for a new picture. -->`;
}

globalThis.picboxInterceptor = async function (chat) {
    try {
        if (getSettings().sentNote === false || !Array.isArray(chat)) return;
        for (let i = 0; i < chat.length; i++) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system || typeof message.mes !== 'string' || !TEXTING.test(message.mes)) continue;
            const blocks = pictureBlocks(message);
            if (!blocks.length) continue;
            chat[i] = { ...message, mes: `${message.mes}\n${sentNote(message, blocks)}` };   // a copy: the saved message stays as it is
        }
    } catch (error) {
        console.warn(LOG, 'sent-photo note', error);
    }
};
