// 📷 button: next to the send button, or a floating button on the left/right edge.
// It opens "픽박스로 그리기" ready to send the picture as the user's message.
import { getSettings } from './settings.js';
import { openDraw } from './draw.js';

const INPUT_ID = 'pbx_input_btn';
const FLOAT_ID = 'pbx_float_btn';

/** 'input' | 'float' | 'off' (older settings stored a boolean). */
export function buttonMode() {
    const settings = getSettings();
    if (settings.inputButtonMode === undefined) settings.inputButtonMode = settings.inputButton === false ? 'off' : 'input';
    return settings.inputButtonMode;
}

function bind(element) {
    const open = () => openDraw('', { forUser: true });
    element.addEventListener('click', open);
    element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
}

function syncInput(show) {
    let button = document.getElementById(INPUT_ID);
    if (!show) { button?.remove(); return; }
    const host = document.getElementById('rightSendForm') || document.getElementById('leftSendForm');
    if (!host) return;
    if (!button) {
        button = document.createElement('div');
        button.id = INPUT_ID;
        button.className = 'fa-solid fa-camera interactable';
        button.title = '픽박스로 그려서 보내기';
        button.tabIndex = 0;
        bind(button);
    }
    // Just left of the send button.
    const send = host.querySelector('#send_but');
    if (send && button.nextElementSibling !== send) host.insertBefore(button, send);
    else if (!send && button.parentElement !== host) host.appendChild(button);
}

const SIZE = 46;
const GAP = 12;
let watching = false;

/**
 * Keep the floating button inside the chat column, just above the input bar,
 * on PC (centered column) and phones alike, and never outside the screen.
 */
function placeFloat() {
    const button = document.getElementById(FLOAT_ID);
    if (!button) return;
    const side = getSettings().floatSide === 'left' ? 'left' : 'right';
    const column = (document.getElementById('sheld') || document.body).getBoundingClientRect();
    const form = (document.getElementById('send_form') || document.getElementById('form_sheld'))?.getBoundingClientRect();
    let left = side === 'left' ? column.left + GAP : column.right - SIZE - GAP;
    let top = (form && form.height ? form.top : window.innerHeight - 80) - SIZE - GAP;
    left = Math.min(Math.max(8, left), window.innerWidth - SIZE - 8);
    top = Math.min(Math.max(8, top), window.innerHeight - SIZE - 8);
    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.round(top)}px`;
}

function watchLayout() {
    if (watching) return;
    watching = true;
    window.addEventListener('resize', placeFloat);
    window.visualViewport?.addEventListener('resize', placeFloat);
    if (window.ResizeObserver) {
        const observer = new ResizeObserver(placeFloat);
        for (const id of ['sheld', 'send_form', 'form_sheld']) {
            const element = document.getElementById(id);
            if (element) observer.observe(element);
        }
    }
    // Themes and panels can move the chat column without resizing it.
    setInterval(placeFloat, 2000);
}

function syncFloat(show, side) {
    let button = document.getElementById(FLOAT_ID);
    if (!show) { button?.remove(); return; }
    if (!button) {
        button = document.createElement('div');
        button.id = FLOAT_ID;
        button.title = '픽박스로 그려서 보내기';
        button.tabIndex = 0;
        button.innerHTML = '<i class="fa-solid fa-camera"></i>';
        bind(button);
        document.body.appendChild(button);
    }
    button.classList.toggle('pbx-left', side === 'left');
    button.classList.toggle('pbx-right', side !== 'left');
    watchLayout();
    placeFloat();
}

export function syncInputButton() {
    const mode = buttonMode();
    syncInput(mode === 'input');
    syncFloat(mode === 'float', getSettings().floatSide || 'right');
}
