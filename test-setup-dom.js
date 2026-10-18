import { Window } from 'happy-dom';
import { afterEach, beforeEach } from 'bun:test';

const matchMediaMock = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
});

function applyDomGlobals(window) {
  window.matchMedia = matchMediaMock;
  globalThis.matchMedia = matchMediaMock;

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.navigator = window.navigator;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.DOMException = window.DOMException;

  // happy-dom exposes these on its Window but Bun's global scope does not
  // define them. Without this, DOM tests that animate (requestAnimationFrame)
  // fail with "requestAnimationFrame is not defined".
  const windowGlobals = [
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'ResizeObserver',
    'IntersectionObserver',
    'HTMLCanvasElement',
    'Element',
    'SVGElement',
  ];
  for (const name of windowGlobals) {
    if (window[name] !== undefined) {
      globalThis[name] = window[name];
    }
  }

  if (globalThis.localStorage === undefined && window.localStorage) {
    globalThis.localStorage = window.localStorage;
  }
  if (globalThis.sessionStorage === undefined && window.sessionStorage) {
    globalThis.sessionStorage = window.sessionStorage;
  }

  for (const name of [
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'EvalError',
    'URIError',
  ]) {
    if (window[name] === undefined && globalThis[name]) {
      window[name] = globalThis[name];
    }
  }
}

const window = new Window({ url: 'https://localhost/' });
applyDomGlobals(window);

export function restoreDomGlobals() {
  applyDomGlobals(window);
}

// Reset happy-dom globals before/after each test so DOM suites do not leak state
// across files in Bun's default single-process test runner.
beforeEach(() => {
  restoreDomGlobals();
});

afterEach(() => {
  restoreDomGlobals();
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});
