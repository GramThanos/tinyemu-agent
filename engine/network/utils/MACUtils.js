export function macToString(buf, offset = 0) {
    return `${buf[offset].toString(16).padStart(2, '0')}:${buf[offset + 1].toString(16).padStart(2, '0')}:${buf[offset + 2].toString(16).padStart(2, '0')}:${buf[offset + 3].toString(16).padStart(2, '0')}:${buf[offset + 4].toString(16).padStart(2, '0')}:${buf[offset + 5].toString(16).padStart(2, '0')}`;
}

/**
 * Pack a 6-byte MAC into a single exact integer (< 2^48, safe as a Map key /
 * Number). Lets the switch index its MAC table without formatting a hex string
 * on every unicast frame. `equals` handles the raw-byte compares elsewhere.
 */
export function macKeyNum(buf, offset = 0) {
    const hi = buf[offset] * 256 + buf[offset + 1];                  // top 16 bits
    const lo = buf[offset + 2] * 16777216 + buf[offset + 3] * 65536  // low 32 bits
             + buf[offset + 4] * 256 + buf[offset + 5];
    return hi * 4294967296 + lo;
}

export function parseMAC(str) {
    const parts = str.split(':').map(s => parseInt(s, 16));
    if (parts.length !== 6 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
        throw new Error(`Invalid MAC address: ${str}`);
    }
    return new Uint8Array(parts);
}

export function macEquals(a, b, offsetA = 0, offsetB = 0) {
    return a[offsetA] === b[offsetB] &&
           a[offsetA + 1] === b[offsetB + 1] &&
           a[offsetA + 2] === b[offsetB + 2] &&
           a[offsetA + 3] === b[offsetB + 3] &&
           a[offsetA + 4] === b[offsetB + 4] &&
           a[offsetA + 5] === b[offsetB + 5];
}

export function isBroadcastMAC(buf, offset = 0) {
    return buf[offset] === 0xff && buf[offset + 1] === 0xff &&
           buf[offset + 2] === 0xff && buf[offset + 3] === 0xff &&
           buf[offset + 4] === 0xff && buf[offset + 5] === 0xff;
}

export function isMulticastMAC(buf, offset = 0) {
    return (buf[offset] & 0x01) !== 0;
}

export function isLocallyAdministered(buf, offset = 0) {
    return (buf[offset] & 0x02) !== 0;
}

export function generateMAC(vmId, prefix = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00]) {
    const mac = new Uint8Array(6);
    mac.set(prefix);
    const hash = simpleHash(String(vmId));
    mac[1] = (hash >> 24) & 0xff;
    mac[2] = (hash >> 16) & 0xff;
    mac[3] = (hash >> 8) & 0xff;
    mac[4] = hash & 0xff;
    mac[5] = vmId & 0xff;
    return mac;
}

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

export function randomMAC() {
    const mac = new Uint8Array(6);
    mac[0] = 0x02 | (Math.random() * 256) & 0xfc;
    for (let i = 1; i < 6; i++) {
        mac[i] = Math.floor(Math.random() * 256);
    }
    return mac;
}

export const MACUtils = {
    toString: macToString,
    keyNum: macKeyNum,
    parse: parseMAC,
    equals: macEquals,
    isBroadcast: isBroadcastMAC,
    isMulticast: isMulticastMAC,
    isLocallyAdministered,
    generate: generateMAC,
    random: randomMAC
};