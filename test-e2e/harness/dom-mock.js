/**
 * test-e2e/harness/dom-mock.js
 * Lightweight inert DOM, Shadow DOM, and DOMParser simulation.
 */

export class MockNode {
    constructor(nodeType, nodeName) {
        this.nodeType = nodeType;
        this.nodeName = nodeName;
        this.parentNode = null;
        this.childNodes = [];
    }

    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

    get nextSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.childNodes.indexOf(this);
        return (idx !== -1 && idx < this.parentNode.childNodes.length - 1) ? this.parentNode.childNodes[idx + 1] : null;
    }

    get previousSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.childNodes.indexOf(this);
        return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
    }

    get nextElementSibling() {
        if (!this.parentNode) return null;
        const siblings = this.parentNode.childNodes.filter(n => n.nodeType === 1);
        const idx = siblings.indexOf(this);
        return (idx !== -1 && idx < siblings.length - 1) ? siblings[idx + 1] : null;
    }

    get previousElementSibling() {
        if (!this.parentNode) return null;
        const siblings = this.parentNode.childNodes.filter(n => n.nodeType === 1);
        const idx = siblings.indexOf(this);
        return idx > 0 ? siblings[idx - 1] : null;
    }

    appendChild(child) {
        if (!child) return child;
        if (child.nodeType === 11) { // DocumentFragment
            const toAppend = [...child.childNodes];
            for (const c of toAppend) {
                this.appendChild(c);
            }
            return child;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }

    append(...nodes) {
        for (const n of nodes) {
            if (typeof n === 'string') {
                this.appendChild(new MockTextNode(n));
            } else if (n) {
                this.appendChild(n);
            }
        }
    }

    prepend(...nodes) {
        const ref = this.firstChild;
        for (const n of nodes) {
            const child = typeof n === 'string' ? new MockTextNode(n) : n;
            if (child) {
                this.insertBefore(child, ref);
            }
        }
    }

    insertBefore(newNode, refNode) {
        if (!newNode) return newNode;
        if (!refNode) return this.appendChild(newNode);
        if (newNode.nodeType === 11) {
            const toAppend = [...newNode.childNodes];
            for (const c of toAppend) {
                this.insertBefore(c, refNode);
            }
            return newNode;
        }
        if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
        const idx = this.childNodes.indexOf(refNode);
        if (idx === -1) return this.appendChild(newNode);
        newNode.parentNode = this;
        this.childNodes.splice(idx, 0, newNode);
        return newNode;
    }

    removeChild(child) {
        const idx = this.childNodes.indexOf(child);
        if (idx !== -1) {
            this.childNodes.splice(idx, 1);
            child.parentNode = null;
        }
        return child;
    }

    replaceChild(newChild, oldChild) {
        const idx = this.childNodes.indexOf(oldChild);
        if (idx !== -1) {
            if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
            this.childNodes[idx] = newChild;
            newChild.parentNode = this;
            oldChild.parentNode = null;
        }
        return oldChild;
    }

    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }

    contains(other) {
        if (!other) return false;
        let cur = other;
        while (cur) {
            if (cur === this) return true;
            cur = cur.parentNode;
        }
        return false;
    }

    cloneNode(deep = false) {
        const copy = new (this.constructor)(this.tagName ? this.tagName.toLowerCase() : this.nodeName);
        if (this.attributes) {
            for (const [k, v] of Object.entries(this.attributes)) copy.setAttribute(k, v);
        }
        if (this.textContent && this.nodeType === 3) {
            copy.textContent = this.textContent;
        }
        if (deep) {
            for (const child of this.childNodes) {
                copy.appendChild(child.cloneNode(true));
            }
        }
        return copy;
    }
}

export class MockTextNode extends MockNode {
    constructor(text) {
        super(3, '#text');
        this._text = String(text != null ? text : '');
    }

    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v != null ? v : ''); }

    get nodeValue() { return this._text; }
    set nodeValue(v) { this._text = String(v != null ? v : ''); }

    get data() { return this._text; }
    set data(v) { this._text = String(v != null ? v : ''); }
}

export class MockElement extends MockNode {
    constructor(tagName) {
        super(1, String(tagName).toUpperCase());
        this.tagName = String(tagName).toUpperCase();
        this.attributes = {};
        this.style = createMockStyle();
        this.shadowRoot = null;
        this.eventListeners = new Map();
        this.classList = createClassList(this);
    }

    getAttribute(name) {
        const lower = String(name).toLowerCase();
        return this.attributes[lower] !== undefined ? this.attributes[lower] : null;
    }

    setAttribute(name, value) {
        const lower = String(name).toLowerCase();
        const strVal = String(value);
        this.attributes[lower] = strVal;
    }

    removeAttribute(name) {
        const lower = String(name).toLowerCase();
        delete this.attributes[lower];
    }

    hasAttribute(name) {
        return this.attributes[String(name).toLowerCase()] !== undefined;
    }

    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }

    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }

    get dataset() {
        const ds = {};
        for (const [k, v] of Object.entries(this.attributes)) {
            if (k.startsWith('data-')) {
                const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
                ds[camel] = v;
            }
        }
        return ds;
    }

    attachShadow({ mode = 'open' } = {}) {
        const sr = new MockShadowRoot(mode, this);
        this.shadowRoot = sr;
        return sr;
    }

    addEventListener(event, cb) {
        if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
        this.eventListeners.get(event).add(cb);
    }

    removeEventListener(event, cb) {
        if (this.eventListeners.has(event)) {
            this.eventListeners.get(event).delete(cb);
        }
    }

    dispatchEvent(ev) {
        if (!ev.target) ev.target = this;
        ev.currentTarget = this;
        const listeners = this.eventListeners.get(ev.type);
        if (listeners) {
            for (const l of Array.from(listeners)) {
                try { l.call(this, ev); } catch (e) { console.error(e); }
            }
        }
        // Bubble up if requested
        if (ev.bubbles && !ev._propagationStopped && this.parentNode && typeof this.parentNode.dispatchEvent === 'function') {
            this.parentNode.dispatchEvent(ev);
        }
        return !ev.defaultPrevented;
    }

    click() {
        const ev = new MockEvent('click', { bubbles: true, cancelable: true });
        this.dispatchEvent(ev);
    }

    get textContent() {
        let text = '';
        for (const child of this.childNodes) {
            if (child.nodeType === 3) text += child.textContent;
            else if (child.nodeType === 1) text += child.textContent;
        }
        return text;
    }

    set textContent(val) {
        this.childNodes = [];
        if (val != null && val !== '') {
            this.appendChild(new MockTextNode(val));
        }
    }

    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }

    get innerHTML() {
        return serializeChildrenToHtml(this);
    }

    set innerHTML(htmlStr) {
        this.childNodes = [];
        parseHtmlInto(String(htmlStr || ''), this);
    }

    querySelector(selector) {
        return querySelectorInternal(this, selector);
    }

    querySelectorAll(selector) {
        return querySelectorAllInternal(this, selector);
    }

    getElementsByTagName(tagName) {
        const tag = tagName.toUpperCase();
        return querySelectorAllInternal(this, tag === '*' ? '*' : tag);
    }

    getElementsByClassName(className) {
        return querySelectorAllInternal(this, `.${className}`);
    }

    closest(selector) {
        let cur = this;
        while (cur && cur.nodeType === 1) {
            if (matchesSelector(cur, selector)) return cur;
            cur = cur.parentNode;
        }
        return null;
    }

    getBoundingClientRect() {
        // Mock geometry
        const width = parseFloat(this.style.width) || 38;
        const height = parseFloat(this.style.height) || 38;
        return {
            x: 0,
            y: 0,
            top: 0,
            bottom: height,
            left: 0,
            right: width,
            width,
            height
        };
    }

    scrollIntoView(options = {}) {}
    scroll(options = {}) {}
    scrollTo(options = {}) {}
}

export class MockShadowRoot extends MockNode {
    constructor(mode, host) {
        super(11, '#shadow-root');
        this.mode = mode;
        this.host = host;
    }

    getElementById(id) { return querySelectorInternal(this, `#${id}`); }
    querySelector(sel) { return querySelectorInternal(this, sel); }
    querySelectorAll(sel) { return querySelectorAllInternal(this, sel); }

    get innerHTML() { return serializeChildrenToHtml(this); }
    set innerHTML(html) {
        this.childNodes = [];
        parseHtmlInto(String(html || ''), this);
    }

    get textContent() {
        let text = '';
        for (const child of this.childNodes) text += child.textContent;
        return text;
    }
    set textContent(v) {
        this.childNodes = [];
        if (v != null && v !== '') this.appendChild(new MockTextNode(v));
    }
}

export class MockDocumentFragment extends MockNode {
    constructor() {
        super(11, '#document-fragment');
    }

    querySelector(sel) { return querySelectorInternal(this, sel); }
    querySelectorAll(sel) { return querySelectorAllInternal(this, sel); }
}

export class MockDocument extends MockNode {
    constructor() {
        super(9, '#document');
        this.documentElement = new MockElement('html');
        this.head = new MockElement('head');
        this.body = new MockElement('body');
        this.documentElement.appendChild(this.head);
        this.documentElement.appendChild(this.body);
        this.appendChild(this.documentElement);
        this.eventListeners = new Map();
    }

    createElement(tag) { return new MockElement(tag); }
    createTextNode(text) { return new MockTextNode(text); }
    createDocumentFragment() { return new MockDocumentFragment(); }

    getElementById(id) {
        return querySelectorInternal(this, `#${id}`);
    }

    querySelector(sel) { return querySelectorInternal(this, sel); }
    querySelectorAll(sel) { return querySelectorAllInternal(this, sel); }

    addEventListener(event, cb) {
        if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
        this.eventListeners.get(event).add(cb);
    }

    removeEventListener(event, cb) {
        if (this.eventListeners.has(event)) this.eventListeners.get(event).delete(cb);
    }

    dispatchEvent(ev) {
        ev.target = this;
        ev.currentTarget = this;
        const listeners = this.eventListeners.get(ev.type);
        if (listeners) {
            for (const l of Array.from(listeners)) {
                try { l.call(this, ev); } catch (e) { console.error(e); }
            }
        }
        return !ev.defaultPrevented;
    }
}

export class MockDOMParser {
    parseFromString(htmlStr, mimeType = 'text/html') {
        const doc = new MockDocument();
        parseHtmlInto(String(htmlStr || ''), doc.body);
        return doc;
    }
}

export class MockMutationObserver {
    constructor(callback) {
        this.callback = callback;
        this.target = null;
        this.options = null;
        this.connected = false;
    }

    observe(target, options) {
        this.target = target;
        this.options = options;
        this.connected = true;
    }

    disconnect() {
        this.connected = false;
    }

    takeRecords() {
        return [];
    }

    triggerMutation(records = [{ type: 'childList' }]) {
        if (this.connected && typeof this.callback === 'function') {
            this.callback(records, this);
        }
    }
}

export class MockEvent {
    constructor(type, options = {}) {
        this.type = type;
        this.bubbles = Boolean(options.bubbles);
        this.cancelable = Boolean(options.cancelable);
        this.defaultPrevented = false;
        this._propagationStopped = false;
        this.target = null;
        this.currentTarget = null;
        Object.assign(this, options);
    }

    preventDefault() {
        if (this.cancelable) this.defaultPrevented = true;
    }

    stopPropagation() {
        this._propagationStopped = true;
    }
}

export class MockCustomEvent extends MockEvent {
    constructor(type, options = {}) {
        super(type, options);
        this.detail = options.detail !== undefined ? options.detail : null;
    }
}

// Style helper
function createMockStyle() {
    const styles = {};
    return new Proxy(styles, {
        get(target, prop) {
            if (typeof prop === 'symbol') return undefined;
            if (prop === 'getPropertyValue') {
                return (name) => target[kebabCase(name)] || '';
            }
            if (prop === 'setProperty') {
                return (name, value) => { target[kebabCase(name)] = String(value); };
            }
            if (prop === 'removeProperty') {
                return (name) => {
                    const old = target[kebabCase(name)];
                    delete target[kebabCase(name)];
                    return old || '';
                };
            }
            return target[kebabCase(prop)] || target[prop] || '';
        },
        set(target, prop, value) {
            target[kebabCase(prop)] = String(value);
            return true;
        }
    });
}

function kebabCase(str) {
    return String(str).replace(/([A-Z])/g, '-$1').toLowerCase();
}

// ClassList helper
function createClassList(el) {
    return {
        add(...tokens) {
            const cur = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
            for (const t of tokens) {
                if (t && !cur.includes(t)) cur.push(t);
            }
            el.setAttribute('class', cur.join(' '));
        },
        remove(...tokens) {
            let cur = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
            cur = cur.filter(c => !tokens.includes(c));
            el.setAttribute('class', cur.join(' '));
        },
        contains(token) {
            const cur = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
            return cur.includes(token);
        },
        toggle(token, force) {
            if (force === true) {
                this.add(token);
                return true;
            } else if (force === false) {
                this.remove(token);
                return false;
            }
            if (this.contains(token)) {
                this.remove(token);
                return false;
            } else {
                this.add(token);
                return true;
            }
        }
    };
}

// HTML Serializer
function serializeChildrenToHtml(node) {
    let out = '';
    for (const child of node.childNodes) {
        if (child.nodeType === 3) {
            out += escapeHtml(child.textContent);
        } else if (child.nodeType === 1) {
            const tag = child.tagName.toLowerCase();
            out += `<${tag}`;
            for (const [k, v] of Object.entries(child.attributes)) {
                out += ` ${k}="${escapeHtml(v)}"`;
            }
            out += `>${serializeChildrenToHtml(child)}</${tag}>`;
        }
    }
    return out;
}

export function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// HTML Entity Decoder for safe plain text
export function decodeHtmlEntities(str) {
    return String(str || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ');
}

// Lightweight HTML Parser
export function parseHtmlInto(htmlStr, parentNode) {
    if (!htmlStr) return;
    const str = String(htmlStr);

    // Regex matching HTML tags or text tokens
    const tokenRegex = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9_-]+)((?:\s+[^=>\s]+(?:=(?:"[^"]*"|'[^']*'|[^>\s]+))?)*)\s*(\/)?>|([^<]+)/g;
    let match;
    let currentParent = parentNode;
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

    while ((match = tokenRegex.exec(str)) !== null) {
        const [full, isClosing, tagName, attrString, isSelfClosing, textContent] = match;

        if (full.startsWith('<!--')) {
            // comment: skip
            continue;
        }

        if (textContent) {
            // Text node: decode common entities for plain text
            const text = decodeHtmlEntities(textContent);
            currentParent.appendChild(new MockTextNode(text));
            continue;
        }

        if (tagName) {
            const tag = tagName.toLowerCase();

            if (isClosing) {
                // Closing tag: climb up until matching tag
                let search = currentParent;
                while (search && search !== parentNode) {
                    if (search.nodeType === 1 && search.tagName.toLowerCase() === tag) {
                        currentParent = search.parentNode || parentNode;
                        break;
                    }
                    search = search.parentNode;
                }
            } else {
                // Opening tag
                const el = new MockElement(tag);

                // Parse attributes
                if (attrString) {
                    const attrRegex = /([a-zA-Z0-9_\-:]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
                    let aMatch;
                    while ((aMatch = attrRegex.exec(attrString)) !== null) {
                        const attrName = aMatch[1].toLowerCase();
                        const attrVal = aMatch[2] !== undefined ? aMatch[2]
                            : aMatch[3] !== undefined ? aMatch[3]
                            : aMatch[4] !== undefined ? aMatch[4]
                            : '';
                        el.setAttribute(attrName, decodeHtmlEntities(attrVal));
                    }
                }

                currentParent.appendChild(el);

                // Handle void tags and self-closing
                if (!voidTags.has(tag) && !isSelfClosing) {
                    // Script / style content handling: parse inner text directly
                    if (tag === 'script' || tag === 'style') {
                        const endTag = `</${tag}>`;
                        const endIdx = str.toLowerCase().indexOf(endTag, tokenRegex.lastIndex);
                        if (endIdx !== -1) {
                            const rawContent = str.slice(tokenRegex.lastIndex, endIdx);
                            el.appendChild(new MockTextNode(rawContent));
                            tokenRegex.lastIndex = endIdx + endTag.length;
                        }
                    } else {
                        currentParent = el;
                    }
                }
            }
        }
    }
}

// Selector matching engine
function matchesSelector(el, selector) {
    if (!el || el.nodeType !== 1) return false;
    const trimmed = selector.trim();
    if (trimmed === '*') return true;

    // Check comma-separated selectors (e.g. "p, div, br")
    if (trimmed.includes(',')) {
        return trimmed.split(',').some(part => matchesSelector(el, part.trim()));
    }

    // Check :not(...) pseudo-class e.g. .stv-line:not(.stv-line-partial)
    const notMatch = trimmed.match(/^(.+?):not\((.+?)\)$/);
    if (notMatch) {
        const base = notMatch[1].trim();
        const negated = notMatch[2].trim();
        return matchesSelector(el, base) && !matchesSelector(el, negated);
    }

    // Check simple tag
    if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return el.tagName.toLowerCase() === trimmed.toLowerCase();
    }

    // Check simple ID
    if (/^#[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return el.id === trimmed.slice(1);
    }

    // Check simple class
    if (/^\.[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return el.classList.contains(trimmed.slice(1));
    }

    // Check attribute selector: e.g. [data-i18n], [data-orig], [rel="next"]
    const attrMatch = trimmed.match(/^\[([a-zA-Z0-9_-]+)(?:=([^\x5D]+))?\]$/);
    if (attrMatch) {
        const attrName = attrMatch[1];
        let expectedVal = attrMatch[2];
        if (expectedVal) {
            expectedVal = expectedVal.replace(/^['"]|['"]$/g, '');
            return el.getAttribute(attrName) === expectedVal;
        }
        return el.hasAttribute(attrName);
    }

    // Check compound: e.g. div#content-container, span.stv-line
    const compound = trimmed.match(/^([a-zA-Z0-9_-]+)?(?:#([a-zA-Z0-9_-]+))?(?:\.([a-zA-Z0-9_-]+))?(?:\[([a-zA-Z0-9_-]+)(?:=([^\x5D]+))?\])?$/);
    if (compound) {
        const [_, tag, id, cls, attr, attrVal] = compound;
        if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        if (id && el.id !== id) return false;
        if (cls && !el.classList.contains(cls)) return false;
        if (attr) {
            if (attrVal) {
                const val = attrVal.replace(/^['"]|['"]$/g, '');
                if (el.getAttribute(attr) !== val) return false;
            } else if (!el.hasAttribute(attr)) return false;
        }
        return true;
    }

    // Check combinator: space or >
    if (trimmed.includes(' ')) {
        const parts = trimmed.split(/\s+/);
        let cur = el;
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (i === parts.length - 1) {
                if (!matchesSelector(cur, p)) return false;
            } else {
                let ancestor = cur.parentNode;
                let found = false;
                while (ancestor && ancestor.nodeType === 1) {
                    if (matchesSelector(ancestor, p)) {
                        found = true;
                        cur = ancestor;
                        break;
                    }
                    ancestor = ancestor.parentNode;
                }
                if (!found) return false;
            }
        }
        return true;
    }

    return false;
}

function querySelectorInternal(root, selector) {
    for (const child of root.childNodes) {
        if (child.nodeType === 1) {
            if (matchesSelector(child, selector)) return child;
            const res = querySelectorInternal(child, selector);
            if (res) return res;
        }
    }
    return null;
}

function querySelectorAllInternal(root, selector) {
    const list = [];
    function walk(node) {
        for (const child of node.childNodes) {
            if (child.nodeType === 1) {
                if (matchesSelector(child, selector)) list.push(child);
                walk(child);
            }
        }
    }
    walk(root);
    return list;
}

export function createWindowMock(options = {}) {
    const doc = new MockDocument();
    const win = {
        document: doc,
        location: {
            href: options.url || 'https://example-novel.com/chapter-1.html',
            origin: options.origin || 'https://example-novel.com',
            hostname: options.hostname || 'example-novel.com',
            pathname: '/chapter-1.html',
            protocol: 'https:'
        },
        navigator: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0'
        },
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        requestAnimationFrame: (cb) => setTimeout(cb, 16),
        cancelAnimationFrame: (id) => clearTimeout(id),
        CustomEvent: MockCustomEvent,
        Event: MockEvent,
        Element: MockElement,
        Node: MockNode,
        DOMParser: MockDOMParser,
        MutationObserver: MockMutationObserver,
        addEventListener: doc.addEventListener.bind(doc),
        removeEventListener: doc.removeEventListener.bind(doc),
        dispatchEvent: doc.dispatchEvent.bind(doc)
    };
    return win;
}
