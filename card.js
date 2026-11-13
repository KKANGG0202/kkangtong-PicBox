// "대사 카드": one shareable image with the picture and a line from the scene.
// Fonts are free Google Fonts (SIL Open Font License), loaded only when the card maker opens.
import { downloadBlob, getSettings, saveSettings } from './settings.js';
import { safeName } from './zip.js';

const WIDTH = 1080;
const THEMES = {
    light: { bg: '#fbf8f3', text: '#2b2621', name: '#c0563f', sub: '#8a8178' },
    dark: { bg: '#17161a', text: '#f1ede7', name: '#e8a27a', sub: '#9a948c' },
};
const SIZES = { small: 34, normal: 40, large: 48, huge: 58 };

/** label shown in the picker → Google Fonts family name ('' = the SillyTavern theme font) */
const FONTS = [
    ['테마 글꼴', ''],
    ['노토 산스', 'Noto Sans KR'],
    ['노토 세리프', 'Noto Serif KR'],
    ['나눔고딕', 'Nanum Gothic'],
    ['나눔명조', 'Nanum Myeongjo'],
    ['고운돋움', 'Gowun Dodum'],
    ['고운바탕', 'Gowun Batang'],
    ['송명', 'Song Myung'],
    ['나눔손글씨 펜', 'Nanum Pen Script'],
    ['나눔손글씨 붓', 'Nanum Brush Script'],
    ['개구', 'Gaegu'],
    ['감자꽃', 'Gamja Flower'],
    ['하이멜로디', 'Hi Melody'],
    ['푸어스토리', 'Poor Story'],
    ['동글', 'Dongle'],
    ['주아', 'Jua'],
    ['도현', 'Do Hyeon'],
    ['연성', 'Yeon Sung'],
    ['동해독도', 'East Sea Dokdo'],
    ['검은고딕', 'Black Han Sans'],
];

const DEFAULT_STYLE = Object.freeze({
    layout: 'below', theme: 'light', size: 'normal', font: '', align: 'left',
    italic: false, bold: false, textColor: '', nameColor: '', bgColor: '',
});

function savedStyle() {
    const settings = getSettings();
    settings.cardStyle = { ...DEFAULT_STYLE, ...(settings.cardStyle || {}) };
    return settings.cardStyle;
}

let fontsLinked = false;
function linkFonts() {
    if (fontsLinked) return;
    fontsLinked = true;
    const families = FONTS.map(([, family]) => family).filter(Boolean)
        .map(family => `family=${family.replace(/ /g, '+')}${/Sans KR|Serif KR/.test(family) ? ':wght@400;700' : ''}`).join('&');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    document.head.appendChild(link);
}

function pageFont() {
    return getComputedStyle(document.body).fontFamily || 'sans-serif';
}

function fontStack(family) {
    return family ? `"${family}", ${pageFont()}` : pageFont();
}

/** Make sure the chosen font is ready before drawing on the canvas (offline: falls back quietly). */
async function ensureFont(family, size) {
    if (!family || !document.fonts?.load) return;
    try {
        await Promise.race([
            document.fonts.load(`${size}px "${family}"`, '가나다abc'),
            new Promise(resolve => setTimeout(resolve, 4000)),
        ]);
    } catch { /* use the fallback font */ }
}

/** Wrap text to a width; Korean has few spaces, so fall back to per-character breaks. */
function wrap(g, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text || '').split('\n')) {
        if (!paragraph.trim()) { lines.push(''); continue; }
        let line = '';
        for (const token of paragraph.split(/(\s+)/)) {
            const next = line + token;
            if (g.measureText(next).width <= maxWidth) { line = next; continue; }
            if (line.trim()) lines.push(line.trimEnd());
            line = '';
            // A token longer than the line: break it by characters.
            for (const ch of token.trimStart()) {
                if (g.measureText(line + ch).width > maxWidth && line) { lines.push(line); line = ''; }
                line += ch;
            }
        }
        if (line.trim()) lines.push(line.trimEnd());
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines;
}

/** Candidate lines: every quoted line of the message first, then its paragraphs. */
function lineCandidates(excerpt) {
    const text = String(excerpt || '').trim();
    const quotes = [...text.matchAll(/["“]([^"”\n]{2,240})["”]/g)].map(m => `"${m[1].trim()}"`);
    const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(p => p && !/^["“]/.test(p))
        .map(p => (p.length > 160 ? `${p.slice(0, 160).trimEnd()}…` : p));
    const all = [...new Set([...quotes, ...paragraphs])];
    return all.length ? all : [''];
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('그림을 불러오지 못했어요.'));
        img.src = src;
    });
}

function render(o) {
    const theme = THEMES[o.theme] || THEMES.light;
    const overlay = o.layout === 'overlay';
    const stack = fontStack(o.font);
    const fontSize = SIZES[o.size] || SIZES.normal;
    const weight = o.bold ? '700' : '400';
    const slant = o.italic ? 'italic ' : '';
    const mainFont = `${slant}${weight} ${fontSize}px ${stack}`;
    const pad = 64;
    const imgH = Math.round(o.img.naturalHeight * (WIDTH / o.img.naturalWidth));
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = mainFont;
    const quote = o.text.trim();
    // Italic glyphs lean right; keep a little room so the last letter is not clipped.
    const lines = quote ? wrap(measure, quote, WIDTH - pad * 2 - (o.italic ? fontSize * 0.3 : 0)) : [];
    const lineH = Math.round(fontSize * 1.6);
    const nameSize = Math.round(fontSize * 0.75);
    const nameH = o.name ? nameSize + 18 : 0;
    const footH = o.footer ? 44 : 0;
    const textBlockH = (lines.length ? lines.length * lineH : 0) + nameH;

    const panelH = overlay ? 0 : (textBlockH ? textBlockH + pad * 2 : 0) + footH + (textBlockH ? 0 : pad / 2);
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = imgH + panelH;
    const g = canvas.getContext('2d');
    g.fillStyle = o.bgColor || theme.bg;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(o.img, 0, 0, WIDTH, imgH);

    let y;
    let textColor = o.textColor || theme.text;
    let nameColor = o.nameColor || theme.name;
    let subColor = theme.sub;
    if (overlay) {
        // Dark gradient over the bottom of the picture, light text on top.
        const shade = Math.min(imgH, textBlockH + pad * 2 + footH + 120);
        const gradient = g.createLinearGradient(0, imgH - shade, 0, imgH);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(0.45, 'rgba(0,0,0,0.55)');
        gradient.addColorStop(1, 'rgba(0,0,0,0.85)');
        g.fillStyle = gradient;
        g.fillRect(0, imgH - shade, WIDTH, shade);
        textColor = o.textColor || '#ffffff';
        nameColor = o.nameColor || '#ffffff';
        subColor = 'rgba(255,255,255,0.7)';
        y = imgH - pad - footH - textBlockH;
    } else {
        y = imgH + pad;
    }

    const center = o.align === 'center';
    const x = center ? WIDTH / 2 : pad;
    g.textAlign = center ? 'center' : 'left';
    g.textBaseline = 'top';
    if (o.name && lines.length) {
        g.font = `${slant}700 ${nameSize}px ${stack}`;
        g.fillStyle = nameColor;
        g.fillText(o.name, x, y);
        y += nameH;
    }
    g.font = mainFont;
    g.fillStyle = textColor;
    for (const line of lines) {
        g.fillText(line, x, y);
        y += lineH;
    }
    if (o.footer) {
        g.font = `22px ${stack}`;
        g.fillStyle = subColor;
        const footY = overlay ? imgH - pad + 8 : canvas.height - pad / 2 - 26;
        g.fillText(o.footer, x, footY);
    }
    return canvas;
}

/** Open the card maker for one gallery item. */
export async function openCard(item) {
    document.getElementById('pbx_card')?.remove();
    linkFonts();
    let img;
    try { img = await loadImage(item.url); } catch (error) { toastr.error(error.message); return; }

    const date = item.date ? new Date(item.date) : null;
    const footer = [item.charName, date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : ''].filter(Boolean).join(' · ');
    const style = savedStyle();
    const state = { text: '', name: item.speaker || item.charName || '', footer, ...style };

    const chips = (group, options) => `<span class="pbx-chips" data-group="${group}">${options.map(([value, label]) => `<button class="pbx-chip" data-value="${value}">${label}</button>`).join('')}</span>`;
    const root = document.createElement('div');
    root.id = 'pbx_card';
    root.innerHTML = `
        <div class="pbx-card-panel">
            <div class="pbx-head">
                <b class="pbx-title"><i class="fa-solid fa-quote-left"></i> 대사 카드</b>
                <span class="pbx-spacer"></span>
                <button class="pbx-btn pbx-icon pbx-x" title="닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="pbx-card-body">
                <div class="pbx-card-preview"><canvas></canvas></div>
                <div class="pbx-card-controls">
                    <div class="pbx-card-label"><span class="pbx-opt-row">대사 <button class="pbx-btn pbx-card-next" title="이 메시지의 다른 대사로 바꾸기"><i class="fa-solid fa-rotate"></i><span class="pbx-card-count"></span></button></span></div>
                    <label class="pbx-card-label"><textarea class="pbx-area pbx-card-text" rows="4" placeholder="카드에 넣을 대사"></textarea></label>
                    <label class="pbx-card-label">이름<input class="pbx-area pbx-card-name" maxlength="40"></label>
                    <label class="pbx-card-label">아래 작은 글씨<input class="pbx-area pbx-card-footer" maxlength="60"></label>

                    <div class="pbx-card-section">글꼴</div>
                    <select class="pbx-select pbx-card-font">${FONTS.map(([label, family]) => `<option value="${family}" style="${family ? `font-family:'${family}'` : ''}">${label}</option>`).join('')}</select>
                    <div class="pbx-opt-row"><span>크기</span>${chips('size', [['small', '작게'], ['normal', '보통'], ['large', '크게'], ['huge', '아주 크게']])}</div>
                    <div class="pbx-opt-row"><span>모양</span>
                        <span class="pbx-chips">
                            <button class="pbx-chip pbx-toggle" data-key="bold"><b>굵게</b></button>
                            <button class="pbx-chip pbx-toggle" data-key="italic"><i style="font-family:inherit">기울기</i></button>
                        </span>
                        ${chips('align', [['left', '왼쪽'], ['center', '가운데']])}
                    </div>

                    <div class="pbx-card-section">배치와 색</div>
                    <div class="pbx-opt-row"><span>배치</span>${chips('layout', [['below', '그림 아래'], ['overlay', '그림 위']])}</div>
                    <div class="pbx-opt-row"><span>기본 색</span>${chips('theme', [['light', '밝게'], ['dark', '어둡게']])}</div>
                    <div class="pbx-opt-row pbx-colors">
                        <label>대사 <input type="color" data-color="textColor"></label>
                        <label>이름 <input type="color" data-color="nameColor"></label>
                        <label>배경 <input type="color" data-color="bgColor"></label>
                        <button class="pbx-btn pbx-card-reset" title="색을 기본으로">되돌리기</button>
                    </div>

                    <div class="pbx-draw-row">
                        <span class="pbx-spacer"></span>
                        <button class="pbx-btn pbx-card-copy"><i class="fa-solid fa-copy"></i><span>복사</span></button>
                        <button class="pbx-btn pbx-primary pbx-card-save"><i class="fa-solid fa-download"></i><span>저장</span></button>
                    </div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(root);
    const $q = selector => root.querySelector(selector);
    let canvas = null;
    let timer = 0;
    let drawToken = 0;

    const remember = () => {
        const settings = getSettings();
        settings.cardStyle = Object.fromEntries(Object.keys(DEFAULT_STYLE).map(key => [key, state[key]]));
        saveSettings();
    };
    const draw = async () => {
        const token = ++drawToken;
        await ensureFont(state.font, SIZES[state.size] || 40);
        if (token !== drawToken || !root.isConnected) return;
        canvas = render({ img, ...state });
        const view = $q('.pbx-card-preview canvas');
        view.width = canvas.width;
        view.height = canvas.height;
        view.getContext('2d').drawImage(canvas, 0, 0);
    };
    const redraw = () => { clearTimeout(timer); timer = setTimeout(draw, 120); };
    const syncControls = () => {
        root.querySelectorAll('.pbx-chips[data-group]').forEach(group => {
            group.querySelectorAll('.pbx-chip').forEach(chip => chip.classList.toggle('active', chip.dataset.value === state[group.dataset.group]));
        });
        root.querySelectorAll('.pbx-toggle').forEach(chip => chip.classList.toggle('active', !!state[chip.dataset.key]));
        $q('.pbx-card-font').value = state.font;
        const theme = THEMES[state.theme] || THEMES.light;
        const overlay = state.layout === 'overlay';
        const fallback = { textColor: overlay ? '#ffffff' : theme.text, nameColor: overlay ? '#ffffff' : theme.name, bgColor: theme.bg };
        root.querySelectorAll('input[data-color]').forEach(input => { input.value = state[input.dataset.color] || fallback[input.dataset.color]; });
    };
    const changed = () => { syncControls(); remember(); draw(); };

    const candidates = lineCandidates(item.excerpt);
    let pick = 0;
    state.text = candidates[0];
    const showPick = () => {
        $q('.pbx-card-count').textContent = candidates.length > 1 ? `다른 대사 ${pick + 1}/${candidates.length}` : '다른 대사 없음';
        $q('.pbx-card-next').disabled = candidates.length < 2;
    };
    $q('.pbx-card-next').addEventListener('click', () => {
        pick = (pick + 1) % candidates.length;
        state.text = candidates[pick];
        $q('.pbx-card-text').value = state.text;
        showPick();
        draw();
    });
    showPick();
    $q('.pbx-card-text').value = state.text;
    $q('.pbx-card-name').value = state.name;
    $q('.pbx-card-footer').value = state.footer;
    for (const [selector, key] of [['.pbx-card-text', 'text'], ['.pbx-card-name', 'name'], ['.pbx-card-footer', 'footer']]) {
        $q(selector).addEventListener('input', event => { state[key] = event.target.value; redraw(); });
        $q(selector).addEventListener('keydown', event => event.stopPropagation());
    }
    root.querySelectorAll('.pbx-chips[data-group] .pbx-chip').forEach(chip => chip.addEventListener('click', () => {
        state[chip.closest('.pbx-chips').dataset.group] = chip.dataset.value;
        changed();
    }));
    root.querySelectorAll('.pbx-toggle').forEach(chip => chip.addEventListener('click', () => {
        state[chip.dataset.key] = !state[chip.dataset.key];
        changed();
    }));
    $q('.pbx-card-font').addEventListener('change', event => { state.font = event.target.value; changed(); });
    root.querySelectorAll('input[data-color]').forEach(input => input.addEventListener('input', () => {
        state[input.dataset.color] = input.value;
        remember();
        redraw();
    }));
    $q('.pbx-card-reset').addEventListener('click', () => {
        state.textColor = state.nameColor = state.bgColor = '';
        changed();
    });

    const toBlob = () => new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const close = () => { document.removeEventListener('keydown', onKey, true); root.remove(); };
    function onKey(event) { if (event.key === 'Escape') { event.stopPropagation(); close(); } }
    $q('.pbx-x').addEventListener('click', close);
    root.addEventListener('click', event => { if (event.target === root) close(); });
    $q('.pbx-card-save').addEventListener('click', async () => {
        const blob = await toBlob();
        downloadBlob(blob, `${safeName(state.name || item.charName || 'card')}_대사카드_${Date.now()}.png`);
    });
    $q('.pbx-card-copy').addEventListener('click', async () => {
        try {
            const blob = await toBlob();
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            toastr.success('카드를 복사했어요. 붙여넣기 하면 돼요.');
        } catch {
            toastr.info('이 브라우저에서는 복사가 안 돼요. 저장을 눌러주세요.');
        }
    });
    document.addEventListener('keydown', onKey, true);
    syncControls();
    draw();
}
