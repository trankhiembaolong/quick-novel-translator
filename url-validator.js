/**
 * Quick Novel Translator (STV) - URL & Preload Security Validator
 * Universal Module: Works in Node.js (CommonJS/ESM) and Chrome Extension Service Worker (importScripts / global)
 */
(function (global, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        const mod = factory();
        global.STV_UrlValidator = mod;
        global.isValidUrl = mod.isValidUrl;
        global.isPrivateIP = mod.isPrivateIP;
        global.extractSiteDomain = mod.extractSiteDomain;
        global.isSafePreloadTarget = mod.isSafePreloadTarget;
    }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Cleans and extracts the hostname string from a URL or host string.
     * Preserves IPv6 brackets or raw IPv6 format.
     * @param {string} input 
     * @returns {string}
     */
    function cleanHost(input) {
        if (!input || typeof input !== 'string') return '';
        let host = input.trim().toLowerCase();
        if (host.includes('://')) {
            try {
                host = new URL(host).hostname.toLowerCase();
            } catch {
                return '';
            }
        } else {
            host = host.split('/')[0];
            if (host.startsWith('[')) {
                const endBracket = host.indexOf(']');
                if (endBracket !== -1) {
                    return host.slice(0, endBracket + 1);
                }
            }
            const colonCount = (host.match(/:/g) || []).length;
            if (colonCount === 1) {
                host = host.split(':')[0];
            }
        }
        while (host.length > 1 && host.endsWith('.')) {
            host = host.slice(0, -1);
        }
        return host;
    }

    /**
     * Parses an IPv4 string in dotted decimal, octal, hex, or dword format
     * into a 32-bit unsigned integer. Returns null if invalid.
     * @param {string} ipStr 
     * @returns {number|null}
     */
    function parseIPv4(ipStr) {
        if (!ipStr || typeof ipStr !== 'string') return null;
        const s = ipStr.trim().toLowerCase();
        const parts = s.split('.');
        if (parts.length > 4 || parts.length === 0) return null;

        const values = [];
        for (const p of parts) {
            if (!p) return null;
            let val;
            if (p.startsWith('0x')) {
                val = parseInt(p, 16);
            } else if (p.length > 1 && p.startsWith('0') && /^0[0-7]+$/.test(p)) {
                val = parseInt(p, 8);
            } else if (/^\d+$/.test(p)) {
                val = parseInt(p, 10);
            } else {
                return null;
            }
            if (isNaN(val) || val < 0) return null;
            values.push(val);
        }

        let ipNum = 0;
        if (values.length === 1) {
            if (values[0] > 0xffffffff) return null;
            ipNum = values[0];
        } else if (values.length === 2) {
            if (values[0] > 0xff || values[1] > 0xffffff) return null;
            ipNum = (((values[0] << 24) >>> 0) + values[1]) >>> 0;
        } else if (values.length === 3) {
            if (values[0] > 0xff || values[1] > 0xff || values[2] > 0xffff) return null;
            ipNum = (((values[0] << 24) >>> 0) + (values[1] << 16) + values[2]) >>> 0;
        } else if (values.length === 4) {
            for (const v of values) {
                if (v > 0xff) return null;
            }
            ipNum = (((values[0] << 24) >>> 0) + (values[1] << 16) + (values[2] << 8) + values[3]) >>> 0;
        }
        return (ipNum >>> 0);
    }

    /**
     * Checks if a 32-bit unsigned integer represents an IPv4 private, loopback,
     * link-local, carrier-grade NAT, or unspecified address.
     * @param {number} num 
     * @returns {boolean}
     */
    function isPrivateIPv4Num(num) {
        const b0 = num >>> 24;
        const b1 = (num >>> 16) & 255;

        // 0.0.0.0/8 (Current network / default route)
        if (b0 === 0) return true;
        // 10.0.0.0/8 (RFC 1918 Private)
        if (b0 === 10) return true;
        // 127.0.0.0/8 (Loopback)
        if (b0 === 127) return true;
        // 169.254.0.0/16 (RFC 3927 Link-Local / Cloud Metadata)
        if (b0 === 169 && b1 === 254) return true;
        // 172.16.0.0/12 (RFC 1918 Private: 172.16.0.0 - 172.31.255.255)
        if (b0 === 172 && (b1 >= 16 && b1 <= 31)) return true;
        // 192.168.0.0/16 (RFC 1918 Private)
        if (b0 === 192 && b1 === 168) return true;
        // 100.64.0.0/10 (RFC 6598 Carrier-Grade NAT: 100.64.0.0 - 100.127.255.255)
        if (b0 === 100 && (b1 >= 64 && b1 <= 127)) return true;

        return false;
    }

    /**
     * Parses an IPv6 address string into an array of 8 16-bit words.
     * Handles bracketed notation, :: expansion, and IPv4-mapped notation.
     * @param {string} ipStr 
     * @returns {number[]|null}
     */
    function parseIPv6(ipStr) {
        if (!ipStr || typeof ipStr !== 'string') return null;
        let s = ipStr.trim().toLowerCase();
        if (s.startsWith('[') && s.endsWith(']')) {
            s = s.slice(1, -1);
        }

        // Handle IPv4-mapped or compatible at end (e.g. ::ffff:192.168.1.1)
        const lastColon = s.lastIndexOf(':');
        if (lastColon !== -1) {
            const after = s.slice(lastColon + 1);
            if (after.includes('.')) {
                const parts = after.split('.');
                if (parts.length === 4) {
                    const b = parts.map(x => parseInt(x, 10));
                    if (b.every(x => !isNaN(x) && x >= 0 && x <= 255)) {
                        const hex1 = ((b[0] << 8) | b[1]).toString(16);
                        const hex2 = ((b[2] << 8) | b[3]).toString(16);
                        s = s.slice(0, lastColon + 1) + hex1 + ':' + hex2;
                    }
                }
            }
        }

        const parts = s.split('::');
        if (parts.length > 2) return null; // More than one :: is invalid

        let words = [];
        if (parts.length === 2) {
            const left = parts[0] ? parts[0].split(':') : [];
            const right = parts[1] ? parts[1].split(':') : [];
            const missing = 8 - (left.length + right.length);
            if (missing < 1) return null;
            words = [...left, ...Array(missing).fill('0'), ...right];
        } else {
            words = s.split(':');
            if (words.length !== 8) return null;
        }

        const nums = [];
        for (const w of words) {
            if (!/^[0-9a-f]{1,4}$/i.test(w)) return null;
            nums.push(parseInt(w, 16));
        }
        return nums;
    }

    /**
     * Checks if 8 16-bit words represent a private or loopback IPv6 address.
     * @param {number[]} words 
     * @returns {boolean}
     */
    function isPrivateIPv6(words) {
        if (!words || words.length !== 8) return false;

        // Loopback ::1
        if (words.slice(0, 7).every(w => w === 0) && words[7] === 1) return true;
        // Unspecified ::
        if (words.every(w => w === 0)) return true;
        // ULA fc00::/7 (fc00:: - fdff::)
        if ((words[0] & 0xfe00) === 0xfc00) return true;
        // Link-local fe80::/10 (fe80:: - febf::)
        if ((words[0] & 0xffc0) === 0xfe80) return true;
        // Site-local deprecated fec0::/10
        if ((words[0] & 0xffc0) === 0xfec0) return true;

        // IPv4-mapped IPv6 (::ffff:0:0/96)
        if (words.slice(0, 5).every(w => w === 0) && words[5] === 0xffff) {
            const num = (((words[6] << 16) | words[7]) >>> 0);
            return isPrivateIPv4Num(num);
        }

        // IPv4-compatible IPv6 (::0:0/96)
        if (words.slice(0, 6).every(w => w === 0) && (words[6] !== 0 || words[7] > 1)) {
            const num = (((words[6] << 16) | words[7]) >>> 0);
            return isPrivateIPv4Num(num);
        }

        return false;
    }

    /**
     * Determines whether a given hostname or IP string is private/loopback/SSRF.
     * @param {string} hostOrIp 
     * @returns {boolean}
     */
    function isPrivateIP(hostOrIp) {
        if (!hostOrIp || typeof hostOrIp !== 'string') return false;
        let host = cleanHost(hostOrIp);
        if (!host) return false;

        if (host.startsWith('[') && host.endsWith(']')) {
            host = host.slice(1, -1);
        }

        // Check local hostnames
        if (
            host === 'localhost' ||
            host.endsWith('.localhost') ||
            host.endsWith('.local') ||
            host.endsWith('.internal') ||
            host.endsWith('.lan') ||
            host === 'localtest.me' ||
            host.endsWith('.localtest.me') ||
            host === 'lvh.me' ||
            host.endsWith('.lvh.me') ||
            host === 'nip.io' ||
            host.includes('.nip.io') ||
            host === 'sslip.io' ||
            host.includes('.sslip.io')
        ) {
            return true;
        }

        // Check IPv4
        const ipv4Num = parseIPv4(host);
        if (ipv4Num !== null) {
            return isPrivateIPv4Num(ipv4Num);
        }

        // Check IPv6
        const ipv6Words = parseIPv6(host);
        if (ipv6Words !== null) {
            return isPrivateIPv6(ipv6Words);
        }

        return false;
    }

    /**
     * Extracts the registrable site domain (eTLD+1) or IP/host from a URL or hostname.
     * @param {string} hostOrUrl 
     * @returns {string}
     */
    function extractSiteDomain(hostOrUrl) {
        if (!hostOrUrl || typeof hostOrUrl !== 'string') return '';
        let host = cleanHost(hostOrUrl);
        if (!host) return '';

        // If IPv6 with brackets
        if (host.startsWith('[') && host.endsWith(']')) {
            return host;
        }

        // If standard IPv4
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
            return host;
        }

        const parts = host.split('.').filter(Boolean);
        if (parts.length <= 1) return host;

        const lastPart = parts[parts.length - 1];
        const secondLast = parts[parts.length - 2];
        const commonTwoPartSecondLevel = new Set([
            'com', 'co', 'net', 'org', 'edu', 'gov', 'ac', 'ne', 're', 'idv', 'biz', 'info'
        ]);

        if (parts.length >= 3 && lastPart.length === 2 && commonTwoPartSecondLevel.has(secondLast)) {
            return parts.slice(-3).join('.');
        }

        return parts.slice(-2).join('.');
    }

    /**
     * Checks if a string is a valid absolute HTTP or HTTPS URL with valid port.
     * @param {string} url 
     * @returns {boolean}
     */
    function isValidUrl(url, allowedProtocols = ['http:', 'https:']) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url);
            const protocols = Array.isArray(allowedProtocols) && allowedProtocols.length
                ? allowedProtocols
                : ['http:', 'https:'];
            if (!protocols.includes(u.protocol)) return false;
            if (u.port) {
                const portNum = Number(u.port);
                if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || u.port === '0') {
                    return false;
                }
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Validates whether a preload target URL is safe to fetch from the background worker
     * on behalf of a sender tab.
     * 
     * Enforces:
     * 1. Valid HTTP/HTTPS protocols on both sender and target.
     * 2. Port bounds (1 to 65535, rejects port 0 or non-numeric/overflow).
     * 3. No embedded credentials in target URL.
     * 4. SSRF and private IP blocking (RFC1918, loopback, link-local, CGNAT, ULA, IPv4-mapped, hex/octal/decimal evasion).
     *    Exception: Allowed only if sender tab is itself on localhost/private.
     * 5. Same-site (eTLD+1) domain matching between sender tab and target URL.
     * 
     * @param {string} senderTabUrl - The URL of the tab requesting the preload.
     * @param {string} targetUrl - The target URL (can be relative or absolute).
     * @returns {{ valid: boolean, reason?: string, resolvedUrl?: string }}
     */
    function isSafePreloadTarget(senderTabUrl, targetUrl) {
        if (!senderTabUrl || typeof senderTabUrl !== 'string' || !targetUrl || typeof targetUrl !== 'string') {
            return { valid: false, reason: 'Missing sender or target URL' };
        }

        const trimmedSender = senderTabUrl.trim();
        const trimmedTarget = targetUrl.trim();

        if (!trimmedSender || !trimmedTarget) {
            return { valid: false, reason: 'Missing sender or target URL' };
        }

        // Validate sender URL
        let parsedSender;
        try {
            parsedSender = new URL(trimmedSender);
        } catch {
            return { valid: false, reason: 'Invalid sender URL' };
        }

        if (parsedSender.protocol !== 'http:' && parsedSender.protocol !== 'https:') {
            return { valid: false, reason: 'Invalid sender scheme: ' + parsedSender.protocol };
        }

        // Resolve and validate target URL against sender URL
        let parsedTarget;
        try {
            parsedTarget = new URL(trimmedTarget, trimmedSender);
        } catch {
            return { valid: false, reason: 'Invalid target URL' };
        }

        if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
            return { valid: false, reason: 'Invalid target scheme: ' + parsedTarget.protocol };
        }

        // Disallow embedded userinfo/credentials in preload targets
        if (parsedTarget.username || parsedTarget.password) {
            return { valid: false, reason: 'Credentials in preload target URL are not allowed' };
        }

        // Validate target port bounds & block dangerous non-HTTP services
        const DANGEROUS_PORTS = new Set([21, 22, 23, 25, 53, 110, 143, 3306, 5432, 6379, 11211, 27017]);
        if (parsedTarget.port) {
            const portNum = Number(parsedTarget.port);
            if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || parsedTarget.port === '0') {
                return { valid: false, reason: 'Invalid target port: ' + parsedTarget.port };
            }
            if (DANGEROUS_PORTS.has(portNum)) {
                return { valid: false, reason: 'Blocked dangerous port: ' + portNum };
            }
        }

        // Check private IP / SSRF defense
        const senderIsPrivate = isPrivateIP(parsedSender.hostname);
        const targetIsPrivate = isPrivateIP(parsedTarget.hostname);

        if (targetIsPrivate && !senderIsPrivate) {
            return { valid: false, reason: 'Blocked private IP / SSRF target: ' + parsedTarget.hostname };
        }

        // Validate same-origin or same-site eTLD+1 matching
        const senderSite = extractSiteDomain(parsedSender.hostname);
        const targetSite = extractSiteDomain(parsedTarget.hostname);

        if (!senderSite || !targetSite || senderSite !== targetSite) {
            return {
                valid: false,
                reason: 'Cross-site preload target rejected: sender site (' + senderSite + ') does not match target site (' + targetSite + ')'
            };
        }

        return {
            valid: true,
            resolvedUrl: parsedTarget.href
        };
    }

    return {
        cleanHost,
        parseIPv4,
        parseIPv6,
        isPrivateIP,
        extractSiteDomain,
        isValidUrl,
        isSafePreloadTarget
    };
});
