(() => {
  'use strict';
  const HOST_ID = 'chatgpt-question-timeline';
  if (document.getElementById(HOST_ID)) return;

  const USER = '[data-message-author-role="user"], [data-user-message-bubble]';
  const ASSISTANT = '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]';
  const ROW = 28;
  const HEADER = 'header, [role="toolbar"]';
  const PAGE = '[data-app-shell-active-page]';
  const TRANSCRIPT = '[data-chatgpt-conversation-selection-target]';
  const UNAVAILABLE = '[hidden], [inert], [aria-hidden="true"], [data-app-shell-active-page="false"]';
  const host = document.createElement('div');
  host.id = HOST_ID;
  // Shadow DOM keeps page styles and our styles independent.
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { color-scheme: light;
        --rail:linear-gradient(110deg,#ffffffb3,#edf5fd66); --rail-edge:#8da8be33;
        --glass-shine:#ffffffd9; --rail-fallback:#f0f5fa;
        --dot:#cfe6fb; --accent:#8ebce2; --halo:#bedcf559;
        --hover:#4a98dd; --hover-ring:#acd1f2;
        --card:#fff; --ink:#35485b; --card-edge:#dfe8f0; }
      :host-context(.dark), :host-context([data-theme="dark"]) {
        color-scheme:dark; --rail:linear-gradient(110deg,#48556880,#27313d66);
        --rail-edge:#c4d9ee26; --glass-shine:#e0edfa33; --rail-fallback:#303d4b;
        --halo:#91c8f33d; --card:#293542; --ink:#e1ecf5; --card-edge:#435469;
        --hover:#71b5ee; --hover-ring:#436d91;
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .rail { position:fixed; right:12px; top:36px; bottom:6px; width:18px; pointer-events:auto;
        background:var(--rail); border-radius:12px;
        backdrop-filter:blur(10px) saturate(140%);
        box-shadow:inset 1px 0 0 var(--glass-shine), 0 0 0 1px var(--rail-edge), 0 2px 10px #57718a12; }
      @supports not (backdrop-filter:blur(1px)) { .rail { background:var(--rail-fallback); } }
      button { font:inherit; color:inherit; border:0; cursor:pointer; background:transparent; }
      button:focus-visible { outline:none; }
      .viewport { position:relative; height:100%; overflow-y:auto; overflow-x:hidden;
        border-radius:inherit;
        scrollbar-width:none; overscroll-behavior:contain; }
      .viewport::-webkit-scrollbar { display:none; }
      .items { position:relative; }
      .node { position:absolute; left:0; width:18px; height:28px; padding:0;
        display:grid; place-items:center; border-radius:10px; }
      .node span { width:12px; height:12px; border-radius:50%; background:var(--dot);
        box-shadow:inset 0 0 0 1px #99bfdf45; }
      .node[aria-current=true] span { background:var(--hover);
        box-shadow:inset 0 0 0 1px #ffffff80, 0 0 0 3px var(--halo); }
      .node:hover span,.node:focus-visible span { width:14px; height:14px; background:var(--hover);
        box-shadow:inset 0 0 0 1px #ffffff80, 0 0 0 2px var(--hover-ring); }
      .preview { position:fixed; right:42px; width:max-content; max-width:min(380px,calc(100vw - 58px));
        max-height:min(380px,65vh); overflow:auto; pointer-events:auto; padding:14px 16px;
        background:var(--card); color:var(--ink); border:1px solid var(--card-edge); border-radius:10px;
        box-shadow:0 4px 18px #30465e12; font:13px/1.65 system-ui,sans-serif; }
      .text { white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
      @media (max-width:600px) { .rail { right:6px; } .preview { right:36px; } }
    </style>
    <nav class="rail" aria-label="提问时间线" hidden>
      <div class="viewport"><div class="items"></div></div>
    </nav>
    <aside class="preview" id="question-preview" role="tooltip" hidden>
      <div class="text"></div>
    </aside>`;
  const rail = shadow.querySelector('.rail');
  const viewport = shadow.querySelector('.viewport');
  const items = shadow.querySelector('.items');
  const preview = shadow.querySelector('.preview');
  const content = shadow.querySelector('.text');
  let questions = [];
  const questionById = new Map();
  let nodeIds = new WeakMap();
  let nextNodeId = 0;
  let cachedConversationKey = null;
  let pendingJump = null;
  let jumpTimer = 0;
  let scanTimer = 0;
  let hideTimer = 0;
  let frame = 0;
  let range = '';
  let active = -1;
  let route = location.pathname;
  let suspended = false;
  let rowStep = ROW;
  let shareButton = null;
  let conversationRoot = null;
  let observedScope = null;
  let mountedQuestions = [];
  let chatScroller = null;
  let scrollTarget = null;
  let activeFrame = 0;
  const headerResize = new ResizeObserver(queueRender);
  const scopeObserver = new MutationObserver(() => {
    // Watch just the active container's ancestors, never every streaming token's style.
    if (conversationRoot && !isAvailable(conversationRoot)) clearTimeline();
    queueScan();
  });

  function isAvailable(element, cache = new Map()) {
    if (!element?.isConnected) return false;
    if (cache.has(element)) return cache.get(element);
    const style = getComputedStyle(element);
    const visible = !element.matches(UNAVAILABLE) && style.display !== 'none' &&
      style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
      (!element.parentElement || isAvailable(element.parentElement, cache));
    cache.set(element, visible);
    return visible;
  }

  function getConversationScope() {
    const cache = new Map();
    const pages = Array.from(document.querySelectorAll(PAGE));
    const roots = pages.length ? pages.filter(page =>
      page.getAttribute('data-app-shell-active-page') === 'true' && isAvailable(page, cache)) : [document.body];
    const id = location.pathname.match(/\/c\/([^/]+)/)?.[1];
    const transcripts = roots.flatMap(root => Array.from(root.querySelectorAll(TRANSCRIPT)))
      .filter(root => isAvailable(root, cache));
    if (transcripts.length) {
      // URLs can change before React changes the active page. Wait for its matching ID.
      return transcripts.find(root => {
        const key = root.getAttribute('data-chatgpt-conversation-selection-target');
        return id ? key.replace(/^local-chatgpt:/, '') === id : key.startsWith('local-chatgpt:');
      }) || null;
    }
    // Legacy pages have no transcript ID; select ONE visible main, never combine them.
    const mains = roots.flatMap(root => Array.from(root.querySelectorAll('main')))
      .filter(main => isAvailable(main, cache));
    return mains.at(-1) || roots.at(-1) || null;
  }

  function watchScope(root) {
    if (!root || root === observedScope) return;
    scopeObserver.disconnect();
    observedScope = root;
    for (let el = root; el; el = el.parentElement) {
      scopeObserver.observe(el, { attributes:true,
        attributeFilter:['class','style','hidden','inert','aria-hidden'] });
    }
  }

  function clearTimeline() {
    hidePreview();
    watchScroll(null);
    mountedQuestions = [];
    questions = [];
    questionById.clear();
    nodeIds = new WeakMap();
    cachedConversationKey = null;
    pendingJump = null;
    clearTimeout(jumpTimer);
    conversationRoot = null;
    active = -1;
    range = '';
    rail.hidden = true;
    items.replaceChildren();
    items.style.height = '0px';
    viewport.scrollTop = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    headerResize.disconnect();
    shareButton = null;
  }

  function checkRoute() {
    if (route === location.pathname) return false;
    route = location.pathname;
    clearTimeline();
    scopeObserver.disconnect();
    observedScope = null;
    clearTimeout(scanTimer);
    scanTimer = 0;
    queueScan();
    return true;
  }

  function currentQuestion(index) {
    if (checkRoute()) return null;
    if (!conversationRoot || getConversationScope() !== conversationRoot) {
      clearTimeline(); queueScan(); return null;
    }
    return questions[index];
  }

  function messageIdentity(node) {
    for (const attr of ['data-message-id','data-chatgpt-search-message-ids','data-turn-key']) {
      const value = node.closest(`[${attr}]`)?.getAttribute(attr);
      if (value && !value.startsWith('fallback-')) return { key:`message:${value}`, durable:true };
    }
    // Without a stable message ID, preserve the legacy DOM-only behavior.
    if (!nodeIds.has(node)) nodeIds.set(node, `node:${++nextNodeId}`);
    return { key:nodeIds.get(node), durable:false };
  }

  function questionText(node) {
    const body = node.querySelector('.whitespace-pre-wrap') || node;
    return body.textContent?.trim() || '（图片、文件或其他非文字提问）';
  }

  function scrollerFor(root) {
    const known = root?.closest('[data-app-action-timeline-scroll]');
    if (known) return known;
    for (let el = root; el && el !== document.body; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement;
  }

  function scrollMetrics(scroller) {
    const isDocument = scroller === document.scrollingElement;
    const rect = scroller.getBoundingClientRect();
    return { top:isDocument ? 0 : rect.top,
      scale:isDocument || !scroller.offsetHeight ? 1 : rect.height / scroller.offsetHeight || 1,
      height:scroller.scrollHeight, offset:scroller.scrollTop };
  }

  function distanceFromBottom(node, metrics) {
    return metrics.height - (metrics.offset + (node.getBoundingClientRect().top - metrics.top) / metrics.scale);
  }

  function mergeQuestions(nodes, scope) {
    const previous = questions;
    const selected = previous[active];
    const key = scope?.getAttribute('data-chatgpt-conversation-selection-target') || location.pathname;
    if (cachedConversationKey !== null && cachedConversationKey !== key) clearTimeline();
    cachedConversationKey = key;
    const metrics = scrollMetrics(scrollerFor(scope));
    const batch = nodes.map(node => {
      const identity = messageIdentity(node);
      const unit = node.closest('[data-content-search-unit-key]')?.getAttribute('data-content-search-unit-key') || '';
      const turn = unit.match(/^fallback-turn-(\d+):/);
      return { ...identity, node, order:turn ? Number(turn[1]) : null, bottom:distanceFromBottom(node, metrics) };
    });
    // Compensate for newly appended replies / measured placeholder heights using
    // a shared loaded message. Prepending older history normally leaves this distance unchanged.
    const anchor = batch.findLast(item => questionById.has(item.key));
    const adjustment = anchor ? anchor.bottom - questionById.get(anchor.key).bottom : 0;
    if (adjustment) for (const entry of questions) entry.bottom += adjustment;
    const mounted = new Set();
    let changed = false;
    for (const item of batch) {
      mounted.add(item.key);
      let entry = questionById.get(item.key);
      const text = questionText(item.node);
      if (!entry) {
        entry = { key:item.key, durable:item.durable };
        questionById.set(item.key, entry);
        changed = true;
      } else if (entry.text !== text) changed = true;
      Object.assign(entry, { text, order:item.order, bottom:item.bottom, node:new WeakRef(item.node) });
    }
    for (const [id, entry] of questionById) {
      if (!mounted.has(id) && !entry.durable) { questionById.delete(id); changed = true; }
    }
    // Stable ordinal where supplied by ChatGPT; otherwise use scroll geometry.
    // UUIDs and prompt text are never used to guess chronological order.
    questions = Array.from(questionById.values()).sort((a,b) =>
      a.order !== null && b.order !== null ? a.order - b.order : b.bottom - a.bottom);
    questions.forEach((entry, index) => { entry.index = index; });
    mountedQuestions = batch.map(item => questionById.get(item.key)).sort((a,b) => a.index - b.index);
    active = selected ? questions.indexOf(selected) : -1;
    return changed || previous.length !== questions.length || questions.some((entry,i)=>entry !== previous[i]);
  }

  function mountedNode(entry) {
    const node = entry?.node?.deref();
    return node?.isConnected && conversationRoot?.contains(node) && isAvailable(node) ? node : null;
  }

  function watchScroll(scroller) {
    if (chatScroller === scroller) return;
    scrollTarget?.removeEventListener('scroll', queueActive);
    cancelAnimationFrame(activeFrame);
    activeFrame = 0;
    chatScroller = scroller;
    scrollTarget = scroller === document.scrollingElement ? document : scroller;
    scrollTarget?.addEventListener('scroll', queueActive, { passive:true });
  }

  function selectQuestion(index, reveal = false) {
    if (index < 0 || index >= questions.length) return;
    if (active !== index) {
      items.querySelector('[aria-current="true"]')?.setAttribute('aria-current', 'false');
      active = index;
      items.querySelector(`[data-index="${index}"]`)?.setAttribute('aria-current', 'true');
    }
    // Keep the reading marker visible even when the rail itself is virtualized.
    if (reveal && (index * rowStep < viewport.scrollTop ||
      index * rowStep + ROW > viewport.scrollTop + viewport.clientHeight)) {
      viewport.scrollTop = Math.max(0, index * rowStep - viewport.clientHeight / 2);
      queueRender();
    }
  }

  function updateActive() {
    activeFrame = 0;
    if (checkRoute() || !conversationRoot || !chatScroller || !questions.length || pendingJump) return;
    const metrics = scrollMetrics(chatScroller);
    const height = chatScroller.clientHeight;
    const visibleTop = Math.max(0, metrics.top);
    const visibleBottom = Math.min(innerHeight, metrics.top + height * metrics.scale);
    const line = (visibleTop + visibleBottom) / 2;
    const readingBottom = metrics.height - metrics.offset - (line - metrics.top) / metrics.scale;
    let before = -1, after = questions.length, anchor = null, anchorBottom = 0;
    // Binary search mounted geometry: even a long fully mounted chat needs only
    // a few layout reads per frame. Never scan the page or copy text on scroll.
    let left = 0, right = mountedQuestions.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      const entry = mountedQuestions[mid];
      const node = entry.node.deref();
      // React is replacing the mount window; the queued scan will refresh it.
      if (!node?.isConnected || !conversationRoot.contains(node)) { queueScan(); return; }
      const top = node.getBoundingClientRect().top;
      if (top <= line + 1) {
        left = mid + 1;
        before = entry.index;
        anchor = entry;
        anchorBottom = metrics.height - metrics.offset - (top - metrics.top) / metrics.scale;
      } else {
        right = mid;
        after = entry.index;
        if (before < 0) {
          anchor = entry;
          anchorBottom = metrics.height - metrics.offset - (top - metrics.top) / metrics.scale;
        }
      }
    }
    // A prompt may be unmounted while its long answer is still on screen.
    // Use its numeric position, calibrated to a live neighbor, within live bounds.
    const delta = anchor ? anchorBottom - anchor.bottom : 0;
    let low = 0, high = questions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (questions[mid].bottom + delta >= readingBottom - 1) low = mid + 1;
      else high = mid;
    }
    let index = Math.max(0, before, Math.min(low - 1, after - 1));
    if (metrics.height > height + 2 && metrics.offset + height >= metrics.height - 2) index = questions.length - 1;
    selectQuestion(index, true);
  }

  function queueActive() {
    if (!document.hidden && !suspended && !activeFrame) activeFrame = requestAnimationFrame(updateActive);
  }

  function restoreJump() {
    if (!pendingJump || checkRoute()) return;
    const node = mountedNode(questionById.get(pendingJump.key));
    if (node) {
      node.scrollIntoView({ behavior:'instant', block:'center' });
      pendingJump = null;
      clearTimeout(jumpTimer);
    } else if (pendingJump.attempts < 3) seekQuestion(questionById.get(pendingJump.key));
  }

  function seekQuestion(entry) {
    if (!entry || !conversationRoot || !pendingJump) return;
    const scroller = scrollerFor(conversationRoot);
    const metrics = scrollMetrics(scroller);
    // Recalibrate against a mounted anchor in case the model has streamed more text.
    const anchor = questions.find(item => mountedNode(item));
    const delta = anchor ? distanceFromBottom(mountedNode(anchor), metrics) - anchor.bottom : 0;
    pendingJump.attempts++;
    scroller.scrollTo({ top:Math.max(0, metrics.height - entry.bottom - delta - scroller.clientHeight / 3), behavior:'instant' });
  }

  function alignWithShare() {
    let selected = null;
    let selectedRect = null;
    // Only search toolbars: assistant messages also contain Share buttons.
    const surface = conversationRoot?.closest(PAGE) || document.body;
    for (const button of surface.querySelectorAll('header button, [role="toolbar"] button')) {
      const label = (button.getAttribute('aria-label') || button.textContent).trim();
      if (!/^(分享|Share)$/i.test(label) || button.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.top < 0 || rect.bottom > innerHeight ||
        getComputedStyle(button).visibility !== 'visible') continue;
      if (!selectedRect || rect.right > selectedRect.right) { selected = button; selectedRect = rect; }
    }
    if (selected !== shareButton) {
      headerResize.disconnect();
      shareButton = selected;
      if (shareButton) {
        headerResize.observe(shareButton);
        headerResize.observe(shareButton.closest(HEADER));
      }
    }
    rail.style.top = `${selectedRect ? selectedRect.bottom + 3 : 36}px`;
  }

  function hidePreview() {
    clearTimeout(hideTimer);
    preview.hidden = true;
    content.textContent = '';
    items.querySelector('[aria-describedby]')?.removeAttribute('aria-describedby');
  }

  function deferHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePreview, 180);
  }

  function showPreview(button) {
    const index = Number(button.dataset.index);
    const question = currentQuestion(index);
    if (!question) return;
    hidePreview();
    const node = mountedNode(question);
    if (node) question.text = questionText(node);
    content.textContent = question.text;
    preview.hidden = false;
    preview.scrollTop = 0;
    button.setAttribute('aria-describedby', 'question-preview');
    const top = button.getBoundingClientRect().top;
    preview.style.top = `${Math.max(8, Math.min(top - 12, innerHeight - preview.offsetHeight - 8))}px`;
  }

  function render(force = false) {
    frame = 0;
    if (checkRoute()) return;
    alignWithShare();
    const height = Math.max(viewport.clientHeight, questions.length * ROW);
    rowStep = questions.length > 1 ? (height - ROW) / (questions.length - 1) : ROW;
    items.style.height = `${height}px`;
    const start = Math.max(0, Math.floor(viewport.scrollTop / rowStep) - 3);
    const end = Math.min(questions.length, start + Math.ceil(viewport.clientHeight / rowStep) + 7);
    const nextRange = `${start}:${end}:${rowStep}`;
    if (!force && range === nextRange) return;
    hidePreview();
    range = nextRange;
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const button = document.createElement('button');
      button.className = 'node';
      button.dataset.index = i;
      button.style.top = `${i * rowStep}px`;
      button.setAttribute('aria-label', `第 ${i + 1} 次提问`);
      button.setAttribute('aria-current', String(i === active));
      const dot = document.createElement('span');
      dot.setAttribute('aria-hidden', 'true');
      button.append(dot);
      fragment.append(button);
    }
    items.replaceChildren(fragment);
  }

  function queueRender() {
    if (document.hidden || suspended) return;
    if (!frame) frame = requestAnimationFrame(() => render());
  }

  function scan() {
    scanTimer = 0;
    if (document.hidden || suspended) return;
    if (!host.isConnected) document.documentElement.append(host);
    if (checkRoute()) return;
    const scope = getConversationScope();
    const cache = new Map();
    const next = scope ? Array.from(scope.querySelectorAll(USER)).filter(question =>
      !question.parentElement?.closest(USER) && isAvailable(question, cache)) : [];
    const scopeChanged = scope !== conversationRoot;
    watchScope(scope);
    if (!scope) { clearTimeline(); return; }
    const changed = mergeQuestions(next, scope);
    conversationRoot = scope;
    watchScroll(scrollerFor(scope));
    rail.hidden = !questions.length;
    if (scopeChanged) viewport.scrollTop = 0;
    if (changed || scopeChanged) render(true);
    restoreJump();
    queueActive();
  }

  function queueScan() {
    if (!scanTimer && !document.hidden && !suspended) scanTimer = setTimeout(scan, 120);
  }

  function includesUser(node) {
    return node.nodeType === Node.ELEMENT_NODE && (node.matches(USER) || Boolean(node.querySelector(USER)));
  }

  const observer = new MutationObserver(records => {
    if (checkRoute()) return;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (['data-app-shell-active-page','data-chatgpt-conversation-selection-target'].includes(record.attributeName)) {
          if (getConversationScope() !== conversationRoot) clearTimeline();
          queueScan(); return;
        }
        if (['hidden','inert','aria-hidden'].includes(record.attributeName)) {
          if (!record.target.closest(ASSISTANT) &&
            ((conversationRoot && record.target.contains(conversationRoot)) || includesUser(record.target))) {
            if (getConversationScope() !== conversationRoot) clearTimeline();
            queueScan(); return;
          }
          continue;
        }
        if (record.target.matches(USER) || record.oldValue === 'user' ||
          (record.attributeName === 'data-user-message-bubble' && record.oldValue !== null)) {
          queueScan(); return;
        }
        continue;
      }
      const parent = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      // Streaming assistant tokens require no rescanning or text copying.
      if (parent?.closest(ASSISTANT)) continue;
      if (parent?.closest(USER)) { hidePreview(); queueScan(); continue; }
      if (parent?.closest(HEADER)) queueRender();
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType === Node.ELEMENT_NODE && (node.matches(HEADER) || node.querySelector(HEADER))) {
          queueRender(); break;
        }
      }
      for (const node of record.addedNodes) if (includesUser(node)) { queueScan(); return; }
      for (const node of record.removedNodes) if (includesUser(node)) { queueScan(); return; }
    }
  });

  function observe() {
    observer.observe(document.body, { childList:true, subtree:true, attributes:true,
      attributeFilter:['data-message-author-role', 'data-user-message-bubble',
        'data-app-shell-active-page','data-chatgpt-conversation-selection-target','hidden','inert','aria-hidden'], attributeOldValue:true });
  }

  items.addEventListener('pointerover', event => {
    const button = event.target.closest('.node');
    if (button && !button.contains(event.relatedTarget)) showPreview(button);
  });
  items.addEventListener('pointerout', event => {
    const button = event.target.closest('.node');
    if (button && !button.contains(event.relatedTarget)) deferHide();
  });
  items.addEventListener('focusin', event => {
    if (event.target.matches('.node')) showPreview(event.target);
  });
  items.addEventListener('focusout', deferHide);
  preview.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  preview.addEventListener('pointerleave', deferHide);
  items.addEventListener('click', event => {
    const button = event.target.closest('.node');
    if (!button) return;
    const index = Number(button.dataset.index);
    const question = currentQuestion(index);
    if (!question) return;
    selectQuestion(index);
    pendingJump = null;
    clearTimeout(jumpTimer);
    const node = mountedNode(question);
    if (node) node.scrollIntoView({ behavior:'instant', block:'center' });
    else {
      pendingJump = { key:question.key, attempts:0 };
      seekQuestion(question);
      // One bounded expiry, not a polling loop. DOM updates complete the jump.
      jumpTimer = setTimeout(() => { pendingJump = null; }, 4000);
    }
    hidePreview();
  });
  items.addEventListener('keydown', event => {
    const button = event.target.closest('.node');
    if (!button || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const index = Number(button.dataset.index);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? questions.length - 1
      : Math.max(0, Math.min(questions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    viewport.scrollTop = Math.max(0, target * rowStep - viewport.clientHeight / 2);
    render(true);
    items.querySelector(`[data-index="${target}"]`)?.focus({ preventScroll:true });
  });
  shadow.addEventListener('keydown', event => { if (event.key === 'Escape') hidePreview(); });
  viewport.addEventListener('scroll', queueRender, { passive:true });
  window.addEventListener('resize', queueRender, { passive:true });
  window.addEventListener('resize', queueActive, { passive:true });
  window.addEventListener('popstate', () => { checkRoute(); queueScan(); });
  // Fires for pushState/replaceState as well as back/forward, including isolated content scripts.
  window.navigation?.addEventListener('currententrychange', () => { checkRoute(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      watchScroll(null);
      mountedQuestions = [];
      observer.disconnect();
      scopeObserver.disconnect();
      observedScope = null;
      conversationRoot = null;
      headerResize.disconnect();
      shareButton = null;
      clearTimeout(scanTimer);
      scanTimer = 0;
      cancelAnimationFrame(frame);
      frame = 0;
      hidePreview();
      pendingJump = null;
      clearTimeout(jumpTimer);
      rail.hidden = true;
      items.replaceChildren();
      range = '';
    } else if (!suspended) { observe(); scan(); }
  });
  window.addEventListener('pagehide', () => {
    suspended = true;
    observer.disconnect();
    scopeObserver.disconnect();
    observedScope = null;
    conversationRoot = null;
    headerResize.disconnect();
    shareButton = null;
    clearTimeout(scanTimer);
    scanTimer = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    hidePreview();
    clearTimeline();
    rail.hidden = true;
    items.replaceChildren();
    range = '';
  });
  window.addEventListener('pageshow', () => {
    if (suspended) { suspended = false; observe(); scan(); }
  });
  document.documentElement.append(host);
  if (!document.hidden) observe();
  scan();
})();
