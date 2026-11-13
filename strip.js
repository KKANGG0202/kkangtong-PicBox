// "태그 정리": remove leftover <autopic> prompt blocks from chat text in one go; the pictures stay.
// Blocks that live inside an <img> tag (AutoPic inline images) are left alone so images never break.
import { ctx, getSettings, postJson, confirmPopup, downloadBlob, currentCharacter, currentChatId, LOG } from './settings.js';
import { listCharacterChats, stripHeader } from './collect.js';

const BLOCK = /<autopic\b[^>]*>[\s\S]*?<\/autopic>|&lt;autopic\b[\s\S]*?&lt;\/autopic&gt;/gi;
// The hidden photo note PicBox adds to "내 메시지로 보내기" messages.
const NOTE = /<!--[^]*? sent a photo\.[^]*?-->|&lt;!--[^]*? sent a photo\.[^]*?--&gt;/g;

/** Text without its <autopic> blocks; each removed block is pushed to `found`. */
export function stripText(text, found, notes = false) {
    if (typeof text !== 'string') return text;
    const hasBlock = /autopic/i.test(text);
    const hasNote = notes && /sent a photo\./.test(text);
    if (!hasBlock && !hasNote) return text;
    let removed = 0;
    let out = text;
    if (hasNote) out = out.replace(NOTE, match => { found.push(match); removed++; return ''; });
    out = out.replace(BLOCK, (match, offset, whole) => {
        const before = whole.slice(0, offset);
        if (before.lastIndexOf('<img') > before.lastIndexOf('>')) return match;
        found.push(match);
        removed++;
        return '';
    });
    if (!removed) return text;
    return out.replace(/(?:\s|<br\s*\/?>)+$/i, '').replace(/\n{3,}/g, '\n\n');
}

/** Strip one message (text, swipes and translations) in place. Returns the removed blocks. */
export function stripMessage(message, notes = false) {
    const found = [];
    if (!message || typeof message !== 'object') return found;
    message.mes = stripText(message.mes, found, notes);
    if (Array.isArray(message.swipes)) {
        const swipeFound = [];
        message.swipes = message.swipes.map(text => stripText(text, swipeFound, notes));
        // The shown swipe is usually the same text as mes: count each block once.
        for (const block of swipeFound) if (!found.includes(block)) found.push(block);
    }
    const extras = [message.extra, ...(message.swipe_info || []).map(info => info?.extra)].filter(Boolean);
    for (const extra of extras) {
        if (typeof extra.display_text === 'string') extra.display_text = stripText(extra.display_text, [], notes);
    }
    return found;
}

function countBlocks(message, notes = false) {
    const texts = [message?.mes, ...(message?.swipes || [])];
    let n = 0;
    for (const text of texts) {
        if (typeof text !== 'string') continue;
        const found = [];
        stripText(text, found, notes);
        n = Math.max(n, found.length);
    }
    return n;
}

/** Auto mode: after the user sends a message, clean every earlier message of the open chat. */
export function initStrip() {
    const { eventSource, eventTypes } = ctx();
    if (!eventTypes?.MESSAGE_SENT) return;
    eventSource.on(eventTypes.MESSAGE_SENT, async () => {
        if (!getSettings().autoStripTags) return;
        try {
            const c = ctx();
            const chat = c.chat || [];
            let changed = 0;
            for (let i = 0; i < chat.length - 1; i++) {
                if (!countBlocks(chat[i])) continue;
                if (stripMessage(chat[i]).length) {
                    changed++;
                    try { c.updateMessageBlock(i, chat[i]); } catch { /* not rendered */ }
                }
            }
            if (changed) await c.saveChat();
        } catch (error) {
            console.warn(LOG, 'auto strip', error);
        }
    });
}

async function loadRaw(character, fileName) {
    const data = await postJson('/api/chats/get', { ch_name: character.name, file_name: fileName, avatar_url: character.avatar });
    const list = Array.isArray(data) ? data : [];
    const messages = stripHeader(list);
    const header = list.length > messages.length ? list[0] : null;
    return { header, messages };
}

export function renderStrip(container) {
    let cancelled = false;
    let running = false;
    const character = currentCharacter();
    container.innerHTML = `
        <div class="pbx-card-box">
            <div class="pbx-chips pbx-strip-scope">
                <button class="pbx-chip active" data-scope="chat">지금 채팅</button>
                <button class="pbx-chip" data-scope="all" ${character ? '' : 'disabled'}>이 캐릭터 모든 채팅</button>
            </div>
            <label class="pbx-check-label"><input type="checkbox" class="pbx-strip-notes"><span>내가 보낸 사진 메모도 같이 지우기</span></label>
            <label class="pbx-check-label"><input type="checkbox" class="pbx-strip-backup" checked><span>지우기 전에 태그를 txt 파일로 저장하기</span></label>
            <div class="pbx-clean-row">
                <button class="pbx-btn pbx-strip-run"><i class="fa-solid fa-eraser"></i><span>태그 찾아서 지우기</span></button>
                <span class="pbx-clean-status"></span>
            </div>
            <small class="pbx-clean-note">메시지 글 안에 남아 있는 &lt;autopic&gt; 태그 글을 한 번에 지워요. 그림은 그대로 남아요. AI가 매번 읽던 태그 글이 빠져서 토큰이 줄어요.<br>
            사진 메모를 지우면 AI가 그 사진 내용을 잊어요. 지운 태그로는 "다시 그리기"를 할 수 없어요. 매번 지우기 귀찮으면 관리 → 설정에서 자동 지우기를 켤 수 있어요.</small>
        </div>`;
    const status = text => { container.querySelector('.pbx-clean-status').textContent = text; };
    let scope = 'chat';
    container.querySelectorAll('.pbx-strip-scope .pbx-chip').forEach(chip => chip.addEventListener('click', () => {
        if (chip.disabled || running) return;
        scope = chip.dataset.scope;
        container.querySelectorAll('.pbx-strip-scope .pbx-chip').forEach(c => c.classList.toggle('active', c === chip));
    }));

    container.querySelector('.pbx-strip-run').addEventListener('click', async () => {
        if (running) return;
        running = true;
        try {
            const c = ctx();
            const current = currentChatId();
            const notes = !!container.querySelector('.pbx-strip-notes')?.checked;
            // 1) Find: count blocks first so the user sees what will go.
            const targets = [];
            const live = c.chat || [];
            const liveCount = live.reduce((n, m) => n + countBlocks(m, notes), 0);
            if (liveCount) targets.push({ file: current, live: true, count: liveCount });
            if (scope === 'all' && character) {
                const files = (await listCharacterChats(character.avatar)).filter(f => f !== current);
                for (let i = 0; i < files.length; i++) {
                    if (cancelled) return;
                    status(`채팅 살펴보는 중… ${i + 1} / ${files.length}`);
                    try {
                        const raw = await loadRaw(character, files[i]);
                        const count = raw.messages.reduce((n, m) => n + countBlocks(m, notes), 0);
                        if (count) targets.push({ file: files[i], raw, count });
                    } catch { /* unreadable chat */ }
                }
            }
            const total = targets.reduce((n, t) => n + t.count, 0);
            if (!total) { status('지울 태그가 없어요.'); return; }
            status('');
            const ok = await confirmPopup(`<h3>${notes ? '태그·메모' : '태그'} ${total}개를 지울까요?</h3><p>${targets.length}개 채팅에서 찾았어요. 그림은 그대로 남지만, 지운 태그는 되돌릴 수 없어요.</p>`);
            if (!ok) return;

            // 2) Strip and save.
            const backup = [];
            let failed = 0;
            for (let i = 0; i < targets.length; i++) {
                if (cancelled) return;
                const target = targets[i];
                status(`지우는 중… ${i + 1} / ${targets.length}`);
                const messages = target.live ? (ctx().chat || []) : target.raw.messages;
                messages.forEach((message, mesId) => {
                    if (!countBlocks(message, notes)) return;
                    const found = stripMessage(message, notes);
                    found.forEach(block => backup.push(`# ${target.file} #${mesId}\n${block}`));
                    if (target.live && found.length) {
                        try { ctx().updateMessageBlock(mesId, message); } catch { /* not rendered */ }
                    }
                });
                try {
                    if (target.live) {
                        await ctx().saveChat();
                    } else {
                        const chat = target.raw.header ? [target.raw.header, ...messages] : messages;
                        await postJson('/api/chats/save', { ch_name: character.name, file_name: target.file, chat, avatar_url: character.avatar, force: false });
                    }
                } catch (error) {
                    failed++;
                    console.warn(LOG, 'strip save', target.file, error);
                }
            }
            if (container.querySelector('.pbx-strip-backup')?.checked && backup.length) {
                const name = `${(character?.name || 'chat').replace(/[\\/:*?"<>|]/g, '_')}_autopic_tags.txt`;
                downloadBlob(new Blob([backup.join('\n\n')], { type: 'text/plain' }), name);
            }
            status(failed ? `${notes ? '태그·메모' : '태그'} ${total}개를 지웠어요. 채팅 ${failed}개는 저장하지 못했어요.` : `${notes ? '태그·메모' : '태그'} ${total}개를 지웠어요.`);
            toastr.success(`${notes ? '태그·메모' : '태그'} ${total}개를 지웠어요.`);
        } catch (error) {
            console.error(LOG, error);
            status(`실패했어요: ${error.message || error}`);
        } finally {
            running = false;
        }
    });
    return () => { cancelled = true; };
}
