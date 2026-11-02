import { MACUtils } from '../utils/MACUtils.js';

export const ETH_P_IP = 0x0800;
export const ETH_P_ARP = 0x0806;
export const ETH_P_RARP = 0x8035;
export const ETH_P_IPV6 = 0x86DD;
export const ETH_P_VLAN = 0x8100;
export const ETH_P_PPPOE_DISC = 0x8863;
export const ETH_P_PPPOE_SES = 0x8864;
export const ETH_P_8021Q = 0x8100;

export const ETH_HDR_LEN = 14;
export const ETH_MTU = 1500;
export const ETH_MIN_FRAME = 64;
export const ETH_MAX_FRAME = 1518;

export class EthernetFrame {
    constructor(buffer = null) {
        this.dstMAC = new Uint8Array(6);
        this.srcMAC = new Uint8Array(6);
        this.ethertype = 0;
        this.payload = null;
        this.vlanTag = null;
        
        if (buffer) {
            this.parse(buffer);
        }
    }

    parse(buffer) {
        if (buffer.length < ETH_HDR_LEN) {
            throw new Error(`Ethernet frame too short: ${buffer.length} bytes`);
        }
        
        this.dstMAC.set(buffer.subarray(0, 6));
        this.srcMAC.set(buffer.subarray(6, 12));
        this.ethertype = (buffer[12] << 8) | buffer[13];
        
        let payloadOffset = ETH_HDR_LEN;
        
        if (this.ethertype === ETH_P_VLAN || this.ethertype === ETH_P_8021Q) {
            this.vlanTag = {
                priority: (buffer[14] >> 5) & 0x07,
                dei: (buffer[14] >> 4) & 0x01,
                vlanId: ((buffer[14] & 0x0f) << 8) | buffer[15]
            };
            this.ethertype = (buffer[16] << 8) | buffer[17];
            payloadOffset += 4;
        }
        
        this.payload = buffer.subarray(payloadOffset);
    }

    serialize() {
        const hasVlan = this.vlanTag !== null;
        const hdrLen = ETH_HDR_LEN + (hasVlan ? 4 : 0);
        const totalLen = hdrLen + (this.payload ? this.payload.length : 0);
        
        const buffer = new Uint8Array(totalLen);
        
        buffer.set(this.dstMAC, 0);
        buffer.set(this.srcMAC, 6);
        
        let offset = 12;
        
        if (hasVlan) {
            buffer[offset++] = 0x81;
            buffer[offset++] = 0x00;
            buffer[offset++] = (this.vlanTag.priority << 5) | (this.vlanTag.dei << 4) | ((this.vlanTag.vlanId >> 8) & 0x0f);
            buffer[offset++] = this.vlanTag.vlanId & 0xff;
        }
        
        buffer[offset++] = (this.ethertype >> 8) & 0xff;
        buffer[offset++] = this.ethertype & 0xff;
        
        if (this.payload) {
            buffer.set(this.payload, offset);
        }
        
        return buffer;
    }

    static build(dstMAC, srcMAC, ethertype, payload, vlanTag = null) {
        const frame = new EthernetFrame();
        frame.dstMAC.set(dstMAC);
        frame.srcMAC.set(srcMAC);
        frame.ethertype = ethertype;
        frame.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
        frame.vlanTag = vlanTag;
        return frame;
    }

    static buildBroadcast(srcMAC, ethertype, payload) {
        const broadcastMAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        return EthernetFrame.build(broadcastMAC, srcMAC, ethertype, payload);
    }

    isBroadcast() {
        return MACUtils.isBroadcast(this.dstMAC);
    }

    isMulticast() {
        return MACUtils.isMulticast(this.dstMAC);
    }

    isIPv4() {
        return this.ethertype === ETH_P_IP;
    }

    isARP() {
        return this.ethertype === ETH_P_ARP;
    }

    isIPv6() {
        return this.ethertype === ETH_P_IPV6;
    }

    getPayload() {
        return this.payload;
    }

    setPayload(payload) {
        this.payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
    }

    toString() {
        return `EthernetFrame: ${MACUtils.toString(this.srcMAC)} -> ${MACUtils.toString(this.dstMAC)} type=0x${this.ethertype.toString(16).padStart(4, '0')} payload=${this.payload?.length || 0} bytes`;
    }
}