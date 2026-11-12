// Story view: images in message order with the text of their message, like a webtoon.
// Only images near the screen keep their src, so long stories stay light on phones.
import { escapeHtml } from './settings.js';
import { jumpTo, isFavorite } from './grid.js';

function chatTitle(file) {
    const match = String(file || '').match(/(\d{4}-\d{2}-\d{2})@(\d{2})h(\d{2})m/);
    const copy = /sync-conflict/i.test(String(file)) ? ' (동기화 충돌 사본)' : '';
    return match ? `${match[1]} ${match[2]}:${match[3]} 채팅${copy}` : (file || '채팅');
}

/**
 * @param {HTMLElement} container
 * @param {object[]} items
 * @param {{closeAll: () => void, onOpen: (index: number, list: object[]) => void}} options
 * @returns {() => void}
 */
export function renderStory(container, items, options) {
    container.replaceChildren();
    if (!items.length) {
        container.innerHTML = '<div class="pbx-empty">그림이 없어요.</div>';
        return () => {};
    }

    // Oldest chat first, then message order: reads like the story happened.
    const list = [...items].sort((a, b) => String(a.chatFile).localeCompare(String(b.chatFile)) || (a.mesId ?? 0) - (b.mesId ?? 0));
    const story = document.createElement('div');
    story.className = 'pbx-story';

    let lastChat = null;
    list.forEach((item, index) => {
        if (item.chatFile !== lastChat) {
            lastChat = item.chatFile;
            const head = document.createElement('div');
            head.className = 'pbx-story-chat';
            head.textContent = item.isCurrent ? `${chatTitle(item.chatFile)} · 지금 채팅` : chatTitle(item.chatFile);
            story.appendChild(head);
        }
        const card = document.createElement('article');
        card.className = 'pbx-story-card';
        card.dataset.index = String(index);
        card.innerHTML = `
            <div class="pbx-story-img"><img alt="" decoding="async"></div>
            <div class="pbx-story-meta">
                <span>${escapeHtml(item.speaker || item.charName || '')}${Number.isInteger(item.mesId) ? ` · #${item.mesId}` : ''}${isFavorite(item.key) ? ' · ★' : ''}</span>
                <button class="pbx-btn pbx-icon pbx-story-jump" title="메시지로 이동"><i class="fa-solid fa-location-arrow"></i></button>
            </div>
            <div class="pbx-story-text"></div>`;
        card.querySelector('.pbx-story-text').textContent = item.excerpt || '';
        card.querySelector('.pbx-story-img').addEventListener('click', () => options.onOpen(index, list));
        card.querySelector('.pbx-story-jump').addEventListener('click', () => jumpTo(item, options.closeAll));
        story.appendChild(card);
    });
    container.appendChild(story);

    const root = container.closest('.pbx-body') || null;
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const img = entry.target.querySelector('img');
            const item = list[Number(entry.target.dataset.index)];
            if (entry.isIntersecting) {
                if (!img.getAttribute('src')) img.src = item.url;
            } else if (img.getAttribute('src') && img.naturalWidth) {
                // Keep the box size so the scroll position does not jump, then free the image.
                img.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
                img.removeAttribute('src');
            }
        }
    }, { root, rootMargin: '1200px 0px' });
    story.querySelectorAll('.pbx-story-card').forEach(card => observer.observe(card));

    return () => observer.disconnect();
}
