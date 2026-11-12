// PicBox: gallery, ZIP export, cleanup, favorites and chat image folding for SillyTavern.
// Everything is reached from the wand menu (or /picbox); there is no extensions-panel drawer.
import { getSettings, LOG, DISPLAY_NAME } from './settings.js';
import { initFold } from './fold.js';
import { openGallery } from './gallery.js';

function addWandButton() {
    if (document.getElementById('pbx_wand')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = 'pbx_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<div class="fa-solid fa-images extensionsMenuExtensionButton"></div><span>${DISPLAY_NAME} 갤러리</span>`;
    item.addEventListener('click', () => {
        document.getElementById('extensionsMenu')?.classList.remove('openDrawer');
        $('#extensionsMenu').hide?.();
        openGallery('chat');
    });
    menu.appendChild(item);
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand } = SillyTavern.getContext();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'picbox',
        callback: () => { openGallery('chat'); return ''; },
        helpString: 'Open the PicBox image gallery.',
    }));
}

(function init() {
    getSettings();
    let ready = false;
    const setup = () => {
        if (ready) return;
        ready = true;
        addWandButton();
        initFold();
        try { registerCommand(); } catch (error) { console.warn(LOG, 'slash command', error); }
    };
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.APP_READY, setup);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
    else setup();
    console.log(`${LOG} Loaded`);
})();
