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
        let payload = parsed || { prompt: text, characterPrompts: [] };
        let run = nai;
        const shot = objectShot(payload.prompt || '');
        if (shot) ({ payload, nai: run } = noPeople(payload, nai, shot));
        return direct.generateDirect({
            nai: run, prompt: payload.prompt, payload, library, context: ctx(),
            getHeaders: ctx().getRequestHeaders, saveImage, letterbox,
        });
    });
    queue = job.catch(() => {});
    return job;
}

// A picture with no person in it (food, a view, an object): NovelAI still likes to slip eyes, faces or hands in,
// and a character can come in from AutoPic's own prefix or imported characters even when the block has none.
// So for such a picture every way a person could get in is closed, for that one picture.
//   'none'  — the scene says no humans: nobody at all.
//   'hands' — the scene says pov hands: only the photographer's hands at the bottom of the frame (no humans would
//             fight with hands, which is where the stray eyes come from, so it is left out).
const NO_HUMANS = /(?:^|[,{(\s]|::)\s*no[ _]humans?\b/i;
const POV_HANDS = /(?:^|[,{(\s]|::)\s*pov[ _]hands?\b/i;
const PERSON = /^(?:\d+\s*(?:girl|boy|other)s?|solo|solo focus|multiple (?:girls|boys|others)|girl|boy|man|woman|men|women|person|people|humans?|male|female|couple|child|(?:pov )?hands?|fingers?|arms?|holding.*|eyes?|.*\beyes\b.*|face|.*\bface\b.*|lips|mouth|skin|.*\bhair\b.*|smile|smiling|blush|looking at .*|selfie|upper body|cowboy shot|full body|portrait|close-up of .*face.*|no humans?|pov)$/i;
const HANDS_OK = /^(?:pov|pov hands?|hands?|fingers?|holding.*|.*\bhand\b.*|nail polish|ring|bracelet|sleeves?|wristwatch)$/i;
const UC_NONE = '2::human::, 2::person::, 1girl, 1boy, multiple girls, multiple boys, face, eyes, eye, hands, fingers, body parts, skin, hair, lips';
const UC_HANDS = '2::face::, 2::eyes::, 2::head::, eye, hair, lips, upper body, 1girl, 1boy, multiple people, extra hands, extra fingers, extra arms';
const tagWord = tag => String(tag).replace(/^-?\d+(?:\.\d+)?::|::$/g, '').replace(/[{}[\]()]/g, '').replace(/:\s*-?\d+(?:\.\d+)?$/, '').replace(/_/g, ' ').trim();
const objectShot = prompt => (POV_HANDS.test(prompt) ? 'hands' : NO_HUMANS.test(prompt) ? 'none' : '');
const keepTags = (list, shot) => String(list || '').split(',').map(t => t.trim())
    .filter(t => t && !NO_HUMANS.test(t) && !(PERSON.test(tagWord(t)) && !(shot === 'hands' && HANDS_OK.test(tagWord(t)))));
function noPeople(payload, nai, shot) {
    const kept = keepTags(payload.prompt, shot).filter(t => !/^pov( hands?)?$/i.test(tagWord(t)));
    const lead = shot === 'hands' ? ['pov', 'pov hands', 'hands at bottom of frame'] : ['2::no humans::', 'still life', 'object focus'];
    const prompt = [...lead, ...kept].join(', ');
    const negative_prompt = [payload.negative_prompt, shot === 'hands' ? UC_HANDS : UC_NONE].filter(Boolean).join(', ');
    // the run's own copy of the settings: AutoPic's prefix without its character blocks or person tags, no imported characters
    const mode = nai.generationMode;
    const own = structuredClone(nai.directSettings?.[mode] || {});
    if (own.prefix) own.prefix = keepTags(String(own.prefix).replace(/<apchar\b[\s\S]*?<\/apchar>/gi, ''), 'none').join(', ');
    own.useImportedCharacters = false;
    return {
        payload: { ...payload, prompt, negative_prompt, characterPrompts: [] },
        nai: { ...nai, directSettings: { ...(nai.directSettings || {}), [mode]: own } },
    };
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
If the picture has no person in it (food, a view, a pet, an object), put no humans in <scene> and write no <apchar> at all. If only the photographer's hands show (holding a cup, food in hand), write pov hands instead of no humans, still with no <apchar>.
Output only the <autopic> block. No story, no explanation, no code fences.
</picbox_task>`;
}
