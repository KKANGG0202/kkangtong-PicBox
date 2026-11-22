// Gallery window: this chat, any character, favorites (with folders) and the manage tab.
import { ctx, currentChatId, currentCharacter, DISPLAY_NAME, escapeHtml, confirmPopup, postJson, runPool } from './settings.js';
import { sanitizeLikeServer } from './cleanup.js';
import { collectImages, listCharacterChats, loadCharacterChat, itemTime } from './collect.js';
import { renderGrid, openViewer, exportItems, favoriteItems, setFavorite, favFolders, removeFavFolder, setInFolder, openFolderPicker, deleteItems } from './grid.js';
import { renderManage } from './manage.js';
import { renderStory } from './story.js';

const TABS = [
    { id: 'chat', label: '이 채팅', icon: 'fa-comment' },
    { id: 'char', label: '캐릭터별', icon: 'fa-user' },
    { id: 'fav', label: '즐겨찾기', icon: 'fa-star' },
    { id: 'manage', label: '관리', icon: 'fa-screwdriver-wrench' },
];
const NO_FOLDER = '__pbx_none__';

let state = null;
// Loaded character galleries are kept while the window is open (keyed by avatar).
const charCache = new Map();

const byNewest = items => items.sort((a, b) => itemTime(b) - itemTime(a) || (b.mesId ?? 0) - (a.mesId ?? 0));

function currentChatItems() {
    const character = currentCharacter();
    return collectImages(ctx().chat || [], {
        chatFile: currentChatId(), charName: character?.name, avatar: character?.avatar, isCurrent: true,
    });
}

// Image count per user/images folder, loaded once per opened window.
let folderCounts = null;
async function loadFolderCounts() {
    if (folderCounts) return folderCounts;
    const counts = new Map();
    try {
        const folders = await postJson('/api/images/folders', {});
        await runPool(Array.isArray(folders) ? folders : [], 6, async folder => {
            try {
                const files = await postJson('/api/images/list', { folder });
                if (Array.isArray(files) && files.length) counts.set(folder, files.length);
            } catch { /* unreadable folder */ }
        });
    } catch { /* fall back to showing everyone */ }
    folderCounts = counts;
    return counts;
}

const SHOW_ALL = '__pbx_all__';

/**
 * Characters for the picker, one entry per character NAME. Cards that share a name
 * (copies, sync-conflict duplicates) also share one image folder, so they are merged.
 * The option value (`avatar` field) is the name. By default only names with pictures are listed.
 */
function characterOptions() {
    const groups = new Map();
    for (const ch of ctx().characters || []) {
        if (!ch?.avatar || !ch?.name) continue;
        if (!groups.has(ch.name)) groups.set(ch.name, []);
        groups.get(ch.name).push(ch);
    }
    const current = currentCharacter()?.name;
    const imageCount = name => folderCounts?.get(sanitizeLikeServer(name)) || folderCounts?.get(name) || 0;
    const filtering = folderCounts && folderCounts.size && !state?.showAllChars;
    return [...groups.entries()]
        .filter(([name]) => !filtering || imageCount(name) > 0 || name === state?.charAvatar)
        .map(([name, cards]) => {
            const n = imageCount(name);
            const copies = cards.length > 1 ? ` (카드 ${cards.length}개)` : '';
            // n counts the files in the folder. Once this character's chats are loaded the label
            // shows what the gallery shows; leftovers get their own button (see leftoverFor).
            const loaded = charCache.get(name);
            const shown = loaded ? loaded.length : n;
            return { avatar: name, name, count: n, label: `${name}${shown ? ` · ${shown}장` : ''}${copies}` };
        })
        .sort((a, b) => (b.avatar === current) - (a.avatar === current) || a.name.localeCompare(b.name));
}

/** All chats of every card with this name. */
async function characterItems(name, onProgress, isStale) {
    const cards = (ctx().characters || []).filter(ch => ch?.avatar && ch.name === name);
    if (!cards.length) return null;
    const current = currentChatId();
    const openAvatar = currentCharacter()?.avatar;
    const jobs = [];
    for (const card of cards) {
        if (isStale()) return null;
        try {
            for (const file of await listCharacterChats(card.avatar)) jobs.push({ card, file });
        } catch { /* card without chats */ }
    }
    const all = [];
    for (let i = 0; i < jobs.length; i++) {
        if (isStale()) return null;
        onProgress(`채팅 불러오는 중… ${i + 1} / ${jobs.length}`);
        const { card, file } = jobs[i];
        const isCurrent = card.avatar === openAvatar && file === current;
        try {
            // The open chat is read from memory so unsaved changes show up.
            const messages = isCurrent ? (ctx().chat || []) : await loadCharacterChat(card, file);
            all.push(...collectImages(messages, { chatFile: file, charName: card.name, avatar: card.avatar, isCurrent }));
        } catch { /* skip unreadable chat */ }
    }
    // The same image can appear in a chat and in its sync-conflict copy: keep one.
    const seen = new Set();
    return all.filter(item => !seen.has(item.key) && seen.add(item.key));
}

/** "blonde hair, office, -nsfw": every term must appear in the prompt, "-term" must not. */
function matchesQuery(item, query) {
    const terms = String(query || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (!terms.length) return true;
    const text = `${item.prompt || ''}\n${item.file || ''}`.toLowerCase();
    return terms.every(term => term.startsWith('-') ? !text.includes(term.slice(1).trim()) : text.includes(term));
}

export function closeGallery() {
    if (!state) return;
    state.dispose();
    document.removeEventListener('keydown', state.onKey, true);
    state.root.remove();
    document.getElementById('pbx_viewer')?.remove();
    state = null;
    charCache.clear();
    folderCounts = null;
}

export function openGallery(tab = 'chat') {
    closeGallery();
    const root = document.createElement('div');
    root.id = 'pbx_overlay';
    root.innerHTML = `
        <div class="pbx-panel">
            <div class="pbx-head">
                <b class="pbx-title"><i class="fa-solid fa-images"></i> ${DISPLAY_NAME}</b>
                <div class="pbx-tabs">${TABS.map(t => `<button class="pbx-tab" data-tab="${t.id}"><i class="fa-solid ${t.icon}"></i><span>${t.label}</span><em class="pbx-badge"></em></button>`).join('')}</div>
                <button class="pbx-btn pbx-icon pbx-x" title="닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="pbx-toolbar" hidden></div>
            <div class="pbx-subbar" hidden>
                <div class="pbx-search"><i class="fa-solid fa-magnifying-glass"></i><input class="pbx-input pbx-q" placeholder="프롬프트 검색 (쉼표로 여러 개, -빼기)"><button class="pbx-btn pbx-icon pbx-q-clear" title="지우기" hidden><i class="fa-solid fa-xmark"></i></button></div>
                <div class="pbx-chips" hidden></div>
            </div>
            <div class="pbx-body"></div>
        </div>`;
    document.body.appendChild(root);

    state = {
        root,
        tab: null,
        all: [],
        items: [],
        query: '',
        view: 'grid',
        favFolder: '',
        charAvatar: currentCharacter()?.name || '',
        showAllChars: false,
        selectMode: false,
        selected: new Set(),
        token: 0,
        dispose: () => {},
        onKey: event => {
            if (event.key !== 'Escape' || event.target?.closest?.('input')) return;
            if (!document.getElementById('pbx_viewer') && !document.querySelector('dialog[open]') && !document.querySelector('.pbx-folder-pop')) closeGallery();
        },
    };
    document.addEventListener('keydown', state.onKey, true);
    root.addEventListener('click', event => { if (event.target === root) closeGallery(); });
    root.querySelector('.pbx-x').addEventListener('click', closeGallery);
    root.querySelectorAll('.pbx-tab').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));

    const q = root.querySelector('.pbx-q');
    let timer = 0;
    q.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.query = q.value; applyFilter(); }, 200);
        root.querySelector('.pbx-q-clear').hidden = !q.value;
    });
    root.querySelector('.pbx-q-clear').addEventListener('click', () => {
        q.value = '';
        state.query = '';
        root.querySelector('.pbx-q-clear').hidden = true;
        applyFilter();
    });
    switchTab(tab);
}

const $ = selector => state.root.querySelector(selector);

function setBadge(count) {
    state.root.querySelectorAll('.pbx-tab').forEach(button => {
        button.querySelector('.pbx-badge').textContent = button.dataset.tab === state.tab && Number.isInteger(count) ? String(count) : '';
    });
}

function setToolbar(html, bind) {
    const bar = $('.pbx-toolbar');
    bar.innerHTML = html;
    bar.hidden = !html;
    bind?.(bar);
}

function showSubbar(visible) {
    $('.pbx-subbar').hidden = !visible;
    drawChips();
}

function drawChips() {
    const box = $('.pbx-chips');
    if (state.tab !== 'fav') { box.hidden = true; box.replaceChildren(); return; }
    const chips = [{ id: '', label: '전체' }, { id: NO_FOLDER, label: '폴더 없음' }, ...favFolders().map(name => ({ id: name, label: name }))];
    if (state.favFolder && !chips.some(c => c.id === state.favFolder)) state.favFolder = '';
    box.innerHTML = chips.map(c => `<button class="pbx-chip ${c.id === state.favFolder ? 'active' : ''}" data-id="${escapeHtml(c.id)}">${c.id && c.id !== NO_FOLDER ? '<i class="fa-solid fa-folder"></i>' : ''}${escapeHtml(c.label)}</button>`).join('');
    box.hidden = false;
    box.querySelectorAll('.pbx-chip').forEach(chip => chip.addEventListener('click', () => {
        state.favFolder = chip.dataset.id;
        reloadTab();
    }));
}

/** Left side of the toolbar: the character picker on the per-character tab. */
/**
 * Files in the character's folder that no loaded chat of that character shows
 * (deleted chats, pictures drawn but never attached). Known only after its chats are loaded.
 */
function leftoverFor(name) {
    const loaded = charCache.get(name);
    if (!loaded || !folderCounts) return { count: 0, folder: '' };
    const sanitized = sanitizeLikeServer(name);
    const folder = folderCounts.has(sanitized) ? sanitized : name;
    const inFolder = folderCounts.get(folder) || 0;
    const attachedHere = loaded.filter(item => item.folder === folder).length;
    return { count: Math.max(0, inFolder - attachedHere), folder };
}

function leftoverHtml() {
    if (state.tab !== 'char') return '';
    const { count } = leftoverFor(state.charAvatar);
    if (!count) return '';
    return `<button class="pbx-btn pbx-leftover" title="폴더에는 있지만 이 캐릭터의 어느 채팅에도 붙어 있지 않은 그림이에요. 눌러서 확인하고 정리할 수 있어요."><i class="fa-solid fa-broom"></i><span>채팅에 없는 그림&nbsp;</span><b>${count}장</b></button>`;
}

function bindLeftover(bar) {
    bar.querySelector('.pbx-leftover')?.addEventListener('click', () => {
        const { folder } = leftoverFor(state.charAvatar);
        state.manageStart = { sub: 'clean', folder };
        switchTab('manage');
    });
}

function pickerHtml() {
    if (state.tab !== 'char') return '';
    const options = characterOptions()
        .map(o => `<option value="${escapeHtml(o.avatar)}" ${o.avatar === state.charAvatar ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
        .join('');
    const toggle = folderCounts?.size
        ? `<option value="${SHOW_ALL}">${state.showAllChars ? '― 그림 있는 캐릭터만 보기 ―' : '― 모든 캐릭터 보기 ―'}</option>`
        : '';
    return `<select class="pbx-select pbx-char">${options}${toggle}</select>`;
}

function bindPicker(bar) {
    bar.querySelector('.pbx-char')?.addEventListener('change', event => {
        if (event.target.value === SHOW_ALL) {
            state.showAllChars = !state.showAllChars;
            if (!state.showAllChars && !characterOptions().find(o => o.avatar === state.charAvatar)?.count) {
                state.charAvatar = characterOptions().find(o => o.count)?.avatar || state.charAvatar;
            }
            reloadTab();
            return;
        }
        state.charAvatar = event.target.value;
        reloadTab();
    });
}

function applyFilter() {
    state.items = state.all.filter(item => matchesQuery(item, state.query));
    for (const key of [...state.selected]) if (!state.items.some(item => item.key === key)) state.selected.delete(key);
    drawItems();
}

/** Remove deleted pictures from every list of the open window. */
function dropDeleted(removed) {
    if (!state || !removed?.size) return;
    for (const [key, list] of charCache) charCache.set(key, list.filter(item => !removed.has(item.key)));
    for (const key of removed) state.selected.delete(key);
    for (const key of removed) {
        const folder = key.replace(/^\/user\/images\//, '').split('/')[0];
        if (folderCounts?.has(folder)) folderCounts.set(folder, Math.max(0, folderCounts.get(folder) - 1));
    }
    state.all = state.all.filter(item => !removed.has(item.key));
    applyFilter();
}

function viewerOptions() {
    return {
        closeAll: closeGallery,
        onDelete: dropDeleted,
        onChange: () => { if (state?.tab === 'fav') reloadTab(); else drawItems(); },
    };
}

function drawItems() {
    state.dispose();
    const body = $('.pbx-body');
    if (state.view === 'story') {
        state.dispose = renderStory(body, state.items, {
            closeAll: closeGallery,
            onOpen: (index, list) => openViewer(list, index, viewerOptions()),
        });
    } else {
        state.dispose = renderGrid(body, state.items, {
            selected: state.selected,
            selectMode: () => state.selectMode,
            onSelectChange: drawToolbar,
            onOpen: index => openViewer(state.items, index, viewerOptions()),
        });
    }
    setBadge(state.items.length);
    drawToolbar();
}

function exportLabel() {
    if (state.tab === 'char') return characterOptions().find(o => o.avatar === state.charAvatar)?.name || '캐릭터';
    if (state.tab === 'fav') return state.favFolder && state.favFolder !== NO_FOLDER ? `즐겨찾기_${state.favFolder}` : '즐겨찾기';
    return TABS.find(t => t.id === state.tab)?.label || '';
}

function drawToolbar() {
    const n = state.items.length;
    const label = exportLabel();
    const isFolder = state.tab === 'fav' && state.favFolder && state.favFolder !== NO_FOLDER;
    if (!state.selectMode) {
        const story = state.view === 'story';
        setToolbar(`
            ${pickerHtml()}
            ${leftoverHtml()}
            <span class="pbx-spacer"></span>
            ${isFolder ? '<button title="폴더 삭제" class="pbx-btn pbx-danger pbx-delfolder"><i class="fa-solid fa-folder-minus"></i><span>폴더 삭제</span></button>' : ''}
            <button title="${story ? '격자로 보기' : '스토리로 보기'}" class="pbx-btn pbx-view ${story ? 'pbx-on' : ''}"><i class="fa-solid ${story ? 'fa-grip' : 'fa-book-open'}"></i><span>${story ? '격자' : '스토리'}</span></button>
            <button title="선택" class="pbx-btn pbx-sel" ${n && !story ? '' : 'disabled'}><i class="fa-solid fa-square-check"></i><span>선택</span></button>
            <button title="전체 ZIP" class="pbx-btn pbx-zip" ${n ? '' : 'disabled'}><i class="fa-solid fa-file-zipper"></i><span>전체 ZIP</span></button>`, bar => {
            bindPicker(bar);
            bindLeftover(bar);
            bar.querySelector('.pbx-view').addEventListener('click', () => { state.view = story ? 'grid' : 'story'; drawItems(); });
            bar.querySelector('.pbx-sel').addEventListener('click', () => { state.selectMode = true; state.selected.clear(); drawItems(); });
            bar.querySelector('.pbx-zip').addEventListener('click', () => exportItems(state.items, label));
            bar.querySelector('.pbx-delfolder')?.addEventListener('click', async () => {
                if (!(await confirmPopup(`<p>'${escapeHtml(state.favFolder)}' 폴더를 지울까요?</p><small>그림과 즐겨찾기는 그대로 남아요.</small>`))) return;
                removeFavFolder(state.favFolder);
                state.favFolder = '';
                reloadTab();
            });
        });
        return;
    }
    const picked = state.items.filter(item => state.selected.has(item.key));
    const none = picked.length ? '' : 'disabled';
    const unfav = state.tab === 'fav';
    setToolbar(`
        <span class="pbx-count">${picked.length}장 선택</span>
        <span class="pbx-spacer"></span>
        <button title="전체" class="pbx-btn pbx-all"><i class="fa-solid fa-check-double"></i><span>${n && state.selected.size === n ? '선택 해제' : '전체'}</span></button>
        <button title="ZIP" class="pbx-btn pbx-zip" ${none}><i class="fa-solid fa-file-zipper"></i><span>ZIP</span></button>
        <button title="폴더" class="pbx-btn pbx-folder" ${none}><i class="fa-solid fa-folder-plus"></i><span>폴더</span></button>
        <button title="${unfav ? (isFolder ? '폴더에서 빼기' : '즐겨찾기 해제') : '즐겨찾기'}" class="pbx-btn pbx-star" ${none}><i class="fa-${unfav ? 'regular' : 'solid'} fa-star"></i><span>${unfav ? (isFolder ? '폴더에서 빼기' : '해제') : '즐겨찾기'}</span></button>
        <button title="삭제" class="pbx-btn pbx-danger pbx-delete" ${none}><i class="fa-solid fa-trash"></i><span>삭제</span></button>
        <button title="취소" class="pbx-btn pbx-cancel"><i class="fa-solid fa-xmark"></i><span>취소</span></button>`, bar => {
        bar.querySelector('.pbx-all').addEventListener('click', () => {
            if (state.selected.size === n) state.selected.clear();
            else state.items.forEach(item => state.selected.add(item.key));
            drawItems();
        });
        bar.querySelector('.pbx-zip').addEventListener('click', () => exportItems(picked, `${label}_선택`));
        bar.querySelector('.pbx-folder').addEventListener('click', event => openFolderPicker(event.currentTarget, picked, () => {
            drawChips();
            if (state.tab !== 'fav') drawItems();
        }));
        bar.querySelector('.pbx-star').addEventListener('click', () => {
            if (unfav && isFolder) {
                setInFolder(picked, state.favFolder, false);
                toastr.success(`${picked.length}장을 '${state.favFolder}' 폴더에서 뺐어요.`);
            } else {
                for (const item of picked) setFavorite(item, !unfav, false);
                ctx().saveSettingsDebounced();
                toastr.success(unfav ? `${picked.length}장을 즐겨찾기에서 뺐어요.` : `${picked.length}장을 즐겨찾기에 넣었어요.`);
            }
            state.selectMode = false;
            state.selected.clear();
            reloadTab();
        });
        bar.querySelector('.pbx-delete').addEventListener('click', async () => {
            const removed = await deleteItems(picked);
            if (!removed.size) return;
            state.selectMode = false;
            dropDeleted(removed);
        });
        bar.querySelector('.pbx-cancel').addEventListener('click', () => { state.selectMode = false; state.selected.clear(); drawItems(); });
    });
}

function showMessage(text) {
    state.dispose();
    state.dispose = () => {};
    const body = $('.pbx-body');
    body.innerHTML = '<div class="pbx-empty"></div>';
    body.firstChild.textContent = text;
    setBadge(null);
}

function setItems(items) {
    state.all = byNewest(items);
    applyFilter();
}

function reloadTab() {
    const tab = state.tab;
    state.tab = null;
    switchTab(tab, true);
}

async function switchTab(tab, keepView = false) {
    if (!state || state.tab === tab) return;
    state.tab = tab;
    state.selectMode = false;
    state.selected.clear();
    if (!keepView) state.view = 'grid';
    const token = ++state.token;
    const isStale = () => !state || state.token !== token;
    state.root.querySelectorAll('.pbx-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    state.dispose();
    state.dispose = () => {};
    setToolbar('', null);
    setBadge(null);
    showSubbar(tab !== 'manage');

    if (tab === 'manage') {
        const start = state.manageStart || {};
        state.manageStart = null;
        // Cleanup and shrinking change what is in the folders; count again when a picture tab is next opened.
        folderCounts = null;
        state.dispose = renderManage($('.pbx-body'), { closeAll: closeGallery, setToolbar }, start.sub || 'stats', start.folder || '');
        return;
    }
    if (tab === 'chat') {
        if (!ctx().chat?.length) { showSubbar(false); return showMessage('열려 있는 채팅이 없어요.'); }
        return setItems(currentChatItems());
    }
    if (tab === 'fav') {
        return setItems(favoriteItems(state.favFolder));
    }
    if (tab === 'char') {
        if (!folderCounts) {
            showMessage('그림 있는 캐릭터 찾는 중…');
            await loadFolderCounts();
            if (isStale()) return;
            // Start on the open character only if it has pictures; otherwise the first one that does.
            const options = characterOptions();
            if (!state.showAllChars && !options.find(o => o.avatar === state.charAvatar)?.count) {
                state.charAvatar = options.find(o => o.count)?.avatar || state.charAvatar;
            }
        }
        if (!state.charAvatar) state.charAvatar = characterOptions()[0]?.avatar || '';
        if (!state.charAvatar) return showMessage('캐릭터가 없어요.');
        // Show the picker right away so another character can be chosen while loading.
        setToolbar(`${pickerHtml()}<span class="pbx-spacer"></span>`, bindPicker);
        if (charCache.has(state.charAvatar)) return setItems([...charCache.get(state.charAvatar)]);
        showMessage('채팅 불러오는 중…');
        try {
            const avatar = state.charAvatar;
            const items = await characterItems(avatar, text => { if (!isStale()) $('.pbx-empty')?.replaceChildren(text); }, isStale);
            if (isStale() || !items) return;
            charCache.set(avatar, items);
            setItems([...items]);
            const inFolder = characterOptions().find(o => o.avatar === avatar)?.count || 0;
            if (!items.length && inFolder) {
                // Pictures exist in the folder but no chat of this character uses them.
                $('.pbx-empty')?.replaceChildren(`이 캐릭터의 채팅에 붙어 있는 그림이 없어요. 폴더에 남은 ${inFolder}장은 관리 → 안 쓰는 그림에서 볼 수 있어요.`);
            }
        } catch (error) {
            if (!isStale()) showMessage(`불러오지 못했어요: ${error?.message || error}`);
        }
    }
}
