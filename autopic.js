// Bridge to AutoPic: reuse its own NovelAI "direct" generator and prompt parser,
// so model, style prefix, registered characters, seed and vibe settings all match AutoPic.
import { ctx, currentCharacter } from './settings.js';

const FOLDER_CANDIDATES = ['AutoPic', 'autopic', 'AutoPic-main', 'SillyTavern-AutoPic'];
const REFERENCE_SIZES = [[1024, 1536], [1536, 1024], [1472, 1472]];
let modules = null;

async function loadAutopic() {
    if (modules) return modules;
    for (const folder of FOLDER_CANDIDATES) {
        try {
            const base = `/scripts/extensions/third-party/${folder}`;
            const [direct, structured] = await Promise.all([
                import(`${base}/nai-direct.mjs`),
                import(`${base}/structured-prompt.mjs`),
            ]);
            if (typeof direct.generateDirect === 'function' && typeof structured.parseAutopic === 'function') {
                modules = { direct, structured };
                return modules;
            }
        } catch { /* try the next folder name */ }
    }
    throw new Error('오토픽 확장을 찾지 못했어요. 오토픽이 설치되어 있고 켜져 있는지 확인해 주세요.');
}

export function autopicSettings() {
    return ctx().extensionSettings?.AutoPic || null;
}

/** AutoPic's registered characters for the open character card. */
export function characterLibrary() {
    const avatar = currentCharacter()?.avatar;
    const list = autopicSettings()?.characterPrompts?.[avatar];
    if (!Array.isArray(list)) return [];
    return list
        .map(item => ({
            name: String(item?.name ?? '').trim(),
            prompt: String(item?.prompt ?? '').trim(),
            clothing: String(item?.clothing ?? '').trim(),
            uc: String(item?.uc ?? '').trim(),
            ...(item?.center ? { center: { ...item.center } } : {}),
            enabled: item?.enabled !== false,
        }))
        .filter(item => item.enabled && item.prompt);
}

function decode(text) {
    const area = document.createElement('textarea');
    area.innerHTML = String(text ?? '');
    return area.value;
}

/** Same letterboxing AutoPic applies to a reference image. */
function letterbox(dataUrl) {
    return new Promise(resolve => {
        const fallback = () => resolve(typeof dataUrl === 'string' ? dataUrl.split(',')[1] : '');
        try {
            const img = new Image();
            img.onload = () => {
                const aspect = img.width / img.height;
                let [tw, th] = REFERENCE_SIZES[0];
                let best = Infinity;
                for (const [cw, ch] of REFERENCE_SIZES) {
                    const diff = Math.abs(cw / ch - aspect);
                    if (diff < best) { best = diff; tw = cw; th = ch; }
                }
                const scale = Math.min(tw / img.width, th / img.height);
                const nw = Math.max(1, Math.round(img.width * scale));
                const nh = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = tw;
                canvas.height = th;
                const g = canvas.getContext('2d');
                g.fillStyle = '#000';
                g.fillRect(0, 0, tw, th);
                g.drawImage(img, Math.floor((tw - nw) / 2), Math.floor((th - nh) / 2), nw, nh);
                resolve(canvas.toDataURL('image/png').split(',')[1]);
            };
            img.onerror = fallback;
            img.src = dataUrl;
        } catch { fallback(); }
    });
}

async function saveImage(base64, folder, fileName, ext) {
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ image: base64, format: ext, ch_name: folder, filename: String(fileName).replace(/\./g, '_') }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.path) throw new Error(data.error || '그림을 저장하지 못했어요.');
    return data.path.startsWith('/') ? data.path : `/${data.path}`;
}

// NovelAI runs one generation per account at a time: queue ours.
let queue = Promise.resolve();

/**
 * Generate one picture from an <autopic> block (or plain tags) with AutoPic's settings.
 * @returns {Promise<string>} saved image path, e.g. /user/images/<char>/autopic_....png
 */
export function generateImage(promptText) {
    const job = queue.then(async () => {
        const settings = autopicSettings();
        const nai = settings?.naiParams;
        if (!nai) throw new Error('오토픽 설정을 찾지 못했어요.');
        const { direct, structured } = await loadAutopic();
        if (!direct.isDirect(nai)) {
            throw new Error('오토픽 생성 방식이 V4.5 Full / V5 Full(직접 생성)일 때만 쓸 수 있어요.');
        }
        const library = characterLibrary();
        const text = decode(promptText).trim();
        const parsed = structured.parseAutopic(text, library, decode);
        const payload = parsed || { prompt: text, characterPrompts: [] };
        return direct.generateDirect({
            nai, prompt: payload.prompt, payload, library, context: ctx(),
            getHeaders: ctx().getRequestHeaders, saveImage, letterbox,
        });
    });
    queue = job.catch(() => {});
    return job;
}

/** Wrap plain tags as an <autopic> block so it is stored and displayed like AutoPic's. */
export function asBlock(text) {
    const value = String(text || '').trim();
    if (/<autopic\b/i.test(value)) return value;
    return `<autopic>\n<scene>${value}</scene>\n</autopic>`;
}

/** Instructions for turning a description into one <autopic> block (model-facing: English). */
export function blockInstructions() {
    const settings = autopicSettings();
    const base = String(settings?.promptInjection?.prompt || '').trim();
    const refs = characterLibrary().filter(item => item.name);
    const refText = refs.length
        ? `\n\n<autopic_registered_characters>\nThese are the only valid ref names for <apchar ref="...">. Use a ref only when the exact name is listed before the '|' symbol.\n${refs.map(item => (item.clothing ? `- ${item.name} | <apchar_outfit>${item.clothing}</apchar_outfit>` : `- ${item.name}`)).join('\n')}\n</autopic_registered_characters>`
        : '';
    return `${base}${refText}

<picbox_task>
You are an image prompt writer, not a roleplay partner. Convert the user's picture request into exactly one <autopic> block that follows the rules above.
The request may be written in any language; the tags must be English.
Output only the <autopic> block. No story, no explanation, no code fences.
</picbox_task>`;
}
