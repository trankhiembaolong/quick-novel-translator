/**
 * test-e2e/tier2-boundaries/ssrf-security.test.js
 * Tier 2 Boundary & Corner Cases: SSRF & Preload URL Security (10 tests)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, UrlValidator } from '../harness/index.js';

describe('Tier 2: SSRF & Preload URL Security', () => {
    let sandbox;
    const SENDER_URL = 'https://truyenfull.vn/story/chap-1.html';

    beforeEach(() => {
        sandbox = setupSandbox();
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T2.23: blocks preload requests targeting IPv4 loopback addresses', () => {
        const targets = [
            'http://127.0.0.1/admin',
            'http://127.0.0.1:8080/chap-2',
            'http://localhost:3000/api',
            'http://0.0.0.0:8000/'
        ];

        for (const target of targets) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block loopback target: ${target}`);
            assert.ok(res.reason.includes('private') || res.reason.includes('Loopback') || res.reason.includes('reserved') || res.reason.includes('RFC1918'), `Expected private IP rejection, got: ${res.reason}`);
        }
    });

    it('T2.24: blocks preload requests targeting IPv6 loopback addresses', () => {
        const targets = [
            'http://[::1]/secret',
            'http://[::1]:8000/chap2'
        ];

        for (const target of targets) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block IPv6 loopback target: ${target}`);
            assert.ok(res.reason.includes('private') || res.reason.includes('Loopback') || res.reason.includes('reserved') || res.reason.includes('RFC1918'), `Expected private IP rejection, got: ${res.reason}`);
        }
    });

    it('T2.25: blocks preload requests targeting RFC1918 Class A private network (10.0.0.0/8)', () => {
        const targets = [
            'http://10.0.0.1/internal-novel',
            'http://10.254.1.5:8080/chap2'
        ];

        for (const target of targets) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block RFC1918 Class A: ${target}`);
            assert.ok(res.reason.includes('private') || res.reason.includes('Loopback') || res.reason.includes('reserved') || res.reason.includes('RFC1918'), `Expected private IP rejection, got: ${res.reason}`);
        }
    });

    it('T2.26: blocks preload requests targeting RFC1918 Class B private network (172.16.0.0/12)', () => {
        const targets = [
            'http://172.16.0.1/admin',
            'http://172.20.10.5:8000/status',
            'http://172.31.255.254/'
        ];

        for (const target of targets) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block RFC1918 Class B: ${target}`);
            assert.ok(res.reason.includes('private') || res.reason.includes('Loopback') || res.reason.includes('reserved') || res.reason.includes('RFC1918'), `Expected private IP rejection, got: ${res.reason}`);
        }
    });

    it('T2.27: blocks preload requests targeting RFC1918 Class C private network (192.168.0.0/16)', () => {
        const targets = [
            'http://192.168.1.1/router-settings',
            'http://192.168.0.100:8080/chap-2'
        ];

        for (const target of targets) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block RFC1918 Class C: ${target}`);
            assert.ok(res.reason.includes('private') || res.reason.includes('Loopback') || res.reason.includes('reserved') || res.reason.includes('RFC1918'), `Expected private IP rejection, got: ${res.reason}`);
        }
    });

    it('T2.28: blocks preload requests targeting AWS/GCP cloud metadata service (169.254.169.254)', () => {
        const targets = [
            'http://169.254.169.254/latest/meta-data/',
            'http://169.254.169.254/computeMetadata/v1/'
        ];

        for (const target of targets) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block link-local metadata endpoint: ${target}`);
            assert.ok(res.reason.includes('private') || res.reason.includes('Loopback') || res.reason.includes('reserved') || res.reason.includes('RFC1918'), `Expected private IP rejection, got: ${res.reason}`);
        }
    });

    it('T2.29: blocks non-HTTP/HTTPS protocols (file:, ftp:, data:, chrome:)', () => {
        const targets = [
            'file:///C:/Windows/win.ini',
            'file:///etc/passwd',
            'ftp://ftp.test/novel.txt',
            'data:text/html,<h1>XSS</h1>',
            'chrome://extensions/'
        ];

        for (const target of targets) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block scheme: ${target}`);
            assert.ok(res.reason.includes('invalid_protocol') || res.reason.includes('Invalid target scheme'));
        }
    });

    it('T2.30: blocks preload requests targeting dangerous ports (22 SSH, 25 SMTP, 3306 MySQL, 6379 Redis)', () => {
        const dangerousTargets = [
            'https://truyenfull.vn:22/chap2',
            'https://truyenfull.vn:25/chap2',
            'https://truyenfull.vn:3306/chap2',
            'https://truyenfull.vn:6379/chap2'
        ];

        for (const target of dangerousTargets) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block dangerous port: ${target}`);
            assert.ok(res.reason.includes('blocked_dangerous_port') || res.reason.includes('Blocked dangerous port'));
        }
    });

    it('T2.31: blocks cross-origin preload when targetUrl belongs to completely different domain', () => {
        const crossOrigins = [
            'https://evil-attacker.com/chap-2.html',
            'https://truyen-gia-mao.org/chap-2.html',
            'https://google.com/'
        ];

        for (const target of crossOrigins) {
            const res = UrlValidator.isSafePreloadTarget(SENDER_URL, target);
            assert.strictEqual(res.valid, false, `Must block cross-origin: ${target}`);
            assert.ok(res.reason.includes('cross_origin_blocked') || res.reason.includes('Cross-site'));
        }
    });

    it('T2.32: allows same eTLD+1 subdomains while blocking trailing bypass tricks (e.g. truyenfull.vn.evil.com)', () => {
        // Allowed: subdomains on same eTLD+1
        const validSubdomain = 'https://m.truyenfull.vn/story/chap-2.html';
        const resValid = UrlValidator.isSafePreloadTarget(SENDER_URL, validSubdomain);
        assert.strictEqual(resValid.valid, true, 'Subdomain on same eTLD+1 must be allowed');
        assert.strictEqual(resValid.resolvedUrl, validSubdomain);

        // Blocked: trailing attacker bypass domain
        const bypassTrick = 'https://truyenfull.vn.evil.com/chap-2.html';
        const resBypass = UrlValidator.isSafePreloadTarget(SENDER_URL, bypassTrick);
        assert.strictEqual(resBypass.valid, false, 'Attacker domain with trick prefix must be blocked');
        assert.ok(resBypass.reason.includes('cross_origin_blocked') || resBypass.reason.includes('Cross-site'));
    });
});
