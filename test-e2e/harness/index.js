/**
 * test-e2e/harness/index.js
 * Unified E2E Test Sandbox & Direct Root Codebase Bindings.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { createChromeMock } from './chrome-mock.js';
import {
    createWindowMock,
    MockDocument,
    MockElement,
    MockNode,
    MockTextNode,
    MockShadowRoot,
    MockDocumentFragment,
    MockDOMParser,
    MockMutationObserver,
    MockEvent,
    MockCustomEvent,
    decodeHtmlEntities,
    escapeHtml,
    parseHtmlInto
} from './dom-mock.js';
import {
    MockAudioContext,
    MockAudioWorkletNode,
    MockSpeechSynthesis,
    MockSpeechSynthesisUtterance
} from './audio-mock.js';
import {
    createNetworkMock,
    MockWebSocket,
    createSseResponse
} from './network-mock.js';

const ROOT_DIR = path.resolve(process.cwd());

// Preserve original globals for clean restoration
const originalGlobals = {
    chrome: globalThis.chrome,
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    navigator: globalThis.navigator,
    DOMParser: globalThis.DOMParser,
    MutationObserver: globalThis.MutationObserver,
    Element: globalThis.Element,
    Node: globalThis.Node,
    CustomEvent: globalThis.CustomEvent,
    Event: globalThis.Event,
    AudioContext: globalThis.AudioContext,
    webkitAudioContext: globalThis.webkitAudioContext,
    speechSynthesis: globalThis.speechSynthesis,
    SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket
};

let currentSandbox = null;

function setGlobal(key, value) {
    try {
        globalThis[key] = value;
    } catch {
        try {
            Object.defineProperty(globalThis, key, {
                value,
                configurable: true,
                writable: true
            });
        } catch {}
    }
}

/**
 * Sets up a clean sandbox environment for a test case and evaluates
 * genuine root codebase modules into the active sandbox.
 */
export function setupSandbox(options = {}) {
    teardownSandbox();

    const chromeMock = createChromeMock(options.chrome || {});
    const windowMock = createWindowMock(options.window || {});
    const networkMock = createNetworkMock();
    const audioContextMock = new MockAudioContext(options.audio || {});
    const speechSynthesisMock = new MockSpeechSynthesis();

    // Mirror environment on windowMock
    windowMock.AudioContext = MockAudioContext;
    windowMock.webkitAudioContext = MockAudioContext;
    windowMock.speechSynthesis = speechSynthesisMock;
    windowMock.SpeechSynthesisUtterance = MockSpeechSynthesisUtterance;
    windowMock.WebSocket = MockWebSocket;
    windowMock.fetch = networkMock.mockFetch;
    windowMock.DOMParser = MockDOMParser;
    windowMock.MutationObserver = MockMutationObserver;
    windowMock.Element = MockElement;
    windowMock.Node = MockNode;
    windowMock.CustomEvent = MockCustomEvent;
    windowMock.Event = MockEvent;

    // Attach mocks to globalThis safely
    setGlobal('chrome', chromeMock);
    setGlobal('window', windowMock);
    setGlobal('document', windowMock.document);
    setGlobal('location', windowMock.location);
    setGlobal('navigator', windowMock.navigator);
    setGlobal('DOMParser', MockDOMParser);
    setGlobal('MutationObserver', MockMutationObserver);
    setGlobal('Element', MockElement);
    setGlobal('Node', MockNode);
    setGlobal('CustomEvent', MockCustomEvent);
    setGlobal('Event', MockEvent);
    setGlobal('AudioContext', MockAudioContext);
    setGlobal('webkitAudioContext', MockAudioContext);
    setGlobal('speechSynthesis', speechSynthesisMock);
    setGlobal('SpeechSynthesisUtterance', MockSpeechSynthesisUtterance);
    setGlobal('fetch', networkMock.mockFetch);
    setGlobal('WebSocket', MockWebSocket);
    setGlobal('requestAnimationFrame', windowMock.requestAnimationFrame);
    setGlobal('cancelAnimationFrame', windowMock.cancelAnimationFrame);

    setGlobal('importScripts', (...scripts) => {
        for (const script of scripts) {
            const scriptPath = path.resolve(ROOT_DIR, script);
            if (fs.existsSync(scriptPath)) {
                vm.runInThisContext(fs.readFileSync(scriptPath, 'utf8'));
            }
        }
    });

    // Directly evaluate genuine root codebase modules into active sandbox
    const rootModules = [
        'url-validator.js',
        'glossary-utils.js',
        'i18n.js',
        'page-ui.js',
        'extractor.js',
        'tts-icon-describer.js',
        'tts-player.js',
        'translator.js'
    ];

    for (const modFile of rootModules) {
        const filePath = path.resolve(ROOT_DIR, modFile);
        if (fs.existsSync(filePath)) {
            const code = fs.readFileSync(filePath, 'utf8');
            vm.runInThisContext(`(function(){\n${code}\n})();`);
        }
    }

    if (!options.skipBackground && !options.chrome?.isContentScript) {
        const bgPath = path.resolve(ROOT_DIR, 'background.js');
        if (fs.existsSync(bgPath)) {
            const bgCode = fs.readFileSync(bgPath, 'utf8');
            try {
                vm.runInThisContext(`(function(){\n${bgCode}\n})();`);
            } catch (err) {
                console.warn('[Sandbox] background.js evaluation warning:', err.message);
            }
        }
    }

    // Bridge module references between windowMock and globalThis
    const urlVal = globalThis.STV_UrlValidator || windowMock.STV_UrlValidator;
    const glossUtils = globalThis.STV_GlossaryUtils || windowMock.STV_GlossaryUtils;
    const i18nMod = globalThis.STV_I18n || windowMock.STV_I18n;
    const pageUI = globalThis.STV_PageUI || windowMock.STV_PageUI;
    const readerUI = globalThis.STV_Reader || windowMock.STV_Reader || pageUI?.Reader;
    const modalUI = globalThis.UIModal || globalThis.STV_Modal || windowMock.UIModal || windowMock.STV_Modal || pageUI?.UIModal;
    const ttsHelpers = globalThis.STV_TTSHelpers || windowMock.STV_TTSHelpers;
    const iconDescriber = globalThis.STV_IconDescriber || windowMock.STV_IconDescriber;
    const ttsController = globalThis.STV_TTSController || windowMock.STV_TTSController;
    const extractorConvert = windowMock.STV_convertHtmlToTextChunks || globalThis.STV_convertHtmlToTextChunks;
    const extractorFindBox = windowMock.STV_findContentBoxInDocument || globalThis.STV_findContentBoxInDocument;
    const extractorFindNext = windowMock.STV_findNextChapterUrl || globalThis.STV_findNextChapterUrl;
    const translatorRenderer = windowMock.STV_createStreamRenderer || globalThis.STV_createStreamRenderer;
    const transBroker = globalThis.STV_TranslationBroker || windowMock.STV_TranslationBroker;

    setGlobal('STV_UrlValidator', urlVal);
    setGlobal('STV_GlossaryUtils', glossUtils);
    setGlobal('STV_I18n', i18nMod);
    setGlobal('STV_PageUI', pageUI);
    setGlobal('STV_Reader', readerUI);
    setGlobal('UIModal', modalUI);
    setGlobal('STV_Modal', modalUI);
    setGlobal('STV_TTSHelpers', ttsHelpers);
    setGlobal('STV_IconDescriber', iconDescriber);
    setGlobal('STV_TTSController', ttsController);
    setGlobal('STV_convertHtmlToTextChunks', extractorConvert);
    setGlobal('STV_findContentBoxInDocument', extractorFindBox);
    setGlobal('STV_findNextChapterUrl', extractorFindNext);
    setGlobal('STV_createStreamRenderer', translatorRenderer);
    setGlobal('STV_TranslationBroker', transBroker);

    currentSandbox = {
        chrome: chromeMock,
        window: windowMock,
        document: windowMock.document,
        network: networkMock,
        audioContext: audioContextMock,
        speechSynthesis: speechSynthesisMock,
        options
    };

    return currentSandbox;
}

/**
 * Restores original globals and cleans up sandbox state.
 */
export function teardownSandbox() {
    MockWebSocket.instances = [];

    const keysToRestore = [
        'chrome', 'window', 'document', 'location', 'navigator',
        'DOMParser', 'MutationObserver', 'Element', 'Node',
        'CustomEvent', 'Event', 'AudioContext', 'webkitAudioContext',
        'speechSynthesis', 'SpeechSynthesisUtterance', 'fetch', 'WebSocket',
        'requestAnimationFrame', 'cancelAnimationFrame'
    ];

    for (const key of keysToRestore) {
        const val = originalGlobals[key];
        if (val === undefined) {
            try { delete globalThis[key]; } catch { setGlobal(key, undefined); }
        } else {
            setGlobal(key, val);
        }
    }

    const extraKeys = [
        'importScripts', 'STV_UrlValidator', 'isValidUrl', 'isPrivateIP', 'extractSiteDomain', 'isSafePreloadTarget',
        'STV_GlossaryUtils', 'STV_I18n', 'STV_PageUI', 'STV_Reader', 'UIModal', 'STV_Modal',
        'STV_TTSHelpers', 'STV_IconDescriber', 'STV_TTSController', 'STV_startTTS', 'STV_stopTTS', 'STV_getTTSState',
        'splitLongTextForTTS', 'WSOLAProcessor', 'ContinuousResampler', 'createAnchorTrimmer', 'cleanTextForSpeech',
        'STV_convertHtmlToTextChunks', 'STV_COMMON_CONTENT_SELECTORS', 'STV_findContentBoxInDocument', 'STV_findNextChapterUrl',
        'STV_extractChapterTextChunks', 'STV_activeContentBox', 'STV_createStreamRenderer',
        'STV_startTranslationSequence', 'STV_startPreloadedTranslation', 'STV_toggleOriginalMode',
        'STV_retranslateLine', 'STV_translationState', 'STV_TranslationBroker', 'Pwned'
    ];

    for (const k of extraKeys) {
        try { delete globalThis[k]; } catch { setGlobal(k, undefined); }
    }

    currentSandbox = null;
}

export function getSandbox() {
    return currentSandbox;
}

// -----------------------------------------------------------------------------
// Direct Genuine Codebase Module Bindings (Zero Facades)
// -----------------------------------------------------------------------------

export const UrlValidator = {
    isValidUrl: (...args) => (globalThis.STV_UrlValidator?.isValidUrl || globalThis.isValidUrl)(...args),
    isPrivateIP: (...args) => (globalThis.STV_UrlValidator?.isPrivateIP || globalThis.isPrivateIP)(...args),
    extractSiteDomain: (...args) => (globalThis.STV_UrlValidator?.extractSiteDomain || globalThis.extractSiteDomain)(...args),
    isSafePreloadTarget: (...args) => (globalThis.STV_UrlValidator?.isSafePreloadTarget || globalThis.isSafePreloadTarget)(...args)
};

export const Locales = new Proxy({}, {
    get(_, prop) {
        const target = globalThis.STV_I18n || {};
        if (prop === 'currentLocale') return target.getLocale?.() || 'vi';
        if (prop === 'dictionaries') return target.DICTIONARY || target.dictionaries || {};
        const val = target[prop];
        if (typeof val === 'function') return val.bind(target);
        return val;
    },
    set(_, prop, val) {
        const target = globalThis.STV_I18n || {};
        if (prop === 'currentLocale') {
            target.setLocale?.(val);
            return true;
        }
        target[prop] = val;
        return true;
    }
});

export const i18n = Locales;

export const ReaderUI = new Proxy({}, {
    get(_, prop) {
        const target = globalThis.STV_Reader || globalThis.STV_PageUI || {};
        const val = target[prop];
        if (typeof val === 'function') return val.bind(target);
        return val;
    }
});

export const TranslationBroker = new Proxy({}, {
    get(_, prop) {
        const target = globalThis.STV_TranslationBroker || {};
        const val = target[prop];
        if (typeof val === 'function') return val.bind(target);
        return val;
    }
});

export const UIModal = new Proxy({}, {
    get(_, prop) {
        const target = globalThis.UIModal || globalThis.STV_Modal || {};
        const val = target[prop];
        if (typeof val === 'function') return val.bind(target);
        return val;
    }
});

export const STV_convertHtmlToTextChunks = (...args) =>
    (globalThis.STV_convertHtmlToTextChunks || globalThis.window?.STV_convertHtmlToTextChunks)(...args);

export const STV_findContentBoxInDocument = (...args) =>
    (globalThis.STV_findContentBoxInDocument || globalThis.window?.STV_findContentBoxInDocument)(...args);

export const STV_findNextChapterUrl = (...args) =>
    (globalThis.STV_findNextChapterUrl || globalThis.window?.STV_findNextChapterUrl)(...args);

export const splitLongTextForTTS = (...args) =>
    (globalThis.STV_TTSHelpers?.splitLongTextForTTS || globalThis.splitLongTextForTTS)(...args);

export const WSOLAProcessor = class {
    constructor(...args) {
        const TargetClass = globalThis.STV_TTSHelpers?.WSOLAProcessor || globalThis.WSOLAProcessor;
        return new TargetClass(...args);
    }
};

export const ContinuousResampler = class {
    constructor(...args) {
        const TargetClass = globalThis.STV_TTSHelpers?.ContinuousResampler || globalThis.ContinuousResampler;
        return new TargetClass(...args);
    }
};

export const createAnchorTrimmer = (...args) =>
    (globalThis.STV_TTSHelpers?.createAnchorTrimmer || globalThis.createAnchorTrimmer)(...args);

export const cleanTextForSpeech = (...args) =>
    (globalThis.STV_TTSHelpers?.cleanTextForSpeech || globalThis.cleanTextForSpeech)(...args);

export const STV_IconDescriber = new Proxy({}, {
    get(_, prop) {
        const target = globalThis.STV_IconDescriber || {};
        const val = target[prop];
        if (typeof val === 'function') return val.bind(target);
        return val;
    }
});

export const STV_TTSController = new Proxy({}, {
    get(_, prop) {
        const target = globalThis.STV_TTSController || {};
        const val = target[prop];
        if (typeof val === 'function') return val.bind(target);
        return val;
    }
});

export const STV_createStreamRenderer = (...args) =>
    (globalThis.STV_createStreamRenderer || globalThis.window?.STV_createStreamRenderer)(...args);

export const STV_GlossaryUtils = new Proxy({}, {
    get(_, prop) {
        const target = globalThis.STV_GlossaryUtils || {};
        const val = target[prop];
        if (typeof val === 'function') return val.bind(target);
        return val;
    }
});
