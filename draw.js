// "픽박스로 그리기": draw a picture from the user's own request with AutoPic's settings.
import { ctx, currentCharacter, currentChatId, escapeHtml, getSettings, saveSettings, confirmPopup } from './settings.js';
import { generateImage, asBlock, blockInstructions, characterLibrary } from './autopic.js';
import { imageKey, findReferences, refKey } from './collect.js';
import { expandMessage } from './fold.js';
import { forgetThumb } from './thumbs.js';

const CONTEXT_MESSAGES = 6;
const MODES = ['scene', 'plain', 'tags'];
const PRESET_LIMIT = 30;
const HOLD_MS = 550;
const HOLD_MOVE_PX = 12;
// Pictures drawn but not yet put into the chat are remembered per chat (in the chat's metadata),
// so closing the window or reloading the page does not lose them.
const HISTORY_KEY = 'picbox_draw_history';
const HISTORY_LIMIT = 30;

/** origin = the chat picture whose prompt a redraw started from: { key, mesId }. */
function validOrigin(origin) {
    return !!origin && typeof origin.key === 'string' && origin.key.startsWith('/user/images/') && Number.isInteger(origin.mesId);
}

/**
 * Index of the message that holds the origin picture, or -1. Message numbers shift when
 * messages are deleted, so the stored number is only trusted while that message still has the picture.
 */
function findOriginMessage(origin) {
    if (!validOrigin(origin)) return -1;
    const chat = ctx().chat || [];
    const path = refKey(origin.key.replace(/^\/user\/images\//, ''));
    const holds = message => !!message && findReferences(message).has(path);
    if (holds(chat[origin.mesId])) return origin.mesId;
    for (let i = chat.length - 1; i >= 0; i--) if (holds(chat[i])) return i;
    return -1;
}

function loadHistory() {
    const list = ctx().chatMetadata?.[HISTORY_KEY];
    if (!Array.isArray(list)) return [];
    return list
        .filter(entry => entry && typeof entry.src === 'string' && entry.src)
        .map(entry => ({
            src: entry.src, block: String(entry.block || ''), request: String(entry.request || ''),
            ...(validOrigin(entry.origin) ? { origin: { key: entry.origin.key, mesId: entry.origin.mesId } } : {}),
        }));
}

function storeHistory(history) {
    const c = ctx();
    if (!c.chatMetadata) return;
    if (history.length) c.chatMetadata[HISTORY_KEY] = history.map(({ src, block, request, origin }) => ({ src, block, request, ...(origin ? { origin } : {}) }));
    else delete c.chatMetadata[HISTORY_KEY];
    // Older builds only expose saveMetadata.
    const save = c.saveMetadataDebounced ?? c.saveMetadata;
    if (typeof save === "function") save();
}

async function deleteFile(src) {
    try {
        const path = decodeURIComponent(src).replace(/^\//, '');
        const response = await fetch('/api/images/delete', {
            method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ path }),
        });
        if (response.ok || response.status === 404) {
            try { await forgetThumb(src); } catch { /* no cached preview */ }
            return true;
        }
    } catch { /* leave it; the cleanup tab can find it later */ }
    return false;
}
let open = false;
// A window hidden while it is still drawing: reopening shows it again instead of a new one.
let hiddenSession = null;
// Text typed into "같이 보낼 말" survives closing the window (until sent or the page reloads).
let sayDraft = { chat: '', text: '' };

/** Last few visible messages as plain text, for "scene" mode. */
function recentScene() {
    const chat = ctx().chat || [];
    return chat
        .filter(m => m && !m.is_system && typeof m.mes === 'string')
        .slice(-CONTEXT_MESSAGES)
        .map(m => `${m.name}: ${m.mes.replace(/<autopic\b[\s\S]*?<\/autopic>/gi, '').replace(/<[^>]+>/g, '').trim()}`)
        .join('\n\n');
}

/** What the user typed in the chat input but has not sent yet. */
function inputDraft() {
    return String(document.getElementById('send_textarea')?.value || '').trim();
}

/** The user's persona, so the user can appear in the picture with the right look. */
function personaBlock() {
    const c = ctx();
    let description = '';
    try { description = String(c.substituteParams('{{persona}}') || '').trim(); } catch { /* no persona */ }
    const name = String(c.name1 || '').trim();
    if (!name && !description) return '';
    return `<user_persona name="${name}">\n${description.slice(0, 1500)}\n</user_persona>\nIf the user (${name}) is visible, draw them as an unregistered character with an <apchar> block using this appearance.`;
}

/**
 * The character card, so characters that are not registered in AutoPic are still drawn
 * with their real look (AutoPic's own replies get this from the main chat prompt).
 */
function characterBlock() {
    const c = ctx();
    let description = '';
    try { description = String(c.substituteParams('{{description}}') || '').trim(); } catch { /* group or none */ }
    const name = String(c.name2 || currentCharacter()?.name || '').trim();
    if (!description) return '';
    return `<character name="${name}">\n${description.slice(0, 4000)}\n</character>\nUse this card for ${name}'s appearance when ${name} is not a registered AutoPic character.`;
}

async function toBlock(request, withScene) {
    const c = ctx();
    const draft = inputDraft();
    const scene = [
        `<recent_chat>\n${recentScene()}\n</recent_chat>`,
        draft ? `<user_next_action>\n${draft}\n</user_next_action>\nThis is what the user is about to do next (not sent yet). Include it in the picture.` : '',
        characterBlock(),
        personaBlock(),
    ].filter(Boolean).join('\n\n');
    const prompt = !withScene
        ? [characterBlock(), personaBlock(), `<picture_request>\n${request}\n</picture_request>`].filter(Boolean).join('\n\n')
        : request
            ? `${scene}\n\n<picture_request>\n${request}\n</picture_request>\n\nDraw the picture request as it would look at this point of the story.`
            : `${scene}\n\nDraw the most recent moment of this chat as a single illustration.`;
    const raw = await c.generateRaw({ systemPrompt: blockInstructions(), prompt });
    const text = String(raw || '');
    const match = text.match(/<autopic\b[\s\S]*?<\/autopic>/i);
    if (!match) throw new Error('태그를 만들지 못했어요. 다시 시도하거나 "태그 그대로"로 그려보세요.');
    return match[0].trim();
}

function mediaItem(src) {
    return { url: src, type: 'image', title: 'AutoPic', source: 'generated' };
}

/** Add the picture to the chat as its own message, hidden from the AI's context. */
async function attachAsNewMessage(src, block) {
    const c = ctx();
    const message = {
        name: '픽박스',
        is_user: false,
        is_system: true,
        send_date: new Date().toISOString(),
        mes: '',
        extra: {
            media: [mediaItem(src)],
            media_display: 'gallery',
            media_index: 0,
            inline_image: true,
            autopic_images: { [imageKey(src)]: block },
            picbox: true,
        },
    };
    c.chat.push(message);
    c.addOneMessage(message);
    await c.saveChat();
}

/** Add the picture to the latest character reply. */
// Permanent-looks tags: the character card already describes these, so the note leaves them out.
// Kept deliberately narrow so clothing like "short skirt" or "tank top" is never dropped.
const LOOKS = /\b(\d+\s*(?:girls?|boys?|others?)|solo|male|female|adult|teenager|\d+s|\d+\s*years?\s*old|tall|petite|slim|slender|muscular|chubby|plump|curvy|broad shoulders|beautiful|handsome|pretty|hair|bangs|ponytail|twintails|braids?|sidelocks|ahoge|eyes|eyebrows|eyelashes|pupils|iris|heterochromia|skin|pale|freckles|mole|lips|teeth|fang|canine tooth|animal ears|elf ears|pointy ears|beard|stubble)\b/i;

// Expressions that mention eyes or hair are details, not looks.
const KEEP = /closed eyes|eyes closed|half-closed|wide-eyed|wide eyes|teary|tears|rolling eyes|heart-shaped pupils|wink|messy hair|wet hair|hair down|hair up|tying hair|hand in (?:own )?hair|looking/i;

function detailTags(tags) {
    return tags.split(',').map(t => t.trim()).filter(t => t && (KEEP.test(t) || !LOOKS.test(t)));
}

// Picture-quality and style words say nothing about what is in the photo.
const STYLE = /^(?:masterpiece|best quality|high quality|amazing quality|good quality|normal quality|very aesthetic|aesthetic|absurdres|highres|incredibly absurdres|ultra[- ]detailed|very detailed|detailed|newest|official art|illustration|anime(?: style| coloring)?|realistic|photorealistic|score_\d+(?:_up)?|rating[:_ ]\w+|year \d+|artist:.*|\d+::.*|no text|watermark)$/i;

/** One tag as plain words: no weights, brackets or underscores. */
function plainTag(tag) {
    return String(tag || '').replace(/^-?\d+(?:\.\d+)?::|::$/g, '').replace(/[{}[\]()]/g, '').replace(/:\s*-?\d+(?:\.\d+)?$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What can be seen in the photo, in plain words: the scene, then each person in it (looks and quality words left out). */
export function visibleWords(block) {
    const text = String(block || '');
    const words = list => detailTags(list.split(',').map(plainTag).filter(t => t && !STYLE.test(t)).join(','));
    const parts = [];
    const scene = words((text.match(/<scene>([\s\S]*?)<\/scene>/i) || [])[1] || '');
    if (scene.length) parts.push(scene.slice(0, 12).join(', '));
    for (const m of text.matchAll(/<apchar(?:\s+ref\s*=\s*"([^"]*)")?[^>]*>([\s\S]*?)<\/apchar>/gi)) {
        const who = words(m[2]);
        if (who.length) parts.push(`${m[1] ? `${m[1]}: ` : ''}${who.slice(0, 14).join(', ')}`);
    }
    if (!parts.length && !/<scene>|<apchar/i.test(text)) {   // plain tags, not an <autopic> block
        const plain = words(text);
        if (plain.length) parts.push(plain.slice(0, 14).join(', '));
    }
    return parts.join('; ').replace(/--/g, '-');
}

/**
 * Note telling the AI what the photo shows (hidden in the chat view, read as text by the AI).
 * Inline images are not sent, so it says in plain words what the photo is and what can be seen in it
 * (outfit, pose, framing, what is showing), so the AI can react to it. Quality words and permanent looks
 * are left out, and the note says the photo is already in the chat and is not to be drawn again —
 * an earlier note that carried the raw tag list got copied into the next picture.
 */
function photoNote(request, block, who = '') {
    const name = String(who || ctx().name1 || 'User');
    const clean = value => String(value || '').replace(/--/g, '-').replace(/\s+/g, ' ').trim();
    const what = clean(request);
    const seen = visibleWords(block);
    return `<!-- ${name} sent a photo${what ? `: ${what}` : ''}.${seen ? ` What can be seen in it: ${seen}.` : ''} It is already in the chat as ${name}'s photo; it is not a new scene, so never draw it again or reuse it for a new picture. -->`;
}

/**
 * Send the picture as the user's own chat message (e.g. a selfie in a phone-chat roleplay).
 * `text` is what the user wrote in the window's "같이 보낼 말" box; then the character replies.
 * `prefilled` is the chat-input text that box started from: if it is still sitting in the
 * chat input it has now been sent, so the input is cleared.
 */
async function sendAsUserMessage(src, block, request, reply, text = '', prefilled = '') {
    const c = ctx();
    const input = document.getElementById('send_textarea');
    const message = {
        name: c.name1,
        is_user: true,
        send_date: new Date().toISOString(),
        mes: getSettings().photoNote === false ? text : `${text}${text ? '\n' : ''}${photoNote(request, block)}`,
        extra: {
            media: [mediaItem(src)],
            media_display: 'gallery',
            media_index: 0,
            inline_image: true,
            autopic_images: { [imageKey(src)]: block },
            picbox: true,
        },
    };
    c.chat.push(message);
    // Sent the way SillyTavern sends a typed message, so extensions that act on a sent message see this one too
    // (e.g. one that sends as an NPC sets its name and picture here, and the photo note then names the NPC).
    const id = c.chat.length - 1;
    try { await c.eventSource.emit(c.eventTypes.MESSAGE_SENT, id); } catch (error) { console.warn('[PicBox] sent', error); }
    if (message.name && message.name !== c.name1 && getSettings().photoNote !== false) {
        message.mes = `${text}${text ? '\n' : ''}${photoNote(request, block, message.name)}`;
    }
    c.addOneMessage(message);
    try { await c.eventSource.emit(c.eventTypes.USER_MESSAGE_RENDERED, id); } catch (error) { console.warn('[PicBox] rendered', error); }
    if (input && prefilled && String(input.value || '').trim() === prefilled) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await c.saveChat();
    if (reply) {
        try { await c.generate('normal'); } catch (error) { console.warn('[PicBox] reply', error); }
    }
}

async function attachToLastReply(src, block) {
    const chat = ctx().chat || [];
    let index = -1;
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i].is_user && !chat[i].is_system) { index = i; break; }
    if (index < 0) { toastr.info('붙일 답변이 없어서 새 메시지로 붙였어요.'); return attachAsNewMessage(src, block); }
    return attachToMessage(index, src, block);
}

/** Add the picture to the message at `index` as one more attached image. */
async function attachToMessage(index, src, block) {
    const c = ctx();
    const message = c.chat[index];
    message.extra ??= {};
    if (!Array.isArray(message.extra.media)) message.extra.media = [];
    message.extra.media.push(mediaItem(src));
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.media_display ??= 'gallery';
    message.extra.inline_image = true;
    message.extra.autopic_images ??= {};
    message.extra.autopic_images[imageKey(src)] = block;
    const element = $(`#chat .mes[mesid="${index}"]`);
    if (element.length) {
        element.find('.mes_media_wrapper').empty();
        c.appendMediaToMessage(message, element);
    }
    await c.saveChat();
}

/** Remove pictures that were drawn but not put into the chat (re-rolls, closed window). */
async function discardUnused(sources) {
    let removed = 0;
    for (const src of sources) if (await deleteFile(src)) removed++;
    if (removed) toastr.info(`채팅에 붙이지 않은 그림 ${removed}장을 정리했어요.`, '픽박스', { timeOut: 2500 });
}

function markBusyButtons(on) {
    for (const id of ['pbx_float_btn', 'pbx_input_btn']) document.getElementById(id)?.classList.toggle('pbx-busy', on);
}

export function openDraw(initial = '', { forUser = false, mode: startMode = 'scene', origin = null } = {}) {
    if (hiddenSession) {
        hiddenSession.show();
        if (initial) toastr.info('그리던 창이 있어서 그 창을 열었어요.', '픽박스', { timeOut: 2500 });
        return;
    }
    if (open) return;
    if (!ctx().chat?.length && !currentCharacter()) { toastr.info('채팅을 먼저 열어주세요.'); return; }
    open = true;
    const refs = characterLibrary().map(item => item.name).filter(Boolean);
    const root = document.createElement('div');
    root.id = 'pbx_draw';
    root.innerHTML = `
        <div class="pbx-draw-panel">
            <div class="pbx-head">
                <b class="pbx-title"><i class="fa-solid ${forUser ? 'fa-camera' : 'fa-palette'}"></i> ${forUser ? '그려서 내 메시지로 보내기' : '픽박스로 그리기'}</b>
                <span class="pbx-spacer"></span>
                <button class="pbx-btn pbx-icon pbx-x" title="닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="pbx-draw-body">
                <textarea class="pbx-area pbx-request" rows="3" placeholder="어떤 그림을 그릴까요? (지금 장면 반영은 비워둬도 돼요) 예) 짱돌이가 창가에서 커피를 내리는 모습"></textarea>
                <div class="pbx-chips pbx-presets"></div>
                <div class="pbx-chips pbx-modes">
                    <button class="pbx-chip active" data-mode="scene"><i class="fa-solid fa-comments"></i>지금 장면 반영</button>
                    <button class="pbx-chip" data-mode="plain"><i class="fa-solid fa-pen"></i>쓴 내용만</button>
                    <button class="pbx-chip" data-mode="tags"><i class="fa-solid fa-tags"></i>태그 그대로</button>
                </div>
                <small class="pbx-mode-note"></small>
                <small class="pbx-draft-note" hidden><i class="fa-solid fa-keyboard"></i> 입력창에 쓴 내용도 장면에 넣어서 그려요.</small>
                <div class="pbx-chips pbx-refchips" hidden></div>
                <div class="pbx-draw-row">
                    <span class="pbx-spacer"></span>
                    <button class="pbx-btn pbx-make"><i class="fa-solid fa-wand-magic-sparkles"></i><span>태그만 보기</span></button>
                    <button class="pbx-btn pbx-go"><i class="fa-solid fa-paintbrush"></i><span>바로 그리기</span></button>
                </div>
                <details class="pbx-block-box" hidden><summary>생성 프롬프트 (고쳐도 돼요)</summary><textarea class="pbx-area pbx-block" rows="7"></textarea></details>
                <div class="pbx-clean-status pbx-draw-status"></div>
                <div class="pbx-draw-result" hidden>
                    <img alt="">
                    <div class="pbx-history" hidden></div>
                    <textarea class="pbx-area pbx-say" rows="2" placeholder="같이 보낼 말 (내 메시지로 보낼 때 같이 나가요. 비워두면 사진만 보내요)"></textarea>
                    <div class="pbx-draw-row">
                        <button class="pbx-btn pbx-again"><i class="fa-solid fa-rotate"></i><span>다시 그리기</span></button>
                        <span class="pbx-spacer"></span>
                        <button class="pbx-btn pbx-to-me ${forUser ? 'pbx-primary' : ''}" title="내 메시지로 보내고 답장 받기"><i class="fa-solid fa-paper-plane"></i><span>내 메시지로 보내기</span></button>
                        <button class="pbx-btn pbx-to-origin" hidden title="이 프롬프트를 가져온 그림이 있던 메시지에 추가"><i class="fa-solid fa-turn-up"></i><span>원래 메시지에 붙이기</span></button>
                        <button class="pbx-btn pbx-to-last" title="캐릭터의 마지막 답변에 그림 추가"><i class="fa-solid fa-reply"></i><span>캐릭터 답변에 붙이기</span></button>
                        <button class="pbx-btn pbx-to-new" title="그림만 있는 메시지 (AI는 안 읽어요)"><i class="fa-solid fa-plus"></i><span>그림만 따로 붙이기</span></button>
                    </div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(root);
    const $q = selector => root.querySelector(selector);
    let mode = 'scene';
    let busy = false;
    let result = null; // the history entry shown in the result area: { src, block, request }
    // Pictures drawn in this chat and not sent yet, oldest first. Kept until sent or deleted.
    const history = loadHistory();
    const chatKey = String(currentChatId() ?? '');
    const inputAtOpen = inputDraft();
    // Pictures drawn in this window; the ones never attached are deleted on close.
    const drawn = [];
    const attached = new Set();

    const NOTES = {
        scene: '최근 대화를 참고해서 AI가 오토픽 태그를 만들어요. 비워두면 지금 장면을 그대로 그려요. 등록된 캐릭터 외형도 자동으로 들어가요.',
        plain: '대화는 보지 않고 쓴 내용만으로 AI가 태그를 만들어요.',
        tags: '쓴 내용을 그대로 NovelAI 태그로 써요. 영어 태그로 쓰거나 <autopic> 블록을 붙여넣으세요.',
    };
    const status = text => { $q('.pbx-draw-status').textContent = text; };
    const destroy = () => {
        open = false;
        hiddenSession = null;
        markBusyButtons(false);
        document.removeEventListener('keydown', onKey, true);
        root.remove();
        if (getSettings().drawAutoDelete) {
            const unused = [...new Set([...drawn, ...history.map(entry => entry.src)])].filter(src => !attached.has(src));
            history.length = 0;
            storeHistory(history);
            discardUnused(unused);
        }
    };
    // Closing while drawing only hides the window; the work continues and can be reopened.
    const close = () => {
        if (!busy) { destroy(); return; }
        root.style.display = 'none';
        hiddenSession = {
            show: () => {
                root.style.display = '';
                hiddenSession = null;
                markBusyButtons(false);
            },
        };
        markBusyButtons(true);
        toastr.info('그리는 중이에요. 다 되면 알려드릴게요. 📷 버튼으로 다시 열 수 있어요.', '픽박스', { timeOut: 3000 });
    };
    const isHidden = () => root.style.display === 'none';
    function onKey(event) {
        if (isHidden()) return;
        // A SillyTavern popup (preset name, delete confirm) is on top: Escape belongs to it.
        if (document.querySelector('dialog[open]')) return;
        if (event.key === 'Escape' && !event.target.closest?.('textarea')) { event.stopPropagation(); close(); }
    }
    function setMode(next) {
        mode = next;
        root.querySelectorAll('.pbx-modes .pbx-chip').forEach(chip => chip.classList.toggle('active', chip.dataset.mode === mode));
        $q('.pbx-mode-note').textContent = NOTES[mode];
        $q('.pbx-make').hidden = mode === 'tags';
        $q('.pbx-draft-note').hidden = !(mode === 'scene' && inputDraft());
    }
    function setBusy(value) {
        busy = value;
        root.querySelectorAll('.pbx-btn:not(.pbx-x)').forEach(button => { button.disabled = value; });
        root.classList.toggle('pbx-draw-busy', value);
    }

    // ----- history: thumbnails of the pictures drawn in this window -----
    /** `reveal: false` keeps the prompt box closed, so "바로 그리기" still starts from the request. */
    function showEntry(entry, { reveal = true } = {}) {
        result = entry;
        $q('.pbx-draw-result > img').src = entry.src;
        $q('.pbx-draw-result').hidden = false;
        $q('.pbx-block').value = entry.block;
        if (reveal) $q('.pbx-block-box').hidden = false;
        // With a picture on screen the mode explanation gives up its space (still the chips' tooltip).
        $q('.pbx-mode-note').hidden = true;
        $q('.pbx-to-origin').hidden = !entry.origin;
        drawHistory();
    }
    /** Take an entry out of the list (sent, deleted or its file is gone) and show a neighbour. */
    function dropEntry(entry) {
        const index = history.indexOf(entry);
        if (index < 0) return;
        history.splice(index, 1);
        storeHistory(history);
        if (entry !== result) { drawHistory(); return; }
        const next = history[Math.min(index, history.length - 1)];
        if (next) { showEntry(next); return; }
        result = null;
        $q('.pbx-draw-result').hidden = true;
        $q('.pbx-draw-result > img').removeAttribute('src');
        $q('.pbx-block-box').hidden = true;
        $q('.pbx-block').value = '';
        $q('.pbx-mode-note').hidden = false;
        drawHistory();
    }
    /** X on a thumbnail: only takes it off this list. The file stays (see "관리 → 안 쓰는 그림"). */
    function deleteEntry(entry) {
        if (busy) return;
        dropEntry(entry);
    }
    function drawHistory() {
        const strip = $q('.pbx-history');
        strip.hidden = history.length < 1;
        strip.replaceChildren(...history.map((entry, index) => {
            const item = document.createElement('div');
            item.className = `pbx-history-item${entry === result ? ' active' : ''}`;
            item.title = `${index + 1}번째 그림`;
            const img = document.createElement('img');
            img.alt = '';
            img.decoding = 'async';
            img.src = entry.src;
            // The file was removed elsewhere (cleanup tab, another device): forget it quietly.
            img.addEventListener('error', () => dropEntry(entry), { once: true });
            img.addEventListener('click', () => { if (!busy && entry !== result) showEntry(entry); });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'pbx-history-x';
            remove.title = '목록에서 빼기 (파일은 남아요)';
            remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            remove.addEventListener('click', event => { event.stopPropagation(); deleteEntry(entry); });
            item.append(img, remove);
            return item;
        }));
        strip.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // ----- presets: saved requests shared by every chat -----
    function applyPreset(preset) {
        if (busy) return;
        $q('.pbx-request').value = preset.text;
        $q('.pbx-block-box').hidden = true;
        $q('.pbx-block').value = '';
        setMode(MODES.includes(preset.mode) ? preset.mode : 'scene');
        status('');
    }
    async function savePreset() {
        if (busy) return;
        const text = $q('.pbx-request').value.trim();
        if (!text) { status('저장할 요청을 먼저 써주세요.'); return; }
        const presets = getSettings().drawPresets;
        if (presets.length >= PRESET_LIMIT) { toastr.info(`프리셋은 ${PRESET_LIMIT}개까지 저장할 수 있어요.`, '픽박스'); return; }
        const { Popup } = ctx();
        const suggested = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12);
        const answer = await Popup.show.input('프리셋 저장', '칩에 보일 이름을 정해주세요.', suggested);
        const name = String(answer || '').trim().slice(0, 20);
        if (!name) return;
        const same = presets.find(preset => preset.name === name);
        if (same) { same.text = text; same.mode = mode; }
        else presets.push({ name, text, mode });
        saveSettings();
        drawPresets();
        toastr.success(same ? `'${name}' 프리셋을 덮어썼어요.` : `'${name}' 프리셋을 저장했어요.`, '픽박스', { timeOut: 2000 });
    }
    async function removePreset(preset) {
        if (!(await confirmPopup(`<p>'${escapeHtml(preset.name)}' 프리셋을 지울까요?</p>`))) return;
        const presets = getSettings().drawPresets;
        const index = presets.indexOf(preset);
        if (index >= 0) presets.splice(index, 1);
        saveSettings();
        drawPresets();
    }
    function presetChip(preset) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'pbx-chip pbx-preset';
        chip.textContent = preset.name;
        chip.title = `${preset.text.slice(0, 200)}\n(길게 누르거나 우클릭하면 삭제)`;
        // Long press (touch) or right click (mouse) deletes; a plain tap applies the preset.
        let timer = 0;
        let origin = null;
        let held = false;
        const disarm = () => { clearTimeout(timer); timer = 0; origin = null; };
        chip.addEventListener('pointerdown', event => {
            held = false;
            if (event.pointerType === 'mouse') return;
            origin = { x: event.clientX, y: event.clientY };
            timer = setTimeout(() => { timer = 0; held = true; removePreset(preset); }, HOLD_MS);
        });
        chip.addEventListener('pointermove', event => {
            if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > HOLD_MOVE_PX) disarm();
        });
        chip.addEventListener('pointerup', disarm);
        chip.addEventListener('pointercancel', disarm);
        chip.addEventListener('pointerleave', disarm);
        chip.addEventListener('contextmenu', event => {
            event.preventDefault();
            disarm();
            if (held) return; // the long-press timer already asked
            held = true;
            removePreset(preset);
        });
        chip.addEventListener('click', () => {
            if (held) { held = false; return; }
            applyPreset(preset);
        });
        return chip;
    }
    function drawPresets() {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'pbx-chip pbx-preset-add';
        add.title = '지금 쓴 요청과 모드를 프리셋으로 저장';
        add.innerHTML = '<i class="fa-solid fa-plus"></i>저장';
        add.addEventListener('click', savePreset);
        $q('.pbx-presets').replaceChildren(...getSettings().drawPresets.map(presetChip), add);
    }

    async function makeBlock() {
        const request = $q('.pbx-request').value.trim();
        // "지금 장면 반영" may be left empty: it then draws the latest moment of the chat.
        if (!request && mode !== 'scene') { status('그릴 내용을 먼저 써주세요.'); return null; }
        if (mode === 'tags') return asBlock(request);
        status('AI가 태그를 만드는 중…');
        const block = await toBlock(request, mode === 'scene');
        $q('.pbx-block').value = block;
        $q('.pbx-block-box').hidden = false;
        $q('.pbx-block-box').open = true;
        status('');
        return block;
    }

    async function draw(useEdited) {
        if (busy) return;
        setBusy(true);
        try {
            let block = useEdited ? $q('.pbx-block').value.trim() : '';
            if (!block) block = await makeBlock();
            if (!block) return;
            block = asBlock(block);
            $q('.pbx-block').value = block;
            $q('.pbx-block-box').hidden = false;
            status('그리는 중… (보통 10~20초)');
            const src = await generateImage(block);
            const entry = { src, block, request: $q('.pbx-request').value.trim(), ...(validOrigin(origin) ? { origin: { key: origin.key, mesId: origin.mesId } } : {}) };
            drawn.push(src);
            history.push(entry);
            if (history.length > HISTORY_LIMIT) history.shift(); // the file itself stays in the folder
            storeHistory(history);
            showEntry(entry);
            status('');
            if (isHidden()) {
                markBusyButtons(false);
                toastr.success('그림이 완성됐어요. 눌러서 이어서 붙이기', '픽박스', {
                    timeOut: 15000, onclick: () => hiddenSession?.show(),
                });
            }
        } catch (error) {
            status(`실패: ${error?.message || error}`);
            if (isHidden()) {
                markBusyButtons(false);
                toastr.error(`그리지 못했어요: ${error?.message || error}`, '픽박스', { onclick: () => hiddenSession?.show() });
            }
        } finally {
            setBusy(false);
        }
    }

    async function attach(where) {
        if (!result || busy) return;
        const entry = result;
        setBusy(true);
        // Sent pictures leave the list; the others wait for next time.
        const markSent = () => {
            attached.add(entry.src);
            const at = history.indexOf(entry);
            if (at >= 0) { history.splice(at, 1); storeHistory(history); }
        };
        try {
            // The request that made the chosen picture, not whatever is in the box now.
            const request = entry.request;
            if (where === 'me') {
                const say = $q('.pbx-say').value.trim();
                sayDraft = { chat: '', text: '' };
                markSent();
                destroy();
                await sendAsUserMessage(entry.src, entry.block, request, true, say, inputAtOpen);
                return;
            }
            let message = '채팅에 붙였어요.';
            if (where === 'origin') {
                const index = findOriginMessage(entry.origin);
                if (index < 0) {
                    status('원래 메시지를 찾지 못했어요. 지워졌거나 그림이 빠진 것 같아요. 다른 버튼으로 붙여주세요.');
                    setBusy(false);
                    return;
                }
                await attachToMessage(index, entry.src, entry.block);
                try { expandMessage(index); } catch { /* folding is off */ }
                message = `#${index} 메시지에 붙였어요.`;
            } else if (where === 'last') await attachToLastReply(entry.src, entry.block);
            else await attachAsNewMessage(entry.src, entry.block);
            markSent();
            toastr.success(message);
            destroy();
        } catch (error) {
            status(`붙이지 못했어요: ${error?.message || error}`);
            setBusy(false);
        }
    }

    // ----- AutoPic's registered characters: tap a chip to put the name into the request -----
    function drawRefChips() {
        const box = $q('.pbx-refchips');
        box.hidden = !refs.length;
        if (!refs.length) return;
        const label = document.createElement('span');
        label.className = 'pbx-refs';
        label.textContent = '등록 캐릭터';
        box.replaceChildren(label, ...refs.map(name => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'pbx-chip pbx-refchip';
            chip.textContent = name;
            chip.title = '요청에 이름 넣기';
            chip.addEventListener('click', () => {
                if (busy) return;
                const area = $q('.pbx-request');
                const start = area.selectionStart ?? area.value.length;
                const end = area.selectionEnd ?? start;
                const before = area.value.slice(0, start);
                const after = area.value.slice(end);
                const lead = before && !/\s$/.test(before) ? ' ' : '';
                const tail = after && !/^\s/.test(after) ? ' ' : '';
                area.value = `${before}${lead}${name}${tail}${after}`;
                const caret = before.length + lead.length + name.length;
                try { area.setSelectionRange(caret, caret); } catch { /* not focusable yet */ }
                area.dispatchEvent(new Event('input', { bubbles: true }));
            });
            return chip;
        }));
    }

    root.querySelectorAll('.pbx-modes .pbx-chip').forEach(chip => {
        chip.title = NOTES[chip.dataset.mode];
        chip.addEventListener('click', () => setMode(chip.dataset.mode));
    });
    $q('.pbx-x').addEventListener('click', close);
    root.addEventListener('click', event => { if (event.target === root) close(); });
    $q('.pbx-make').addEventListener('click', async () => {
        if (busy) return;
        setBusy(true);
        try { await makeBlock(); } catch (error) { status(`실패: ${error?.message || error}`); } finally { setBusy(false); }
    });
    // "그리기" uses the shown prompt when there is one (so edits apply), otherwise makes it first.
    $q('.pbx-go').addEventListener('click', () => draw(!$q('.pbx-block-box').hidden));
    $q('.pbx-again').addEventListener('click', () => draw(true));
    $q('.pbx-to-me').addEventListener('click', () => attach('me'));
    $q('.pbx-to-origin').addEventListener('click', () => attach('origin'));
    $q('.pbx-to-last').addEventListener('click', () => attach('last'));
    $q('.pbx-to-new').addEventListener('click', () => attach('new'));
    // A new request invalidates an old generated prompt.
    $q('.pbx-request').addEventListener('input', () => { $q('.pbx-block-box').hidden = true; $q('.pbx-block').value = ''; });
    document.addEventListener('keydown', onKey, true);
    drawPresets();
    drawRefChips();
    // "같이 보낼 말": continue what was typed here before, otherwise start from the chat input.
    $q('.pbx-say').value = sayDraft.chat === chatKey && sayDraft.text ? sayDraft.text : inputAtOpen;
    $q('.pbx-say').addEventListener('input', () => { sayDraft = { chat: chatKey, text: $q('.pbx-say').value }; });
    if (history.length) showEntry(history[history.length - 1], { reveal: false });
    setMode(MODES.includes(startMode) ? startMode : 'scene');
    if (initial) $q('.pbx-request').value = initial;
    $q('.pbx-request').focus();
}
