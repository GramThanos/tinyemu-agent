import { internetChecksum } from '../utils/Checksum.js';
import { IPUtils } from '../utils/IPUtils.js';

export const IP_PROTO_ICMP = 1;
export const IP_PROTO_IGMP = 2;
export const IP_PROTO_TCP = 6;
export const IP_PROTO_UDP = 17;
export const IP_PROTO_IPV6 = 41;
export const IP_PROTO_ESP = 50;
export const IP_PROTO_AH = 51;

export const IP_FLAG_MF = 0x2000;
export const IP_FLAG_DF = 0x4000;
export const IP_FLAG_RF = 0x8000;
export const IP_OFFMASK = 0x1fff;

export const IP_HDR_MIN_LEN = 20;

export class IPPacket {
    constructor(buffer = null) {
        this.version = 4;
        this.ihl = 5;
        this.tos = 0;
        this.totalLength = 0;
        this.identification = 0;
        this.flags = 0;
        this.fragmentOffset = 0;
        this.ttl = 64;
        this.protocol = 0;
        this.headerChecksum = 0;
        this.srcIP = new Uint8Array(4);
        this.dstIP = new Uint8Array(4);
        this.options = null;
        this.payload = null;
        
        if (buffer) {
            this.parse(buffer);
        }
    }

    parse(buffer) {
        if (buffer.length < IP_HDR_MIN_LEN) {
            throw new Error(`IP packet too short: ${buffer.length} bytes`);
        }
        
        const verIhl = buffer[0];
        this.version = verIhl >> 4;
        this.ihl = verIhl & 0x0f;
        
        if (this.version !== 4) {
            throw new Error(`Unsupported IP version: ${this.version}`);
        }
        
        if (this.ihl < 5) {
            throw new Error(`Invalid IHL: ${this.ihl}`);
        }
        
        const hdrLen = this.ihl * 4;
        if (buffer.length < hdrLen) {
            throw new Error(`IP header truncated: ${buffer.length} < ${hdrLen}`);
        }
        
        this.tos = buffer[1];
        this.totalLength = (buffer[2] << 8) | buffer[3];
        this.identification = (buffer[4] << 8) | buffer[5];
        const flagsFrag = (buffer[6] << 8) | buffer[7];
        this.flags = flagsFrag & 0xe000;
        this.fragmentOffset = flagsFrag & IP_OFFMASK;
        this.ttl = buffer[8];
        this.protocol = buffer[9];
        this.headerChecksum = (buffer[10] << 8) | buffer[11];
        this.srcIP.set(buffer.subarray(12, 16));
        this.dstIP.set(buffer.subarray(16, 20));
        
        if (this.ihl > 5) {
            this.options = buffer.subarray(20, hdrLen);
        }
        
        const payloadLen = this.totalLength - hdrLen;
        if (buffer.length < hdrLen + payloadLen) {
            throw new Error(`IP payload truncated: ${buffer.length} < ${hdrLen + payloadLen}`);
        }
        
        this.payload = buffer.subarray(hdrLen, hdrLen + payloadLen);
        
        const computedChecksum = this.computeChecksum(buffer.subarray(0, hdrLen));
        if (computedChecksum !== 0) {
            console.warn(`IP checksum mismatch: computed=${computedChecksum.toString(16)}, expected=0`);
        }
    }

    computeChecksum(header) {
        return internetChecksum(header);
    }

    serialize() {
        const hdrLen = this.ihl * 4;
        const optionsLen = this.options ? this.options.length : 0;
        const actualHdrLen = IP_HDR_MIN_LEN + optionsLen;
        
        if (actualHdrLen !== hdrLen) {
            throw new Error(`IHL mismatch: ${this.ihl} * 4 = ${hdrLen} but options length = ${optionsLen}`);
        }
        
        const totalLen = hdrLen + (this.payload ? this.payload.length : 0);
        if (totalLen > 0xffff) {
            throw new Error(`IP packet too large: ${totalLen} bytes`);
        }
        
        this.totalLength = totalLen;
        
        const buffer = new Uint8Array(totalLen);
        
        buffer[0] = (this.version << 4) | this.ihl;
        buffer[1] = this.tos;
        buffer[2] = (this.totalLength >> 8) & 0xff;
        buffer[3] = this.totalLength & 0xff;
        buffer[4] = (this.identification >> 8) & 0xff;
        buffer[5] = this.identification & 0xff;
        const flagsFrag = this.flags | (this.fragmentOffset & IP_OFFMASK);
        buffer[6] = (flagsFrag >> 8) & 0xff;
        buffer[7] = flagsFrag & 0xff;
        buffer[8] = this.ttl;
        buffer[9] = this.protocol;
        buffer[10] = 0;
        buffer[11] = 0;
        buffer.set(this.srcIP, 12);
        buffer.set(this.dstIP, 16);
        
        if (this.options) {
            buffer.set(this.options, 20);
        }
        
        this.headerChecksum = this.computeChecksum(buffer.subarray(0, hdrLen));
        buffer[10] = (this.headerChecksum >> 8) & 0xff;
        buffer[11] = this.headerChecksum & 0xff;
        
        if (this.payload) {
            buffer.set(this.payload, hdrLen);
        }
        
        return buffer;
    }

    static build(srcIP, dstIP, protocol, payload, ttl = 64, options = null) {
        const packet = new IPPacket();
        packet.srcIP.set(srcIP);
        packet.dstIP.set(dstIP);
        packet.protocol = protocol;
        packet.ttl = ttl;
        packet.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
        packet.options = options;
        packet.ihl = 5 + (options ? Math.ceil(options.length / 4) : 0);
        packet.identification = Math.floor(Math.random() * 0x10000);
        return packet;
    }

    getSrcIP() {
        return IPUtils.toString(this.srcIP);
    }

    getDstIP() {
        return IPUtils.toString(this.dstIP);
    }

    isFragmented() {
        return (this.flags & IP_FLAG_MF) !== 0 || this.fragmentOffset !== 0;
    }

    isFirstFragment() {
        return this.fragmentOffset === 0;
    }

    getPayload() {
        return this.payload;
    }

    setPayload(payload) {
        this.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
    }

    decrementTTL() {
        this.ttl--;
        return this.ttl > 0;
    }

    toString() {
        return `IPPacket: ${this.getSrcIP()} -> ${this.getDstIP()} proto=${this.protocol} ttl=${this.ttl} len=${this.totalLength} id=0x${this.identification.toString(16).padStart(4, '0')}`;
    }
}