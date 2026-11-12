// "관리" tab: storage stats, unused-image cleanup, WebP shrinking and options.
import { ctx, getSettings, saveSettings, postJson, confirmPopup, escapeHtml, formatBytes, runPool, sniffExt, blobToBase64, currentCharacter } from './settings.js';
import { renderCleanup, sanitizeLikeServer, fileTime } from './cleanup.js';
import { exportItems } from './grid.js';
import { renderOptions } from './options.js';

const SUBTABS = [
    { id: 'stats', label: '통계', icon: 'fa-chart-simple' },
    { id: 'clean', label: '안 쓰는 그림', icon: 'fa-broom' },
    { id: 'shrink', label: '용량 줄이기', icon: 'fa-compress' },
    { id: 'options', label: '설정', icon: 'fa-gear' },
];
const RECENT_MS = 30 * 60 * 1000;

// Stats survive tab switches while the gallery is open.
let statsCache = null;

const urlOf = (folder, file) => `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;

/** Size and real type of a file with one tiny ranged request. */
async function probe(folder, file) {
    try {
        const response = await fetch(urlOf(folder, file), { headers: { Range: 'bytes=0-15' }, cache: 'no-store' });
        if (!response.ok) return { size: 0, type: '' };
        const bytes = new Uint8Array(await response.arrayBuffer());
        const range = response.headers.get('Content-Range');
        const size = range ? Number(range.split('/')[1]) : Number(response.headers.get('Content-Length')) || bytes.length;
        return { size: Number.isFinite(size) ? size : 0, type: sniffExt(bytes) };
    } catch {
        return { size: 0, type: '' };
    }
}

async function listFolder(folder) {
    const files = await postJson('/api/images/list', { folder });
    return Array.isArray(files) ? files : [];
}

async function folderList() {
    const folders = await postJson('/api/images/folders', {});
    return Array.isArray(folders) ? folders.sort((a, b) => a.localeCompare(b)) : [];
}

function folderOptions(folders, selected) {
    return folders.map(name => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

/**
 * @param {HTMLElement} body
 * @param {{closeAll: () => void, setToolbar: (html: string, bind?: (root: HTMLElement) => void) => void}} host
 */
export function renderManage(body, host, startSub = 'stats') {
    let sub = startSub;
    let disposeSub = () => {};
    let preferredFolder = currentCharacter() ? sanitizeLikeServer(currentCharacter().name) : '';

    body.innerHTML = `
        <div class="pbx-manage">
            <div class="pbx-subtabs">${SUBTABS.map(t => `<button class="pbx-chip" data-sub="${t.id}"><i class="fa-solid ${t.icon}"></i>${t.label}</button>`).join('')}</div>
            <div class="pbx-subbody"></div>
        </div>`;
    const subBody = body.querySelector('.pbx-subbody');

    function open(id, folder) {
        if (folder) preferredFolder = folder;
        sub = id;
        disposeSub();
        disposeSub = () => {};
        host.setToolbar('', null);
        body.querySelectorAll('.pbx-subtabs .pbx-chip').forEach(chip => chip.classList.toggle('active', chip.dataset.sub === id));
        if (id === 'clean') disposeSub = renderCleanup(subBody, host, { folder: preferredFolder });
        else if (id === 'stats') disposeSub = renderStats(subBody, open);
        else if (id === 'options') disposeSub = renderOptions(subBody);
        else disposeSub = renderShrink(subBody, preferredFolder);
    }
    body.querySelectorAll('.pbx-subtabs .pbx-chip').forEach(chip => chip.addEventListener('click', () => open(chip.dataset.sub)));
    open(sub);
    return () => disposeSub();
}

// ---------- stats ----------
function renderStats(container, openSub) {
    let cancelled = false;
    container.innerHTML = `
        <div class="pbx-card-box">
            <div class="pbx-clean-row">
                <button class="pbx-btn pbx-stats-run"><i class="fa-solid fa-calculator"></i><span>${statsCache ? '다시 계산' : '용량 계산'}</span></button>
                <span class="pbx-clean-status"></span>
            </div>
            <small class="pbx-clean-note">캐릭터 폴더마다 그림 수와 용량을 세요. 파일이 많으면 1~2분 걸릴 수 있어요. "줄일 수 있는 용량"은 PNG를 WebP로 바꿨을 때의 대략적인 예상치예요.</small>
            <div class="pbx-stats"></div>
        </div>`;
    const status = text => { container.querySelector('.pbx-clean-status').textContent = text; };

    function draw() {
        const box = container.querySelector('.pbx-stats');
        if (!statsCache) { box.replaceChildren(); return; }
        const rows = [...statsCache].sort((a, b) => b.size - a.size);
        const total = rows.reduce((acc, r) => ({ count: acc.count + r.count, size: acc.size + r.size, png: acc.png + r.png }), { count: 0, size: 0, png: 0 });
        const max = Math.max(1, ...rows.map(r => r.size));
        box.innerHTML = `
            <div class="pbx-stat-total">
                <div><b>${total.count.toLocaleString()}</b><small>장</small></div>
                <div><b>${formatBytes(total.size)}</b><small>전체 용량</small></div>
                <div><b>${formatBytes(total.png * 0.8)}</b><small>줄일 수 있는 용량 (예상)</small></div>
            </div>
            <div class="pbx-stat-list">${rows.map(r => `
                <div class="pbx-stat-row">
                    <div class="pbx-stat-name">${escapeHtml(r.folder)}</div>
                    <div class="pbx-stat-bar"><span style="width:${Math.max(2, Math.round(r.size / max * 100))}%"></span></div>
                    <div class="pbx-stat-num">${r.count}장 · ${formatBytes(r.size)}</div>
                    <div class="pbx-stat-actions">
                        <button class="pbx-btn pbx-icon" data-act="clean" data-folder="${escapeHtml(r.folder)}" title="안 쓰는 그림 찾기"><i class="fa-solid fa-broom"></i></button>
                        <button class="pbx-btn pbx-icon" data-act="shrink" data-folder="${escapeHtml(r.folder)}" title="용량 줄이기" ${r.png ? '' : 'disabled'}><i class="fa-solid fa-compress"></i></button>
                    </div>
                </div>`).join('')}
            </div>`;
        box.querySelectorAll('[data-act]').forEach(button => button.addEventListener('click', () => openSub(button.dataset.act, button.dataset.folder)));
    }

    container.querySelector('.pbx-stats-run').addEventListener('click', async () => {
        const run = container.querySelector('.pbx-stats-run');
        run.disabled = true;
        try {
            const folders = await folderList();
            const result = [];
            for (let i = 0; i < folders.length; i++) {
                if (cancelled) return;
                const folder = folders[i];
                status(`${i + 1} / ${folders.length} · ${folder}`);
                const files = await listFolder(folder);
                const row = { folder, count: files.length, size: 0, png: 0 };
                await runPool(files, 8, async file => {
                    if (cancelled) return;
                    const info = await probe(folder, file);
                    row.size += info.size;
                    if (info.type === 'png') row.png += info.size;
                });
                if (row.count) result.push(row);
            }
            statsCache = result;
            status('');
            draw();
        } catch (error) {
            status(`계산 실패: ${error?.message || error}`);
        } finally {
            run.disabled = false;
        }
    });
    draw();
    return () => { cancelled = true; };
}

// ---------- shrink ----------
async function toWebp(blob, quality) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
    canvas.width = canvas.height = 0;
    return out;
}

function renderShrink(container, preferredFolder) {
    const settings = getSettings();
    let cancelled = false;
    let running = false;
    container.innerHTML = `
        <div class="pbx-card-box">
            <div class="pbx-clean-row">
                <select class="pbx-select pbx-shrink-folder"><option>폴더 불러오는 중…</option></select>
                <select class="pbx-select pbx-shrink-quality" title="화질">
                    <option value="95">화질 높음 (95)</option>
                    <option value="90">화질 보통 (90)</option>
                    <option value="80">용량 우선 (80)</option>
                </select>
            </div>
            <div class="pbx-clean-row">
                <label class="pbx-check-label"><input type="checkbox" class="pbx-shrink-backup"><span>바꾸기 전에 원본 ZIP 백업</span></label>
                <span class="pbx-spacer"></span>
                <button class="pbx-btn pbx-shrink-run"><i class="fa-solid fa-compress"></i><span>용량 줄이기</span></button>
                <button class="pbx-btn pbx-shrink-stop" hidden><i class="fa-solid fa-stop"></i><span>멈추기</span></button>
            </div>
            <small class="pbx-clean-note">PNG 그림을 WebP로 압축해서 같은 파일 이름에 덮어써요. 채팅 링크는 그대로라 그림이 깨지지 않아요. 보통 80~90% 줄어들고(1.5MB → 약 0.2MB) 눈으로는 차이가 거의 없어요.<br>
            단, PNG 안에 들어 있던 NovelAI 생성 정보(시드 등)는 사라져요. 오토픽의 "그림에서 시드 가져오기" 같은 기능은 바뀐 그림에서는 안 돼요. 덮어쓴 파일은 되돌릴 수 없으니 백업을 켜두는 걸 추천해요. 최근 30분 안에 만든 그림은 건너뛰어요.</small>
            <div class="pbx-clean-status"></div>
            <div class="pbx-progress" hidden><span></span></div>
        </div>`;
    const $ = selector => container.querySelector(selector);
    const status = text => { $('.pbx-clean-status').textContent = text; };
    const progress = ratio => {
        $('.pbx-progress').hidden = ratio === null;
        if (ratio !== null) $('.pbx-progress span').style.width = `${Math.round(ratio * 100)}%`;
    };

    $('.pbx-shrink-quality').value = String(settings.webpQuality);
    $('.pbx-shrink-quality').addEventListener('change', event => { settings.webpQuality = Number(event.target.value) || 90; saveSettings(); });
    $('.pbx-shrink-backup').checked = !!settings.webpBackup;
    $('.pbx-shrink-backup').addEventListener('change', event => { settings.webpBackup = event.target.checked; saveSettings(); });
    $('.pbx-shrink-stop').addEventListener('click', () => { cancelled = true; status('멈추는 중…'); });

    folderList().then(folders => {
        $('.pbx-shrink-folder').innerHTML = folderOptions(folders, preferredFolder);
    }).catch(() => status('폴더 목록을 불러오지 못했어요.'));

    $('.pbx-shrink-run').addEventListener('click', async () => {
        if (running) return;
        const folder = $('.pbx-shrink-folder').value;
        if (!folder) return;
        running = true;
        cancelled = false;
        $('.pbx-shrink-run').hidden = true;
        $('.pbx-shrink-stop').hidden = false;
        try {
            status('파일 확인 중…');
            const files = await listFolder(folder);
            const now = Date.now();
            const candidates = [];
            await runPool(files, 8, async file => {
                const ext = (file.match(/\.([a-z]+)$/) || [])[1];
                if (ext !== 'png') return;
                if (fileTime(file) && now - fileTime(file) < RECENT_MS) return;
                const info = await probe(folder, file);
                if (info.type === 'png') candidates.push({ file, size: info.size });
            });
            if (cancelled) { status('멈췄어요.'); return; }
            if (!candidates.length) { status('줄일 PNG 그림이 없어요. (이미 줄였거나 WebP예요)'); return; }

            const totalSize = candidates.reduce((sum, c) => sum + c.size, 0);
            const backup = $('.pbx-shrink-backup').checked;
            const ok = await confirmPopup(`<p><b>${escapeHtml(folder)}</b> 폴더의 PNG <b>${candidates.length}장</b> (${formatBytes(totalSize)})을 WebP로 바꿀까요?</p><p>원본은 덮어써져서 되돌릴 수 없어요.${backup ? ' 먼저 원본 ZIP을 내려받아요.' : ''}</p>`);
            if (!ok) { status(''); return; }

            const items = candidates.map(c => ({
                key: `/user/images/${folder}/${c.file}`, url: urlOf(folder, c.file), folder, file: c.file,
                mesId: null, prompt: '', charName: folder, date: '',
            }));
            if (backup && !(await exportItems(items, '원본백업', { confirm: false }))) {
                status('백업이 끝나지 않아서 바꾸지 않았어요.');
                return;
            }

            const quality = (Number(settings.webpQuality) || 90) / 100;
            let done = 0, changed = 0, saved = 0, failed = 0;
            for (const candidate of candidates) {
                if (cancelled) break;
                done++;
                status(`바꾸는 중… ${done} / ${candidates.length}`);
                progress(done / candidates.length);
                try {
                    const response = await fetch(urlOf(folder, candidate.file), { cache: 'no-store' });
                    if (!response.ok) throw new Error('read');
                    const original = await response.blob();
                    const webp = await toWebp(original, quality);
                    if (!webp || webp.type !== 'image/webp') {
                        status('이 브라우저는 WebP 저장을 지원하지 않아요. (아이폰 사파리 등) 다른 브라우저에서 해주세요.');
                        failed = candidates.length - changed;
                        break;
                    }
                    // Not worth it: keep the original.
                    if (webp.size > original.size * 0.9) continue;
                    const result = await postJson('/api/images/upload', {
                        image: await blobToBase64(webp), format: 'png', ch_name: folder, filename: candidate.file,
                    });
                    const expected = `${folder}/${candidate.file}`;
                    if (!String(result?.path || '').replace(/\\/g, '/').endsWith(expected)) throw new Error('path');
                    changed++;
                    saved += original.size - webp.size;
                } catch {
                    failed++;
                }
            }
            progress(null);
            statsCache = null;
            status(`${changed}장을 바꿔서 ${formatBytes(saved)} 줄였어요.${failed ? ` 실패 ${failed}장.` : ''}${cancelled ? ' (중간에 멈춤)' : ''}`);
            if (changed) toastr.success(`${formatBytes(saved)} 줄였어요.`);
        } catch (error) {
            status(`실패: ${error?.message || error}`);
        } finally {
            running = false;
            progress(null);
            $('.pbx-shrink-run').hidden = false;
            $('.pbx-shrink-stop').hidden = true;
        }
    });

    return () => { cancelled = true; };
}
