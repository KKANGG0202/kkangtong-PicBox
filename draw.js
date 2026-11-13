// "픽박스로 그리기": draw a picture from the user's own request with AutoPic's settings.
import { ctx, currentCharacter, escapeHtml, getSettings } from './settings.js';
import { generateImage, asBlock, blockInstructions, characterLibrary } from './autopic.js';
import { imageKey } from './collect.js';

const CONTEXT_MESSAGES = 6;
let open = false;
// A window hidden while it is still drawing: reopening shows it again instead of a new one.
let hiddenSession = null;

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

/**
 * Note telling the AI what the photo shows (hidden in the chat view, read as text by the AI).
 * Inline images are not sent, so it carries the user's request, the scene tags and the
 * per-character details (pose, expression, clothing...). Looks and negative tags are left out.
 */
function photoNote(request, block) {
    const name = String(ctx().name1 || 'User');
    const text = String(block || '');
    const clean = value => String(value || '').replace(/--/g, '-').replace(/\s+/g, ' ').trim();
    const scene = detailTags(clean((text.match(/<scene>([\s\S]*?)<\/scene>/i) || [])[1])).join(', ');
    const people = [...text.matchAll(/<apchar\b([^>]*)>([\s\S]*?)<\/apchar>/gi)]
        .map(m => {
            const ref = (m[1].match(/(?:ref|name)\s*=\s*["']([^"']*)["']/i) || [])[1];
            const tags = detailTags(clean(m[2])).join(', ');
            return tags ? `${ref ? `${clean(ref)}: ` : ''}${tags}` : '';
        })
        .filter(Boolean);
    const parts = [];
    if (clean(request)) parts.push(`Request: ${clean(request)}`);
    if (scene) parts.push(`Scene: ${scene}`);
    if (people.length) parts.push(`Details: ${people.join(' / ')}`);
    return `<!-- ${name} sent a photo.${parts.length ? ` ${parts.join(' | ')}` : ''} -->`;
}

/**
 * Send the picture as the user's own chat message (e.g. a selfie in a phone-chat roleplay).
 * Text typed in the chat input goes with it, then the character replies.
 */
async function sendAsUserMessage(src, block, request, reply) {
    const c = ctx();
    const input = document.getElementById('send_textarea');
    const text = String(input?.value || '').trim();
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
    c.addOneMessage(message);
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    await c.saveChat();
    if (reply) {
        try { await c.generate('normal'); } catch (error) { console.warn('[PicBox] reply', error); }
    }
}

async function attachToLastReply(src, block) {
    const c = ctx();
    const chat = c.chat || [];
    let index = -1;
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i].is_user && !chat[i].is_system) { index = i; break; }
    if (index < 0) { toastr.info('붙일 답변이 없어서 새 메시지로 붙였어요.'); return attachAsNewMessage(src, block); }
    const message = chat[index];
    message.extra ??= {};
    if (!Array.isArray(message.extra.media)) message.extra.media = [];
    message.extra.media.push(mediaItem(src));
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.media_display ??= 'gallery';
    message.extra.inline_image = true;
    message.extra.autopic_images ??= {};
    message.extra.autopic_images[imageKey(src)] = block;
    const element = $(`#chat .mes[mesid="${index}"]`);
    element.find('.mes_media_wrapper').empty();
    c.appendMediaToMessage(message, element);
    await c.saveChat();
}

/** Remove pictures that were drawn but not put into the chat (re-rolls, closed window). */
async function discardUnused(sources) {
    let removed = 0;
    for (const src of sources) {
        try {
            const path = decodeURIComponent(src).replace(/^\//, '');
            const response = await fetch('/api/images/delete', {
                method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ path }),
            });
            if (response.ok || response.status === 404) removed++;
        } catch { /* leave it; the cleanup tab can find it later */ }
    }
    if (removed) toastr.info(`채팅에 붙이지 않은 그림 ${removed}장을 정리했어요.`, '픽박스', { timeOut: 2500 });
}

function markBusyButtons(on) {
    for (const id of ['pbx_float_btn', 'pbx_input_btn']) document.getElementById(id)?.classList.toggle('pbx-busy', on);
}

export function openDraw(initial = '', { forUser = false } = {}) {
    if (hiddenSession) { hiddenSession.show(); return; }
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
                <div class="pbx-chips pbx-modes">
                    <button class="pbx-chip active" data-mode="scene"><i class="fa-solid fa-comments"></i>지금 장면 반영</button>
                    <button class="pbx-chip" data-mode="plain"><i class="fa-solid fa-pen"></i>쓴 내용만</button>
                    <button class="pbx-chip" data-mode="tags"><i class="fa-solid fa-tags"></i>태그 그대로</button>
                </div>
                <small class="pbx-mode-note"></small>
                <small class="pbx-draft-note" hidden><i class="fa-solid fa-keyboard"></i> 입력창에 쓴 내용도 장면에 넣어서 그려요.</small>
                ${refs.length ? `<small class="pbx-refs">오토픽에 등록된 캐릭터: ${refs.map(escapeHtml).join(', ')}</small>` : ''}
                <div class="pbx-draw-row">
                    <span class="pbx-spacer"></span>
                    <button class="pbx-btn pbx-make"><i class="fa-solid fa-wand-magic-sparkles"></i><span>태그만 보기</span></button>
                    <button class="pbx-btn pbx-go"><i class="fa-solid fa-paintbrush"></i><span>바로 그리기</span></button>
                </div>
                <details class="pbx-block-box" hidden><summary>생성 프롬프트 (고쳐도 돼요)</summary><textarea class="pbx-area pbx-block" rows="7"></textarea></details>
                <div class="pbx-clean-status pbx-draw-status"></div>
                <div class="pbx-draw-result" hidden>
                    <img alt="">
                    <div class="pbx-draw-row">
                        <button class="pbx-btn pbx-again"><i class="fa-solid fa-rotate"></i><span>다시 그리기</span></button>
                        <span class="pbx-spacer"></span>
                        <button class="pbx-btn pbx-to-me ${forUser ? 'pbx-primary' : ''}" title="내 메시지로 보내고 답장 받기"><i class="fa-solid fa-paper-plane"></i><span>내 메시지로 보내기</span></button>
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
    let result = null; // { src, block }
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
        if (getSettings().drawAutoDelete) discardUnused(drawn.filter(src => !attached.has(src)));
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
            result = { src, block };
            drawn.push(src);
            $q('.pbx-draw-result img').src = src;
            $q('.pbx-draw-result').hidden = false;
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
        setBusy(true);
        try {
            const request = $q('.pbx-request').value.trim();
            attached.add(result.src);
            if (where === 'me') {
                destroy();
                await sendAsUserMessage(result.src, result.block, request, true);
                return;
            }
            if (where === 'last') await attachToLastReply(result.src, result.block);
            else await attachAsNewMessage(result.src, result.block);
            toastr.success('채팅에 붙였어요.');
            destroy();
        } catch (error) {
            status(`붙이지 못했어요: ${error?.message || error}`);
            setBusy(false);
        }
    }

    root.querySelectorAll('.pbx-modes .pbx-chip').forEach(chip => chip.addEventListener('click', () => setMode(chip.dataset.mode)));
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
    $q('.pbx-to-last').addEventListener('click', () => attach('last'));
    $q('.pbx-to-new').addEventListener('click', () => attach('new'));
    // A new request invalidates an old generated prompt.
    $q('.pbx-request').addEventListener('input', () => { $q('.pbx-block-box').hidden = true; $q('.pbx-block').value = ''; });
    document.addEventListener('keydown', onKey, true);
    setMode('scene');
    if (initial) $q('.pbx-request').value = initial;
    $q('.pbx-request').focus();
}
