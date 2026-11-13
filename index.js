// PicBox: gallery, ZIP export, cleanup, favorites, drawing and chat image folding for SillyTavern.
// Everything is reached from the wand menu (or /picbox, /pbdraw); there is no extensions-panel drawer.
import { getSettings, LOG, DISPLAY_NAME } from './settings.js';
import { initFold } from './fold.js';
import { initLongPress } from './longpress.js';
import { initRetry } from './retry.js';
import { openGallery } from './gallery.js';
import { openDraw } from './draw.js';
import { syncInputButton } from './inputbutton.js';
import { initStrip } from './strip.js';

function closeWandMenu() {
    document.getElementById('extensionsMenu')?.classList.remove('openDrawer');
    $('#extensionsMenu').hide?.();
}

function addWandButtons() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('pbx_wand')) return;
    const make = (id, icon, label, onClick) => {
        const item = document.createElement('div');
        item.id = id;
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = `<div class="fa-solid ${icon} extensionsMenuExtensionButton"></div><span>${label}</span>`;
        item.addEventListener('click', () => { closeWandMenu(); onClick(); });
        menu.appendChild(item);
    };
    make('pbx_wand', 'fa-images', `${DISPLAY_NAME} 갤러리`, () => openGallery('chat'));
    make('pbx_wand_draw', 'fa-palette', `${DISPLAY_NAME}로 그리기`, () => openDraw());
}

function registerCommands() {
    const { SlashCommandParser, SlashCommand } = SillyTavern.getContext();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'picbox',
        callback: () => { openGallery('chat'); return ''; },
        helpString: 'Open the PicBox image gallery.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pbdraw',
        callback: (_args, text) => { openDraw(String(text || '')); return ''; },
        helpString: 'Open the PicBox drawing window, optionally with a picture request.',
    }));
}

(function init() {
    getSettings();
    let ready = false;
    const setup = () => {
        if (ready) return;
        ready = true;
        addWandButtons();
        initFold();
        initLongPress();
        initRetry();
        initStrip();
        syncInputButton();
        // Some themes or extensions rebuild the input bar later.
        setTimeout(syncInputButton, 3000);
        try { registerCommands(); } catch (error) { console.warn(LOG, 'slash command', error); }
    };
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.APP_READY, setup);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
    else setup();
    console.log(`${LOG} Loaded`);
})();
