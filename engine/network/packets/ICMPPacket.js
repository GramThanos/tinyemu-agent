import { internetChecksum, icmpChecksum } from '../utils/Checksum.js';

export const ICMP_ECHO_REPLY = 0;
export const ICMP_DEST_UNREACH = 3;
export const ICMP_SOURCE_QUENCH = 4;
export const ICMP_REDIRECT = 5;
export const ICMP_ECHO_REQUEST = 8;
export const ICMP_ROUTER_ADVERT = 9;
export const ICMP_ROUTER_SOLICIT = 10;
export const ICMP_TIME_EXCEEDED = 11;
export const ICMP_PARAM_PROBLEM = 12;
export const ICMP_TIMESTAMP_REQUEST = 13;
export const ICMP_TIMESTAMP_REPLY = 14;
export const ICMP_INFO_REQUEST = 15;
export const ICMP_INFO_REPLY = 16;

export const ICMP_UNREACH_NET = 0;
export const ICMP_UNREACH_HOST = 1;
export const ICMP_UNREACH_PROTOCOL = 2;
export const ICMP_UNREACH_PORT = 3;
export const ICMP_UNREACH_NEEDFRAG = 4;
export const ICMP_UNREACH_SRCFAIL = 5;

export const ICMP_REDIRECT_NET = 0;
export const ICMP_REDIRECT_HOST = 1;
export const ICMP_REDIRECT_TOS_NET = 2;
export const ICMP_REDIRECT_TOS_HOST = 3;

export const ICMP_EXC_TTL = 0;
export const ICMP_EXC_FRAGTIME = 1;

export const ICMP_HDR_LEN = 4;

export class ICMPPacket {
    constructor(buffer = null) {
        this.type = 0;
        this.code = 0;
        this.checksum = 0;
        this.rest = new Uint8Array(4);
        this.payload = null;
        
        if (buffer) {
            this.parse(buffer);
        }
    }

    parse(buffer) {
        if (buffer.length < ICMP_HDR_LEN) {
            throw new Error(`ICMP packet too short: ${buffer.length} bytes`);
        }
        
        this.type = buffer[0];
        this.code = buffer[1];
        this.checksum = (buffer[2] << 8) | buffer[3];
        this.rest.set(buffer.subarray(4, 8));
        
        this.payload = buffer.length > 8 ? buffer.subarray(8) : new Uint8Array(0);
    }

    serialize() {
        const payloadLen = this.payload ? this.payload.length : 0;
        const totalLen = 8 + payloadLen;
        
        const buffer = new Uint8Array(totalLen);
        
        buffer[0] = this.type;
        buffer[1] = this.code;
        buffer[2] = 0;
        buffer[3] = 0;
        buffer.set(this.rest, 4);
        
        if (this.payload) {
            buffer.set(this.payload, 8);
        }
        
        this.checksum = icmpChecksum(buffer);
        buffer[2] = (this.checksum >> 8) & 0xff;
        buffer[3] = this.checksum & 0xff;
        
        return buffer;
    }

    static buildEchoRequest(identifier, sequenceNumber, payload = null) {
        const packet = new ICMPPacket();
        packet.type = ICMP_ECHO_REQUEST;
        packet.code = 0;
        packet.rest[0] = (identifier >> 8) & 0xff;
        packet.rest[1] = identifier & 0xff;
        packet.rest[2] = (sequenceNumber >> 8) & 0xff;
        packet.rest[3] = sequenceNumber & 0xff;
        packet.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
        return packet;
    }

    static buildEchoReply(identifier, sequenceNumber, payload = null) {
        const packet = new ICMPPacket();
        packet.type = ICMP_ECHO_REPLY;
        packet.code = 0;
        packet.rest[0] = (identifier >> 8) & 0xff;
        packet.rest[1] = identifier & 0xff;
        packet.rest[2] = (sequenceNumber >> 8) & 0xff;
        packet.rest[3] = sequenceNumber & 0xff;
        packet.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
        return packet;
    }

    static buildDestUnreach(code, originalIPHeader, originalPayload = null) {
        const packet = new ICMPPacket();
        packet.type = ICMP_DEST_UNREACH;
        packet.code = code;
        packet.rest.fill(0);
        
        const ipHeaderLen = originalIPHeader ? originalIPHeader.length : 0;
        const payloadLen = originalPayload ? originalPayload.length : 0;
        const totalLen = Math.min(576, ipHeaderLen + payloadLen);
        
        packet.payload = new Uint8Array(totalLen);
        if (originalIPHeader) {
            packet.payload.set(originalIPHeader.subarray(0, Math.min(ipHeaderLen, totalLen)));
        }
        if (originalPayload && ipHeaderLen < totalLen) {
            packet.payload.set(
                originalPayload.subarray(0, totalLen - ipHeaderLen),
                ipHeaderLen
            );
        }
        
        return packet;
    }

    static buildTimeExceeded(code, originalIPHeader, originalPayload = null) {
        const packet = new ICMPPacket();
        packet.type = ICMP_TIME_EXCEEDED;
        packet.code = code;
        packet.rest.fill(0);
        
        const ipHeaderLen = originalIPHeader ? originalIPHeader.length : 0;
        const payloadLen = originalPayload ? originalPayload.length : 0;
        const totalLen = Math.min(576, ipHeaderLen + payloadLen);
        
        packet.payload = new Uint8Array(totalLen);
        if (originalIPHeader) {
            packet.payload.set(originalIPHeader.subarray(0, Math.min(ipHeaderLen, totalLen)));
        }
        if (originalPayload && ipHeaderLen < totalLen) {
            packet.payload.set(
                originalPayload.subarray(0, totalLen - ipHeaderLen),
                ipHeaderLen
            );
        }
        
        return packet;
    }

    static buildRedirect(code, gatewayIP, originalIPHeader, originalPayload = null) {
        const packet = new ICMPPacket();
        packet.type = ICMP_REDIRECT;
        packet.code = code;
        packet.rest[0] = gatewayIP[0];
        packet.rest[1] = gatewayIP[1];
        packet.rest[2] = gatewayIP[2];
        packet.rest[3] = gatewayIP[3];
        
        const ipHeaderLen = originalIPHeader ? originalIPHeader.length : 0;
        const payloadLen = originalPayload ? originalPayload.length : 0;
        const totalLen = Math.min(576, ipHeaderLen + payloadLen);
        
        packet.payload = new Uint8Array(totalLen);
        if (originalIPHeader) {
            packet.payload.set(originalIPHeader.subarray(0, Math.min(ipHeaderLen, totalLen)));
        }
        if (originalPayload && ipHeaderLen < totalLen) {
            packet.payload.set(
                originalPayload.subarray(0, totalLen - ipHeaderLen),
                ipHeaderLen
            );
        }
        
        return packet;
    }

    isEchoRequest() {
        return this.type === ICMP_ECHO_REQUEST && this.code === 0;
    }

    isEchoReply() {
        return this.type === ICMP_ECHO_REPLY && this.code === 0;
    }

    getIdentifier() {
        return (this.rest[0] << 8) | this.rest[1];
    }

    getSequenceNumber() {
        return (this.rest[2] << 8) | this.rest[3];
    }

    createEchoReply() {
        const reply = new ICMPPacket();
        reply.type = ICMP_ECHO_REPLY;
        reply.code = 0;
        reply.rest.set(this.rest);
        reply.payload = this.payload ? new Uint8Array(this.payload) : new Uint8Array(0);
        return reply;
    }

    verifyChecksum() {
        if (this.checksum === 0) return true;
        const buf = this.serialize();
        const computed = icmpChecksum(buf);
        return computed === 0;
    }

    getPayload() {
        return this.payload;
    }

    setPayload(payload) {
        this.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
    }

    getTypeName() {
        const names = {
            [ICMP_ECHO_REPLY]: 'ECHO_REPLY',
            [ICMP_DEST_UNREACH]: 'DEST_UNREACH',
            [ICMP_SOURCE_QUENCH]: 'SOURCE_QUENCH',
            [ICMP_REDIRECT]: 'REDIRECT',
            [ICMP_ECHO_REQUEST]: 'ECHO_REQUEST',
            [ICMP_ROUTER_ADVERT]: 'ROUTER_ADVERT',
            [ICMP_ROUTER_SOLICIT]: 'ROUTER_SOLICIT',
            [ICMP_TIME_EXCEEDED]: 'TIME_EXCEEDED',
            [ICMP_PARAM_PROBLEM]: 'PARAM_PROBLEM',
            [ICMP_TIMESTAMP_REQUEST]: 'TIMESTAMP_REQUEST',
            [ICMP_TIMESTAMP_REPLY]: 'TIMESTAMP_REPLY',
            [ICMP_INFO_REQUEST]: 'INFO_REQUEST',
            [ICMP_INFO_REPLY]: 'INFO_REPLY'
        };
        return names[this.type] || `TYPE(${this.type})`;
    }

    toString() {
        return `ICMPPacket: ${this.getTypeName()} code=${this.code} id=${this.getIdentifier()} seq=${this.getSequenceNumber()} checksum=0x${this.checksum.toString(16).padStart(4, '0')}`;
    }
}