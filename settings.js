// Shared settings and small helpers.
export const MODULE_NAME = 'picbox';
export const DISPLAY_NAME = '픽박스';
export const LOG = '[PicBox]';

const defaultSettings = Object.freeze({
    foldEnabled: true,
    foldKeep: 3,
    foldMobileOnly: false,
    zipWithPrompts: true,
    favorites: {},
    favFolders: [],
    webpQuality: 90,
    webpBackup: true,
    longPressViewer: true,
    drawAutoDelete: false,
    inputButton: true,
    floatSide: 'right',
    photoNote: true,
    autoStripTags: false,
    storyLinesOnly: false,
});

export function ctx() {
    return SillyTavern.getContext();
}

export function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
        // Carry over the options of the earlier stand-alone fold extension.
        const old = extensionSettings.autopic_fold;
        if (old) {
            extensionSettings[MODULE_NAME].foldEnabled = !!old.enabled;
            extensionSettings[MODULE_NAME].foldKeep = Number(old.keepCount) || 3;
            extensionSettings[MODULE_NAME].foldMobileOnly = !!old.mobileOnly;
        }
    }
    const settings = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) settings[key] = structuredClone(defaultSettings[key]);
    }
    if (!settings.favorites || typeof settings.favorites !== 'object') settings.favorites = {};
    if (!Array.isArray(settings.favFolders)) settings.favFolders = [];
    return settings;
}

/** Real image type from the first bytes (a converted file keeps its .png name). */
export function sniffExt(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    if (b[0] === 0xFF && b[1] === 0xD8) return 'jpg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    return '';
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

export async function runPool(items, limit, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            await worker(items[index], index);
        }
    });
    await Promise.all(runners);
}

export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

export function isMobileDevice() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function currentChatId() {
    const c = ctx();
    return typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : c.chatId;
}

export function currentCharacter() {
    const c = ctx();
    if (c.groupId) return null;
    const id = c.characterId;
    if (id === undefined || id === null || id === '') return null;
    return c.characters?.[id] ?? null;
}

export async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

export async function confirmPopup(html) {
    const c = ctx();
    const result = await c.callGenericPopup(html, c.POPUP_TYPE.CONFIRM);
    return result === c.POPUP_RESULT.AFFIRMATIVE || result === true;
}

export function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Clipboard API is unavailable on plain http from another device (e.g. phone over LAN).
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        area.remove();
        return ok;
    }
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
