import { MACUtils } from '../utils/MACUtils.js';
import { IPUtils } from '../utils/IPUtils.js';

export const DHCP_OP_BOOTREQUEST = 1;
export const DHCP_OP_BOOTREPLY = 2;
export const DHCP_HTYPE_ETHERNET = 1;
export const DHCP_HLEN_ETHERNET = 6;
export const DHCP_MAGIC_COOKIE = [0x63, 0x82, 0x53, 0x63];
export const DHCP_MAGIC_COOKIE_UINT32 = 0x63825363;
export const DHCP_PORT_SERVER = 67;
export const DHCP_PORT_CLIENT = 68;

export const DHCP_OPT_SUBNET_MASK = 1;
export const DHCP_OPT_TIME_OFFSET = 2;
export const DHCP_OPT_ROUTER = 3;
export const DHCP_OPT_TIME_SERVER = 4;
export const DHCP_OPT_NAME_SERVER = 5;
export const DHCP_OPT_DNS = 6;
export const DHCP_OPT_LOG_SERVER = 7;
export const DHCP_OPT_COOKIE_SERVER = 8;
export const DHCP_OPT_LPR_SERVER = 9;
export const DHCP_OPT_HOSTNAME = 12;
export const DHCP_OPT_BOOT_FILE_SIZE = 13;
export const DHCP_OPT_DOMAIN = 15;
export const DHCP_OPT_SWAP_SERVER = 16;
export const DHCP_OPT_ROOT_PATH = 17;
export const DHCP_OPT_EXTENSIONS_PATH = 18;
export const DHCP_OPT_IP_FORWARDING = 19;
export const DHCP_OPT_NON_LOCAL_SOURCE_ROUTING = 20;
export const DHCP_OPT_POLICY_FILTER = 21;
export const DHCP_OPT_MAX_DGRAM_REASSEMBLY = 22;
export const DHCP_OPT_DEFAULT_IP_TTL = 23;
export const DHCP_OPT_PATH_MTU_AGING_TIMEOUT = 24;
export const DHCP_OPT_PATH_MTU_PLATEAU_TABLE = 25;
export const DHCP_OPT_INTERFACE_MTU = 26;
export const DHCP_OPT_ALL_SUBNETS_LOCAL = 27;
export const DHCP_OPT_BROADCAST = 28;
export const DHCP_OPT_PERFORM_MASK_DISCOVERY = 29;
export const DHCP_OPT_MASK_SUPPLIER = 30;
export const DHCP_OPT_ROUTER_DISCOVERY = 31;
export const DHCP_OPT_ROUTER_SOLICITATION_ADDRESS = 32;
export const DHCP_OPT_STATIC_ROUTE = 33;
export const DHCP_OPT_TRAILER_ENCAPSULATION = 34;
export const DHCP_OPT_ARP_CACHE_TIMEOUT = 35;
export const DHCP_OPT_ETHERNET_ENCAPSULATION = 36;
export const DHCP_OPT_TCP_DEFAULT_TTL = 37;
export const DHCP_OPT_TCP_KEEPALIVE_INTERVAL = 38;
export const DHCP_OPT_TCP_KEEPALIVE_GARBAGE = 39;
export const DHCP_OPT_NIS_DOMAIN = 40;
export const DHCP_OPT_NIS_SERVERS = 41;
export const DHCP_OPT_NTP_SERVERS = 42;
export const DHCP_OPT_VENDOR_SPECIFIC = 43;
export const DHCP_OPT_NETBIOS_NAME_SERVER = 44;
export const DHCP_OPT_NETBIOS_DD_SERVER = 45;
export const DHCP_OPT_NETBIOS_NODE_TYPE = 46;
export const DHCP_OPT_NETBIOS_SCOPE = 47;
export const DHCP_OPT_X_WINDOW_FONT_SERVER = 48;
export const DHCP_OPT_X_WINDOW_DISPLAY_MANAGER = 49;
export const DHCP_OPT_LEASE_TIME = 51;
export const DHCP_OPT_OVERLOAD = 52;
export const DHCP_OPT_MSG_TYPE = 53;
export const DHCP_OPT_SERVER_ID = 54;
export const DHCP_OPT_PARAM_REQUEST = 55;
export const DHCP_OPT_MESSAGE = 56;
export const DHCP_OPT_REQ_ADDR = 50;
export const DHCP_OPT_MAX_MSG_SIZE = 57;
export const DHCP_OPT_RENEWAL_TIME = 58;
export const DHCP_OPT_REBIND_TIME = 59;
export const DHCP_OPT_VENDOR_CLASS = 60;
export const DHCP_OPT_CLIENT_ID = 61;
export const DHCP_OPT_TFTP_SERVER = 66;
export const DHCP_OPT_BOOTFILE_NAME = 67;
export const DHCP_OPT_MOBILE_IP_HOME_AGENT = 68;
export const DHCP_OPT_SMTP_SERVER = 69;
export const DHCP_OPT_POP3_SERVER = 70;
export const DHCP_OPT_NNTP_SERVER = 71;
export const DHCP_OPT_WWW_SERVER = 72;
export const DHCP_OPT_FINGER_SERVER = 73;
export const DHCP_OPT_IRC_SERVER = 74;
export const DHCP_OPT_STREET_TALK_SERVER = 75;
export const DHCP_OPT_STREET_TALK_DA_SERVER = 76;
export const DHCP_OPT_USER_CLASS = 77;
export const DHCP_OPT_SLP_DA = 78;
export const DHCP_OPT_SLP_SCOPE = 79;
export const DHCP_OPT_RAPID_COMMIT = 80;
export const DHCP_OPT_FQDN = 81;
export const DHCP_OPT_AGENT_OPTIONS = 82;
export const DHCP_OPT_NDS_SERVERS = 85;
export const DHCP_OPT_NDS_TREE_NAME = 86;
export const DHCP_OPT_NDS_CONTEXT = 87;
export const DHCP_OPT_CLIENT_LAST_XID = 88;
export const DHCP_OPT_SUBNET_SELECTION = 118;
export const DHCP_OPT_DOMAIN_SEARCH = 119;
export const DHCP_OPT_SIP_SERVERS = 120;
export const DHCP_OPT_CLASSLESS_STATIC_ROUTE = 121;
export const DHCP_OPT_PXE_ARCH = 93;
export const DHCP_OPT_PXE_CLIENT = 94;

export const DHCP_OPT_END = 255;
export const DHCP_OPT_PAD = 0;

export const DHCP_MSG_DISCOVER = 1;
export const DHCP_MSG_OFFER = 2;
export const DHCP_MSG_REQUEST = 3;
export const DHCP_MSG_DECLINE = 4;
export const DHCP_MSG_ACK = 5;
export const DHCP_MSG_NAK = 6;
export const DHCP_MSG_RELEASE = 7;
export const DHCP_MSG_INFORM = 8;

export const DHCP_FLAG_BROADCAST = 0x8000;

export const DHCP_FIXED_SIZE = 236;
export const DHCP_MIN_SIZE = DHCP_FIXED_SIZE + 4;

export class DHCPPacket {
    constructor(buffer = null) {
        this.op = DHCP_OP_BOOTREQUEST;
        this.htype = DHCP_HTYPE_ETHERNET;
        this.hlen = DHCP_HLEN_ETHERNET;
        this.hops = 0;
        this.xid = 0;
        this.secs = 0;
        this.flags = 0;
        this.ciaddr = new Uint8Array(4);
        this.yiaddr = new Uint8Array(4);
        this.siaddr = new Uint8Array(4);
        this.giaddr = new Uint8Array(4);
        this.chaddr = new Uint8Array(16);
        this.sname = new Uint8Array(64);
        this.file = new Uint8Array(128);
        this.options = new Map();
        
        if (buffer) {
            this.parse(buffer);
        }
    }

    parse(buffer) {
        if (buffer.length < DHCP_FIXED_SIZE) {
            throw new Error(`DHCP packet too short: ${buffer.length} bytes`);
        }
        
        this.op = buffer[0];
        this.htype = buffer[1];
        this.hlen = buffer[2];
        this.hops = buffer[3];
        this.xid = (buffer[4] << 24) | (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];
        this.secs = (buffer[8] << 8) | buffer[9];
        this.flags = (buffer[10] << 8) | buffer[11];
        this.ciaddr.set(buffer.subarray(12, 16));
        this.yiaddr.set(buffer.subarray(16, 20));
        this.siaddr.set(buffer.subarray(20, 24));
        this.giaddr.set(buffer.subarray(24, 28));
        this.chaddr.set(buffer.subarray(28, 44));
        this.sname.set(buffer.subarray(44, 108));
        this.file.set(buffer.subarray(108, 236));
        
        if (buffer.length > DHCP_FIXED_SIZE) {
            this.parseOptions(buffer.subarray(DHCP_FIXED_SIZE));
        }
    }

    parseOptions(data) {
        let offset = 0;
        
        if (data.length < 4) {
            return;
        }
        
        const cookie = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
        if (cookie !== DHCP_MAGIC_COOKIE_UINT32) {
            console.warn(`DHCP: Invalid magic cookie: 0x${cookie.toString(16)}`);
            return;
        }
        
        offset = 4;
        
        while (offset < data.length) {
            const tag = data[offset++];
            
            if (tag === DHCP_OPT_PAD) {
                continue;
            }
            
            if (tag === DHCP_OPT_END) {
                break;
            }
            
            if (offset >= data.length) {
                break;
            }
            
            const len = data[offset++];
            
            if (offset + len > data.length) {
                console.warn(`DHCP: Option ${tag} length ${len} exceeds remaining data`);
                break;
            }
            
            const value = data.subarray(offset, offset + len);
            this.options.set(tag, new Uint8Array(value));
            offset += len;
        }
    }

    buildOptions() {
        const opts = [];
        
        for (const [tag, value] of this.options) {
            if (tag === DHCP_OPT_PAD || tag === DHCP_OPT_END) continue;
            opts.push(tag, value.length, ...value);
        }
        
        opts.push(DHCP_OPT_END);
        
        const cookie = new Uint8Array(DHCP_MAGIC_COOKIE);
        const result = new Uint8Array(cookie.length + opts.length);
        result.set(cookie, 0);
        result.set(opts, cookie.length);
        
        return result;
    }

    serialize() {
        const opts = this.buildOptions();
        const totalLen = DHCP_FIXED_SIZE + opts.length;
        const buffer = new Uint8Array(totalLen);
        
        buffer[0] = this.op;
        buffer[1] = this.htype;
        buffer[2] = this.hlen;
        buffer[3] = this.hops;
        buffer[4] = (this.xid >> 24) & 0xff;
        buffer[5] = (this.xid >> 16) & 0xff;
        buffer[6] = (this.xid >> 8) & 0xff;
        buffer[7] = this.xid & 0xff;
        buffer[8] = (this.secs >> 8) & 0xff;
        buffer[9] = this.secs & 0xff;
        buffer[10] = (this.flags >> 8) & 0xff;
        buffer[11] = this.flags & 0xff;
        buffer.set(this.ciaddr, 12);
        buffer.set(this.yiaddr, 16);
        buffer.set(this.siaddr, 20);
        buffer.set(this.giaddr, 24);
        buffer.set(this.chaddr, 28);
        buffer.set(this.sname, 44);
        buffer.set(this.file, 108);
        buffer.set(opts, DHCP_FIXED_SIZE);
        
        return buffer;
    }

    static buildReply(request, msgType, serverIP, clientIP, options = {}) {
        const reply = new DHCPPacket();
        reply.op = DHCP_OP_BOOTREPLY;
        reply.htype = request.htype;
        reply.hlen = request.hlen;
        reply.hops = 0;
        reply.xid = request.xid;
        reply.secs = 0;
        reply.flags = request.flags;
        reply.ciaddr.set(request.ciaddr);
        reply.yiaddr.set(clientIP);
        reply.siaddr.set(serverIP);
        reply.giaddr.set(request.giaddr);
        reply.chaddr.set(request.chaddr);
        
        reply.setOption(DHCP_OPT_MSG_TYPE, new Uint8Array([msgType]));
        reply.setOption(DHCP_OPT_SERVER_ID, serverIP);
        
        if (options.subnetMask) {
            reply.setOption(DHCP_OPT_SUBNET_MASK, options.subnetMask);
        }
        if (options.router) {
            reply.setOption(DHCP_OPT_ROUTER, options.router);
        }
        if (options.dns) {
            reply.setOption(DHCP_OPT_DNS, options.dns);
        }
        if (options.leaseTime !== undefined) {
            const buf = new Uint8Array(4);
            const lease = options.leaseTime;
            buf[0] = (lease >> 24) & 0xff;
            buf[1] = (lease >> 16) & 0xff;
            buf[2] = (lease >> 8) & 0xff;
            buf[3] = lease & 0xff;
            reply.setOption(DHCP_OPT_LEASE_TIME, buf);
        }
        if (options.renewalTime !== undefined) {
            const buf = new Uint8Array(4);
            const t = options.renewalTime;
            buf[0] = (t >> 24) & 0xff;
            buf[1] = (t >> 16) & 0xff;
            buf[2] = (t >> 8) & 0xff;
            buf[3] = t & 0xff;
            reply.setOption(DHCP_OPT_RENEWAL_TIME, buf);
        }
        if (options.rebindTime !== undefined) {
            const buf = new Uint8Array(4);
            const t = options.rebindTime;
            buf[0] = (t >> 24) & 0xff;
            buf[1] = (t >> 16) & 0xff;
            buf[2] = (t >> 8) & 0xff;
            buf[3] = t & 0xff;
            reply.setOption(DHCP_OPT_REBIND_TIME, buf);
        }
        if (options.broadcast) {
            reply.setOption(DHCP_OPT_BROADCAST, options.broadcast);
        }
        
        return reply;
    }

    getOption(tag) {
        return this.options.get(tag) || null;
    }

    getOptionUInt32(tag) {
        const opt = this.getOption(tag);
        if (!opt || opt.length !== 4) return null;
        return (opt[0] << 24) | (opt[1] << 16) | (opt[2] << 8) | opt[3];
    }

    getOptionIP(tag) {
        const opt = this.getOption(tag);
        if (!opt || opt.length !== 4) return null;
        return new Uint8Array(opt);
    }

    getOptionString(tag) {
        const opt = this.getOption(tag);
        if (!opt) return null;
        return String.fromCharCode(...opt);
    }

    setOption(tag, value) {
        this.options.set(tag, value instanceof Uint8Array ? value : new Uint8Array(value));
    }

    getMessageType() {
        const opt = this.getOption(DHCP_OPT_MSG_TYPE);
        return opt ? opt[0] : 0;
    }

    getClientMAC() {
        return new Uint8Array(this.chaddr.subarray(0, 6));
    }

    getClientMACString() {
        return MACUtils.toString(this.chaddr, 0);
    }

    getRequestedIP() {
        return this.getOptionIP(DHCP_OPT_REQ_ADDR);
    }

    getServerID() {
        return this.getOptionIP(DHCP_OPT_SERVER_ID);
    }

    getParamRequestList() {
        const opt = this.getOption(DHCP_OPT_PARAM_REQUEST);
        return opt ? Array.from(opt) : [];
    }

    getClientID() {
        return this.getOption(DHCP_OPT_CLIENT_ID);
    }

    getHostname() {
        return this.getOptionString(DHCP_OPT_HOSTNAME);
    }

    getVendorClass() {
        return this.getOptionString(DHCP_OPT_VENDOR_CLASS);
    }

    isBroadcast() {
        return (this.flags & DHCP_FLAG_BROADCAST) !== 0;
    }

    toString() {
        const msgType = this.getMessageType();
        const typeStr = 
            msgType === DHCP_MSG_DISCOVER ? 'DISCOVER' :
            msgType === DHCP_MSG_OFFER ? 'OFFER' :
            msgType === DHCP_MSG_REQUEST ? 'REQUEST' :
            msgType === DHCP_MSG_ACK ? 'ACK' :
            msgType === DHCP_MSG_NAK ? 'NAK' :
            msgType === DHCP_MSG_RELEASE ? 'RELEASE' :
            msgType === DHCP_MSG_INFORM ? 'INFORM' :
            msgType === DHCP_MSG_DECLINE ? 'DECLINE' : `TYPE(${msgType})`;
        
        return `DHCPPacket: ${typeStr} xid=0x${this.xid.toString(16).padStart(8, '0')} ${this.getClientMACString()} ciaddr=${IPUtils.toString(this.ciaddr)} yiaddr=${IPUtils.toString(this.yiaddr)}`;
    }
}