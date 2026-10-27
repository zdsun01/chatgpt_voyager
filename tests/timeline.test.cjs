const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, {service_worker:'return-storage.js'});
  assert.deepEqual(manifest.permissions, ['storage']);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width:1280, height:800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType:'text/html', body:`
      <!doctype html><html><head><meta charset="utf-8"><style>
      body{font:16px system-ui;background:#f9faf9;color:#27332d;margin:0}
      main{max-width:720px;margin:auto;padding:60px 70px}
      article{margin:36px 0;padding:20px;border-radius:16px;background:white}
      [data-message-author-role=user]{background:#e9f3ee}
      </style></head><body><main><h1>ChatGPT 提问时间线 · 本地演示</h1>
      <article data-message-author-role="user"><div class="whitespace-pre-wrap">如何设计一个轻量的 Chrome 插件？</div></article>
      <article data-message-author-role="assistant">这是模型的回答，不应该出现在时间线上。</article>
      <article data-message-author-role="user"><div class="whitespace-pre-wrap">长对话里怎样减少内存占用？\n希望悬停预览，点击跳转。</div></article>
      <article data-message-author-role="assistant">这是另一条模型回答。</article>
      </main></body></html>` }));
    await page.goto('https://chatgpt.com/c/test');
    await page.evaluate(() => {
      window.userScans = 0;
      const original = Element.prototype.querySelectorAll;
      Element.prototype.querySelectorAll = function(selector) {
        if (selector === '[data-message-author-role="user"], [data-user-message-bubble]') window.userScans++;
        return original.call(this, selector);
      };
    });
    const source = path.join(__dirname, '../extension/content.js');
    await page.addScriptTag({ path:source });
    const host = page.locator('#chatgpt-question-timeline');
    const nodes = host.locator('.node');
    await page.waitForFunction(() => document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelectorAll('.node').length === 2);
    assert.equal(await nodes.count(), 2);
    // Align to the actual toolbar Share button, not message action buttons.
    await page.evaluate(() => {
      const header = document.createElement('header');
      header.style.cssText = 'position:fixed;top:10px;right:16px';
      header.innerHTML = '<button aria-label="分享" style="height:45px">分享</button>';
      document.body.prepend(header);
      const decoy = document.createElement('button');
      decoy.setAttribute('aria-label', '分享');
      decoy.style.cssText = 'position:fixed;right:0;top:200px';
      decoy.id = 'message-share';
      document.querySelector('main').append(decoy);
    });
    const aligned = () => {
      const rail = document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelector('.rail');
      const share = document.querySelector('header button');
      return Math.abs(rail.getBoundingClientRect().top - share.getBoundingClientRect().bottom - 3) < 0.1;
    };
    await page.waitForFunction(aligned);
    await page.evaluate(() => { document.querySelector('header button').style.height = '57.5px'; });
    await page.waitForFunction(aligned);
    await page.setViewportSize({ width:1100, height:700 });
    await page.waitForFunction(aligned);
    await page.evaluate(() => { document.querySelector('header').remove(); document.querySelector('#message-share').remove(); });
    await page.waitForFunction(() => document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelector('.rail').getBoundingClientRect().top === 36);
    await page.setViewportSize({ width:1280, height:800 });
    await nodes.nth(1).hover();
    assert.match(await host.locator('.text').innerText(), /长对话/);
    assert.doesNotMatch(await host.locator('.text').innerText(), /模型回答/);
    fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive:true });
    await page.screenshot({ path:path.join(__dirname, '../test-results/preview.png') });

    // Assistant token replacement must not trigger a conversation rescan.
    const before = await page.evaluate(() => window.userScans);
    await page.evaluate(async () => {
      const answer = document.querySelector('[data-message-author-role=assistant]');
      for (let i = 0; i < 100; i++) {
        answer.textContent = `streaming token ${i}`;
        answer.setAttribute('aria-hidden', String(i % 2 === 0));
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.userScans), before);
    await nodes.first().click();
    assert.equal(await nodes.first().getAttribute('aria-current'), 'true');
    assert.equal(await host.locator('.preview').isVisible(), false);

    // Dynamic insertion, plain text rendering, and removal.
    await page.evaluate(() => {
      const message = document.createElement('article');
      message.dataset.messageAuthorRole = 'user';
      message.textContent = '<img src=x onerror=alert(1)> 只是提问文本';
      document.querySelector('main').append(message);
    });
    await page.waitForFunction(() => document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelectorAll('.node').length === 3);
    await nodes.last().hover();
    assert.match(await host.locator('.text').innerText(), /<img/);
    assert.equal(await host.locator('.text img').count(), 0);
    await page.evaluate(() => document.querySelector('main').lastElementChild.remove());
    await page.waitForFunction(() => document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelectorAll('.node').length === 2);

    // Regression from the real ChatGPT page: no legacy author attributes,
    // new user-bubble markers, and an empty <main> before the chat's <main>.
    await page.evaluate(() => {
      const conversation = document.querySelector('main');
      conversation.id = 'conversation';
      document.body.prepend(document.createElement('main'));
      for (const question of conversation.querySelectorAll('[data-message-author-role=user]')) {
        question.removeAttribute('data-message-author-role');
        question.setAttribute('data-user-message-bubble', 'true');
      }
      for (const answer of conversation.querySelectorAll('[data-message-author-role=assistant]')) {
        answer.removeAttribute('data-message-author-role');
        answer.setAttribute('data-content-search-unit-key', 'fallback-turn-0:2:assistant');
      }
    });
    await page.waitForTimeout(200);
    assert.equal(await nodes.count(), 2);
    assert.equal(await host.locator('.rail').isVisible(), true);
    await nodes.nth(1).hover();
    assert.match(await host.locator('.text').innerText(), /长对话/);
    const modernBefore = await page.evaluate(() => window.userScans);
    await page.evaluate(async () => {
      const answer = document.querySelector('[data-content-search-unit-key$=":assistant"]');
      for (let i = 0; i < 50; i++) {
        answer.textContent = `new-layout streaming ${i}`;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.userScans), modernBefore);

    // Nested old/new markers must represent one question, not two nodes.
    await page.evaluate(() => {
      const question = document.querySelector('[data-user-message-bubble]');
      const legacy = document.createElement('div');
      legacy.dataset.messageAuthorRole = 'user';
      question.before(legacy);
      legacy.append(question);
    });
    await page.waitForTimeout(200);
    assert.equal(await nodes.count(), 2);
    // New bubbles added after loading must be observed, too.
    await page.evaluate(() => {
      const question = document.createElement('div');
      question.setAttribute('data-user-message-bubble', 'true');
      question.textContent = '新版新增提问';
      document.querySelector('#conversation').append(question);
    });
    await page.waitForFunction(() => document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelectorAll('.node').length === 3);
    await nodes.last().hover();
    assert.equal(await host.locator('.text').innerText(), '新版新增提问');
    // Return to a single main for the independent large-conversation fixture.
    await page.evaluate(() => {
      document.querySelector('main').remove();
      document.querySelector('#conversation').lastElementChild.remove();
    });
    await page.waitForFunction(() => document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelectorAll('.node').length === 2);

    // Thousands of prompts must not create thousands of timeline buttons.
    await page.evaluate(() => {
      history.pushState({}, '', '/c/large');
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 2000; i++) {
        const question = document.createElement('article');
        question.dataset.messageAuthorRole = 'user';
        question.textContent = `第 ${i + 1} 个问题`;
        fragment.append(question);
      }
      document.querySelector('main').replaceChildren(fragment);
    });
    await page.waitForFunction(() => document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelector('.items').style.height === '56000px');
    assert.ok(await nodes.count() < 40);
    await nodes.first().focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(50);
    assert.ok(await nodes.count() < 40);
    const last = host.locator('.node[data-index="1999"]');
    await last.hover();
    assert.equal(await host.locator('.text').innerText(), '第 2000 个问题');
    await last.click();
    assert.ok(await page.evaluate(() => {
      const rect = document.querySelector('main').lastElementChild.getBoundingClientRect();
      return rect.top < innerHeight && rect.bottom > 0;
    }));

    // Switching chats and removing all messages clears old references and UI.
    await page.evaluate(() => {
      history.pushState({}, '', '/');
      document.querySelector('main').replaceChildren();
    });
    await page.waitForFunction(() => document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelector('.rail').hidden);
    assert.equal(await nodes.count(), 0);
    await page.addScriptTag({ path:source });
    assert.equal(await page.locator('#chatgpt-question-timeline').count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: legacy and current ChatGPT markup, multiple main regions, nested-marker deduplication, hover, user-only text, streaming in both layouts, click navigation, additions/removals, safe text, 2,000-message virtualization, keyboard, chat switch, duplicate injection.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
