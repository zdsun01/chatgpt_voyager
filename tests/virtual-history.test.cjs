const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://chatgpt.com/**', route => route.fulfill({contentType:'text/html',body:`
      <!doctype html><style>body{margin:0}main{margin:60px;width:700px}
      #scroll{height:400px;overflow:auto}#transcript{position:relative;height:1200px}
      .turn{position:absolute;height:100px;width:600px}</style>
      <div data-app-shell-active-page="true"><main><div id="scroll" data-app-action-timeline-scroll>
      <div id="transcript" data-chatgpt-conversation-selection-target="history"></div></div></main></div>`}));
    await page.goto('https://chatgpt.com/c/history');
    await page.evaluate(() => {
      window.total = 12;
      window.mount = (start,end) => {
        const fragment = document.createDocumentFragment();
        for (let i=start;i<=end;i++) {
          const turn = document.createElement('div');
          turn.className='turn'; turn.style.top=`${i*100}px`;
          turn.dataset.turnKey=`id-${i}`;
          turn.dataset.chatgptSearchMessageIds=`id-${i}`;
          turn.dataset.contentSearchUnitKey=`fallback-turn-${i}:0:user`;
          const q = document.createElement('div');
          q.setAttribute('data-user-message-bubble','true');
          q.textContent = i===5||i===6 ? '重复的提问' : `question ${i}`;
          turn.append(q); fragment.append(turn);
        }
        document.getElementById('transcript').replaceChildren(fragment);
      };
      window.mount(8,11);
      document.getElementById('scroll').scrollTop=800;
      document.getElementById('scroll').addEventListener('scroll', () => {
        if (!window.virtualizeOnScroll) return;
        const start=Math.floor(document.getElementById('scroll').scrollTop/100);
        window.mount(start,Math.min(window.total-1,start+4));
      });
    });
    await page.addScriptTag({path:path.join(__dirname,'../extension/content.js')});
    const host=page.locator('#chatgpt-question-timeline');
    const nodes=host.locator('.node');
    const countIs=n=>page.waitForFunction(count=>document.querySelector('#chatgpt-question-timeline').shadowRoot.querySelectorAll('.node').length===count,n,{timeout:4000});
    await countIs(4);
    await nodes.last().hover(); assert.equal(await host.locator('.text').innerText(),'question 11');

    // Prepend history while virtualizing away newest messages.
    await page.evaluate(()=>{window.mount(4,8);document.getElementById('scroll').scrollTop=400;});
    await countIs(8);
    await nodes.first().hover(); assert.equal(await host.locator('.text').innerText(),'question 4');
    await nodes.last().hover(); assert.equal(await host.locator('.text').innerText(),'question 11');
    assert.equal(await page.locator('[data-turn-key="id-11"]').count(),0);
    await page.evaluate(()=>{window.mount(0,5);document.getElementById('scroll').scrollTop=0;});
    await countIs(12);
    await nodes.first().hover(); assert.equal(await host.locator('.text').innerText(),'question 0');
    await nodes.nth(5).hover(); assert.equal(await host.locator('.text').innerText(),'重复的提问');
    await nodes.nth(6).hover(); assert.equal(await host.locator('.text').innerText(),'重复的提问');

    // An empty mount window is temporary, not a deletion of all cached nodes.
    await page.evaluate(()=>window.mount(0,-1));
    await page.waitForTimeout(180); assert.equal(await nodes.count(),12);
    await nodes.last().hover(); assert.equal(await host.locator('.text').innerText(),'question 11');

    // Click a cached unmounted latest prompt. Scroll causes remount; observer
    // then locates its exact ID and completes the jump without polling.
    await page.evaluate(()=>{window.mount(0,3);window.virtualizeOnScroll=true;});
    await nodes.last().click();
    await page.waitForFunction(()=>!!document.querySelector('[data-turn-key="id-11"]'));
    await page.waitForTimeout(200);
    assert.equal(await nodes.count(),12);
    assert.equal(await nodes.last().getAttribute('aria-current'),'true');
    assert.ok(await page.evaluate(()=>document.getElementById('scroll').scrollTop>=790));

    // Repeat recycling; append a new prompt; neither operation duplicates IDs.
    await page.evaluate(()=>{window.virtualizeOnScroll=false;window.mount(4,8);});
    await page.waitForTimeout(180); assert.equal(await nodes.count(),12);
    await page.evaluate(()=>{
      window.mount(4,8);
      document.querySelectorAll('[data-chatgpt-search-message-ids]').forEach(el=>el.removeAttribute('data-chatgpt-search-message-ids'));
    });
    await page.waitForTimeout(180); assert.equal(await nodes.count(),12);
    await page.evaluate(()=>{window.total=13;document.getElementById('transcript').style.height='1300px';window.mount(9,12);});
    await countIs(13);
    await nodes.first().hover(); assert.equal(await host.locator('.text').innerText(),'question 0');
    await nodes.last().hover(); assert.equal(await host.locator('.text').innerText(),'question 12');
    // Edits update the cached text under the same stable ID.
    await page.evaluate(()=>{document.querySelector('[data-turn-key="id-12"] [data-user-message-bubble]').textContent='edited 12';});
    await page.waitForTimeout(180);
    await nodes.last().hover(); assert.equal(await host.locator('.text').innerText(),'edited 12');
    await page.evaluate(()=>window.mount(0,3));
    await page.waitForTimeout(180);
    await nodes.last().hover(); assert.equal(await host.locator('.text').innerText(),'edited 12');

    // Same-chat backgrounding keeps accumulated history, but navigation clears it.
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
    await countIs(13);
    await page.evaluate(()=>history.pushState({},'', '/c/other'));
    await countIs(0);
    await page.waitForTimeout(180); assert.equal(await nodes.count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: 4→8→12 accumulated nodes; dedup IDs; duplicate text; empty mount; cached preview/jump; append/edit; background retain; cross-chat reset.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
