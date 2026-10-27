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
  let settleTimer = 0, settling = null;
  let hidden = document.hidden, disposed = false;
  const restoreObserver = new MutationObserver(queueRestore);
  const actionObserver = new MutationObserver(changedActions);
  let observingActions = false;
  let userIds = new WeakMap(), nextUserId = 0;
  let storageGeneration = 0, loadingStorage = false;
  let savedRecords = new Map();

  function storageChat() {
    const id = location.pathname.match(/\/c\/([\w-]{1,160})(?:\/|$)/)?.[1];
    return id ? `/c/${id}` : null;
  }

  function storedRecord(record) {
    const a = record.anchor;
    if (!a.id || a.id.attr === 'data-content-search-unit-key' ||
      /^(?:local:|data-content-search-unit-key:)/.test(record.userKey)) return null;
    return {userKey:record.userKey,prompt:record.prompt,at:record.at,
      target:record.target?.id || null,
      anchor:{id:a.id,start:a.start,quote:a.quote,prefix:a.prefix,suffix:a.suffix,top:a.top,viewportOffset:a.viewportOffset}};
  }

  function storageMessage(message) {
    try {
      if (!globalThis.chrome?.runtime?.sendMessage) return Promise.resolve(null);
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(()=>null);
    } catch {return Promise.resolve(null);}
  }

  function saveRecords() {
    const chat = storageChat();
    if (!chat || loadingStorage || disposed) return;
    for (const key of savedRecords.keys()) if (!records.some(record=>record.userKey === key)) savedRecords.delete(key);
    const changed = [], snapshots = new Map();
    for (const record of records) {
      const stored = storedRecord(record);
      if (!stored) continue;
      const serialized = JSON.stringify(stored);
      if (savedRecords.get(record.userKey) === serialized) continue;
      changed.push(stored);snapshots.set(record.userKey,serialized);
      savedRecords.set(record.userKey,serialized);
    }
    if (!changed.length) return;
    const generation = storageGeneration;
    void storageMessage({type:'voyager:return:save',chat,records:changed}).then(result=>{
      if (generation !== storageGeneration || result?.ok) return;
      // Keep session navigation working on storage failure; retry only on another change.
      for (const [key,value] of snapshots) if (savedRecords.get(key) === value) savedRecords.delete(key);
    });
  }

  function loadRecords() {
    const chat = storageChat(), generation = ++storageGeneration;
    loadingStorage = Boolean(chat);
    watchActions();queueActions();
    if (!chat) return;
    void storageMessage({type:'voyager:return:load',chat}).then(result=>{
      if (generation !== storageGeneration || disposed || storageChat() !== chat) return;
      loadingStorage = false;
      for (const saved of result?.ok && Array.isArray(result.records) ? result.records.slice(-LIMIT) : []) {
        if (records.some(record=>record.userKey === saved.userKey)) continue;
        const record = {userKey:saved.userKey,prompt:saved.prompt,at:saved.at,
          anchor:{...saved.anchor,key:chat,node:null},user:null,
          target:saved.target ? {id:saved.target,node:null} : null,button:null};
        records.push(record);
        savedRecords.set(record.userKey,JSON.stringify(storedRecord(record)));
      }
      records.sort((a,b)=>a.at-b.at);
      while (records.length > LIMIT) records.shift().button?.deref()?.remove();
      watchActions();queueActions();saveRecords();
    });
  }

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
    return storageChat() || `${location.pathname}|${root?.getAttribute('data-chatgpt-conversation-selection-target') || ''}`;
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
    // A turn ID survives late message-ID hydration and assistant regeneration.
    for (const attr of ['data-turn-key', ...ATTRS.filter(attr => attr !== 'data-turn-key')]) {
      const owner = node.closest(`[${attr}]`);
      if (owner && root.contains(owner)) return `${attr}:${owner.getAttribute(attr)}`;
    }
    if (!userIds.has(node)) userIds.set(node, `local:${++nextUserId}`);
    return userIds.get(node);
  }

  function promptSignature(node) {
    // Two rolling hashes + length; retain no prompt text. Ignore layout whitespace
    // added/removed by the rich-text editor and rendered user bubble.
    const body = node.querySelector('[data-user-message-bubble]') || node;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text, length = 0, a = 2166136261, b = 5381;
    while ((text = walker.nextNode())) {
      for (const char of text.data) {
        if (/[\s\u200b]/u.test(char)) continue;
        const value = char.codePointAt(0);
        a = Math.imul(a ^ value, 16777619) >>> 0;
        b = (Math.imul(b, 33) ^ value) >>> 0;
        length++;
      }
    }
    return `${length}:${a}:${b}`;
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
    if (observingActions || hidden || disposed) return;
    actionObserver.observe(document.body, {childList:true,subtree:true,attributes:true,characterData:true,
      attributeFilter:[...ATTRS,'aria-label','data-testid','data-app-shell-active-page']});
    observingActions = true;
  }

  function changedActions(changes) {
    if (changedRoute()) return;
    for (const change of changes) {
      if (change.type === 'characterData') {
        if (submitted && change.target.parentElement?.closest(USER)) {queueActions();return;}
        if (isNativeQuote(change.target.parentElement?.closest('button'))) {queueActions();return;}
      } else if (change.type === 'attributes') {
        if (!change.target.hasAttribute('data-voyager-return')) { queueActions(); return; }
      } else {
        if (submitted && change.target.closest?.(USER)) {queueActions();return;}
        if (isNativeQuote(change.target.closest?.('button'))) {queueActions();return;}
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

  function isNativeQuote(button) {
    return Boolean(button && !button.hasAttribute('data-voyager-return') &&
      [button.textContent,button.getAttribute('aria-label')].some(text=>
        /^(?:1\s*个已选文本片段|1\s+selected\s+text(?:\s+(?:passage|snippet|excerpt))?s?)$/i.test(text?.trim() || '')));
  }

  function nativeQuoteFor(user,root) {
    const turn=user.closest('[data-turn-key]');
    if (!turn || !root.contains(turn)) return null;
    const buttons=Array.from(turn.querySelectorAll('button')).filter(button=>
      isNativeQuote(button) && visible(button) &&
      Boolean(button.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING));
    return buttons.length===1 ? buttons[0] : null;
  }

  function makeReturnButton(retry,handler) {
    const button=document.createElement('button');
    button.type='button';button.textContent='↩';
    button.setAttribute('data-voyager-return','');
    button.setAttribute('aria-label','返回原文');button.title='返回原文';
    button.className=retry.className;
    button.style.cssText='display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;font:22px/1 system-ui;vertical-align:middle;';
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();handler();});
    return button;
  }

  function placeReturnButton(retry,button) {
    const slot=retry.parentElement?.matches('[data-state], [data-tooltip-trigger]') && retry.parentElement.children.length===1
      ? retry.parentElement : retry;
    if (slot.nextElementSibling!==button) slot.after(button);
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
      // Moving to the composer can remount OLD messages before the new question
      // arrives. A new DOM node alone is not evidence of a new submission.
      const matches = users.filter(user => !submitted.known.has(userKey(user,root)) &&
        !records.some(record => record.userKey === userKey(user,root)) &&
        promptSignature(user) === submitted.prompt);
      const newest = matches.length === 1 ? matches[0] : null;
      if (newest) {
        records.push({anchor:submitted.anchor,user:new WeakRef(newest),userKey:userKey(newest,root),prompt:submitted.prompt,at:Date.now(),target:null,button:null});
        if (records.length > LIMIT) {
          const removed = records.shift();removed.button?.deref()?.remove();savedRecords.delete(removed.userKey);
        }
        submitted = null; staged = null; clearTimeout(submitTimer);
      }
    }
    const answers = messageNodes(root, ASSISTANT);
    const retryButtons = Array.from(root.querySelectorAll('button')).filter(button => isRetry(button) && visible(button));
    const claimedAnswers = new Set();
    const claimedUsers = new Set();
    for (const record of records) {
      let userIndex = users.findIndex(user => userKey(user,root) === record.userKey);
      if (userIndex < 0) {
        // Message IDs can be added after an optimistic bubble has mounted.
        userIndex = users.findIndex(user => user === record.user?.deref() && promptSignature(user) === record.prompt);
        if (userIndex >= 0) record.userKey = userKey(users[userIndex],root);
      }
      let answer = record.target ? locateMessage(record.target,root) : null;
      const nextUser = userIndex < 0 ? null : users[userIndex+1];
      if (userIndex >= 0) {
        record.user = new WeakRef(users[userIndex]);
        // Bind to this specific follow-up, never to whichever answer is last on screen.
        answer = answers.find(node => Boolean(users[userIndex].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          (!nextUser || Boolean(node.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING))) || null;
      }
      if (!answer || claimedAnswers.has(answer)) {
        record.button?.deref()?.remove();record.button=null;continue;
      }
      claimedAnswers.add(answer);
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
      claimedUsers.add(record.userKey);
      for (const native of root.querySelectorAll('[data-voyager-return-native]')) {
        if (native.getAttribute('data-voyager-return-for')===record.userKey) native.remove();
      }
      let button = record.button?.deref();
      if (!button?.isConnected) {
        button = makeReturnButton(retry,()=>returnToOrigin(record));
        record.button = new WeakRef(button);
      }
      button.setAttribute('data-voyager-return-for',record.userKey);
      placeReturnButton(retry,button);
    }
    // Native quote references survive refresh even when our capture was missed
    // (e.g. formulas, old versions, storage eviction). Delegate to that exact
    // message's own control; never infer a source from the latest visible reply.
    const nativeButtons=Array.from(root.querySelectorAll('[data-voyager-return-native]'));
    const keep=new Set();
    for (let i=0;i<users.length;i++) {
      const user=users[i],userId=userKey(user,root);
      if (claimedUsers.has(userId) || !nativeQuoteFor(user,root)) continue;
      const next=users[i+1];
      const answer=answers.find(node=>Boolean(user.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING) &&
        (!next || Boolean(node.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING)));
      if (!answer || claimedAnswers.has(answer)) continue;
      const retry=retryButtons.find(button=>Boolean(answer.compareDocumentPosition(button)&Node.DOCUMENT_POSITION_FOLLOWING) &&
        (!next || Boolean(button.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING)) &&
        answers.findLast(node=>Boolean(node.compareDocumentPosition(button)&Node.DOCUMENT_POSITION_FOLLOWING))===answer);
      if (!retry) continue;
      let button=nativeButtons.find(button=>button.getAttribute('data-voyager-return-for')===userId);
      if (!button) {
        button=makeReturnButton(retry,()=>{
          if (hidden || disposed || changedRoute()) return;
          const current=scope();
          if (!current || chatKey(current)!==key) return;
          const owner=messageNodes(current,USER).find(node=>userKey(node,current)===userId);
          const quote=owner && nativeQuoteFor(owner,current);
          if (quote) {stopRestore();clearFlash();refreshButtons();quote.click();}
        });
        button.setAttribute('data-voyager-return-native','');
        button.setAttribute('data-voyager-return-for',userId);
      }
      claimedAnswers.add(answer);keep.add(button);placeReturnButton(retry,button);
    }
    for (const button of nativeButtons) if (!keep.has(button)) button.remove();
    refreshButtons();
    saveRecords();
  }

  function markSubmitted() {
    if (!staged || submitted || hidden || disposed || changedRoute()) return;
    const root = scope(), editor = Array.from(document.querySelectorAll(EDITOR)).find(visible);
    if (!root || staged.key !== chatKey(root) || !editor) return;
    const composer = editor.closest('[data-composer-body],form,[data-testid="composer"]') || editor.parentElement?.parentElement;
    const quote = staged.quote.trim().slice(0,24);
    // If the user removes the native quote before sending, there is no return link.
    if (!quote || !composer?.textContent.replace(/\s+/g,' ').includes(quote.replace(/\s+/g,' '))) { staged = null; return; }
    submitted = {anchor:staged,prompt:promptSignature(editor),known:new Set([
      ...messageNodes(root,USER).map(user => userKey(user,root)),...records.map(record => record.userKey)
    ])};
    clearTimeout(submitTimer);
    submitTimer = setTimeout(() => { submitted = null; },120000);
    watchActions(); queueActions();
  }

  function stopRestore() {
    restoreObserver.disconnect();
    cancelAnimationFrame(retryFrame); retryFrame = 0;
    clearTimeout(expiry); expiry = 0;
    clearTimeout(settleTimer);settleTimer=0;settling=null;
    pending = null;
  }

  function finishRestore(record, success) {
    stopRestore();
    record.failed = !success;
    candidate = armed = null;
    if (success) flashTimer = setTimeout(clearFlash,1800);
    else clearFlash();
    refreshButtons();
  }

  function clearFlash() {
    clearTimeout(flashTimer);
    CSS.highlights?.delete('chatgpt-voyager-origin');
  }

  function reset() {
    storageGeneration++;loadingStorage=false;savedRecords.clear();
    stopRestore(); clearFlash();
    candidate = armed = staged = submitted = null;
    clearTimeout(submitTimer);
    for (const record of records) record.button?.deref()?.remove();
    for (const button of document.querySelectorAll('[data-voyager-return-native]')) button.remove();
    records.length = 0;
    actionObserver.disconnect(); observingActions = false;
    userIds = new WeakMap();
    cancelAnimationFrame(selectionFrame); selectionFrame = 0;
    cancelAnimationFrame(actionFrame); actionFrame = 0;
  }

  function changedRoute() {
    if (route === location.pathname) return false;
    // Pending writes were dispatched when the relation changed; never write the
    // previous chat's records under the new URL during navigation.
    route = location.pathname; reset();loadRecords(); return true;
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
    const live = anchor.node?.deref();
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
    clearTimeout(settleTimer);
    // Only while a click is in flight. This also detects native scroll corrections
    // and CSS/layout-only changes that do not produce transcript mutations.
    settleTimer = setTimeout(queueRestore,100);
    const record = pending, anchor = record.anchor, root = scope();
    if (!root) return;
    if (chatKey(root) !== anchor.key) {reset();return;}
    const message = locateMessage(anchor, root);
    if (!message) return;
    let range = settling.range;
    // Retain a Range only for this bounded jump, never in saved return records.
    if (!range || !message.contains(range.startContainer) || !message.contains(range.endContainer) || range.toString() !== anchor.quote) {
      const offset = findOffset(message, anchor);
      if (offset < 0) return;
      range = rangeAt(message, offset, anchor.quote.length);
    }
    if (!range) return;
    const scroll = scroller(root), view = metrics(scroll);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const now = performance.now();
    if (settling.firstMatch === null) settling.firstMatch = now;
    const desired = Math.min(anchor.viewportOffset, scroll.clientHeight * .55);
    const target = Math.max(0,Math.min(scroll.scrollHeight-scroll.clientHeight,
      scroll.scrollTop + (rect.top - view.top) / view.scale - desired));
    if (Math.abs(scroll.scrollTop-target) > 2) {
      settling.lastCorrection=now;
      scroll.scrollTo({top:target,behavior:'instant'});
    }
    if (settling.range !== range && CSS.highlights && typeof Highlight !== 'undefined') {
      CSS.highlights.set('chatgpt-voyager-origin', new Highlight(range));
    }
    settling.range=range;
    const after = range.getBoundingClientRect();
    settling.visible=after.bottom>view.top && after.top<view.top+scroll.clientHeight*view.scale;
    // The first successful scroll is provisional: virtual-list measurements,
    // focus restoration and formula/image layout can move it on later frames.
    if (settling.visible && now-settling.firstMatch>=1000 && now-settling.lastCorrection>=250) finishRestore(record,true);
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
    settling={range:null,firstMatch:null,lastCorrection:performance.now(),visible:false};
    restoreObserver.observe(root, {childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:[...ATTRS,'style','class','hidden']});
    expiry = setTimeout(()=>{
      // Never claim success merely because scrollTo() was called.
      const scroll=scroller(root),view=metrics(scroll),rect=settling?.range?.getBoundingClientRect();
      finishRestore(record,Boolean(rect?.height && root.contains(settling.range.startContainer) &&
        settling.range.toString()===anchor.quote && rect.bottom>view.top && rect.top<view.top+scroll.clientHeight*view.scale));
    },5000);
    tryRestore();
    // Approximate scroll only requests remounting; highlighting requires an exact match.
    if (settling?.firstMatch === null) {
      const scroll = scroller(root);
      scroll.scrollTo({top:Math.max(0,anchor.top-Math.min(anchor.viewportOffset,scroll.clientHeight*.55)),behavior:'instant'});
    }
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
  const interrupt = () => {if (pending) {stopRestore();clearFlash();refreshButtons();}};
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
  window.addEventListener('pageshow',event => {
    disposed=false;hidden=document.hidden;
    if (!changedRoute() && event.persisted) loadRecords();
    watchActions();queueActions();
  });
  document.documentElement.append(host);
  loadRecords();
})();
