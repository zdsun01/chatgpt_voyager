const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://chatgpt.com/**', route => route.fulfill({contentType:'text/html', body:'<!doctype html><body></body>'}));
    await page.goto('https://chatgpt.com/g/project/c/b');
    await page.evaluate(() => {
      for (const [id, count] of [['a',4],['b',5],['new',0]]) {
        const shell = document.createElement('div');
        shell.id = id;
        shell.setAttribute('data-app-shell-active-page', String(id === 'b'));
        shell.style.display = id === 'b' ? 'contents' : 'none';
        const main = document.createElement('main');
        main.style.minHeight = '700px';
        const transcript = document.createElement('div');
        if (id !== 'new') transcript.setAttribute('data-chatgpt-conversation-selection-target', id);
        for (let i=0;i<count;i++) {
          const q = document.createElement('div');
          q.setAttribute('data-user-message-bubble','true');
          q.textContent = `${id} question ${i+1}`;
          q.style.cssText = 'height:80px;padding:10px';
          transcript.append(q);
        }
        main.append(transcript); shell.append(main); document.body.append(shell);
      }
      window.activateChat = id => {
        for (const shell of document.querySelectorAll('[data-app-shell-active-page]')) {
          shell.setAttribute('data-app-shell-active-page', String(shell.id === id));
          shell.style.display = shell.id === id ? 'contents' : 'none';
        }
      };
      addEventListener('popstate', () => window.activateChat(location.pathname.split('/').pop()));
    });
    await page.addScriptTag({path:path.join(__dirname,'../extension/content.js')});
    const nodes = page.locator('#chatgpt-question-timeline .node');
    const preview = page.locator('#chatgpt-question-timeline .text');
    const countIs = count => page.waitForFunction(n => document.getElementById('chatgpt-question-timeline').shadowRoot.querySelectorAll('.node').length === n, count, {timeout:4000});
    await countIs(5);
    await nodes.first().hover();
    assert.equal(await preview.innerText(),'b question 1');

    // Route changes before React updates the active page: never expose old text.
    await page.evaluate(() => history.pushState({},'', '/c/a'));
    await countIs(0);
    await page.waitForTimeout(180);
    assert.equal(await nodes.count(),0);
    await page.evaluate(() => window.activateChat('a'));
    await countIs(4);
    await nodes.last().hover();
    assert.equal(await preview.innerText(),'a question 4');

    // Browser back/forward reuses cached DOM instead of inserting messages.
    await page.goBack(); await countIs(5);
    await nodes.first().hover(); assert.equal(await preview.innerText(),'b question 1');
    await page.goForward(); await countIs(4);
    await nodes.first().hover(); assert.equal(await preview.innerText(),'a question 1');

    // Rapid switches, including a project URL, finish with only the latest chat.
    await page.evaluate(() => {
      history.pushState({},'', '/g/project/c/b'); window.activateChat('b');
      history.pushState({},'', '/c/a'); window.activateChat('a');
      history.pushState({},'', '/g/project/c/b'); window.activateChat('b');
    });
    await countIs(5);
    await nodes.last().click();
    assert.equal(await nodes.last().getAttribute('aria-current'),'true');
    await page.evaluate(() => {history.pushState({},'', '/');window.activateChat('new');});
    await countIs(0);
    assert.equal(await page.locator('#chatgpt-question-timeline .preview').isVisible(),false);

    // CSS-only legacy cache hiding; the active conversation ID still governs.
    await page.evaluate(() => {
      history.pushState({},'', '/c/a'); window.activateChat('a');
      document.querySelectorAll('[data-app-shell-active-page]').forEach(el=>el.removeAttribute('data-app-shell-active-page'));
    });
    await countIs(4);
    await page.evaluate(() => {document.getElementById('a').style.display='none';});
    await countIs(0);
    await page.evaluate(() => {document.getElementById('a').style.display='contents';});
    await countIs(4);
    await page.evaluate(() => {history.pushState({},'', '/c/b');document.getElementById('b').style.display='contents';});
    await countIs(5);
    assert.deepEqual(errors,[]);
    console.log('PASS: cached inactive 4 + current 5 => 5; route-before-DOM; back/forward; rapid project-chat switches; new chat; CSS-hidden cache.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
