(() => {
  'use strict';
  const ID = 'chatgpt-voyager-return';
  if (document.getElementById(ID)) return;
  const ASSISTANT = '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]';
  const PAGE = '[data-app-shell-active-page]';
  const TRANSCRIPT = '[data-chatgpt-conversation-selection-target]';
  const ATTRS = ['data-message-id', 'data-chatgpt-search-message-ids', 'data-turn-key', 'data-content-search-unit-key'];
  const LIMIT = 20;
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483001';
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = `<style>
    :host { color-scheme:light; --bg:#ffffffed; --ink:#32638c; --edge:#cddfed; }
    :host-context(.dark),:host-context([data-theme="dark"]) { color-scheme:dark; --bg:#293542f2; --ink:#cfe6fb; --edge:#4b647b; }
    * { box-sizing:border-box; } [hidden] { display:none!important; }
    .panel { position:fixed;right:44px;bottom:100px;pointer-events:auto;font:13px/1.5 system-ui,sans-serif; }
    .controls { display:flex;align-items:center;background:var(--bg);border:1px solid var(--edge);
      border-radius:18px;box-shadow:0 3px 14px #30465e18;overflow:hidden; }
    button { color:var(--ink);font:inherit;border:0;background:transparent;cursor:pointer;padding:8px 12px; }
    button:hover { background:#91bce62b; } button:focus-visible { outline:2px solid #4a98dd;outline-offset:-3px; }
    button:disabled { cursor:wait;opacity:.65; } .clear { padding:8px 10px;border-left:1px solid var(--edge); }
    .status { max-width:240px;margin:0 0 8px;padding:8px 12px;border-radius:10px;color:var(--ink);background:var(--bg);border:1px solid var(--edge); }
    @media(max-width:600px) { .panel { right:32px; } }
  </style><div class="panel" hidden>
    <div class="status" role="status" hidden></div>
    <div class="controls"><button class="back" type="button" title="返回刚才选中的原文">↩ 返回原文</button><button class="clear" type="button" aria-label="清除返回记录" title="清除返回记录">×</button></div>
  </div>`;
  // The highlight belongs to the page text, so its rule must be outside Shadow DOM.
  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = '::highlight(chatgpt-voyager-origin) { background-color:#f8d775; color:#202020; }';
  host.append(highlightStyle);
  const panel = shadow.querySelector('.panel');
  const back = shadow.querySelector('.back');
  const status = shadow.querySelector('.status');
  const stack = [];
  let route = location.pathname;
  let candidate = null, armed = null, pending = null;
  let selectionFrame = 0, retryFrame = 0, expiry = 0, flashTimer = 0;
  let hidden = document.hidden, disposed = false;
  const restoreObserver = new MutationObserver(queueRestore);

  function visible(el) {
    if (!el?.isConnected) return false;
    for (let node = el; node; node = node.parentElement) {
      if (node.matches('[hidden],[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]')) return false;
      const css = getComputedStyle(node);
      if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse') return false;
    }
    return true;
  }

  function scope() {
    const pages = Array.from(document.querySelectorAll(PAGE));
    const roots = pages.length ? pages.filter(el => el.getAttribute('data-app-shell-active-page') === 'true' && visible(el)) : [document.body];
    const transcripts = roots.flatMap(el => Array.from(el.querySelectorAll(TRANSCRIPT))).filter(visible);
    const id = location.pathname.match(/\/c\/([^/]+)/)?.[1];
    if (transcripts.length) return transcripts.find(el => {
      const key = el.getAttribute('data-chatgpt-conversation-selection-target');
      return id ? key.replace(/^local-chatgpt:/, '') === id : key.startsWith('local-chatgpt:');
    }) || null;
    return roots.flatMap(el => Array.from(el.querySelectorAll('main'))).filter(visible).at(-1) || roots.at(-1) || null;
  }

  function chatKey(root) {
    return `${location.pathname}|${root?.getAttribute('data-chatgpt-conversation-selection-target') || ''}`;
  }

  function answerFor(element, root) {
    let answer = element?.closest(ASSISTANT);
    if (!answer || !root?.contains(answer)) return null;
    for (let parent = answer.parentElement?.closest(ASSISTANT); parent && root.contains(parent);
      parent = answer.parentElement?.closest(ASSISTANT)) answer = parent;
    return answer;
  }

  function scroller(root) {
    const known = root.closest('[data-app-action-timeline-scroll]');
    if (known) return known;
    for (let el = root; el && el !== document.body; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement;
  }

  function metrics(el) {
    const doc = el === document.scrollingElement;
    const rect = el.getBoundingClientRect();
    return {top:doc ? 0 : rect.top, scale:doc ? 1 : rect.height / el.offsetHeight || 1};
  }

  function identity(message, root) {
    for (const attr of ATTRS) {
      const owner = message.closest(`[${attr}]`);
      if (!owner || !root.contains(owner)) continue;
      const value = owner.getAttribute(attr);
      if (!value) continue;
      const parts = owner.matches(ASSISTANT) ? [owner] : Array.from(owner.querySelectorAll(ASSISTANT));
      return {attr, value, part:parts.indexOf(message)};
    }
    return null;
  }

  function sameIdentity(message, anchor, root) {
    const id = identity(message, root);
    return anchor.id ? id?.attr === anchor.id.attr && id.value === anchor.id.value && id.part === anchor.id.part : !id;
  }

  // Copy bounded fragments only; never retain Selection/Range or full answer text.
  function fragment(root, start, length) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, offset = 0, text = '';
    while ((node = walker.nextNode()) && text.length < length) {
      const end = offset + node.length;
      if (end > start) text += node.data.slice(Math.max(0, start - offset), Math.max(0, start - offset) + length - text.length);
      offset = end;
    }
    return text;
  }

  function textOffset(root, target, offset) {
    // Normalize an element boundary (e.g. selectNodeContents) into a text boundary.
    if (target.nodeType !== Node.TEXT_NODE) {
      const boundary = document.createRange();
      boundary.setStart(target, offset); boundary.collapse(true);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node, total = 0;
      while ((node = walker.nextNode())) {
        if (boundary.comparePoint(node, 0) >= 0) return total;
        total += node.length;
      }
      return total;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, total = 0;
    while ((node = walker.nextNode())) {
      if (node === target) return total + offset;
      total += node.length;
    }
    return -1;
  }

  function capture() {
    if (hidden || disposed || changedRoute()) return null;
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const endEl = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
    const root = scope();
    const message = answerFor(startEl, root);
    if (!message || answerFor(endEl, root) !== message || !visible(message)) return null;
    if (startEl.closest('button,textarea,input,[contenteditable="true"]')) return null;
    const start = textOffset(message, range.startContainer, range.startOffset);
    const end = textOffset(message, range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return null;
    const quote = fragment(message, start, Math.min(160, end - start));
    if (!quote.trim()) return null;
    const scroll = scroller(root), view = metrics(scroll);
    const rect = range.getBoundingClientRect();
    return {key:chatKey(root), id:identity(message, root), node:new WeakRef(message), start, quote,
      prefix:fragment(message, Math.max(0, start - 40), Math.min(40, start)),
      suffix:fragment(message, start + quote.length, 40),
      top:scroll.scrollTop + (rect.top - view.top) / view.scale,
      viewportOffset:Math.max(0, (rect.top - view.top) / view.scale), at:Date.now()};
  }

  function askButton(target) {
    const button = target?.closest?.('button,[role="button"],[role="menuitem"]');
    if (!button || !visible(button)) return null;
    return [button.getAttribute('aria-label'), button.textContent].some(label =>
      /^(?:向\s*ChatGPT\s*提问|询问\s*ChatGPT|Ask\s+ChatGPT)$/i.test(label?.trim() || '')) ? button : null;
  }

  function trackSelection() {
    if (selectionFrame || hidden || disposed) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = 0;
      const next = capture();
      if (next) candidate = next;
    });
  }

  function positionPanel() {
    if (panel.hidden) return;
    const composer = document.querySelector('#prompt-textarea')?.closest('form');
    const top = composer && visible(composer) ? composer.getBoundingClientRect().top : innerHeight;
    panel.style.bottom = `${Math.min(Math.max(90, innerHeight - top + 12), Math.max(16, innerHeight - 100))}px`;
  }

  function render() {
    panel.hidden = !stack.length || hidden || disposed;
    back.disabled = Boolean(pending);
    back.textContent = pending ? '正在返回…' : '↩ 返回原文';
    positionPanel();
  }

  function stopRestore() {
    restoreObserver.disconnect();
    cancelAnimationFrame(retryFrame); retryFrame = 0;
    clearTimeout(expiry); expiry = 0;
    pending = null;
  }

  function clearFlash() {
    clearTimeout(flashTimer);
    CSS.highlights?.delete('chatgpt-voyager-origin');
  }

  function reset() {
    stopRestore(); clearFlash();
    candidate = armed = null;
    stack.length = 0;
    status.hidden = true; status.textContent = '';
    cancelAnimationFrame(selectionFrame); selectionFrame = 0;
    render();
  }

  function changedRoute() {
    if (route === location.pathname) return false;
    route = location.pathname; reset(); return true;
  }

  function confirmAsk(event) {
    if (hidden || disposed || changedRoute() || !askButton(event.target)) return;
    const anchor = armed || capture() || candidate;
    armed = candidate = null;
    const root = scope();
    if (!anchor || Date.now() - anchor.at > 60000 || anchor.key !== chatKey(root)) return;
    stopRestore(); clearFlash();
    const last = stack.at(-1);
    if (!last || last.node.deref() !== anchor.node.deref() || last.start !== anchor.start || last.quote !== anchor.quote) {
      stack.push(anchor);
      if (stack.length > LIMIT) stack.shift();
    }
    status.hidden = true;
    render();
  }

  function locateMessage(anchor, root) {
    const live = anchor.node.deref();
    if (live?.isConnected && root.contains(live) && visible(live) && sameIdentity(live, anchor, root)) return live;
    if (!anchor.id) return null;
    const {attr, value, part} = anchor.id;
    const owners = Array.from(root.querySelectorAll(`[${attr}="${CSS.escape(value)}"]`)).filter(visible);
    if (root.matches(`[${attr}="${CSS.escape(value)}"]`)) owners.unshift(root);
    const matches = owners.map(owner => owner.matches(ASSISTANT) ? owner : owner.querySelectorAll(ASSISTANT)[part]).filter(Boolean);
    return matches.length === 1 ? matches[0] : null;
  }

  function findOffset(message, anchor) {
    const {quote, prefix, suffix, start} = anchor;
    const expected = prefix + quote + suffix;
    if (fragment(message, Math.max(0, start - prefix.length), expected.length) === expected) return start;
    // A bounded rolling window handles inline markup and text inserted before the quote.
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    let node, tail = '', processed = 0, found = -1;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < node.length; i += 512) {
        const chunk = node.data.slice(i, i + 512), buffer = tail + chunk;
        let index = buffer.indexOf(expected);
        while (index !== -1) {
          const absolute = processed - tail.length + index + prefix.length;
          if (found !== -1 && found !== absolute) return -1;
          found = absolute;
          index = buffer.indexOf(expected, index + 1);
        }
        processed += chunk.length;
        tail = expected.length > 1 ? buffer.slice(-(expected.length - 1)) : '';
      }
    }
    return found;
  }

  function rangeAt(message, start, length) {
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node, offset = 0, begun = false;
    while ((node = walker.nextNode())) {
      const end = offset + node.length;
      if (!begun && end > start) { range.setStart(node, Math.max(0, start - offset)); begun = true; }
      if (begun && end >= start + length) { range.setEnd(node, start + length - offset); return range; }
      offset = end;
    }
    return null;
  }

  function tryRestore() {
    retryFrame = 0;
    if (!pending || hidden || disposed || changedRoute()) return;
    const anchor = pending, root = scope();
    if (!root || chatKey(root) !== anchor.key) { reset(); return; }
    const message = locateMessage(anchor, root);
    if (!message) return;
    const offset = findOffset(message, anchor);
    if (offset < 0) return;
    const range = rangeAt(message, offset, anchor.quote.length);
    if (!range) return;
    const scroll = scroller(root), view = metrics(scroll);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const desired = Math.min(anchor.viewportOffset, scroll.clientHeight * .55);
    scroll.scrollTo({top:Math.max(0, scroll.scrollTop + (rect.top - view.top) / view.scale - desired), behavior:'instant'});
    stopRestore();
    stack.pop();
    candidate = armed = null;
    clearFlash();
    if (CSS.highlights && typeof Highlight !== 'undefined') {
      CSS.highlights.set('chatgpt-voyager-origin', new Highlight(range));
      flashTimer = setTimeout(clearFlash, 1800);
    }
    status.hidden = true;
    render();
  }

  function queueRestore() {
    if (pending && !retryFrame) retryFrame = requestAnimationFrame(tryRestore);
  }

  function returnToOrigin() {
    if (changedRoute() || !stack.length || hidden || disposed) return;
    stopRestore();
    const anchor = stack.at(-1), root = scope();
    if (!root || chatKey(root) !== anchor.key) { reset(); return; }
    status.hidden = true;
    pending = anchor;
    tryRestore();
    if (!pending) return;
    // Approximate scrolling only requests remounting; pop the stack ONLY after exact relocation.
    restoreObserver.observe(root, {childList:true, subtree:true, characterData:true, attributes:true,
      attributeFilter:ATTRS});
    const scroll = scroller(root);
    scroll.scrollTo({top:Math.max(0, anchor.top - Math.min(anchor.viewportOffset, scroll.clientHeight * .55)), behavior:'instant'});
    expiry = setTimeout(() => {
      stopRestore();
      status.textContent = '原文暂未加载，请向上加载后重试。'; status.hidden = false;
      render();
    }, 5000);
    queueRestore(); render();
  }

  document.addEventListener('selectionchange', trackSelection);
  document.addEventListener('pointerdown', event => {
    if (event.composedPath().includes(host)) return;
    if (askButton(event.target)) armed = capture() || candidate;
    else { candidate = armed = null; }
  }, true);
  document.addEventListener('click', confirmAsk, true);
  back.addEventListener('click', returnToOrigin);
  shadow.querySelector('.clear').addEventListener('click', reset);
  const interrupt = () => { if (pending) { stopRestore(); render(); } };
  document.addEventListener('wheel', interrupt, {passive:true, capture:true});
  document.addEventListener('touchstart', interrupt, {passive:true, capture:true});
  document.addEventListener('keydown', event => {
    if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End','Escape'].includes(event.key)) interrupt();
  }, true);
  window.addEventListener('popstate', changedRoute);
  window.navigation?.addEventListener('currententrychange', changedRoute);
  window.addEventListener('resize', positionPanel, {passive:true});
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    stopRestore(); clearFlash(); candidate = armed = null;
    cancelAnimationFrame(selectionFrame); selectionFrame = 0;
    if (!hidden && stack.length && stack.at(-1).key !== chatKey(scope())) reset();
    render();
  });
  window.addEventListener('pagehide', () => { disposed = true; reset(); });
  window.addEventListener('pageshow', () => { disposed = false; hidden = document.hidden; changedRoute(); render(); });
  document.documentElement.append(host);
})();
