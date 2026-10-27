const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1100,height:750}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:`
      <meta charset="utf-8"><style>body{font:16px system-ui}#transcript{height:450px;overflow:auto}
      article{min-height:500px}button{min-height:32px}#ask{position:fixed;top:0;right:0}</style>
      <main><div id="transcript" data-chatgpt-conversation-selection-target="branches"></div></main>
      <button id="ask">向 ChatGPT 提问</button><div data-composer-body><div id="quote"></div>
      <div data-composer-markdown contenteditable="true"></div><button aria-label="发送">Send</button></div>`}));
    await page.goto('https://chatgpt.com/c/branches');
    await page.evaluate(()=>{
      window.makeTurn=(id,prompt)=>{
        const el=document.createElement('article');el.dataset.turnKey=`turn-${id}`;
        el.innerHTML=`<div data-chatgpt-search-message-ids="user-${id}"><div data-content-search-unit-key="fallback-turn-${id}:0:user"><div data-user-message-bubble>${prompt}</div></div></div>
          <section data-content-search-unit-key="fallback-turn-${id}:2:assistant" data-chatgpt-search-message-ids="answer-${id} answer-${id}"><p>Answer ${id}</p><p id="source-${id}">Quoted passage from ${id}</p></section>
          <div class="actions"><button aria-label="复制">copy</button><button aria-label="重新生成回复">retry</button><button aria-label="更多操作">more</button></div>`;
        return el;
      };
      document.querySelector('#transcript').append(makeTurn('A','initial'));
      document.querySelector('#ask').addEventListener('click',()=>{
        document.querySelector('#quote').textContent=getSelection().toString();getSelection().removeAllRanges();
      });
      window.nextId='B';window.restoreBeforeSend=null;window.delayedText=false;
      document.querySelector('[aria-label="发送"]').addEventListener('click',()=>{
        const id=window.nextId,editor=document.querySelector('[data-composer-markdown]'),prompt=editor.textContent;
        editor.textContent='';document.querySelector('#quote').textContent='';
        // ChatGPT first remounts old turns while moving to the bottom, then appends the new question.
        if(window.restoreBeforeSend){document.querySelector('#transcript').append(window.restoreBeforeSend);window.restoreBeforeSend=null;}
        setTimeout(()=>{
          const turn=makeTurn(id,window.delayedText ? '' : prompt);document.querySelector('#transcript').append(turn);
          if(window.delayedText)setTimeout(()=>turn.querySelector('[data-user-message-bubble]').textContent=prompt,60);
        },160);
      });
    });
    await page.addScriptTag({path:path.join(__dirname,'../extension/return-origin.js')});
    const arrows=id=>page.locator(`[data-turn-key="turn-${id}"] [data-voyager-return]`);
    const ask=async(source,target,prompt=`question ${target}`)=>{
      await page.evaluate(({source,target})=>{
        const range=document.createRange();range.selectNodeContents(document.querySelector(`#source-${source}`));
        getSelection().removeAllRanges();getSelection().addRange(range);window.nextId=target;
      },{source,target});
      await page.locator('#ask').click();
      await page.locator('[data-composer-markdown]').fill(prompt);
    };
    const send=async()=>{await page.getByRole('button',{name:'发送',exact:true}).click();await page.waitForTimeout(320);};
    const assertLink=async(target,source)=>{
      assert.equal(await arrows(target).count(),1,`${target} must have exactly one return arrow`);
      await arrows(target).click();
      assert.equal(await page.evaluate(()=>{
        const range=[...(CSS.highlights.get('chatgpt-voyager-origin')||[])][0];
        return range?.startContainer.parentElement.closest('[data-turn-key]')?.getAttribute('data-turn-key');
      }),`turn-${source}`,`${target} must return to ${source}`);
    };
    await ask('A','B');await send();await assertLink('B','A');
    // Reproduce the reported pair of symptoms: two arrows on B, none on C.
    await page.evaluate(()=>{window.restoreBeforeSend=document.querySelector('[data-turn-key="turn-B"]');window.restoreBeforeSend.remove();});
    await ask('A','C');await send();
    await assertLink('B','A');await assertLink('C','A');
    await ask('B','D');await send();
    await assertLink('D','B');await assertLink('B','A');await assertLink('C','A');
    assert.equal(await arrows('A').count(),0);
    // A repeated prompt cannot hijack an earlier linked turn when it remounts.
    await page.evaluate(()=>{window.restoreBeforeSend=document.querySelector('[data-turn-key="turn-B"]');window.restoreBeforeSend.remove();});
    await ask('A','E','question B');await send();await assertLink('E','A');await assertLink('B','A');
    // A never-seen historical turn with a different prompt is not the submitted question.
    await page.evaluate(()=>{window.restoreBeforeSend=makeTurn('old','unrelated history');window.delayedText=true;});
    await ask('C','F');await send();await assertLink('F','C');assert.equal(await arrows('old').count(),0);
    // Identity attributes may arrive later; a detached/rebuilt toolbar still gets one arrow.
    await page.evaluate(()=>{
      const turn=document.querySelector('[data-turn-key="turn-F"]');
      turn.querySelector('[data-user-message-bubble]').setAttribute('data-message-id','server-user-F');
      const actions=turn.querySelector('.actions');actions.querySelector('[data-voyager-return]').remove();
      actions.replaceWith(actions.cloneNode(true));
    });
    await page.waitForTimeout(80);await assertLink('F','C');
    for(const id of ['B','C','D','E','F'])assert.equal(await arrows(id).count(),1);
    assert.deepEqual(errors,[]);
    await page.close();
    console.log('PASS: B→A, C→A, D→B; one arrow per answer; historical remount before new send; repeated prompts; delayed user text; late IDs; toolbar replacement.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
