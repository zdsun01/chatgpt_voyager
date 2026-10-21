const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    for (const nested of [true, false]) {
      const page = await browser.newPage({ viewport:{ width:1280, height:800 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType:'text/html', body:`
        <!doctype html><style>body{margin:0}main{margin:40px;width:700px}
        #scroll{${nested ? 'height:400px;overflow:auto' : ''}}
        article{height:600px} [data-user-message-bubble]{height:40px}
        [data-message-author-role=assistant]{height:560px}</style>
        <div data-app-shell-active-page="true"><main><div id="scroll" ${nested ? 'data-app-action-timeline-scroll' : ''}>
        <div id="transcript" data-chatgpt-conversation-selection-target="reading">
        ${Array.from({length:80}, (_,i) => `<article data-turn-key="q-${i}" data-content-search-unit-key="fallback-turn-${i}:0:user">
          <div data-user-message-bubble>question ${i}</div><div data-message-author-role="assistant">long answer ${i}</div>
        </article>`).join('')}</div></div></main></div>` }));
      await page.goto('https://chatgpt.com/c/reading');
      await page.evaluate(nested => {
        window.chatScroll = nested ? document.getElementById('scroll') : document.scrollingElement;
        window.userScans = 0;
        const original = Element.prototype.querySelectorAll;
        Element.prototype.querySelectorAll = function(selector) {
          if (selector === '[data-message-author-role="user"], [data-user-message-bubble]') window.userScans++;
          return original.call(this, selector);
        };
      }, nested);
      await page.addScriptTag({path:path.join(__dirname,'../extension/content.js')});
      const currentIs = index => page.waitForFunction(index => {
        const shadow = document.getElementById('chatgpt-question-timeline').shadowRoot;
        const active = shadow.querySelectorAll('[aria-current="true"]');
        return active.length === 1 && Number(active[0].dataset.index) === index;
      }, index, {timeout:4000});
      const scrollTo = top => page.evaluate(top => window.chatScroll.scrollTo({top, behavior:'instant'}), top);
      await currentIs(0);
      await page.waitForTimeout(200);
      const scans = await page.evaluate(() => window.userScans);
      await scrollTo(650); await currentIs(1);
      // Reading farther through the same assistant answer retains the prompt marker.
      await scrollTo(750); await currentIs(1);
      await scrollTo(1250); await currentIs(2);
      await scrollTo(0); await currentIs(0);
      assert.equal(await page.evaluate(() => window.userScans), scans, 'scroll must not scan prompts');

      // Removing only the prompt DOM must not lose the marker while reading its answer.
      await page.evaluate(() => {
        const prompt = document.querySelector('[data-turn-key="q-1"] [data-user-message-bubble]');
        const spacer = document.createElement('div'); spacer.style.height='40px'; prompt.replaceWith(spacer);
      });
      await page.waitForTimeout(200);
      await scrollTo(650); await currentIs(1);

      // At the end, the rail reveals the current marker without creating 80 buttons.
      await scrollTo(1000000); await currentIs(79);
      const state = await page.evaluate(() => {
        const shadow = document.getElementById('chatgpt-question-timeline').shadowRoot;
        const marker = shadow.querySelector('[aria-current="true"]').getBoundingClientRect();
        const rail = shadow.querySelector('.viewport').getBoundingClientRect();
        return {count:shadow.querySelectorAll('.node').length, visible:marker.top>=rail.top && marker.bottom<=rail.bottom};
      });
      assert.ok(state.count < 40); assert.equal(state.visible, true);
      await scrollTo(0); await currentIs(0);

      // Background suspension and restoration rebind the scroll listener.
      await page.evaluate(() => {
        Object.defineProperty(document,'hidden',{value:true,configurable:true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await scrollTo(1250);
      await page.evaluate(() => {
        Object.defineProperty(document,'hidden',{value:false,configurable:true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await currentIs(2);
      // A route change immediately clears the old selected marker.
      await page.evaluate(() => history.pushState({},'', '/c/other'));
      await page.waitForFunction(() => !document.getElementById('chatgpt-question-timeline').shadowRoot.querySelector('[aria-current="true"]'));
      await scrollTo(650);
      await page.waitForTimeout(200);
      assert.equal(await page.locator('#chatgpt-question-timeline .node').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: nested/document scroll selection; long answers; reverse scroll; cached prompt; bounded rail reveal; zero scroll scans; resume; navigation cleanup.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
