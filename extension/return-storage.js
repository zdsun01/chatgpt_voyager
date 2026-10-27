// Event-driven MV3 worker. No timers, polling, network requests or permanent chat cache.
(() => {
  'use strict';
  const KEY = 'voyager-return-v1';
  const MAX_CHATS = 50, MAX_RECORDS = 20, MAX_BYTES = 512 * 1024;
  const encoder = new TextEncoder();
  let queue = Promise.resolve();
  const bounded = (value, max) => typeof value === 'string' && value.length <= max;
  const number = value => Number.isFinite(value) && value >= 0 && value <= 1e10;

  function identity(value) {
    if (!value || !['data-message-id','data-chatgpt-search-message-ids','data-turn-key'].includes(value.attr) ||
      !bounded(value.value,512) || !value.value || /^(?:fallback-|local:)/.test(value.value) ||
      !Number.isInteger(value.part) || value.part < 0 || value.part > 100) return null;
    return {attr:value.attr,value:value.value,part:value.part};
  }

  function clean(record) {
    const a = record?.anchor, id = identity(a?.id);
    if (!id || !bounded(record.userKey,600) ||
      !/^data-(?:turn-key|message-id|chatgpt-search-message-ids):.+/.test(record.userKey) ||
      /:(?:fallback-|local:)/.test(record.userKey) || !bounded(record.prompt,80) ||
      !/^\d+:\d+:\d+$/.test(record.prompt) || !Number.isSafeInteger(record.at) || record.at < 0 ||
      !bounded(a.quote,160) || !a.quote.trim() || !bounded(a.prefix,40) || !bounded(a.suffix,40) ||
      !Number.isSafeInteger(a.start) || !number(a.start) || !number(a.top) || !number(a.viewportOffset)) return null;
    return {userKey:record.userKey,prompt:record.prompt,at:record.at,
      target:identity(record.target),
      anchor:{id,start:a.start,quote:a.quote,prefix:a.prefix,suffix:a.suffix,top:a.top,viewportOffset:a.viewportOffset}};
  }

  function records(values) {
    const unique = new Map();
    for (const value of Array.isArray(values) ? values.slice(-MAX_RECORDS) : []) {
      const record = clean(value);
      if (record) unique.set(record.userKey,record);
    }
    return [...unique.values()];
  }

  async function handle(message) {
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    const state = {schema:1,chats:{}};
    // Bound and sanitize persisted input before returning any records to a page.
    if (stored?.schema === 1 && stored.chats && typeof stored.chats === 'object') {
      for (const [key,chat] of Object.entries(stored.chats).slice(-MAX_CHATS)) {
        if (/^\/c\/[\w-]{1,160}$/.test(key) && Number.isFinite(chat?.at)) {
          state.chats[key] = {at:chat.at,records:records(chat.records)};
        }
      }
    }
    const old = state.chats[message.chat];
    if (message.type === 'voyager:return:load') return {ok:true,records:old?.records || []};
    const incoming = records(message.records);
    if (!incoming.length) return {ok:true};
    const merged = new Map((old?.records || []).map(record => [record.userKey,record]));
    for (const record of incoming) {
      const existing = merged.get(record.userKey);
      // A response's origin is immutable, including when another tab saves it.
      merged.set(record.userKey,existing ? {...existing,target:record.target || existing.target} : record);
    }
    state.chats[message.chat] = {at:Date.now(),records:[...merged.values()].sort((a,b)=>a.at-b.at).slice(-MAX_RECORDS)};
    const oldest = Object.keys(state.chats).sort((a,b)=>state.chats[a].at-state.chats[b].at);
    while (oldest.length > MAX_CHATS || encoder.encode(JSON.stringify(state)).length + KEY.length > MAX_BYTES) {
      delete state.chats[oldest.shift()];
    }
    await chrome.storage.local.set({[KEY]:state});
    return {ok:true};
  }

  chrome.runtime.onMessage.addListener((message,sender,reply) => {
    if (!['voyager:return:load','voyager:return:save'].includes(message?.type)) return;
    let url;
    try {url = new URL(sender.url);} catch {return;}
    if (sender.id !== chrome.runtime.id || url.protocol !== 'https:' ||
      !['chatgpt.com','chat.openai.com'].includes(url.hostname) ||
      !/^\/c\/[\w-]{1,160}$/.test(message.chat)) return;
    // Serialize read/merge/write across tabs. Rejection must not poison the queue.
    queue = queue.then(()=>handle(message)).then(reply,()=>reply({ok:false}));
    return true;
  });
})();
