import { internetChecksum, udpChecksum } from '../utils/Checksum.js';

export const UDP_HDR_LEN = 8;

export class UDPPacket {
    constructor(buffer = null) {
        this.srcPort = 0;
        this.dstPort = 0;
        this.length = 0;
        this.checksum = 0;
        this.payload = null;
        
        if (buffer) {
            this.parse(buffer);
        }
    }

    parse(buffer) {
        if (buffer.length < UDP_HDR_LEN) {
            throw new Error(`UDP packet too short: ${buffer.length} bytes`);
        }
        
        this.srcPort = (buffer[0] << 8) | buffer[1];
        this.dstPort = (buffer[2] << 8) | buffer[3];
        this.length = (buffer[4] << 8) | buffer[5];
        this.checksum = (buffer[6] << 8) | buffer[7];
        
        if (this.length < UDP_HDR_LEN) {
            throw new Error(`Invalid UDP length: ${this.length}`);
        }
        
        if (buffer.length < this.length) {
            throw new Error(`UDP payload truncated: ${buffer.length} < ${this.length}`);
        }
        
        this.payload = buffer.subarray(UDP_HDR_LEN, this.length);
    }

    serialize(srcIP = null, dstIP = null) {
        const payloadLen = this.payload ? this.payload.length : 0;
        this.length = UDP_HDR_LEN + payloadLen;
        
        const buffer = new Uint8Array(this.length);
        
        buffer[0] = (this.srcPort >> 8) & 0xff;
        buffer[1] = this.srcPort & 0xff;
        buffer[2] = (this.dstPort >> 8) & 0xff;
        buffer[3] = this.dstPort & 0xff;
        buffer[4] = (this.length >> 8) & 0xff;
        buffer[5] = this.length & 0xff;
        buffer[6] = 0;
        buffer[7] = 0;
        
        if (this.payload) {
            buffer.set(this.payload, UDP_HDR_LEN);
        }
        
        if (srcIP && dstIP) {
            this.checksum = udpChecksum(srcIP, dstIP, buffer);
            buffer[6] = (this.checksum >> 8) & 0xff;
            buffer[7] = this.checksum & 0xff;
        } else if (this.checksum !== 0) {
            buffer[6] = (this.checksum >> 8) & 0xff;
            buffer[7] = this.checksum & 0xff;
        }
        
        return buffer;
    }

    static build(srcPort, dstPort, payload) {
        const packet = new UDPPacket();
        packet.srcPort = srcPort;
        packet.dstPort = dstPort;
        packet.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
        return packet;
    }

    verifyChecksum(srcIP, dstIP) {
        if (this.checksum === 0) return true;
        const computed = udpChecksum(srcIP, dstIP, this.serialize());
        return computed === 0;
    }

    getPayload() {
        return this.payload;
    }

    setPayload(payload) {
        this.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
    }

    toString() {
        return `UDPPacket: ${this.srcPort} -> ${this.dstPort} len=${this.length} checksum=0x${this.checksum.toString(16).padStart(4, '0')}`;
    }
}