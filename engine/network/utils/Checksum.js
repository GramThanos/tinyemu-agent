export function internetChecksum(buffer) {
    let sum = 0;
    const len = buffer.length;
    for (let i = 0; i < len; i += 2) {
        sum += (buffer[i] << 8) + (buffer[i + 1] || 0);
    }
    while (sum > 0xffff) {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    return ~sum & 0xffff;
}

export function internetChecksumArray(arrays) {
    let sum = 0;
    for (const arr of arrays) {
        const len = arr.length;
        for (let i = 0; i < len; i += 2) {
            sum += (arr[i] << 8) + (arr[i + 1] || 0);
        }
    }
    while (sum > 0xffff) {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    return ~sum & 0xffff;
}

export function udpChecksum(srcIP, dstIP, udpBuffer) {
    const pseudoHeader = new Uint8Array(12);
    pseudoHeader.set(srcIP, 0);
    pseudoHeader.set(dstIP, 4);
    pseudoHeader[8] = 0;
    pseudoHeader[9] = 17;
    pseudoHeader[10] = (udpBuffer.length >> 8) & 0xff;
    pseudoHeader[11] = udpBuffer.length & 0xff;
    return internetChecksumArray([pseudoHeader, udpBuffer]);
}

export function tcpChecksum(srcIP, dstIP, tcpBuffer) {
    const pseudoHeader = new Uint8Array(12);
    pseudoHeader.set(srcIP, 0);
    pseudoHeader.set(dstIP, 4);
    pseudoHeader[8] = 0;
    pseudoHeader[9] = 6;
    pseudoHeader[10] = (tcpBuffer.length >> 8) & 0xff;
    pseudoHeader[11] = tcpBuffer.length & 0xff;
    return internetChecksumArray([pseudoHeader, tcpBuffer]);
}

export function icmpChecksum(buffer) {
    return internetChecksum(buffer);
}