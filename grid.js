// Thumbnail grid, image viewer, favorites and ZIP export shared by the gallery tabs.
import { ctx, getSettings, saveSettings, copyText, downloadBlob, currentChatId, confirmPopup, escapeHtml, sniffExt, postJson } from './settings.js';
import { getThumb, forgetThumb } from './thumbs.js';
import { buildZip, safeName } from './zip.js';
import { itemTime, imageKey } from './collect.js';
import { expandMessage } from './fold.js';
import { openCard } from './card.js';

// ---------- favorites ----------
export function isFavorite(key) {
    return !!getSettings().favorites[key];
}

export function setFavorite(item, on, save = true) {
    const favorites = getSettings().favorites;
    if (on) {
        const old = favorites[item.key];
        favorites[item.key] = {
            key: item.key, url: item.url, folder: item.folder, file: item.file, prompt: item.prompt || '',
            mesId: item.mesId, chatFile: item.chatFile || '', charName: item.charName || item.folder,
            avatar: item.avatar || '', date: item.date || '', excerpt: String(item.excerpt || '').slice(0, 300),
            addedAt: old?.addedAt || Date.now(),
            folders: Array.isArray(old?.folders) ? old.folders : [],
        };
    } else {
        delete favorites[item.key];
    }
    if (save) saveSettings();
}

export function favoriteItems(folder = '') {
    return Object.values(getSettings().favorites)
        .filter(item => item && item.key)
        .filter(item => {
            if (!folder) return true;
            const folders = Array.isArray(item.folders) ? item.folders : [];
            return folder === '__pbx_none__' ? folders.length === 0 : folders.includes(folder);
        })
        .map(item => ({ ...item, isCurrent: item.chatFile === currentChatId() }));
}

export function favFolders() {
    return getSettings().favFolders;
}

export function addFavFolder(name) {
    const clean = String(name || '').trim().slice(0, 30);
    if (!clean || clean === '__pbx_none__') return '';
    const folders = favFolders();
    if (!folders.includes(clean)) folders.push(clean);
    saveSettings();
    return clean;
}

export function removeFavFolder(name) {
    const settings = getSettings();
    settings.favFolders = settings.favFolders.filter(f => f !== name);
    for (const fav of Object.values(settings.favorites)) {
        if (Array.isArray(fav?.folders)) fav.folders = fav.folders.filter(f => f !== name);
    }
    saveSettings();
}

/** Put items in / out of a favorite folder. Adding also makes them favorites. */
export function setInFolder(items, folder, on) {
    const favorites = getSettings().favorites;
    for (const item of items) {
        if (on && !favorites[item.key]) setFavorite(item, true, false);
        const fav = favorites[item.key];
        if (!fav) continue;
        const folders = new Set(Array.isArray(fav.folders) ? fav.folders : []);
        if (on) folders.add(folder); else folders.delete(folder);
        fav.folders = [...folders];
    }
    saveSettings();
}

/**
 * Small popover listing favorite folders with checkboxes and a "new folder" field.
 * @param {HTMLElement} anchor element the popover is placed under
 * @param {object[]} items
 * @param {() => void} [onChange]
 */
export function openFolderPicker(anchor, items, onChange) {
    document.querySelector('.pbx-folder-pop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'pbx-folder-pop';
    const host = anchor.closest('#pbx_viewer, #pbx_overlay') || document.body;
    host.appendChild(pop);

    const draw = () => {
        const favorites = getSettings().favorites;
        const rows = favFolders().map(name => {
            const inCount = items.filter(item => favorites[item.key]?.folders?.includes(name)).length;
            const state = inCount === 0 ? '' : inCount === items.length ? 'checked' : 'data-mixed="1"';
            return `<label class="pbx-check-label"><input type="checkbox" data-folder="${escapeHtml(name)}" ${state}><span>${escapeHtml(name)}</span></label>`;
        }).join('');
        pop.innerHTML = `
            <div class="pbx-pop-title">즐겨찾기 폴더${items.length > 1 ? ` · ${items.length}장` : ''}</div>
            <div class="pbx-pop-list">${rows || '<small>아직 폴더가 없어요.</small>'}</div>
            <div class="pbx-pop-new"><input class="pbx-input" maxlength="30" placeholder="새 폴더 이름"><button class="pbx-btn pbx-icon" title="추가"><i class="fa-solid fa-plus"></i></button></div>`;
        pop.querySelectorAll('input[data-mixed]').forEach(input => { input.indeterminate = true; });
        pop.querySelectorAll('input[data-folder]').forEach(input => input.addEventListener('change', () => {
            setInFolder(items, input.dataset.folder, input.checked);
            onChange?.();
        }));
        const field = pop.querySelector('.pbx-input');
        const add = () => {
            const name = addFavFolder(field.value);
            if (!name) return;
            setInFolder(items, name, true);
            onChange?.();
            draw();
        };
        pop.querySelector('.pbx-pop-new .pbx-btn').addEventListener('click', add);
        field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } event.stopPropagation(); });
    };
    draw();

    const rect = anchor.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    pop.style.top = `${Math.round(rect.bottom - hostRect.top + 6)}px`;
    pop.style.right = `${Math.max(8, Math.round(hostRect.right - rect.right))}px`;

    const close = event => {
        if (pop.contains(event.target) || anchor.contains(event.target)) return;
        pop.remove();
        document.removeEventListener('pointerdown', close, true);
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}

// ---------- delete ----------
const IMG_TAG = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** Drop deleted images from the open chat so its messages do not keep broken pictures. */
async function forgetInOpenChat(keys) {
    const c = ctx();
    const chat = c.chat || [];
    const gone = src => keys.has(imageKey(String(src || '').replace(/&amp;/g, '&')));
    const changedIds = [];
    chat.forEach((message, mesId) => {
        if (!message || typeof message !== 'object') return;
        let changed = false;
        const extras = [message.extra, ...(message.swipe_info || []).map(info => info?.extra)].filter(Boolean);
        for (const extra of extras) {
            if (Array.isArray(extra.media)) {
                const kept = extra.media.filter(m => !gone(m?.url));
                if (kept.length !== extra.media.length) {
                    extra.media = kept;
                    if (Number.isInteger(extra.media_index)) extra.media_index = Math.max(0, Math.min(extra.media_index, kept.length - 1));
                    changed = true;
                }
            }
            for (const key of Object.keys(extra.autopic_images || {})) {
                if (keys.has(key)) { delete extra.autopic_images[key]; changed = true; }
            }
        }
        const strip = text => typeof text === 'string' && text.includes('<img')
            ? text.replace(IMG_TAG, (tag, src) => (gone(src) ? '' : tag)) : text;
        const mes = strip(message.mes);
        if (mes !== message.mes) { message.mes = mes; changed = true; }
        if (Array.isArray(message.swipes)) {
            const swipes = message.swipes.map(strip);
            if (swipes.some((t, i) => t !== message.swipes[i])) { message.swipes = swipes; changed = true; }
        }
        if (changed) changedIds.push(mesId);
    });
    if (!changedIds.length) return;
    for (const mesId of changedIds) {
        try {
            c.updateMessageBlock(mesId, chat[mesId]);
            const element = $(`#chat .mes[mesid="${mesId}"]`);
            element.find('.mes_media_wrapper').empty();
            c.appendMediaToMessage(chat[mesId], element);
        } catch { /* message not rendered */ }
    }
    await c.saveChat();
}

/**
 * Permanently delete image files (and their favorites / previews).
 * @returns {Promise<Set<string>>} keys that are gone
 */
export async function deleteItems(items) {
    if (!items.length) return new Set();
    const inOpenChat = items.some(item => item.isCurrent);
    const ok = await confirmPopup(`<p>그림 <b>${items.length}장</b>을 폴더에서 <b>영구 삭제</b>할까요?</p>
        <p>되돌릴 수 없어요.</p>
        <small>${inOpenChat ? '지금 채팅에 붙은 그림은 채팅에서도 같이 빠져요. ' : ''}다른 채팅에 붙어 있던 그림은 그 채팅에서 깨진 그림으로 보일 수 있어요.</small>`);
    if (!ok) return new Set();
    const removed = new Set();
    let failed = 0;
    for (const item of items) {
        try {
            const response = await fetch('/api/images/delete', {
                method: 'POST',
                headers: ctx().getRequestHeaders(),
                body: JSON.stringify({ path: `user/images/${item.folder}/${item.file}` }),
            });
            // 404: already gone, which is what the user wanted.
            if (!response.ok && response.status !== 404) throw new Error(String(response.status));
            removed.add(item.key);
            if (isFavorite(item.key)) setFavorite(item, false, false);
            forgetThumb(item.url);
        } catch {
            failed++;
        }
    }
    if (removed.size) {
        saveSettings();
        try { await forgetInOpenChat(removed); } catch { /* the files are deleted either way */ }
        toastr.success(`${removed.size}장을 삭제했어요.`);
    }
    if (failed) toastr.error(`${failed}장은 삭제하지 못했어요.`);
    return removed;
}

// ---------- background ----------
async function setAsBackground(item) {
    const c = ctx();
    const result = await c.callGenericPopup('<p>이 그림을 배경으로 쓸까요?</p><small>"이 채팅에만"은 지금 열린 채팅에만 배경을 고정해요.</small>', c.POPUP_TYPE.CONFIRM, '', {
        okButton: '모든 채팅',
        cancelButton: '취소',
        customButtons: [{ text: '이 채팅에만', result: 2 }],
    });
    if (result !== 2 && result !== c.POPUP_RESULT.AFFIRMATIVE) return;
    const chatOnly = result === 2;
    try {
        const response = await fetch(item.url);
        if (!response.ok) throw new Error('image');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const ext = sniffExt(bytes) || 'png';
        const name = `picbox_${safeName(item.file.replace(/\.[^.]+$/, ''))}.${ext}`;
        const form = new FormData();
        form.append('avatar', new File([bytes], name, { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` }));
        const upload = await fetch('/api/backgrounds/upload', {
            method: 'POST',
            headers: c.getRequestHeaders({ omitContentType: true }),
            body: form,
        });
        if (!upload.ok) throw new Error('upload');
        const bg = (await upload.text()).trim() || name;
        await c.executeSlashCommandsWithOptions(`/bg ${bg}`);
        if (chatOnly) await c.executeSlashCommandsWithOptions('/lockbg');
        toastr.success(chatOnly ? '이 채팅의 배경으로 정했어요.' : '배경으로 정했어요.');
    } catch {
        toastr.error('배경으로 정하지 못했어요.');
    }
}

// ---------- names ----------
function stamp(item) {
    const time = itemTime(item);
    if (!time) return 'unknown';
    const d = new Date(time);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function extensionOf(file) {
    const match = String(file).match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase() : 'png';
}

export function niceFileName(item, index = 0, ext = '') {
    const mes = Number.isInteger(item.mesId) ? `_${item.mesId}` : '';
    const n = index ? `_${index}` : '';
    return `${safeName(item.charName || item.folder)}_${stamp(item)}${mes}${n}.${ext || extensionOf(item.file)}`;
}

// ---------- export ----------
export async function exportItems(items, label, { confirm = true } = {}) {
    if (!items.length) { toastr.info('내보낼 그림이 없어요.'); return false; }
    const ok = !confirm || await confirmPopup(`<p>그림 <b>${items.length}장</b>을 ZIP 파일로 내보낼까요?</p><small>장수가 많으면 폰에서는 시간이 걸리고 메모리를 많이 써요.</small>`);
    if (!ok) return false;

    const withPrompts = getSettings().zipWithPrompts;
    const entries = [];
    const promptLines = [];
    const used = new Set();
    let failed = 0;
    const progress = toastr.info(`0 / ${items.length}`, 'ZIP 만드는 중', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
            const response = await fetch(item.url);
            if (!response.ok) throw new Error(String(response.status));
            const data = new Uint8Array(await response.arrayBuffer());
            const ext = sniffExt(data);
            let name = niceFileName(item, 0, ext);
            for (let n = 2; used.has(name); n++) name = niceFileName(item, n, ext);
            used.add(name);
            entries.push({ name, data, date: new Date(itemTime(item) || Date.now()) });
            if (withPrompts && item.prompt) promptLines.push(`[${name}]\n${item.prompt}\n`);
        } catch {
            failed++;
        }
        progress.find?.('.toast-message')?.text(`${i + 1} / ${items.length}`);
    }
    toastr.clear(progress);

    if (!entries.length) { toastr.error('그림을 하나도 불러오지 못했어요.'); return false; }
    if (promptLines.length) entries.push({ name: 'prompts.txt', data: new TextEncoder().encode(promptLines.join('\n')) });

    const first = items[0];
    const zipName = `${safeName(first.charName || first.folder)}_${label}_${stamp({ file: '', date: new Date().toISOString() })}.zip`;
    downloadBlob(buildZip(entries), zipName);
    if (failed) toastr.warning(`${failed}장은 파일을 찾지 못해 빠졌어요.`);
    else toastr.success(`${entries.length - (promptLines.length ? 1 : 0)}장을 내보냈어요.`);
    return failed === 0;
}

// ---------- grid ----------
/**
 * @param {HTMLElement} container
 * @param {object[]} items
 * @param {{selected?: Set<string>, selectMode?: () => boolean, onOpen?: (index: number) => void, onSelectChange?: () => void}} options
 * @returns {() => void} cleanup function
 */
export function renderGrid(container, items, options = {}) {
    container.replaceChildren();
    const objectUrls = [];
    let alive = true;

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'pbx-empty';
        empty.textContent = '그림이 없어요.';
        container.appendChild(empty);
        return () => {};
    }

    const grid = document.createElement('div');
    grid.className = 'pbx-grid';
    container.appendChild(grid);

    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            const card = entry.target;
            const item = items[Number(card.dataset.index)];
            getThumb(item.url, () => !alive).then(blob => {
                if (!alive || !blob) return;
                const url = URL.createObjectURL(blob);
                objectUrls.push(url);
                card.querySelector('img').src = url;
                card.classList.add('loaded');
            }).catch(() => card.classList.add('missing'));
        }
    }, { root: container.closest('.pbx-body') || null, rootMargin: '300px' });

    items.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = 'pbx-card';
        card.dataset.index = String(index);
        card.innerHTML = `
            <div class="pbx-thumb"><img alt=""></div>
            <div class="pbx-check"><i class="fa-solid fa-check"></i></div>
            ${isFavorite(item.key) ? '<div class="pbx-star">★</div>' : ''}
            <div class="pbx-cap">${Number.isInteger(item.mesId) ? `#${item.mesId}` : ''}${item.isCurrent ? '' : item.chatFile ? ' · 다른 채팅' : ''}</div>`;
        if (options.selected?.has(item.key)) card.classList.add('selected');
        card.addEventListener('click', () => {
            if (options.selectMode?.()) {
                if (options.selected.has(item.key)) options.selected.delete(item.key);
                else options.selected.add(item.key);
                card.classList.toggle('selected', options.selected.has(item.key));
                options.onSelectChange?.();
            } else {
                options.onOpen?.(index);
            }
        });
        grid.appendChild(card);
        observer.observe(card);
    });

    return () => {
        alive = false;
        observer.disconnect();
        for (const url of objectUrls) URL.revokeObjectURL(url);
    };
}

// ---------- viewer ----------
export async function jumpTo(item, closeAll) {
    const c = ctx();
    const mesId = item.mesId;
    if (!Number.isInteger(mesId)) return;
    if (item.chatFile && item.chatFile !== currentChatId()) {
        if (!item.avatar) {
            toastr.info('이 그림이 있던 채팅 정보를 찾지 못했어요.');
            return;
        }
        const waitChat = () => new Promise(resolve => {
            let done = false;
            const handler = () => {
                if (done) return;
                done = true;
                c.eventSource.removeListener(c.eventTypes.CHAT_CHANGED, handler);
                resolve();
            };
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, handler);
            setTimeout(handler, 8000);
        });
        closeAll();
        const current = c.characters?.[c.characterId];
        if (!current || current.avatar !== item.avatar) {
            const index = (c.characters || []).findIndex(ch => ch?.avatar === item.avatar);
            if (index < 0) { toastr.error(`'${item.charName}' 캐릭터를 찾지 못했어요.`); return; }
            const switched = waitChat();
            await c.selectCharacterById(index);
            await switched;
        }
        if (currentChatId() !== item.chatFile) {
            const opened = waitChat();
            await ctx().openCharacterChat(item.chatFile);
            await opened;
        }
        await new Promise(resolve => setTimeout(resolve, 400));
    } else {
        closeAll();
    }
    expandMessage(mesId);
    try {
        await ctx().executeSlashCommandsWithOptions(`/chat-jump ${mesId}`);
    } catch {
        document.querySelector(`#chat .mes[mesid="${mesId}"]`)?.scrollIntoView({ block: 'center' });
    }
}

/**
 * @param {object[]} items
 * @param {number} startIndex
 * @param {{onChange?: () => void, closeAll: () => void}} options
 */
/**
 * Pinch / double-tap / wheel zoom and drag for the viewer image.
 * Returns { reset, zoomed } — swiping to the next picture only happens while not zoomed.
 */
function attachZoom(stage, img) {
    let scale = 1, tx = 0, ty = 0;
    const MAX = 6;
    const apply = () => {
        img.style.transform = scale === 1 && !tx && !ty ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
        stage.classList.toggle('pbx-zoomed', scale > 1);
    };
    const clamp = () => {
        const limX = Math.max(0, (img.offsetWidth * scale - stage.clientWidth) / 2);
        const limY = Math.max(0, (img.offsetHeight * scale - stage.clientHeight) / 2);
        tx = Math.min(limX, Math.max(-limX, tx));
        ty = Math.min(limY, Math.max(-limY, ty));
    };
    /** Zoom to `next` keeping the stage point (x, y) under the finger / cursor. */
    const zoomAt = (next, x, y) => {
        next = Math.min(MAX, Math.max(1, next));
        const rect = stage.getBoundingClientRect();
        const cx = x - rect.left - rect.width / 2;
        const cy = y - rect.top - rect.height / 2;
        tx = cx - (cx - tx) * (next / scale);
        ty = cy - (cy - ty) * (next / scale);
        scale = next;
        if (scale === 1) { tx = 0; ty = 0; }
        clamp();
        apply();
    };
    const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

    // Touch: two fingers pinch, one finger drags while zoomed, double tap toggles.
    let pinch = null, drag = null, lastTap = 0;
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    stage.addEventListener('touchstart', event => {
        if (event.target.closest('button')) return;
        if (event.touches.length === 2) {
            const [a, b] = event.touches;
            pinch = { d: dist(a, b), scale };
            drag = null;
        } else if (event.touches.length === 1) {
            const t = event.touches[0];
            drag = { x: t.clientX, y: t.clientY, tx, ty };
            const now = Date.now();
            if (now - lastTap < 300) {
                zoomAt(scale > 1 ? 1 : 2.5, t.clientX, t.clientY);
                lastTap = 0;
                drag = null;
            } else lastTap = now;
        }
    }, { passive: true });
    stage.addEventListener('touchmove', event => {
        if (pinch && event.touches.length === 2) {
            event.preventDefault();
            const [a, b] = event.touches;
            zoomAt(pinch.scale * (dist(a, b) / pinch.d), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        } else if (drag && scale > 1 && event.touches.length === 1) {
            event.preventDefault();
            const t = event.touches[0];
            tx = drag.tx + (t.clientX - drag.x);
            ty = drag.ty + (t.clientY - drag.y);
            clamp();
            apply();
        }
    }, { passive: false });
    stage.addEventListener('touchend', event => {
        if (event.touches.length < 2) pinch = null;
        if (event.touches.length === 1 && scale > 1) {
            // One finger left after a pinch: keep dragging from here.
            const t = event.touches[0];
            drag = { x: t.clientX, y: t.clientY, tx, ty };
        } else if (!event.touches.length) drag = null;
    });

    // Mouse: wheel zooms, drag moves, double click toggles.
    stage.addEventListener('wheel', event => {
        event.preventDefault();
        zoomAt(scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX, event.clientY);
    }, { passive: false });
    stage.addEventListener('dblclick', event => {
        if (event.target.closest('button')) return;
        zoomAt(scale > 1 ? 1 : 2.5, event.clientX, event.clientY);
    });
    let mouse = null;
    stage.addEventListener('mousedown', event => {
        if (scale === 1 || event.button !== 0 || event.target.closest('button')) return;
        event.preventDefault();
        mouse = { x: event.clientX, y: event.clientY, tx, ty };
    });
    const onMouseMove = event => {
        if (!mouse) return;
        tx = mouse.tx + (event.clientX - mouse.x);
        ty = mouse.ty + (event.clientY - mouse.y);
        clamp();
        apply();
    };
    const onMouseUp = () => { mouse = null; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    const dispose = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
    };
    return { reset, zoomed: () => scale > 1, dispose };
}

export function openViewer(items, startIndex, options) {
    document.getElementById('pbx_viewer')?.remove();
    let index = startIndex;
    const viewer = document.createElement('div');
    viewer.id = 'pbx_viewer';
    viewer.innerHTML = `
        <div class="pbx-viewer-top">
            <span class="pbx-viewer-info"></span>
            <div class="pbx-viewer-actions">
                <button class="pbx-btn pbx-icon pbx-fav" title="즐겨찾기"></button>
                <button class="pbx-btn pbx-icon pbx-folderbtn" title="즐겨찾기 폴더"><i class="fa-solid fa-folder-plus"></i></button>
                <button class="pbx-btn pbx-icon pbx-copy" title="프롬프트 복사"><i class="fa-solid fa-copy"></i></button>
                <button class="pbx-btn pbx-icon pbx-down" title="다운로드"><i class="fa-solid fa-download"></i></button>
                <button class="pbx-btn pbx-icon pbx-cardbtn" title="대사 카드 만들기"><i class="fa-solid fa-quote-left"></i></button>
                <button class="pbx-btn pbx-icon pbx-bg" title="배경으로 설정"><i class="fa-solid fa-panorama"></i></button>
                <button class="pbx-btn pbx-icon pbx-jump" title="메시지로 이동"><i class="fa-solid fa-location-arrow"></i></button>
                <button class="pbx-btn pbx-icon pbx-danger pbx-del" title="삭제"><i class="fa-solid fa-trash"></i></button>
                <button class="pbx-btn pbx-icon pbx-close" title="닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="pbx-viewer-stage">
            <button class="pbx-nav pbx-prev" aria-label="이전"><i class="fa-solid fa-chevron-left"></i></button>
            <img class="pbx-viewer-img" alt="">
            <button class="pbx-nav pbx-next" aria-label="다음"><i class="fa-solid fa-chevron-right"></i></button>
        </div>
        <details class="pbx-prompt" open><summary>생성 프롬프트</summary><pre></pre></details>`;
    document.body.appendChild(viewer);

    const $ = selector => viewer.querySelector(selector);
    const zoom = attachZoom($('.pbx-viewer-stage'), $('.pbx-viewer-img'));
    const close = () => { document.removeEventListener('keydown', onKey, true); zoom.dispose(); viewer.remove(); };

    function show() {
        const item = items[index];
        zoom.reset();
        $('.pbx-viewer-img').src = item.url;
        const where = Number.isInteger(item.mesId) ? `#${item.mesId}` : '';
        $('.pbx-viewer-info').innerHTML = `${index + 1} / ${items.length} ${escapeHtml(where)}<br><small>${escapeHtml(item.charName || '')}${item.isCurrent || !item.chatFile ? '' : ` · ${escapeHtml(item.chatFile)}`}</small>`;
        $('.pbx-fav').textContent = isFavorite(item.key) ? '★' : '☆';
        const folders = getSettings().favorites[item.key]?.folders || [];
        $('.pbx-folderbtn').classList.toggle('pbx-on', folders.length > 0);
        $('.pbx-folderbtn').title = folders.length ? `폴더: ${folders.join(', ')}` : '즐겨찾기 폴더';
        $('.pbx-prompt pre').textContent = item.prompt || '(저장된 프롬프트가 없어요)';
        $('.pbx-copy').disabled = !item.prompt;
        $('.pbx-jump').disabled = !Number.isInteger(item.mesId);
        $('.pbx-prev').style.visibility = index > 0 ? 'visible' : 'hidden';
        $('.pbx-next').style.visibility = index < items.length - 1 ? 'visible' : 'hidden';
    }
    const move = step => { const next = index + step; if (next >= 0 && next < items.length) { index = next; show(); } };
    function onKey(event) {
        if (event.target?.closest?.('input, textarea')) return;
        if (event.key === 'Escape') { event.stopPropagation(); close(); }
        else if (event.key === 'ArrowLeft') move(-1);
        else if (event.key === 'ArrowRight') move(1);
    }

    $('.pbx-close').addEventListener('click', close);
    $('.pbx-prev').addEventListener('click', () => move(-1));
    $('.pbx-next').addEventListener('click', () => move(1));
    $('.pbx-fav').addEventListener('click', () => {
        const item = items[index];
        setFavorite(item, !isFavorite(item.key));
        show();
        options.onChange?.();
    });
    $('.pbx-copy').addEventListener('click', async () => {
        toastr[(await copyText(items[index].prompt || '')) ? 'success' : 'error']('프롬프트 복사', '', { timeOut: 1500 });
    });
    $('.pbx-down').addEventListener('click', async () => {
        const item = items[index];
        try {
            const response = await fetch(item.url);
            if (!response.ok) throw new Error();
            const bytes = new Uint8Array(await response.arrayBuffer());
            const ext = sniffExt(bytes);
            downloadBlob(new Blob([bytes], { type: `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}` }), niceFileName(item, 0, ext));
        } catch { toastr.error('그림 파일을 찾지 못했어요.'); }
    });
    $('.pbx-folderbtn').addEventListener('click', event => {
        openFolderPicker(event.currentTarget, [items[index]], () => { show(); options.onChange?.(); });
    });
    $('.pbx-bg').addEventListener('click', () => setAsBackground(items[index]));
    $('.pbx-cardbtn').addEventListener('click', () => openCard(items[index]));
    $('.pbx-del').addEventListener('click', async () => {
        const removed = await deleteItems([items[index]]);
        if (!removed.size) return;
        items.splice(index, 1);
        options.onDelete?.(removed);
        if (!items.length) { close(); return; }
        index = Math.min(index, items.length - 1);
        show();
    });
    $('.pbx-jump').addEventListener('click', () => jumpTo(items[index], () => { close(); options.closeAll(); }));

    // Swipe left / right on touch screens.
    let touchX = null;
    $('.pbx-viewer-stage').addEventListener('touchstart', event => {
        touchX = event.touches.length === 1 && !zoom.zoomed() ? event.touches[0].clientX : null;
    }, { passive: true });
    $('.pbx-viewer-stage').addEventListener('touchend', event => {
        if (touchX === null || zoom.zoomed() || event.touches.length) { touchX = null; return; }
        const dx = event.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) > 50) move(dx < 0 ? 1 : -1);
    });
    document.addEventListener('keydown', onKey, true);
    show();
}
