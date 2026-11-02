export function ipToString(buf, offset = 0) {
    return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

export function ipToNumber(buf, offset = 0) {
    return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

export function numberToIP(num) {
    return new Uint8Array([
        (num >> 24) & 0xff,
        (num >> 16) & 0xff,
        (num >> 8) & 0xff,
        num & 0xff
    ]);
}

export function parseIP(str) {
    const parts = str.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => p < 0 || p > 255 || isNaN(p))) {
        throw new Error(`Invalid IP address: ${str}`);
    }
    return new Uint8Array(parts);
}

export function parseCIDR(str) {
    const [ipStr, prefixStr] = str.split('/');
    const ip = parseIP(ipStr);
    const prefix = parseInt(prefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`Invalid CIDR prefix: ${prefixStr}`);
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { ip, prefix, mask: numberToIP(mask) };
}

export function ipEquals(a, b, offsetA = 0, offsetB = 0) {
    return a[offsetA] === b[offsetB] &&
           a[offsetA + 1] === b[offsetB + 1] &&
           a[offsetA + 2] === b[offsetB + 2] &&
           a[offsetA + 3] === b[offsetB + 3];
}

export function ipInSubnet(ip, subnetIP, mask) {
    const ipNum = ipToNumber(ip);
    const subnetNum = ipToNumber(subnetIP);
    const maskNum = ipToNumber(mask);
    return (ipNum & maskNum) === (subnetNum & maskNum);
}

export function nextIP(ip) {
    const num = ipToNumber(ip) + 1;
    return numberToIP(num);
}

export function prevIP(ip) {
    const num = ipToNumber(ip) - 1;
    return numberToIP(num);
}

export function ipToUint32Array(ip, offset = 0) {
    return new Uint32Array([ipToNumber(ip, offset)]);
}

export function broadcastIP(subnetIP, mask) {
    const subnetNum = ipToNumber(subnetIP);
    const maskNum = ipToNumber(mask);
    const broadcastNum = subnetNum | (~maskNum >>> 0);
    return numberToIP(broadcastNum);
}

export function networkIP(subnetIP, mask) {
    const subnetNum = ipToNumber(subnetIP);
    const maskNum = ipToNumber(mask);
    const networkNum = subnetNum & maskNum;
    return numberToIP(networkNum);
}

export function ipRangeCount(subnetIP, mask) {
    const maskNum = ipToNumber(mask);
    const hostBits = 32 - Math.clz32(~maskNum >>> 0);
    return (1 << hostBits) - 2;
}

export const IPUtils = {
    toString: ipToString,
    toNumber: ipToNumber,
    numberToIP,
    parse: parseIP,
    parseCIDR,
    equals: ipEquals,
    inSubnet: ipInSubnet,
    next: nextIP,
    prev: prevIP,
    broadcast: broadcastIP,
    network: networkIP,
    rangeCount: ipRangeCount
};