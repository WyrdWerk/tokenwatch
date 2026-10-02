import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDGET_JS = join(__dirname, '..', 'public', 'advisor-widget.js');

/**
 * Minimal DOM shim for the advisor widget. The widget is a classic script, so
 * we execute it in a vm context with a fake document/window. This exercises the
 * real placement + open/close/focus behavior without a browser and without any
 * network (fetch is a spy that records calls and never resolves).
 */
function makeDom({ withHeaderLinks = false, withHeaderRow = false, withMain = false } = {}) {
  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      childNodes: [],
      parentNode: null,
      _id: '',
      _classes: new Set(),
      attributes: {},
      style: {},
      _listeners: {},
      textContent: '',
      innerHTML: '',
      value: '',
      disabled: false,
      placeholder: '',
      type: '',
      title: '',
      _rect: { top: 100, left: 100, right: 300, bottom: 130, width: 200, height: 30 },
      classList: {
        add: (...c) => c.forEach((x) => el._classes.add(x)),
        remove: (...c) => c.forEach((x) => el._classes.delete(x)),
        toggle: (c, force) => {
          if (force === undefined) {
            if (el._classes.has(c)) { el._classes.delete(c); return false; }
            el._classes.add(c); return true;
          }
          if (force) { el._classes.add(c); return true; }
          el._classes.delete(c); return false;
        },
        contains: (c) => el._classes.has(c),
      },
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = el;
        el.childNodes.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parentNode) child.parentNode.removeChild(child);
        const i = ref ? el.childNodes.indexOf(ref) : -1;
        if (i >= 0) el.childNodes.splice(i, 0, child); else el.childNodes.push(child);
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const i = el.childNodes.indexOf(child);
        if (i >= 0) el.childNodes.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
      addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) {
        const arr = el._listeners[type] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      dispatchEvent(ev) { (el._listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
      focus() { document.activeElement = el; },
      getBoundingClientRect() { return el._rect; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    Object.defineProperty(el, 'id', { get: () => el._id, set: (v) => { el._id = v; } });
    Object.defineProperty(el, 'className', {
      get: () => [...el._classes].join(' '),
      set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    el.setAttribute = (k, v) => { el.attributes[k] = String(v); };
    el.getAttribute = (k) => (k in el.attributes ? el.attributes[k] : null);
    return el;
  }

  const body = makeEl('body');
  const document = {
    readyState: 'complete',
    activeElement: body,
    documentElement: { clientWidth: 1280, clientHeight: 800 },
    body,
    createElement: (tag) => makeEl(tag),
    getElementById(id) { return walkFind(body, (n) => n.id === id); },
    querySelector(sel) {
      if (sel === '.header-links') return walkFind(body, (n) => n._classes.has('header-links'));
      if (sel === '.header-row') return walkFind(body, (n) => n._classes.has('header-row'));
      if (sel === 'main') return walkFind(body, (n) => n.tagName === 'MAIN');
      return null;
    },
    addEventListener(type, fn) { (document._listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = document._listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent(ev) { (document._listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    _listeners: {},
  };

  let headerRow = null;
  let headerLinks = null;
  if (withHeaderRow || withHeaderLinks) {
    headerRow = makeEl('div');
    headerRow.className = 'header-row';
    body.appendChild(headerRow);
    if (withHeaderLinks) {
      headerLinks = makeEl('div');
      headerLinks.className = 'header-links';
      headerRow.appendChild(headerLinks);
    }
  }
  let main = null;
  if (withMain) {
    main = makeEl('main');
    body.appendChild(main);
  }

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) { (window._listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = window._listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    _listeners: {},
  };

  const fetchCalls = [];
  const localStorage = {
    _d: {},
    getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
  };

  return { document, window, localStorage, fetchCalls, body, headerRow, headerLinks, main };
}

function walkFind(root, pred) {
  for (const child of root.childNodes) {
    if (pred(child)) return child;
    const hit = walkFind(child, pred);
    if (hit) return hit;
  }
  return null;
}

async function runWidget(dom) {
  const src = await readFile(WIDGET_JS, 'utf-8');
  const fetch = (...args) => { dom.fetchCalls.push(args); return Promise.reject(new Error('network disabled in test')); };
  const context = vm.createContext({
    window: dom.window,
    document: dom.document,
    localStorage: dom.localStorage,
    fetch,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(src, context, { filename: 'advisor-widget.js' });
}

test('closed launcher is mounted into existing .header-links actions', async () => {
  const dom = makeDom({ withHeaderLinks: true });
  await runWidget(dom);
  const container = dom.document.getElementById('tw-advisor-container');
  assert.ok(container, 'advisor container must exist');
  assert.equal(container.parentNode, dom.headerLinks,
    'container must be placed inside .header-links, not floating over the page');
  assert.ok(!container.style.position, 'container must not be fixed/absolute');
  const launcher = dom.document.getElementById('tw-advisor-bubble');
  assert.ok(launcher, 'launcher must exist');
  assert.equal(launcher.tagName, 'BUTTON');
  assert.equal(launcher.getAttribute('aria-expanded'), 'false');
  assert.match(launcher.getAttribute('aria-label') || '', /advisor/i);
});

test('closed launcher falls back to .header-row when .header-links is absent', async () => {
  const dom = makeDom({ withHeaderRow: true });
  await runWidget(dom);
  const container = dom.document.getElementById('tw-advisor-container');
  assert.equal(container.parentNode, dom.headerRow,
    'container must be placed inside the header actions when no .header-links exists');
});

test('body-flow fallback when no header exists (never a floating closed button)', async () => {
  const dom = makeDom({ withMain: true });
  await runWidget(dom);
  const container = dom.document.getElementById('tw-advisor-container');
  assert.equal(container.parentNode, dom.body, 'container must live in body flow');
  assert.equal(container.parentNode, dom.main.parentNode);
  assert.ok(container.classList.contains('tw-advisor-container--flow'),
    'flow fallback must be marked so CSS keeps it in document flow');
  assert.ok(dom.body.childNodes.indexOf(container) < dom.body.childNodes.indexOf(dom.main),
    'flow fallback must sit before main content');
  assert.ok(!container.style.position, 'flow fallback must not be fixed/absolute');
});

test('opening is deliberate: no network, aria-expanded flips, input focused', async () => {
  const dom = makeDom({ withHeaderLinks: true });
  await runWidget(dom);
  const launcher = dom.document.getElementById('tw-advisor-bubble');
  const panel = dom.document.getElementById('tw-advisor-panel');
  const input = dom.document.getElementById('tw-advisor-input');

  assert.ok(panel.classList.contains('hidden'), 'panel starts closed');
  assert.equal(panel.getAttribute('aria-hidden'), 'true');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.match(panel.getAttribute('aria-label') || '', /advisor/i);
  assert.equal(dom.fetchCalls.length, 0, 'startup must not hit the network');

  launcher.dispatchEvent({ type: 'click' });
  assert.equal(panel.classList.contains('hidden'), false, 'panel opens on deliberate click');
  assert.equal(panel.getAttribute('aria-hidden'), 'false');
  assert.equal(launcher.getAttribute('aria-expanded'), 'true');
  assert.equal(dom.document.activeElement, input, 'input receives focus on open');
  assert.equal(dom.fetchCalls.length, 0, 'opening must not hit the network');
});

test('Escape closes the panel and returns focus to the launcher', async () => {
  const dom = makeDom({ withHeaderLinks: true });
  await runWidget(dom);
  const launcher = dom.document.getElementById('tw-advisor-bubble');
  const panel = dom.document.getElementById('tw-advisor-panel');

  launcher.dispatchEvent({ type: 'click' });
  assert.equal(dom.document.activeElement, dom.document.getElementById('tw-advisor-input'));

  dom.document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.ok(panel.classList.contains('hidden'), 'Escape must close the panel');
  assert.equal(panel.getAttribute('aria-hidden'), 'true');
  assert.equal(launcher.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.document.activeElement, launcher, 'focus returns to the launcher');
});

test('Close button closes the panel and returns focus to the launcher', async () => {
  const dom = makeDom({ withHeaderLinks: true });
  await runWidget(dom);
  const launcher = dom.document.getElementById('tw-advisor-bubble');
  const panel = dom.document.getElementById('tw-advisor-panel');
  const close = dom.document.getElementById('tw-advisor-close');
  assert.ok(close, 'close control must exist');
  assert.match(close.getAttribute('aria-label') || '', /close/i);

  launcher.dispatchEvent({ type: 'click' });
  close.dispatchEvent({ type: 'click' });
  assert.ok(panel.classList.contains('hidden'));
  assert.equal(launcher.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.document.activeElement, launcher);
});

test('panel keeps viewport bounds on a narrow screen', async () => {
  const dom = makeDom({ withHeaderLinks: true });
  dom.window.innerWidth = 360;
  dom.window.innerHeight = 640;
  dom.document.documentElement.clientWidth = 360;
  dom.document.documentElement.clientHeight = 640;
  await runWidget(dom);
  const launcher = dom.document.getElementById('tw-advisor-bubble');
  launcher._rect = { top: 80, left: 20, right: 340, bottom: 110, width: 320, height: 30 };
  launcher.dispatchEvent({ type: 'click' });

  const panel = dom.document.getElementById('tw-advisor-panel');
  const right = parseFloat(panel.style.right);
  const top = parseFloat(panel.style.top);
  const width = parseFloat(panel.style.width);
  assert.ok(right >= 12, `right ${right} must leave a viewport margin`);
  assert.ok(right + width <= 360 - 12 + 0.5, `panel ${right}+${width} must stay inside 360px viewport`);
  assert.ok(top >= 12 && top < 640, `top ${top} must be inside the viewport`);
  assert.ok(parseFloat(panel.style.maxHeight) <= 640 - top - 12 + 0.5,
    'maxHeight must bound the panel to the viewport');
});
