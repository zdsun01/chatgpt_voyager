const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const storageWorker = require('./helpers/storage-worker.cjs');

(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const worker=storageWorker(),errors=[];
  const script=path.join(__dirname,'../extension/return-origin.js');
  let savedMarkup='',delayChat=null,releaseRead;
  const connect=async page=>{
    page.on('pageerror',e=>errors.push(e.message));
    await page.exposeBinding('storageBridge',async(_,message)=>{
      const response=await worker.request(message);
      if(message.type==='voyager:return:load' && message.chat===delayChat){
        delayChat=null;await new Promise(resolve=>{releaseRead=resolve;});
      }
      return response;
    });
    await page.addInitScript(()=>{
      window.chrome.runtime={sendMessage:message=>window.storageBridge(message)};
    });
    await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:`
      <meta charset="utf-8"><style>body{font:16px system-ui}#transcript{height:450px;overflow:auto}
      article{min-height:500px}button{min-height:32px}#ask{position:fixed;top:0;right:0}</style>
      <main><div id="transcript" data-chatgpt-conversation-selection-target="saved">${savedMarkup}</div></main>
      <button id="ask">向 ChatGPT 提问</button><div data-composer-body><div id="quote"></div>
      <div data-composer-markdown contenteditable="true"></div><button aria-label="发送">Send</button></div>`}));
  };
  const setup=async page=>{
    await page.evaluate(()=>{
      window.makeTurn=(id,prompt)=>{
        const el=document.createElement('article');el.dataset.turnKey=`turn-${id}`;
        el.innerHTML=`<div data-chatgpt-search-message-ids="user-${id}"><div data-user-message-bubble></div></div>
          <section data-chatgpt-search-message-ids="answer-${id} answer-${id}" data-content-search-unit-key="fallback-${id}:assistant"><p>Introduction ${id}</p><p id="source-${id}">Quoted passage from ${id}</p></section>
          <div class="actions"><button aria-label="重新生成回复">retry</button><button aria-label="更多操作">more</button></div>`;
        el.querySelector('[data-user-message-bubble]').textContent=prompt;return el;
      };
      if(!document.querySelector('article'))document.querySelector('#transcript').append(makeTurn('A','initial'));
      document.querySelector('#ask').addEventListener('click',()=>{
        document.querySelector('#quote').textContent=getSelection().toString();getSelection().removeAllRanges();
      });
      document.querySelector('[aria-label="发送"]').addEventListener('click',()=>{
        const editor=document.querySelector('[data-composer-markdown]');
        const turn=makeTurn(window.nextId,editor.textContent);
        editor.textContent='';document.querySelector('#quote').textContent='';
        document.querySelector('#transcript').append(turn);
      });
    });
    await page.addScriptTag({path:script});
  };
  const assertLink=async(page,to,from)=>{
    const arrow=page.locator(`[data-turn-key="turn-${to}"] [data-voyager-return]`);
    await arrow.waitFor();assert.equal(await arrow.count(),1);await arrow.click();
    assert.equal(await page.evaluate(()=>[...(CSS.highlights.get('chatgpt-voyager-origin')||[])][0]?.startContainer.parentElement.closest('[data-turn-key]')?.dataset.turnKey),`turn-${from}`);
  };
  const ask=async(page,from,to)=>{
    await page.evaluate(({from,to})=>{
      const range=document.createRange();range.selectNodeContents(document.querySelector(`#source-${from}`));
      getSelection().removeAllRanges();getSelection().addRange(range);window.nextId=to;
    },{from,to});
    await page.locator('#ask').click();await page.locator('[data-composer-markdown]').fill(`question ${to}`);
    await page.getByRole('button',{name:'发送',exact:true}).click();await assertLink(page,to,from);
  };
  try {
    let page=await browser.newPage();await connect(page);await page.goto('https://chatgpt.com/c/saved');await setup(page);
    await ask(page,'A','B');await ask(page,'A','C');await ask(page,'B','D');
    await page.waitForTimeout(120);
    const stored=worker.data['voyager-return-v1'];assert.equal(stored.chats['/c/saved'].records.length,3);
    assert.ok(!JSON.stringify(stored).includes('question B'),'full prompts must not be stored');
    savedMarkup=await page.evaluate(()=>{
      const copy=document.querySelector('#transcript').cloneNode(true);copy.querySelectorAll('[data-voyager-return]').forEach(e=>e.remove());return copy.innerHTML;
    });
    // Full page reload discards every JS reference while keeping extension storage.
    await page.reload();await setup(page);
    await assertLink(page,'B','A');await assertLink(page,'C','A');await assertLink(page,'D','B');
    // Idle/scroll/hover do not wake the worker to rewrite the same records.
    const writes=worker.counts().sets;
    await page.evaluate(()=>{for(let i=0;i<20;i++)document.querySelector('#transcript').dispatchEvent(new Event('scroll'));});
    await page.waitForTimeout(180);assert.equal(worker.counts().sets,writes);
    // Navigating away removes arrows but preserves disk records; stale async reads cannot leak back.
    delayChat='/c/saved';
    await page.evaluate(()=>history.pushState({},'', '/c/other'));
    await page.waitForTimeout(50);assert.equal(await page.locator('[data-voyager-return]').count(),0);
    await page.evaluate(()=>history.pushState({},'', '/c/saved'));
    await page.waitForTimeout(60);assert.ok(releaseRead);
    await page.evaluate(()=>history.pushState({},'', '/c/other'));
    releaseRead();await page.waitForTimeout(80);assert.equal(await page.locator('[data-voyager-return]').count(),0);
    await page.evaluate(()=>history.pushState({},'', '/g/project/c/saved'));
    await assertLink(page,'B','A');await assertLink(page,'D','B');
    // New tab + restarted worker: sources may be loaded later, independently of the answer.
    await page.close();worker.restart();page=await browser.newPage();await connect(page);
    await page.goto('https://chatgpt.com/c/saved');
    await page.evaluate(()=>{
      window.sourceA=document.querySelector('[data-turn-key="turn-A"]');window.sourceA.remove();
    });
    await setup(page);
    const b=page.locator('[data-turn-key="turn-B"] [data-voyager-return]');await b.waitFor();await b.click();
    await page.evaluate(()=>document.querySelector('#transcript').prepend(window.sourceA));
    await page.waitForFunction(()=>CSS.highlights.has('chatgpt-voyager-origin'));
    await assertLink(page,'B','A');await assertLink(page,'C','A');await assertLink(page,'D','B');
    // Disk failure is contained; newly created session return links still work.
    worker.setFail(true);await ask(page,'C','E');await assertLink(page,'E','C');worker.setFail(false);
    assert.deepEqual(errors,[]);
    console.log(`PASS: refresh; tab close/reopen; worker restart; B→A/C→A/D→B persistence; chat isolation; project URL normalization; delayed storage race; unloaded source; no scroll writes; storage failure. Saved 3-relationship fixture: ${Buffer.byteLength(JSON.stringify(stored))} bytes.`);
    await page.close();
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
