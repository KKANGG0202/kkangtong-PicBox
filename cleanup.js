// Find images in a user/images folder that no chat references, and delete the chosen ones.
import { ctx, postJson, confirmPopup, escapeHtml, currentCharacter } from './settings.js';
import { listCharacterChats, loadCharacterChat, loadGroupChat, findReferences } from './collect.js';
import { renderGrid, exportItems, openViewer, setFavorite, isFavorite } from './grid.js';
import { forgetThumb } from './thumbs.js';

// Files newer than this may belong to a generation whose chat is not saved yet.
const RECENT_MS = 30 * 60 * 1000;

function fileTime(file) {
    const match = String(file).match(/(?:^|_)(1\d{12})(?:_|\.)/);
    return match ? Number(match[1]) : 0;
}

function sanitizeLikeServer(name) {
    return String(name || '').replace(/[\/\\?<>:*|"\u0000-\u001f]/g, '').replace(/^\.+$/, '').trim();
}

async function scanReferences(folder, fullScan, onProgress, isCancelled) {
    const c = ctx();
    const refs = new Set();
    findReferences(c.chat || [], refs); // unsaved in-memory state of the open chat

    const characters = (c.characters || []).filter(ch => ch?.avatar && (fullScan || sanitizeLikeServer(ch.name) === folder || ch.name === folder));
    const jobs = [];
    for (const character of characters) jobs.push({ type: 'char', character });
    if (fullScan) for (const group of c.groups || []) for (const id of group?.chats || []) jobs.push({ type: 'group', id });

    // Expand characters into chat files first so the progress bar is honest.
    const tasks = [];
    let listed = 0;
    for (const job of jobs) {
        if (isCancelled()) return null;
        if (job.type === 'group') { tasks.push(job); continue; }
        try {
            for (const file of await listCharacterChats(job.character.avatar)) tasks.push({ type: 'char', character: job.character, file });
        } catch { /* character without chats */ }
        onProgress(`채팅 목록 확인 중… ${++listed} / ${jobs.length}`);
    }

    let done = 0;
    let failed = 0;
    const worker = async () => {
        while (tasks.length) {
            if (isCancelled()) return;
            const task = tasks.shift();
            try {
                const messages = task.type === 'group' ? await loadGroupChat(task.id) : await loadCharacterChat(task.character, task.file);
                findReferences(messages, refs);
            } catch {
                failed++;
            }
            done++;
            onProgress(`채팅 검사 중… ${done} / ${done + tasks.length}`);
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (isCancelled()) return null;
    // Character cards (avatars, alternate greetings with inline images) can reference images too.
    for (const character of c.characters || []) findReferences(character?.data?.first_mes || character?.first_mes || '', refs);
    return { refs, failed };
}

/**
 * @param {HTMLElement} body
 * @param {{closeAll: () => void, setToolbar: (html: string, bind: (root: HTMLElement) => void) => void}} host
 * @returns {() => void}
 */
export { sanitizeLikeServer, fileTime };

export function renderCleanup(body, host, { folder: preferredFolder = '' } = {}) {
    let disposeGrid = () => {};
    let cancelled = false;
    let orphans = [];
    let folder = '';
    const selected = new Set();
    const character = currentCharacter();

    body.innerHTML = `
        <div class="pbx-clean">
            <div class="pbx-clean-row">
                <select class="pbx-select pbx-folder"><option>폴더 불러오는 중…</option></select>
                <label class="pbx-check-label"><input type="checkbox" class="pbx-full" checked><span>모든 채팅 검사 (안전, 느림)</span></label>
                <button title="검사" class="pbx-btn pbx-scan"><i class="fa-solid fa-magnifying-glass"></i><span>검사</span></button>
            </div>
            <small class="pbx-clean-note">어느 채팅에도 붙어 있지 않은 그림을 찾아요. 최근 30분 안에 만든 그림은 건너뛰어요. PC와 폰을 동기화하고 있다면, 다른 기기에서만 연 채팅에 붙은 그림도 여기 나올 수 있으니 꼭 확인하고 지워주세요.</small>
            <div class="pbx-clean-status"></div>
            <div class="pbx-clean-results"></div>
        </div>`;
    const $ = selector => body.querySelector(selector);
    const status = text => { $('.pbx-clean-status').textContent = text; };

    function updateToolbar() {
        if (!orphans.length) { host.setToolbar('', () => {}); return; }
        host.setToolbar(`
            <span class="pbx-count">안 쓰는 그림 ${orphans.length}장 · ${selected.size}장 선택</span>
            <span class="pbx-spacer"></span>
            <button class="pbx-btn pbx-all"><i class="fa-solid fa-check-double"></i><span>${selected.size === orphans.length ? '선택 해제' : '전체'}</span></button>
            <button title="백업 후 삭제" class="pbx-btn pbx-backup-del" ${selected.size ? '' : 'disabled'}><i class="fa-solid fa-file-zipper"></i><span>백업 후 삭제</span></button>
            <button title="삭제만" class="pbx-btn pbx-danger pbx-del" ${selected.size ? '' : 'disabled'}><i class="fa-solid fa-trash"></i><span>삭제만</span></button>`, root => {
            root.querySelector('.pbx-all').addEventListener('click', () => {
                if (selected.size === orphans.length) selected.clear();
                else orphans.forEach(item => selected.add(item.key));
                drawGrid();
            });
            root.querySelector('.pbx-backup-del').addEventListener('click', () => removeSelected(true));
            root.querySelector('.pbx-del').addEventListener('click', () => removeSelected(false));
        });
    }

    function drawGrid() {
        disposeGrid();
        disposeGrid = renderGrid($('.pbx-clean-results'), orphans, {
            selected,
            selectMode: () => true,
            onSelectChange: updateToolbar,
            onOpen: index => openViewer(orphans, index, { closeAll: host.closeAll }),
        });
        updateToolbar();
    }

    async function removeSelected(backup) {
        const targets = orphans.filter(item => selected.has(item.key));
        if (!targets.length) return;
        const ok = await confirmPopup(`<p>그림 <b>${targets.length}장</b>을 <b>영구 삭제</b>할까요?</p><p>되돌릴 수 없어요.${backup ? ' 먼저 ZIP 백업 파일을 내려받아요.' : ''}</p>`);
        if (!ok) return;
        if (backup && !(await exportItems(targets, '정리백업', { confirm: false }))) {
            toastr.warning('백업이 끝나지 않아서 삭제하지 않았어요.');
            return;
        }
        let removed = 0;
        for (const item of targets) {
            try {
                await postJson('/api/images/delete', { path: `user/images/${item.folder}/${item.file}` });
                removed++;
                selected.delete(item.key);
                if (isFavorite(item.key)) setFavorite(item, false);
                forgetThumb(item.url);
            } catch { /* keep it in the list */ }
        }
        orphans = orphans.filter(item => selected.has(item.key) || !targets.includes(item));
        toastr.success(`${removed}장을 삭제했어요.`);
        drawGrid();
    }

    async function scan() {
        folder = $('.pbx-folder').value;
        if (!folder) return;
        cancelled = false;
        selected.clear();
        orphans = [];
        disposeGrid();
        $('.pbx-clean-results').replaceChildren();
        updateToolbar();
        $('.pbx-scan').disabled = true;
        try {
            status('폴더 파일 확인 중…');
            const files = await postJson('/api/images/list', { folder });
            if (!Array.isArray(files)) throw new Error('list');
            const result = await scanReferences(folder, $('.pbx-full').checked, status, () => cancelled);
            if (!result) return;
            const now = Date.now();
            orphans = files
                .filter(file => !result.refs.has(`${folder}/${file}`))
                .filter(file => !(fileTime(file) && now - fileTime(file) < RECENT_MS))
                .map(file => {
                    const key = `/user/images/${folder}/${file}`;
                    return { key, url: key.split('/').map(part => encodeURIComponent(part)).join('/'), folder, file, mesId: null, prompt: '', charName: folder, chatFile: '', isCurrent: false, date: '' };
                });
            status(`${files.length}장 중 ${orphans.length}장이 어느 채팅에도 쓰이지 않아요.${result.failed ? ` (읽지 못한 채팅 ${result.failed}개가 있어서 결과가 정확하지 않을 수 있어요)` : ''}`);
            drawGrid();
        } catch (error) {
            status(`검사 실패: ${error?.message || error}`);
        } finally {
            $('.pbx-scan').disabled = false;
        }
    }

    $('.pbx-scan').addEventListener('click', scan);
    postJson('/api/images/folders', {}).then(folders => {
        const list = Array.isArray(folders) ? folders.sort((a, b) => a.localeCompare(b)) : [];
        const preferred = preferredFolder || (character ? sanitizeLikeServer(character.name) : '');
        $('.pbx-folder').innerHTML = list.map(name => `<option value="${escapeHtml(name)}" ${name === preferred ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    }).catch(() => status('폴더 목록을 불러오지 못했어요.'));

    return () => { cancelled = true; disposeGrid(); };
}
