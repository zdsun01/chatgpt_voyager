const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');

(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:`
      <meta charset="utf-8"><main><div data-chatgpt-conversation-selection-target="native"></div></main>`}));
    await page.goto('https://chatgpt.com/c/native');
    await page.evaluate(()=>{
      window.turn=(id,source)=>{
        const article=document.createElement('article');article.dataset.turnKey=id;
        article.innerHTML=`${source?'<button class="native-quote">1 个已选文本片段</button>':''}<div data-user-message-bubble>question ${id}</div>
          <section data-message-author-role="assistant" data-message-id="answer-${id}">Answer ${id}</section>
          <div class="actions"><button aria-label="重新生成回复">retry</button><button aria-label="更多操作">more</button></div>`;
        if(source)article.querySelector('.native-quote').onclick=()=>{document.body.dataset.nativeTarget=source;};
        return article;
      };
      document.querySelector('[data-chatgpt-conversation-selection-target]').append(turn('A'),turn('B','A'),turn('C','A'),turn('D','B'));
    });
    await page.addScriptTag({path:path.join(__dirname,'../extension/return-origin.js')});
    const arrow=id=>page.locator(`[data-turn-key="${id}"] [data-voyager-return]`);
    const check=async(to,from)=>{await arrow(to).waitFor();assert.equal(await arrow(to).count(),1);await arrow(to).click();assert.equal(await page.getAttribute('body','data-native-target'),from);};
    await check('B','A');await check('C','A');await check('D','B');
    assert.equal(await arrow('A').count(),0);
    assert.equal(await arrow('B').evaluate(e=>e.previousElementSibling.getAttribute('aria-label')),'重新生成回复');
    // Re-rendered toolbars and unmounted native references must not leave duplicates.
    await page.evaluate(()=>{
      const turn=document.querySelector('[data-turn-key="C"]');turn.querySelector('.actions').innerHTML='<button aria-label="重新生成回复">retry</button><button aria-label="更多操作">more</button>';
    });
    await check('C','A');
    await page.evaluate(()=>document.querySelector('[data-turn-key="C"] .native-quote').remove());
    await page.waitForTimeout(80);assert.equal(await arrow('C').count(),0);
    // Native fallback appears even if the reference and its label arrive late.
    await page.evaluate(()=>{
      const turn=window.turn('E','A');turn.querySelector('.native-quote').textContent='';document.querySelector('[data-chatgpt-conversation-selection-target]').append(turn);
    });
    await page.waitForTimeout(50);assert.equal(await arrow('E').count(),0);
    await page.evaluate(()=>document.querySelector('[data-turn-key="E"] .native-quote').textContent='1 个已选文本片段');
    await check('E','A');
    // Cross-chat cached content cannot keep a clickable fallback from the old chat.
    await page.evaluate(()=>history.pushState({},'', '/c/other'));
    await page.waitForTimeout(80);assert.equal(await page.locator('[data-voyager-return]').count(),0);
    await page.evaluate(()=>{
      window.chrome.runtime={sendMessage:message=>message.type==='voyager:return:load'
        ? new Promise(resolve=>{window.restoreStored=()=>resolve({ok:true,records:[{
          userKey:'data-turn-key:B',prompt:'9:1:1',at:1,target:{attr:'data-message-id',value:'answer-B',part:0},
          anchor:{id:{attr:'data-message-id',value:'answer-A',part:0},start:0,quote:'Answer A',prefix:'',suffix:'',top:0,viewportOffset:0}
        }]});}) : Promise.resolve({ok:true})};
      history.pushState({},'', '/c/native');
    });
    // A slow disk read may arrive after the native fallback is already rendered.
    await check('B','A');
    await page.evaluate(()=>window.restoreStored());await page.waitForTimeout(80);
    assert.equal(await arrow('B').count(),1);
    assert.equal(await arrow('B').getAttribute('data-voyager-return-native'),null);
    await arrow('B').click();
    assert.equal(await page.evaluate(()=>[...(CSS.highlights.get('chatgpt-voyager-origin')||[])][0]?.toString()),'Answer A');
    assert.deepEqual(errors,[]);await page.close();
    console.log('PASS: existing native quote without stored records; B→A/C→A/D→B; one arrow per answer; toolbar replacement; quote removal; delayed reference label; chat isolation.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
