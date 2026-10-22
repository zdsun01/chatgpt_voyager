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
  // Hidden marker/style only: the sole visible UI is an arrow in native answer actions.
  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `
    ::highlight(chatgpt-voyager-origin) { background-color:#f8d775; color:#202020; }
    [data-voyager-return] { cursor:pointer; }
    [data-voyager-return]:hover { background-color:#8882!important; }
    [data-voyager-return]:focus-visible { outline:2px solid #4a98dd;outline-offset:1px; }
    [data-voyager-return]:disabled { opacity:.5;cursor:wait; }
  `;
  host.append(highlightStyle);
  const USER = '[data-message-author-role="user"], [data-user-message-bubble]';
  const EDITOR = '#prompt-textarea, [data-composer-markdown][contenteditable="true"]';
  const records = [];
  let route = location.pathname;
  let candidate = null, armed = null, pending = null, staged = null, submitted = null;
  let selectionFrame = 0, retryFrame = 0, actionFrame = 0, expiry = 0, flashTimer = 0, submitTimer = 0;
  let hidden = document.hidden, disposed = false;
  const restoreObserver = new MutationObserver(queueRestore);
  const actionObserver = new MutationObserver(changedActions);
  let observingActions = false;
  let userIds = new WeakMap(), nextUserId = 0;

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

  function userKey(node, root) {
    for (const attr of ATTRS) {
      const owner = node.closest(`[${attr}]`);
      if (owner && root.contains(owner)) return `${attr}:${owner.getAttribute(attr)}`;
    }
    if (!userIds.has(node)) userIds.set(node, `local:${++nextUserId}`);
    return userIds.get(node);
  }

  function messageNodes(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter(node =>
      !node.parentElement?.closest(selector) && visible(node));
  }

  function isRetry(button) {
    return button.matches('[data-testid="regenerate-response-button"],[data-testid="retry-button"]') ||
      [button.getAttribute('aria-label'),button.getAttribute('title'),button.textContent].some(label =>
        /^(?:重试|重新生成|重新生成回答|重新生成回复|重试回答|Retry|Try again|Regenerate|Regenerate response)$/i.test(label?.trim() || ''));
  }

  function watchActions() {
    if (observingActions || hidden || disposed || (!records.length && !submitted)) return;
    actionObserver.observe(document.body, {childList:true,subtree:true,attributes:true,
      attributeFilter:[...ATTRS,'aria-label','data-testid','data-app-shell-active-page']});
    observingActions = true;
  }

  function changedActions(changes) {
    if (changedRoute()) return;
    for (const change of changes) {
      if (change.type === 'attributes') {
        if (!change.target.hasAttribute('data-voyager-return')) { queueActions(); return; }
      } else {
        // Skip streaming text replacements and our own inserted arrow.
        for (const node of [...change.addedNodes,...change.removedNodes]) {
          if (node.nodeType !== Node.ELEMENT_NODE || node.hasAttribute('data-voyager-return')) continue;
          if (node.matches(`${USER},${ASSISTANT},button`) || node.querySelector(`${USER},${ASSISTANT},button`)) {
            queueActions(); return;
          }
        }
      }
    }
  }

  function queueActions() {
    if (!hidden && !disposed && !actionFrame) actionFrame = requestAnimationFrame(syncActions);
  }

  function refreshButtons() {
    for (const record of records) {
      const button = record.button?.deref();
      if (!button) continue;
      button.disabled = record === pending;
      button.hidden = hidden || disposed;
      button.style.display = button.hidden ? 'none' : 'inline-flex';
      button.title = record.failed ? '返回原文（暂未加载，请加载原文后重试）' : '返回原文';
    }
  }

  function syncActions() {
    actionFrame = 0;
    if (hidden || disposed || changedRoute()) return;
    const root = scope();
    if (!root) return;
    const key = chatKey(root);
    if (records.some(record => record.anchor.key !== key) || (submitted && submitted.anchor.key !== key)) { reset(); return; }
    const users = messageNodes(root, USER);
    if (submitted) {
      const newest = users.at(-1);
      if (newest && !submitted.known.has(userKey(newest,root))) {
        records.push({anchor:submitted.anchor,user:new WeakRef(newest),userKey:userKey(newest,root),target:null,button:null});
        if (records.length > LIMIT) records.shift().button?.deref()?.remove();
        submitted = null; staged = null; clearTimeout(submitTimer);
      }
    }
    const answers = messageNodes(root, ASSISTANT);
    const retryButtons = Array.from(root.querySelectorAll('button')).filter(button => isRetry(button) && visible(button));
    for (const record of records) {
      const userIndex = users.findIndex(user => userKey(user,root) === record.userKey);
      let answer = record.target ? locateMessage(record.target,root) : null;
      const nextUser = userIndex < 0 ? null : users[userIndex+1];
      if (userIndex >= 0) {
        // Bind to this specific follow-up, never to whichever answer is last on screen.
        answer = answers.find(node => Boolean(users[userIndex].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          (!nextUser || Boolean(node.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING))) || null;
      }
      if (!answer) continue;
      record.target = {id:identity(answer,root),node:new WeakRef(answer)};
      const retry = retryButtons.find(button => {
        if (!(answer.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        if (nextUser && !(button.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        // A toolbar may be outside the answer text wrapper. Its nearest preceding
        // assistant must nevertheless be exactly the linked response.
        const previous = answers.findLast(node => Boolean(node.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING));
        return previous === answer;
      });
      if (!retry) continue;
      let button = record.button?.deref();
      if (!button?.isConnected) {
        button = document.createElement('button');
        button.type = 'button'; button.textContent = '↩';
        button.setAttribute('data-voyager-return','');
        button.setAttribute('aria-label','返回原文');
        button.title = '返回原文';
        button.className = retry.className;
        button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;font:22px/1 system-ui;vertical-align:middle;';
        button.addEventListener('click',event => {event.preventDefault();event.stopPropagation();returnToOrigin(record);});
        record.button = new WeakRef(button);
      }
      // Preserve a native tooltip wrapper when retry itself is nested in one.
      const slot = retry.parentElement?.matches('[data-state], [data-tooltip-trigger]') && retry.parentElement.children.length === 1
        ? retry.parentElement : retry;
      if (slot.nextElementSibling !== button) slot.after(button);
    }
    refreshButtons();
  }

  function markSubmitted() {
    if (!staged || submitted || hidden || disposed || changedRoute()) return;
    const root = scope(), editor = Array.from(document.querySelectorAll(EDITOR)).find(visible);
    if (!root || staged.key !== chatKey(root) || !editor) return;
    const composer = editor.closest('[data-composer-body],form,[data-testid="composer"]') || editor.parentElement?.parentElement;
    const quote = staged.quote.trim().slice(0,24);
    // If the user removes the native quote before sending, there is no return link.
    if (!quote || !composer?.textContent.replace(/\s+/g,' ').includes(quote.replace(/\s+/g,' '))) { staged = null; return; }
    submitted = {anchor:staged,known:new Set(messageNodes(root,USER).map(user => userKey(user,root)))};
    clearTimeout(submitTimer);
    submitTimer = setTimeout(() => { submitted = null; if (!records.length) {actionObserver.disconnect();observingActions=false;} },120000);
    watchActions(); queueActions();
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
    candidate = armed = staged = submitted = null;
    clearTimeout(submitTimer);
    for (const record of records) record.button?.deref()?.remove();
    records.length = 0;
    actionObserver.disconnect(); observingActions = false;
    userIds = new WeakMap();
    cancelAnimationFrame(selectionFrame); selectionFrame = 0;
    cancelAnimationFrame(actionFrame); actionFrame = 0;
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
    staged = anchor;
    // Wait for the native composer submission and its resulting answer.
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
    const record = pending, anchor = record.anchor, root = scope();
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
    record.failed = false;
    candidate = armed = null;
    clearFlash();
    if (CSS.highlights && typeof Highlight !== 'undefined') {
      CSS.highlights.set('chatgpt-voyager-origin', new Highlight(range));
      flashTimer = setTimeout(clearFlash, 1800);
    }
    refreshButtons();
  }

  function queueRestore() {
    if (pending && !retryFrame) retryFrame = requestAnimationFrame(tryRestore);
  }

  function returnToOrigin(record) {
    if (changedRoute() || !records.includes(record) || hidden || disposed) return;
    stopRestore(); clearFlash();
    const anchor = record.anchor, root = scope();
    if (!root || chatKey(root) !== anchor.key) { reset(); return; }
    record.failed = false;
    pending = record;
    tryRestore();
    if (!pending) return;
    // Approximate scroll only requests remounting; highlighting requires an exact match.
    restoreObserver.observe(root, {childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:ATTRS});
    const scroll = scroller(root);
    scroll.scrollTo({top:Math.max(0,anchor.top-Math.min(anchor.viewportOffset,scroll.clientHeight*.55)),behavior:'instant'});
    expiry = setTimeout(() => {stopRestore();record.failed=true;refreshButtons();},5000);
    queueRestore(); refreshButtons();
  }

  document.addEventListener('selectionchange',trackSelection);
  document.addEventListener('pointerdown',event => {
    if (event.target.closest?.('[data-voyager-return]')) return;
    if (askButton(event.target)) armed = capture() || candidate;
    else {candidate = armed = null;}
  },true);
  document.addEventListener('click',event => {
    confirmAsk(event);
    const button = event.target.closest?.('button');
    if (button && (button.matches('[data-testid="send-button"]') ||
      /^(?:发送|发送消息|发送提示|Send|Send message|Send prompt)$/i.test(button.getAttribute('aria-label') || ''))) markSubmitted();
  },true);
  document.addEventListener('submit',event => {
    if (event.target.querySelector?.(EDITOR)) markSubmitted();
  },true);
  const interrupt = () => {if (pending) {stopRestore();refreshButtons();}};
  document.addEventListener('wheel',interrupt,{passive:true,capture:true});
  document.addEventListener('touchstart',interrupt,{passive:true,capture:true});
  document.addEventListener('keydown',event => {
    if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End','Escape'].includes(event.key)) interrupt();
    if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
      event.target.closest?.(EDITOR)) markSubmitted();
  },true);
  window.addEventListener('popstate',changedRoute);
  window.navigation?.addEventListener('currententrychange',changedRoute);
  document.addEventListener('visibilitychange',() => {
    hidden = document.hidden;
    stopRestore();clearFlash();candidate=armed=null;
    cancelAnimationFrame(selectionFrame);selectionFrame=0;
    cancelAnimationFrame(actionFrame);actionFrame=0;
    actionObserver.disconnect();observingActions=false;
    const key = chatKey(scope());
    if (!hidden && (records.some(record => record.anchor.key !== key) || (staged && staged.key !== key))) reset();
    refreshButtons();
    if (!hidden) {watchActions();queueActions();}
  });
  window.addEventListener('pagehide',() => {disposed=true;reset();});
  window.addEventListener('pageshow',() => {disposed=false;hidden=document.hidden;changedRoute();watchActions();queueActions();});
  document.documentElement.append(host);
})();
