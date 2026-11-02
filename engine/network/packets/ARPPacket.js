import { MACUtils } from '../utils/MACUtils.js';
import { IPUtils } from '../utils/IPUtils.js';

export const ARP_HW_ETHERNET = 1;
export const ARP_PROTO_IP = 0x0800;
export const ARP_OP_REQUEST = 1;
export const ARP_OP_REPLY = 2;
export const ARP_OP_RREQUEST = 3;
export const ARP_OP_RREPLY = 4;
export const ARP_OP_INVREQUEST = 8;
export const ARP_OP_INVREPLY = 9;

export const ARP_HDR_LEN = 28;

export class ARPPacket {
    constructor(buffer = null) {
        this.hardwareType = ARP_HW_ETHERNET;
        this.protocolType = ARP_PROTO_IP;
        this.hardwareSize = 6;
        this.protocolSize = 4;
        this.operation = 0;
        this.senderMAC = new Uint8Array(6);
        this.senderIP = new Uint8Array(4);
        this.targetMAC = new Uint8Array(6);
        this.targetIP = new Uint8Array(4);
        
        if (buffer) {
            this.parse(buffer);
        }
    }

    parse(buffer) {
        if (buffer.length < ARP_HDR_LEN) {
            throw new Error(`ARP packet too short: ${buffer.length} bytes`);
        }
        
        this.hardwareType = (buffer[0] << 8) | buffer[1];
        this.protocolType = (buffer[2] << 8) | buffer[3];
        this.hardwareSize = buffer[4];
        this.protocolSize = buffer[5];
        this.operation = (buffer[6] << 8) | buffer[7];
        
        if (this.hardwareType !== ARP_HW_ETHERNET) {
            throw new Error(`Unsupported hardware type: ${this.hardwareType}`);
        }
        
        if (this.protocolType !== ARP_PROTO_IP) {
            throw new Error(`Unsupported protocol type: 0x${this.protocolType.toString(16)}`);
        }
        
        if (this.hardwareSize !== 6 || this.protocolSize !== 4) {
            throw new Error(`Invalid hardware/protocol size: ${this.hardwareSize}/${this.protocolSize}`);
        }
        
        this.senderMAC.set(buffer.subarray(8, 14));
        this.senderIP.set(buffer.subarray(14, 18));
        this.targetMAC.set(buffer.subarray(18, 24));
        this.targetIP.set(buffer.subarray(24, 28));
    }

    serialize() {
        const buffer = new Uint8Array(ARP_HDR_LEN);
        
        buffer[0] = (this.hardwareType >> 8) & 0xff;
        buffer[1] = this.hardwareType & 0xff;
        buffer[2] = (this.protocolType >> 8) & 0xff;
        buffer[3] = this.protocolType & 0xff;
        buffer[4] = this.hardwareSize;
        buffer[5] = this.protocolSize;
        buffer[6] = (this.operation >> 8) & 0xff;
        buffer[7] = this.operation & 0xff;
        buffer.set(this.senderMAC, 8);
        buffer.set(this.senderIP, 14);
        buffer.set(this.targetMAC, 18);
        buffer.set(this.targetIP, 24);
        
        return buffer;
    }

    static buildRequest(senderMAC, senderIP, targetIP) {
        const packet = new ARPPacket();
        packet.operation = ARP_OP_REQUEST;
        packet.senderMAC.set(senderMAC);
        packet.senderIP.set(senderIP);
        packet.targetMAC.fill(0);
        packet.targetIP.set(targetIP);
        return packet;
    }

    static buildReply(senderMAC, senderIP, targetMAC, targetIP) {
        const packet = new ARPPacket();
        packet.operation = ARP_OP_REPLY;
        packet.senderMAC.set(senderMAC);
        packet.senderIP.set(senderIP);
        packet.targetMAC.set(targetMAC);
        packet.targetIP.set(targetIP);
        return packet;
    }

    static buildGratuitousARP(senderMAC, senderIP) {
        const packet = new ARPPacket();
        packet.operation = ARP_OP_REPLY;
        packet.senderMAC.set(senderMAC);
        packet.senderIP.set(senderIP);
        packet.targetMAC.set(senderMAC);
        packet.targetIP.set(senderIP);
        return packet;
    }

    isRequest() {
        return this.operation === ARP_OP_REQUEST;
    }

    isReply() {
        return this.operation === ARP_OP_REPLY;
    }

    getSenderIP() {
        return IPUtils.toString(this.senderIP);
    }

    getTargetIP() {
        return IPUtils.toString(this.targetIP);
    }

    getSenderMAC() {
        return MACUtils.toString(this.senderMAC);
    }

    getTargetMAC() {
        return MACUtils.toString(this.targetMAC);
    }

    toString() {
        const opStr = this.isRequest() ? 'REQUEST' : this.isReply() ? 'REPLY' : `OP(${this.operation})`;
        return `ARPPacket: ${opStr} ${this.getSenderMAC()} (${this.getSenderIP()}) -> ${this.getTargetMAC()} (${this.getTargetIP()})`;
    }
}