const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../url-validator.js');

const {
    isValidUrl,
    isPrivateIP,
    extractSiteDomain,
    isSafePreloadTarget
} = validator;

describe('URL & Preload Validator Tests', () => {

    describe('isValidUrl', () => {
        it('accepts valid HTTP and HTTPS URLs', () => {
            assert.strictEqual(isValidUrl('http://example.com'), true);
            assert.strictEqual(isValidUrl('https://example.com'), true);
            assert.strictEqual(isValidUrl('https://example.com/path?arg=1#frag'), true);
            assert.strictEqual(isValidUrl('https://sub.domain.truyenfull.vn/ch1'), true);
        });

        it('accepts valid port bounds (1-65535)', () => {
            assert.strictEqual(isValidUrl('http://example.com:80'), true);
            assert.strictEqual(isValidUrl('https://example.com:443'), true);
            assert.strictEqual(isValidUrl('http://example.com:8080'), true);
            assert.strictEqual(isValidUrl('https://example.com:65535'), true);
            assert.strictEqual(isValidUrl('http://example.com:1'), true);
        });

        it('rejects forbidden protocols', () => {
            assert.strictEqual(isValidUrl('javascript:alert(1)'), false);
            assert.strictEqual(isValidUrl('file:///C:/Windows/win.ini'), false);
            assert.strictEqual(isValidUrl('data:text/html,<b>hi</b>'), false);
            assert.strictEqual(isValidUrl('blob:https://example.com/uuid'), false);
            assert.strictEqual(isValidUrl('ftp://ftp.example.com/file.txt'), false);
            assert.strictEqual(isValidUrl('ws://example.com/socket'), false);
            assert.strictEqual(isValidUrl('wss://example.com/socket'), false);
        });

        it('rejects invalid or out-of-range ports', () => {
            assert.strictEqual(isValidUrl('http://example.com:0'), false);
            assert.strictEqual(isValidUrl('http://example.com:70000'), false);
            assert.strictEqual(isValidUrl('http://example.com:-1'), false);
            assert.strictEqual(isValidUrl('http://example.com:abc'), false);
        });

        it('rejects malformed inputs and non-strings', () => {
            assert.strictEqual(isValidUrl(null), false);
            assert.strictEqual(isValidUrl(undefined), false);
            assert.strictEqual(isValidUrl(''), false);
            assert.strictEqual(isValidUrl('   '), false);
            assert.strictEqual(isValidUrl(12345), false);
            assert.strictEqual(isValidUrl({}), false);
            assert.strictEqual(isValidUrl('/relative/path'), false);
        });
    });

    describe('isPrivateIP', () => {
        it('identifies RFC1918 private IPv4 addresses', () => {
            // 10.0.0.0/8
            assert.strictEqual(isPrivateIP('10.0.0.1'), true);
            assert.strictEqual(isPrivateIP('10.255.255.254'), true);
            // 172.16.0.0/12
            assert.strictEqual(isPrivateIP('172.16.0.1'), true);
            assert.strictEqual(isPrivateIP('172.31.255.254'), true);
            assert.strictEqual(isPrivateIP('172.15.255.255'), false); // Public
            assert.strictEqual(isPrivateIP('172.32.0.1'), false);      // Public
            // 192.168.0.0/16
            assert.strictEqual(isPrivateIP('192.168.0.1'), true);
            assert.strictEqual(isPrivateIP('192.168.1.100'), true);
            assert.strictEqual(isPrivateIP('192.169.0.1'), false);    // Public
        });

        it('identifies loopback and unspecified addresses', () => {
            assert.strictEqual(isPrivateIP('127.0.0.1'), true);
            assert.strictEqual(isPrivateIP('127.0.0.2'), true);
            assert.strictEqual(isPrivateIP('127.255.255.254'), true);
            assert.strictEqual(isPrivateIP('0.0.0.0'), true);
            assert.strictEqual(isPrivateIP('0'), true);
        });

        it('identifies link-local and cloud metadata addresses (169.254.x.x)', () => {
            assert.strictEqual(isPrivateIP('169.254.169.254'), true);
            assert.strictEqual(isPrivateIP('169.254.1.1'), true);
            assert.strictEqual(isPrivateIP('169.253.255.255'), false);
            assert.strictEqual(isPrivateIP('169.255.0.1'), false);
        });

        it('identifies Carrier-Grade NAT (CGNAT RFC6598 100.64.0.0/10)', () => {
            assert.strictEqual(isPrivateIP('100.64.0.1'), true);
            assert.strictEqual(isPrivateIP('100.127.255.254'), true);
            assert.strictEqual(isPrivateIP('100.63.255.255'), false);
            assert.strictEqual(isPrivateIP('100.128.0.1'), false);
        });

        it('identifies SSRF evasion notations (octal, hex, dword, BSD shorthand)', () => {
            assert.strictEqual(isPrivateIP('0177.0.0.1'), true);     // Octal 127.0.0.1
            assert.strictEqual(isPrivateIP('0x7f000001'), true);     // Hex 127.0.0.1
            assert.strictEqual(isPrivateIP('0x7f.0.0.1'), true);     // Hex part
            assert.strictEqual(isPrivateIP('2130706433'), true);     // Dword 127.0.0.1
            assert.strictEqual(isPrivateIP('127.1'), true);          // BSD 2-part
            assert.strictEqual(isPrivateIP('127.0.1'), true);        // BSD 3-part
            assert.strictEqual(isPrivateIP('0300.0250.0.1'), true);  // Octal 192.168.0.1
        });

        it('identifies localhost and internal hostnames', () => {
            assert.strictEqual(isPrivateIP('localhost'), true);
            assert.strictEqual(isPrivateIP('sub.localhost'), true);
            assert.strictEqual(isPrivateIP('foo.bar.localhost'), true);
            assert.strictEqual(isPrivateIP('router.local'), true);
            assert.strictEqual(isPrivateIP('service.internal'), true);
            assert.strictEqual(isPrivateIP('nas.lan'), true);
            assert.strictEqual(isPrivateIP('localtest.me'), true);
            assert.strictEqual(isPrivateIP('app.localtest.me'), true);
            assert.strictEqual(isPrivateIP('lvh.me'), true);
            assert.strictEqual(isPrivateIP('sub.lvh.me'), true);
            assert.strictEqual(isPrivateIP('test.127.0.0.1.nip.io'), true);
            assert.strictEqual(isPrivateIP('nip.io'), true);
            assert.strictEqual(isPrivateIP('127.0.0.1.sslip.io'), true);
            assert.strictEqual(isPrivateIP('sslip.io'), true);
            assert.strictEqual(isPrivateIP('127.0.0.1.'), true);
        });

        it('identifies IPv6 loopback, ULA, link-local, and IPv4-mapped addresses', () => {
            assert.strictEqual(isPrivateIP('::1'), true);
            assert.strictEqual(isPrivateIP('[::1]'), true);
            assert.strictEqual(isPrivateIP('::'), true);
            assert.strictEqual(isPrivateIP('[::]'), true);
            // ULA fc00::/7
            assert.strictEqual(isPrivateIP('fc00::1'), true);
            assert.strictEqual(isPrivateIP('[fc00::1]'), true);
            assert.strictEqual(isPrivateIP('fd12:3456:789a::1'), true);
            // Link-local fe80::/10
            assert.strictEqual(isPrivateIP('fe80::1'), true);
            assert.strictEqual(isPrivateIP('[fe80::1]'), true);
            assert.strictEqual(isPrivateIP('febf::1'), true);
            // IPv4-mapped IPv6
            assert.strictEqual(isPrivateIP('::ffff:127.0.0.1'), true);
            assert.strictEqual(isPrivateIP('[::ffff:7f00:1]'), true);
            assert.strictEqual(isPrivateIP('::ffff:10.0.0.1'), true);
            assert.strictEqual(isPrivateIP('::ffff:192.168.1.1'), true);
            assert.strictEqual(isPrivateIP('::ffff:8.8.8.8'), false); // Mapped public IP
            // Public IPv6
            assert.strictEqual(isPrivateIP('2001:4860:4860::8888'), false);
        });

        it('returns false for public hostnames and IP addresses', () => {
            assert.strictEqual(isPrivateIP('8.8.8.8'), false);
            assert.strictEqual(isPrivateIP('1.1.1.1'), false);
            assert.strictEqual(isPrivateIP('93.184.216.34'), false);
            assert.strictEqual(isPrivateIP('example.com'), false);
            assert.strictEqual(isPrivateIP('truyenfull.vn'), false);
            assert.strictEqual(isPrivateIP('openrouter.ai'), false);
        });
    });

    describe('extractSiteDomain', () => {
        it('extracts standard registrable domain (eTLD+1)', () => {
            assert.strictEqual(extractSiteDomain('https://example.com/chapter-1'), 'example.com');
            assert.strictEqual(extractSiteDomain('https://sub.example.com/'), 'example.com');
            assert.strictEqual(extractSiteDomain('https://a.b.c.example.org'), 'example.org');
            assert.strictEqual(extractSiteDomain('truyenfull.vn'), 'truyenfull.vn');
            assert.strictEqual(extractSiteDomain('https://novel.truyenfull.vn/c1'), 'truyenfull.vn');
        });

        it('handles multi-part ccTLDs (.co.uk, .com.vn, .com.au, etc.)', () => {
            assert.strictEqual(extractSiteDomain('https://novel.truyenfull.com.vn/c1'), 'truyenfull.com.vn');
            assert.strictEqual(extractSiteDomain('https://sub.read.co.uk/page'), 'read.co.uk');
            assert.strictEqual(extractSiteDomain('https://test.site.com.au'), 'site.com.au');
            assert.strictEqual(extractSiteDomain('read.co.uk'), 'read.co.uk');
        });

        it('handles localhost and IP addresses', () => {
            assert.strictEqual(extractSiteDomain('http://localhost:3000/ch1'), 'localhost');
            assert.strictEqual(extractSiteDomain('http://127.0.0.1:8080/ch1'), '127.0.0.1');
            assert.strictEqual(extractSiteDomain('http://[::1]:8080/ch1'), '[::1]');
        });

        it('handles invalid inputs gracefully', () => {
            assert.strictEqual(extractSiteDomain(''), '');
            assert.strictEqual(extractSiteDomain(null), '');
            assert.strictEqual(extractSiteDomain(undefined), '');
            assert.strictEqual(extractSiteDomain(123), '');
        });
    });

    describe('isSafePreloadTarget', () => {
        it('allows valid same-origin HTTP/HTTPS preload targets', () => {
            const res = isSafePreloadTarget('https://truyenfull.vn/chuong-1', 'https://truyenfull.vn/chuong-2');
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.resolvedUrl, 'https://truyenfull.vn/chuong-2');
        });

        it('resolves and allows valid relative URLs', () => {
            const res = isSafePreloadTarget('https://truyenfull.vn/truyen-hay/chuong-1', '/truyen-hay/chuong-2');
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.resolvedUrl, 'https://truyenfull.vn/truyen-hay/chuong-2');

            const resRelative = isSafePreloadTarget('https://truyenfull.vn/truyen-hay/chuong-1', 'chuong-2.html');
            assert.strictEqual(resRelative.valid, true);
            assert.strictEqual(resRelative.resolvedUrl, 'https://truyenfull.vn/truyen-hay/chuong-2.html');
        });

        it('allows same-site cross-subdomain preloading (same eTLD+1)', () => {
            const res1 = isSafePreloadTarget('https://m.novel.com/c1', 'https://www.novel.com/c2');
            assert.strictEqual(res1.valid, true);
            assert.strictEqual(res1.resolvedUrl, 'https://www.novel.com/c2');

            const res2 = isSafePreloadTarget('https://chapter1.readnovel.co.uk/p1', 'https://chapter2.readnovel.co.uk/p2');
            assert.strictEqual(res2.valid, true);
            assert.strictEqual(res2.resolvedUrl, 'https://chapter2.readnovel.co.uk/p2');
        });

        it('allows valid custom ports on public domains', () => {
            const res = isSafePreloadTarget('https://truyenfull.vn:8443/c1', 'https://truyenfull.vn:8443/c2');
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.resolvedUrl, 'https://truyenfull.vn:8443/c2');
        });

        it('allows localhost preloading when sender is also localhost', () => {
            const res = isSafePreloadTarget('http://localhost:3000/c1', 'http://localhost:3000/c2');
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.resolvedUrl, 'http://localhost:3000/c2');
        });

        it('rejects cross-site targets', () => {
            const res = isSafePreloadTarget('https://truyenfull.vn/c1', 'https://evil-novel.com/c2');
            assert.strictEqual(res.valid, false);
            assert.match(res.reason, /Cross-site/i);
        });

        it('rejects SSRF attempts from public sender to private IPv4 / RFC1918', () => {
            const targets = [
                'http://127.0.0.1:8080/c2',
                'http://192.168.1.1/admin',
                'http://10.0.0.1/api',
                'http://172.16.0.1/status',
                'http://169.254.169.254/latest/meta-data/',
                'http://100.64.0.1/c2'
            ];
            for (const t of targets) {
                const res = isSafePreloadTarget('https://truyenfull.vn/c1', t);
                assert.strictEqual(res.valid, false, `Failed to block target: ${t}`);
                assert.match(res.reason, /Blocked private IP|Cross-site/i);
            }
        });

        it('rejects SSRF evasion attempts (octal, hex, dword, 0.0.0.0)', () => {
            const evasionTargets = [
                'http://0177.0.0.1/admin',
                'http://0x7f000001/admin',
                'http://2130706433/admin',
                'http://0.0.0.0:8000/',
                'http://0:8000/'
            ];
            for (const t of evasionTargets) {
                const res = isSafePreloadTarget('https://truyenfull.vn/c1', t);
                assert.strictEqual(res.valid, false, `Failed to block evasion target: ${t}`);
                assert.match(res.reason, /Blocked private IP|Cross-site/i);
            }
        });

        it('rejects SSRF to private IPv6 addresses', () => {
            const ipv6Targets = [
                'http://[::1]:8080/',
                'http://[::]:8080/',
                'http://[fc00::1]/',
                'http://[fe80::1]/',
                'http://[::ffff:127.0.0.1]/'
            ];
            for (const t of ipv6Targets) {
                const res = isSafePreloadTarget('https://truyenfull.vn/c1', t);
                assert.strictEqual(res.valid, false, `Failed to block IPv6 target: ${t}`);
                assert.match(res.reason, /Blocked private IP|Cross-site/i);
            }
        });

        it('rejects localhost sender attempting to scan arbitrary private LAN IP', () => {
            const res = isSafePreloadTarget('http://localhost:3000/c1', 'http://192.168.1.1/admin');
            assert.strictEqual(res.valid, false);
            assert.match(res.reason, /Cross-site/i);
        });

        it('rejects dangerous and non-HTTP protocols', () => {
            const dangerous = [
                'javascript:alert(document.cookie)',
                'file:///C:/Windows/win.ini',
                'data:text/html,<script>evil()</script>',
                'ftp://truyenfull.vn/c2',
                'blob:https://truyenfull.vn/abc'
            ];
            for (const t of dangerous) {
                const res = isSafePreloadTarget('https://truyenfull.vn/c1', t);
                assert.strictEqual(res.valid, false);
                assert.match(res.reason, /Invalid target scheme/i);
            }
        });

        it('rejects invalid or out-of-range port numbers', () => {
            assert.strictEqual(isSafePreloadTarget('https://truyenfull.vn/c1', 'https://truyenfull.vn:0/c2').valid, false);
            assert.strictEqual(isSafePreloadTarget('https://truyenfull.vn/c1', 'https://truyenfull.vn:70000/c2').valid, false);
            assert.strictEqual(isSafePreloadTarget('https://truyenfull.vn/c1', 'https://truyenfull.vn:-1/c2').valid, false);
            assert.strictEqual(isSafePreloadTarget('https://truyenfull.vn/c1', 'https://truyenfull.vn:abc/c2').valid, false);
        });

        it('rejects preload targets with embedded credentials', () => {
            const res = isSafePreloadTarget('https://truyenfull.vn/c1', 'https://admin:pass@truyenfull.vn/c2');
            assert.strictEqual(res.valid, false);
            assert.match(res.reason, /Credentials/i);
        });

        it('rejects invalid sender URL or non-HTTP sender scheme', () => {
            assert.strictEqual(isSafePreloadTarget('chrome://extensions', 'https://truyenfull.vn/c2').valid, false);
            assert.strictEqual(isSafePreloadTarget('file:///C:/test.html', 'https://truyenfull.vn/c2').valid, false);
            assert.strictEqual(isSafePreloadTarget('about:blank', 'https://truyenfull.vn/c2').valid, false);
            assert.strictEqual(isSafePreloadTarget('not-a-url', 'https://truyenfull.vn/c2').valid, false);
        });

        it('rejects missing or empty inputs', () => {
            assert.strictEqual(isSafePreloadTarget(null, 'https://truyenfull.vn/c2').valid, false);
            assert.strictEqual(isSafePreloadTarget('https://truyenfull.vn/c1', null).valid, false);
            assert.strictEqual(isSafePreloadTarget('', '').valid, false);
            assert.strictEqual(isSafePreloadTarget('   ', '   ').valid, false);
        });
    });
});
