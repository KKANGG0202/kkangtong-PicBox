// Minimal store-only ZIP writer (PNG/WebP are already compressed). UTF-8 file names.
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

/**
 * @param {{name: string, data: Uint8Array, date?: Date}[]} entries
 * @returns {Blob}
 */
export function buildZip(entries) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const data = entry.data;
        const crc = crc32(data);
        const { time, day } = dosDateTime(entry.date || new Date());

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // UTF-8 names
        local.setUint16(8, 0, true); // stored
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        parts.push(local.buffer, name, data);

        const record = new DataView(new ArrayBuffer(46));
        record.setUint32(0, 0x02014b50, true);
        record.setUint16(4, 20, true);
        record.setUint16(6, 20, true);
        record.setUint16(8, 0x0800, true);
        record.setUint16(10, 0, true);
        record.setUint16(12, time, true);
        record.setUint16(14, day, true);
        record.setUint32(16, crc, true);
        record.setUint32(20, data.length, true);
        record.setUint32(24, data.length, true);
        record.setUint16(28, name.length, true);
        record.setUint32(42, offset, true);
        central.push(record.buffer, name);

        offset += 30 + name.length + data.length;
    }

    const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/** Characters not allowed in file names on Windows/Android. */
export function safeName(text) {
    return String(text || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'image';
}
