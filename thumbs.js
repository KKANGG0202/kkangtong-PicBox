// Small WebP thumbnails generated in the browser and cached in IndexedDB,
// so the gallery grid never has to show full-size 2 MB PNGs.
const THUMB_WIDTH = 320;
const CONCURRENCY = 2;

let store = null;
function getStore() {
    if (store) return store;
    const lf = SillyTavern.libs?.localforage ?? window.localforage;
    store = lf ? lf.createInstance({ name: 'PicBox', storeName: 'thumbs' }) : null;
    return store;
}

const queue = [];
let running = 0;

async function render(url) {
    const cache = getStore();
    try {
        const cached = await cache?.getItem(url);
        if (cached instanceof Blob) return cached;
    } catch { /* cache unavailable */ }

    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const scale = Math.min(1, THUMB_WIDTH / image.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    image.src = '';
    let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.8));
    if (!blob) blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    if (!blob) throw new Error('thumbnail failed');
    try { await cache?.setItem(url, blob); } catch { /* quota: still show it */ }
    return blob;
}

function pump() {
    while (running < CONCURRENCY && queue.length) {
        const job = queue.shift();
        if (job.cancelled()) { job.resolve(null); continue; }
        running++;
        render(job.url).then(job.resolve, job.reject).finally(() => { running--; pump(); });
    }
}

/** Resolves to a Blob, or null when cancelled before it started. */
export function getThumb(url, cancelled = () => false) {
    return new Promise((resolve, reject) => {
        queue.push({ url, resolve, reject, cancelled });
        pump();
    });
}

export async function forgetThumb(url) {
    try { await getStore()?.removeItem(url); } catch { /* ignore */ }
}

export async function clearThumbs() {
    try { await getStore()?.clear(); } catch { /* ignore */ }
}
