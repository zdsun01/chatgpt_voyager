const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    for (const nested of [true,false]) {
      const page = await browser.newPage({viewport:{width:1280,height:800}});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://chatgpt.com/**', route => route.fulfill({contentType:'text/html',body:`
        <!doctype html><meta charset="utf-8"><style>
        body{margin:0;font:16px/1.6 system-ui}main{width:700px;margin:50px auto}
        #scroll{${nested ? 'height:500px;overflow:auto' : ''}} article{height:1100px}
        p{margin:30px 0}#ask,#other{position:fixed;top:4px;left:20px}#other{left:240px}
        #prompt-textarea{height:60px}form{position:fixed;bottom:10px;left:250px;width:700px;background:#eee}
        </style><div data-app-shell-active-page="true"><main><div id="scroll" ${nested ? 'data-app-action-timeline-scroll' : ''}>
        <div id="transcript" data-chatgpt-conversation-selection-target="reading">
        ${[0,1,2].map(i => `<article data-turn-key="turn-${i}"><div data-user-message-bubble>question ${i}</div>
          <section data-content-search-unit-key="fallback-turn-${i}:0:assistant" data-message-id="answer-${i}">
          <div data-message-author-role="assistant"><p>Introduction ${i}</p><p id="quote-${i}">Before ${i}: <strong>Rubric Prompt</strong> means scoring criteria ${i}.</p>
          <p>More explanation ${i}</p></div></section></article>`).join('')}
        </div></div></main></div><button id="ask">向 ChatGPT 提问</button><button id="other">复制</button>
        <form><div id="prompt-textarea" contenteditable="true"></div></form>`}));
      await page.goto('https://chatgpt.com/c/reading');
      await page.evaluate(nested => {
        window.chatScroll = nested ? document.getElementById('scroll') : document.scrollingElement;
        window.choose = (selector, whole=false) => {
          const el = document.querySelector(selector);
          const range = document.createRange();
          if (whole) range.selectNodeContents(el);
          else { range.setStart(el.firstChild,0); range.setEnd(el.firstChild,el.firstChild.length); }
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        };
        // The native action clears selection before click, then jumps to the composer.
        document.querySelector('#ask').addEventListener('pointerdown', () => getSelection().removeAllRanges());
        document.querySelector('#ask').addEventListener('click', () => window.chatScroll.scrollTo({top:100000,behavior:'instant'}));
      }, nested);
      const script = path.join(__dirname,'../extension/return-origin.js');
      await page.addScriptTag({path:path.join(__dirname,'../extension/content.js')});
      await page.addScriptTag({path:script});
      const host = page.locator('#chatgpt-voyager-return');
      const back = host.locator('.back');
      const ask = async (i, whole=false) => {
        await page.evaluate(({i,whole}) => {
          document.querySelector(`#quote-${i}`).scrollIntoView({block:'center'});
          window.choose(`#quote-${i}${whole ? '' : ' strong'}`,whole);
        }, {i,whole});
        await page.locator('#ask').click();
        assert.equal(await back.isVisible(),true);
      };
      const returned = async i => {
        await back.click();
        await page.waitForFunction(i => {
          const ranges = [...(CSS.highlights.get('chatgpt-voyager-origin') || [])];
          return ranges.length === 1 && ranges[0].startContainer.parentElement.closest('section').dataset.messageId === `answer-${i}`;
        },i,{timeout:7000}).catch(async error => {
          console.error({nested, i, state:await page.evaluate(() => ({
            scroll:window.chatScroll.scrollTop,
            answer:!!document.querySelector('[data-message-id="answer-0"]'),
            panel:document.getElementById('chatgpt-voyager-return').shadowRoot.querySelector('.panel').textContent,
            highlighted:[...(CSS.highlights.get('chatgpt-voyager-origin') || [])].map(range=>range.toString())
          })), errors});
          throw error;
        });
        assert.ok(await page.evaluate(i => {
          const rect = document.querySelector(`#quote-${i}`).getBoundingClientRect();
          const s = window.chatScroll === document.scrollingElement ? {top:0,bottom:innerHeight} : window.chatScroll.getBoundingClientRect();
          return rect.bottom > s.top && rect.top < s.bottom;
        },i));
      };
      assert.equal(await back.isVisible(),false);
      await ask(0);
      // Reflow above the quote and a growing later answer must not move the return target.
      await page.evaluate(() => {
        document.querySelector('#quote-0').previousElementSibling.style.height='180px';
        document.querySelector('article:last-child').style.height='1800px';
        document.querySelector('[data-message-id="answer-0"]').prepend(document.createTextNode('New introductory text added before the original response. '));
      });
      await returned(0); assert.equal(await back.isVisible(),false);

      // Stack of follow-ups; keyboard activation; element and inline text boundaries.
      await ask(0,true);
      await ask(1);
      await returned(1); assert.equal(await back.isVisible(),true);
      await returned(0); assert.equal(await back.isVisible(),false);
      await page.evaluate(() => {window.choose('#quote-1 strong'); document.querySelector('#ask').textContent='Ask ChatGPT';});
      await page.locator('#ask').focus(); await page.keyboard.press('Enter');
      await returned(1);

      // No entry for user prompts, input text, copying, or a canceled Ask click.
      await page.evaluate(() => window.choose('[data-user-message-bubble]'));
      await page.locator('#ask').click(); assert.equal(await back.isVisible(),false);
      await page.evaluate(() => {document.querySelector('#prompt-textarea').textContent='my draft';window.choose('#prompt-textarea');});
      await page.locator('#ask').click(); assert.equal(await back.isVisible(),false);
      await page.evaluate(() => window.choose('#quote-0 strong'));
      await page.locator('#other').click(); assert.equal(await back.isVisible(),false);
      await page.evaluate(() => {window.choose('#quote-0 strong');document.querySelector('#ask').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));});
      assert.equal(await back.isVisible(),false);

      // Unmount the answer; scrolling requests a new DOM copy with the same identity.
      await ask(0);
      await page.evaluate(() => {
        const answer = document.querySelector('[data-message-id="answer-0"]');
        window.answerHTML = answer.outerHTML;
        answer.remove();
        const target = window.chatScroll === document.scrollingElement ? document : window.chatScroll;
        const remount = () => {
          if (window.chatScroll.scrollTop < 500 && !document.querySelector('[data-message-id="answer-0"]')) {
            target.removeEventListener('scroll',remount);
            setTimeout(() => document.querySelector('article').insertAdjacentHTML('beforeend',window.answerHTML),60);
          }
        };
        target.addEventListener('scroll',remount);
      });
      await returned(0); assert.equal(await back.isVisible(),false);

      // Do not silently return to identical text in another answer when the source is absent.
      if (nested) {
        await ask(1);
        await page.evaluate(() => {
          const answer = document.querySelector('[data-message-id="answer-1"]');
          window.missingAnswerHTML = answer.outerHTML;
          answer.remove();
        });
        await back.click();
        await page.waitForFunction(() => {
          const shadow = document.querySelector('#chatgpt-voyager-return').shadowRoot;
          return !shadow.querySelector('.status').hidden && !shadow.querySelector('.back').disabled;
        },null,{timeout:7000});
        assert.equal(await back.isVisible(),true);
        assert.equal(await page.evaluate(() => CSS.highlights.has('chatgpt-voyager-origin')),false);
        // The kept entry can be retried once the original identity is mounted again.
        await page.evaluate(() => document.querySelector('article:nth-child(2)').insertAdjacentHTML('beforeend',window.missingAnswerHTML));
        await returned(1);
      }

      // Same-chat backgrounding preserves the stack, but navigation clears it.
      await ask(1);
      await page.evaluate(() => {Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
      assert.equal(await back.isVisible(),false);
      await page.evaluate(() => {Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
      assert.equal(await back.isVisible(),true);
      await returned(1);
      await ask(0);
      await page.evaluate(() => history.pushState({},'', '/c/other'));
      assert.equal(await back.isVisible(),false);
      assert.equal(await page.evaluate(() => CSS.highlights.has('chatgpt-voyager-origin')),false);
      await page.evaluate(() => history.replaceState({},'', '/c/reading'));
      await ask(0);
      await host.locator('.clear').click(); assert.equal(await back.isVisible(),false);
      // Bounded history: alternating follow-ups keep the latest 20 return locations.
      if (nested) {
        for (let i=0;i<22;i++) await ask(i%2);
        for (let i=21;i>=2;i--) await returned(i%2);
        assert.equal(await back.isVisible(),false);
        // Save a screenshot with a live return button for visual inspection.
        await ask(0);
        await page.screenshot({path:path.join(__dirname,'../test-results/return-origin.png')});
        await host.locator('.clear').click();
      }
      await page.addScriptTag({path:script}); assert.equal(await host.count(),1);
      assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log('PASS: return to selected text; nested/document scrolling; reflow; growing answer; nested follow-ups; keyboard; exclusion of user/editor/copy; remount; background; route isolation; clear; duplicate injection.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
