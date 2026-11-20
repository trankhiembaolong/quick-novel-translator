/**
 * test-e2e/harness/chrome-mock.js
 * High-fidelity Chrome Manifest V3 API Simulation for Node.js v24.
 */

export function createChromeMock(options = {}) {
    // 1. Storage API with TRUSTED_CONTEXTS support and session storage
    const storageStore = new Map(Object.entries(options.initialStorage || {}));
    const sessionStore = new Map(Object.entries(options.initialSessionStorage || {}));
    let storageAccessLevel = options.accessLevel || 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
    const storageChangeListeners = new Set();

    // Sensitive keys restricted to trusted contexts
    const SENSITIVE_KEYS = new Set(['apikey', 'ttsApiKey', 'secretKey']);
    const isTrustedContext = options.isContentScript !== true;
    const canAccessLocalKey = (k) => {
        if (storageAccessLevel === 'TRUSTED_CONTEXTS' && !isTrustedContext) {
            return !SENSITIVE_KEYS.has(k);
        }
        return true;
    };

    const createStorageArea = (store, areaName, canAccessKey = () => true) => ({
        async get(keys, callback) {
            let res = {};
            if (keys == null) {
                for (const [k, v] of store.entries()) {
                    if (canAccessKey(k)) res[k] = v;
                }
            } else if (typeof keys === 'string') {
                if (canAccessKey(keys) && store.has(keys)) {
                    res = { [keys]: store.get(keys) };
                }
            } else if (Array.isArray(keys)) {
                for (const k of keys) {
                    if (canAccessKey(k) && store.has(k)) {
                        res[k] = store.get(k);
                    }
                }
            } else if (typeof keys === 'object') {
                for (const [k, defVal] of Object.entries(keys)) {
                    if (canAccessKey(k)) {
                        res[k] = store.has(k) ? store.get(k) : defVal;
                    }
                }
            }

            if (typeof callback === 'function') {
                callback(res);
            }
            return res;
        },

        async set(items, callback) {
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
                const oldValue = store.get(k);
                store.set(k, v);
                changes[k] = { oldValue, newValue: v };
            }
            for (const listener of storageChangeListeners) {
                try { listener(changes, areaName); } catch (e) { console.error(e); }
            }
            if (typeof callback === 'function') {
                callback();
            }
        },

        async remove(keys, callback) {
            const keyList = Array.isArray(keys) ? keys : [keys];
            const changes = {};
            for (const k of keyList) {
                if (store.has(k)) {
                    const oldValue = store.get(k);
                    store.delete(k);
                    changes[k] = { oldValue, newValue: undefined };
                }
            }
            for (const listener of storageChangeListeners) {
                try { listener(changes, areaName); } catch (e) { console.error(e); }
            }
            if (typeof callback === 'function') {
                callback();
            }
        },

        async clear(callback) {
            const changes = {};
            for (const [k, v] of store.entries()) {
                changes[k] = { oldValue: v, newValue: undefined };
            }
            store.clear();
            for (const listener of storageChangeListeners) {
                try { listener(changes, areaName); } catch (e) { console.error(e); }
            }
            if (typeof callback === 'function') {
                callback();
            }
        },

        _getRawStore() {
            return store;
        }
    });

    const localArea = createStorageArea(storageStore, 'local', canAccessLocalKey);
    const sessionArea = createStorageArea(sessionStore, 'session');

    const storage = {
        local: {
            ...localArea,
            async setAccessLevel({ accessLevel }) {
                if (accessLevel !== 'TRUSTED_CONTEXTS' && accessLevel !== 'TRUSTED_AND_UNTRUSTED_CONTEXTS') {
                    throw new Error(`Invalid access level: ${accessLevel}`);
                }
                storageAccessLevel = accessLevel;
            },
            _getAccessLevel() {
                return storageAccessLevel;
            }
        },
        session: sessionArea,

        onChanged: {
            addListener(cb) { storageChangeListeners.add(cb); },
            removeListener(cb) { storageChangeListeners.delete(cb); }
        }
    };

    // 2. Runtime IPC Ports and Messaging
    const messageListeners = new Set();
    const connectListeners = new Set();
    const installedListeners = new Set();
    const startupListeners = new Set();

    class MockPort {
        constructor(name, peer = null) {
            this.name = name;
            this.peer = peer;
            this.messageListeners = new Set();
            this.disconnectListeners = new Set();

            this.onMessage = {
                addListener: (cb) => this.messageListeners.add(cb),
                removeListener: (cb) => this.messageListeners.delete(cb)
            };
            this.onDisconnect = {
                addListener: (cb) => this.disconnectListeners.add(cb),
                removeListener: (cb) => this.disconnectListeners.delete(cb)
            };
        }

        postMessage(msg) {
            const targetPeer = this.peer;
            if (targetPeer) {
                queueMicrotask(() => {
                    if (targetPeer && targetPeer.messageListeners) {
                        for (const cb of targetPeer.messageListeners) {
                            try { cb(msg); } catch (e) { console.error(e); }
                        }
                    }
                });
            }
        }

        disconnect() {
            if (this.peer) {
                const peer = this.peer;
                this.peer = null;
                peer.peer = null;
                for (const cb of peer.disconnectListeners) {
                    try { cb(); } catch (e) { console.error(e); }
                }
                for (const cb of this.disconnectListeners) {
                    try { cb(); } catch (e) { console.error(e); }
                }
            }
        }
    }

    const runtime = {
        id: 'stv-mock-extension-id-1234567890',
        lastError: null,

        getURL(path) {
            const cleanPath = String(path || '').replace(/^\/+/, '');
            return `chrome-extension://${runtime.id}/${cleanPath}`;
        },

        onMessage: {
            addListener(cb) { messageListeners.add(cb); },
            removeListener(cb) { messageListeners.delete(cb); }
        },

        onConnect: {
            addListener(cb) { connectListeners.add(cb); },
            removeListener(cb) { connectListeners.delete(cb); }
        },

        onInstalled: {
            addListener(cb) { installedListeners.add(cb); },
            removeListener(cb) { installedListeners.delete(cb); }
        },

        onStartup: {
            addListener(cb) { startupListeners.add(cb); },
            removeListener(cb) { startupListeners.delete(cb); }
        },

        sendMessage(msg, callback) {
            return new Promise((resolve) => {
                let responded = false;
                const sendResponse = (res) => {
                    if (responded) return;
                    responded = true;
                    if (callback) callback(res);
                    resolve(res);
                };

                const sender = {
                    id: runtime.id,
                    tab: tabs._activeTab,
                    url: tabs._activeTab ? tabs._activeTab.url : 'chrome-extension://' + runtime.id + '/popup.html'
                };

                let isAsync = false;
                for (const listener of messageListeners) {
                    try {
                        const result = listener(msg, sender, sendResponse);
                        if (result === true) {
                            isAsync = true;
                        }
                    } catch (e) {
                        console.error('Message listener error:', e);
                    }
                }

                if (!isAsync && !responded) {
                    sendResponse(undefined);
                }
            });
        },

        connect({ name = 'default' } = {}) {
            const clientPort = new MockPort(name);
            const serverPort = new MockPort(name, clientPort);
            clientPort.peer = serverPort;

            queueMicrotask(() => {
                for (const listener of connectListeners) {
                    try { listener(serverPort); } catch (e) { console.error(e); }
                }
            });
            return clientPort;
        },

        sendNativeMessage(host, payload, cb) {
            if (options.onNativeMessage) {
                options.onNativeMessage(host, payload, cb);
            } else if (options.nativeHostInstalled === false) {
                runtime.lastError = { message: 'Specified native messaging host not found.' };
                if (cb) cb({ ok: false, error: 'host_not_found' });
            } else {
                if (cb) cb({ ok: true, status: 'mock_native_success', echo: payload });
            }
        }
    };

    // 3. Tabs & Scripting
    const tabList = options.initialTabs ? [...options.initialTabs] : [
        { id: 1, active: true, url: 'https://example-novel.com/chapter-1.html', status: 'complete', title: 'Chapter 1' }
    ];
    let activeTab = tabList.find(t => t.active) || tabList[0];
    const tabUpdateListeners = new Set();
    const tabRemovedListeners = new Set();

    const tabs = {
        _tabList: tabList,
        _activeTab: activeTab,

        async query(queryInfo = {}) {
            return tabList.filter(t => {
                if (queryInfo.active != null && t.active !== queryInfo.active) return false;
                if (queryInfo.currentWindow != null && queryInfo.currentWindow !== true) return false;
                if (queryInfo.url != null && !t.url.includes(queryInfo.url)) return false;
                return true;
            });
        },

        async get(tabId) {
            const t = tabList.find(item => item.id === tabId);
            if (!t) throw new Error(`Tab ${tabId} not found`);
            return t;
        },

        async create({ url = 'about:blank', active = true } = {}) {
            const newTab = {
                id: tabList.length + 1,
                url,
                active,
                status: 'complete',
                title: 'New Tab'
            };
            if (active) {
                tabList.forEach(t => t.active = false);
                tabs._activeTab = newTab;
            }
            tabList.push(newTab);
            return newTab;
        },

        async update(tabId, updateProps = {}) {
            const t = tabList.find(item => item.id === tabId);
            if (!t) throw new Error(`Tab ${tabId} not found`);
            Object.assign(t, updateProps);
            if (updateProps.active) {
                tabList.forEach(item => { if (item.id !== tabId) item.active = false; });
                tabs._activeTab = t;
            }
            for (const l of tabUpdateListeners) {
                try { l(tabId, updateProps, t); } catch (e) { console.error(e); }
            }
            return t;
        },

        async sendMessage(tabId, msg) {
            return runtime.sendMessage(msg);
        },

        onUpdated: {
            addListener(cb) { tabUpdateListeners.add(cb); },
            removeListener(cb) { tabUpdateListeners.delete(cb); }
        },
        onRemoved: {
            addListener(cb) { tabRemovedListeners.add(cb); },
            removeListener(cb) { tabRemovedListeners.delete(cb); }
        }
    };

    const scripting = {
        async executeScript({ target = {}, files = [], func = null, args = [] } = {}) {
            if (options.onExecuteScript) {
                return options.onExecuteScript({ target, files, func, args });
            }
            if (typeof func === 'function') {
                try {
                    const res = await func(...args);
                    return [{ result: res }];
                } catch (err) {
                    throw err;
                }
            }
            return [{ result: { injectedFiles: files, tabId: target.tabId } }];
        }
    };

    // 4. Permissions API (Site-by-Site)
    const grantedPermissions = new Set(options.initialPermissions || ['storage', 'activeTab', 'scripting']);
    const grantedOrigins = new Set(options.initialOrigins || []);
    const permissionAddedListeners = new Set();
    const permissionRemovedListeners = new Set();

    const permissions = {
        async contains({ permissions: perms = [], origins = [] } = {}) {
            const permsOk = perms.every(p => grantedPermissions.has(p));
            const originsOk = origins.every(o => {
                // Check wildcard or exact origin
                if (grantedOrigins.has(o) || grantedOrigins.has('<all_urls>') || grantedOrigins.has('*://*/*')) return true;
                const match = Array.from(grantedOrigins).some(granted => {
                    if (granted.endsWith('/*')) {
                        const prefix = granted.slice(0, -2);
                        return o.startsWith(prefix);
                    }
                    return granted === o;
                });
                return match;
            });
            return permsOk && originsOk;
        },

        async request({ permissions: perms = [], origins = [] } = {}) {
            if (options.denyPermissions) return false;
            perms.forEach(p => grantedPermissions.add(p));
            origins.forEach(o => grantedOrigins.add(o));
            const payload = { permissions: [...perms], origins: [...origins] };
            for (const listener of permissionAddedListeners) {
                try { listener(payload); } catch (e) { console.error(e); }
            }
            return true;
        },

        async remove({ permissions: perms = [], origins = [] } = {}) {
            perms.forEach(p => grantedPermissions.delete(p));
            origins.forEach(o => grantedOrigins.delete(o));
            const payload = { permissions: [...perms], origins: [...origins] };
            for (const listener of permissionRemovedListeners) {
                try { listener(payload); } catch (e) { console.error(e); }
            }
            return true;
        },

        async getAll() {
            return {
                permissions: Array.from(grantedPermissions),
                origins: Array.from(grantedOrigins)
            };
        },

        onAdded: {
            addListener(cb) { permissionAddedListeners.add(cb); },
            removeListener(cb) { permissionAddedListeners.delete(cb); }
        },

        onRemoved: {
            addListener(cb) { permissionRemovedListeners.add(cb); },
            removeListener(cb) { permissionRemovedListeners.delete(cb); }
        }
    };

    // 5. DeclarativeNetRequest API
    const VALID_DNR_RESOURCE_TYPES = new Set([
        'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
        'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
        'websocket', 'webtransport', 'webbundle', 'other'
    ]);
    const dynamicRules = new Map();

    const declarativeNetRequest = {
        async updateDynamicRules({ addRules = [], removeRuleIds = [] } = {}) {
            for (const id of removeRuleIds) {
                dynamicRules.delete(id);
            }
            for (const rule of addRules) {
                const resTypes = rule?.condition?.resourceTypes;
                if (Array.isArray(resTypes)) {
                    for (const rt of resTypes) {
                        if (!VALID_DNR_RESOURCE_TYPES.has(rt)) {
                            throw new Error(`Invalid declarativeNetRequest resourceType: ${rt}`);
                        }
                    }
                }
                dynamicRules.set(rule.id, structuredClone(rule));
            }
        },

        async getDynamicRules() {
            return Array.from(dynamicRules.values()).map((r) => structuredClone(r));
        }
    };

    return {
        storage,
        runtime,
        tabs,
        scripting,
        permissions,
        declarativeNetRequest
    };
}
