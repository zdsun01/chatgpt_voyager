const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    for (const {nested,modern} of [{nested:true,modern:false},{nested:false,modern:false},{nested:true,modern:true},{nested:false,modern:true}]) {
      const retryLabel=modern ? '重新生成回复' : '重试';
      const page = await browser.newPage({viewport:{width:1280,height:800}});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://chatgpt.com/**', route => route.fulfill({contentType:'text/html',body:`
        <!doctype html><meta charset="utf-8"><style>
        body{margin:0;font:16px/1.6 system-ui}main{width:700px;margin:50px auto}
        #scroll{${nested ? 'height:500px;overflow:auto' : ''}} article{min-height:650px}
        section{padding:16px 0}p{margin:24px 0}.actions{display:flex;align-items:center;color:#777;gap:8px}
        .actions button{background:transparent;border:0;width:32px;height:32px;color:inherit;font-size:18px}
        #ask{position:fixed;top:4px;left:20px}form{position:fixed;bottom:10px;left:250px;width:700px;background:#f3f3f3;padding:10px}
        #prompt-textarea{height:40px}#quote-card{max-height:45px;overflow:hidden}
        </style><div data-app-shell-active-page="true"><main><div id="scroll" ${nested ? 'data-app-action-timeline-scroll' : ''}>
        <div id="transcript" data-chatgpt-conversation-selection-target="reading"></div></div></main></div>
        <button id="ask">向 ChatGPT 提问</button><form><div id="quote-card"></div><div id="prompt-textarea" contenteditable="true">对的</div>
        <button data-testid="send-button" type="submit">发送</button></form>`}));
      await page.goto('https://chatgpt.com/c/reading');
      if (modern) await page.evaluate(() => {
        const editor=document.querySelector('#prompt-textarea');
        editor.removeAttribute('id');editor.setAttribute('data-composer-markdown','');
        const body=document.createElement('div');body.setAttribute('data-composer-body','');
        const form=document.querySelector('form');body.innerHTML=form.innerHTML;form.replaceWith(body);
        const hidden=document.createElement('div');hidden.hidden=true;hidden.innerHTML='<div id="prompt-textarea" contenteditable="true"></div>';
        document.body.prepend(hidden);
      });
      await page.evaluate(({nested,modern,retryLabel}) => {
        window.chatScroll = nested ? document.getElementById('scroll') : document.scrollingElement;
        window.nextTurn = 3;
        window.answer = i => `<section data-message-id="answer-${i}" data-content-search-unit-key="fallback-turn-${i}:0:assistant"><div data-message-author-role="assistant"><p>Introduction ${i}</p><p id="quote-${i}">Before ${i}: <strong>Rubric Prompt</strong> means scoring criteria ${i}.</p><p>More explanation ${i}</p></div></section>`;
        window.actions = () => '<div class="actions"><button aria-label="复制">▢</button><button aria-label="点赞">♧</button><button aria-label="分享">↑</button><button aria-label="朗读">◖</button><button aria-label="'+retryLabel+'">⟳</button><button aria-label="更多">⋯</button></div>';
        for (let i=0;i<3;i++) document.getElementById('transcript').insertAdjacentHTML('beforeend',`<article data-turn-key="turn-${i}"><div data-message-author-role="user" data-message-id="user-${i}"><div data-user-message-bubble>question ${i}</div></div>${window.answer(i)}${window.actions()}</article>`);
        window.choose = (selector, whole=false) => {
          const el = document.querySelector(selector), range = document.createRange();
          if (whole) range.selectNodeContents(el);
          else {range.setStart(el.firstChild,0);range.setEnd(el.firstChild,el.firstChild.length);}
          const selection = getSelection();selection.removeAllRanges();selection.addRange(range);
        };
        const ask = document.querySelector('#ask');
        ask.addEventListener('pointerdown',() => {window.nativeQuote=getSelection().toString();getSelection().removeAllRanges();});
        ask.addEventListener('click',() => {
          document.querySelector('#quote-card').textContent=window.nativeQuote || getSelection().toString();
          getSelection().removeAllRanges();window.chatScroll.scrollTo({top:100000,behavior:'instant'});
        });
        const submit = event => {
          event.preventDefault();
          const i=window.nextTurn++;
          const prompt=document.querySelector(modern ? '[data-composer-markdown]' : '#prompt-textarea').textContent;
          const quoted=Boolean(document.querySelector('#quote-card').textContent);
          document.querySelector('#quote-card').textContent='';
          const article=document.createElement('article');article.dataset.turnKey=`turn-${i}`;
          article.innerHTML=`${quoted ? '<button>1 个已选文本片段</button>' : ''}<div data-message-author-role="user" data-message-id="user-${i}"><div data-user-message-bubble>follow-up ${i}</div></div>`;
          article.querySelector('[data-user-message-bubble]').textContent=prompt;
          document.getElementById('transcript').append(article);
          setTimeout(() => {article.insertAdjacentHTML('beforeend',window.answer(i));setTimeout(() => article.insertAdjacentHTML('beforeend',window.actions()),40);},40);
          window.chatScroll.scrollTo({top:100000,behavior:'instant'});
        };
        if(modern){
          document.querySelector('[data-testid="send-button"]').addEventListener('click',submit);
          document.querySelector('[data-composer-markdown]').addEventListener('keydown',event=>{if(event.key==='Enter')submit(event);});
        }else document.querySelector('form').addEventListener('submit',submit);
      },{nested,modern,retryLabel});
      await page.addScriptTag({path:path.join(__dirname,'../extension/content.js')});
      const script=path.join(__dirname,'../extension/return-origin.js');
      await page.addScriptTag({path:script});
      const arrow=i=>page.locator(`[data-turn-key="turn-${i}"] [data-voyager-return]`);
      const ask=async (i,whole=false) => {
        await page.evaluate(({i,whole})=>{
          document.querySelector(`#quote-${i}`).scrollIntoView({block:'center'});
          window.choose(`#quote-${i}${whole ? '' : ' strong'}`,whole);
        },{i,whole});
        await page.locator('#ask').click();
      };
      const send=async()=>{
        const i=await page.evaluate(()=>window.nextTurn);
        await page.locator(modern ? '[data-composer-markdown]' : '#prompt-textarea').fill(`follow-up ${i}`);
        if(modern && !nested) await page.locator('[data-composer-markdown]').press('Enter');
        else await page.locator('[data-testid="send-button"]').click();
        await page.locator(`[data-turn-key="turn-${i}"] [aria-label="${retryLabel}"]`).waitFor();
        await page.waitForTimeout(80);
        return i;
      };
      const returned=async(target,source)=>{
        await arrow(target).click();
        await page.waitForFunction(source=>{
          const ranges=[...(CSS.highlights.get('chatgpt-voyager-origin') || [])];
          return ranges.length===1 && ranges[0].startContainer.parentElement?.closest('section')?.dataset.messageId===`answer-${source}`;
        },source,{timeout:7000});
        assert.ok(await page.evaluate(source=>{
          const rect=document.querySelector(`#quote-${source}`).getBoundingClientRect();
          const view=window.chatScroll===document.scrollingElement ? {top:0,bottom:innerHeight} : window.chatScroll.getBoundingClientRect();
          return rect.bottom>view.top && rect.top<view.bottom;
        },source));
      };
      assert.equal(await page.locator('[data-voyager-return]').count(),0);
      await ask(0); // No extra Ask button or floating panel; no return before sending.
      assert.equal(await page.getByRole('button',{name:'向 ChatGPT 提问',exact:true}).count(),1);
      assert.equal(await page.locator('[data-voyager-return]').count(),0);
      assert.equal(await page.locator('#chatgpt-voyager-return button').count(),0);
      await page.evaluate(()=>document.querySelector('#quote-card').textContent='');
      const plain=await send(); assert.equal(await arrow(plain).count(),0);

      await ask(0);
      const first=await send(); await arrow(first).waitFor();
      assert.equal(await arrow(first).innerText(),'↩');
      assert.equal(await arrow(first).getAttribute('title'),'返回原文');
      assert.equal(await arrow(0).count(),0);
      assert.equal(await arrow(first).evaluate(el=>el.previousElementSibling.getAttribute('aria-label')),retryLabel);
      assert.equal(await arrow(first).evaluate(el=>el.nextElementSibling.getAttribute('aria-label')),'更多');
      await page.evaluate(()=>{
        document.querySelector('#quote-0').previousElementSibling.style.height='180px';
        document.querySelector('[data-message-id="answer-0"]').prepend(document.createTextNode('New text before the original response. '));
      });
      await returned(first,0);
      assert.equal(await arrow(first).count(),1); // Link can be used repeatedly.
      await returned(first,0);
      await ask(first,true);
      const second=await send(); await arrow(second).waitFor();
      await returned(second,first);await returned(first,0);
      const unquoted=await send();assert.equal(await arrow(unquoted).count(),0);

      // Regeneration of the linked response keeps its own original quote target.
      await page.evaluate(i=>{
        const article=document.querySelector(`[data-turn-key="turn-${i}"]`);
        article.querySelector('section').remove();article.querySelector('.actions').remove();
        article.insertAdjacentHTML('beforeend',window.answer(i).replace(`answer-${i}`,`answer-${i}-retry`)+window.actions());
      },first);
      await arrow(first).waitFor();await returned(first,0);

      // Remounting the source uses stable identity; it must not match another identical phrase.
      await page.evaluate(()=>{
        const answer=document.querySelector('[data-message-id="answer-0"]');window.savedAnswer=answer.outerHTML;answer.remove();
        const target=window.chatScroll===document.scrollingElement ? document : window.chatScroll;
        const remount=()=>{
          if(window.chatScroll.scrollTop<500){target.removeEventListener('scroll',remount);setTimeout(()=>document.querySelector('article').insertAdjacentHTML('beforeend',window.savedAnswer),40);}
        };
        target.addEventListener('scroll',remount);
      });
      await returned(first,0);

      if(nested && !modern){
        await page.evaluate(()=>document.querySelector('[data-message-id="answer-0"]').remove());
        await arrow(first).click();
        await page.waitForFunction(i=>document.querySelector(`[data-turn-key="turn-${i}"] [data-voyager-return]`)?.title.includes('暂未加载'),first,{timeout:7000});
        assert.equal(await arrow(first).isEnabled(),true);
        await page.evaluate(()=>document.querySelector('article').insertAdjacentHTML('beforeend',window.savedAnswer));
        await returned(first,0);
        // A screenshot of the exact intended action-row placement.
        await arrow(first).scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(__dirname,'../test-results/return-origin-inline.png')});
      }
      await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
      assert.equal(await arrow(first).isVisible(),false);
      await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
      await arrow(first).waitFor();await returned(first,0);
      await page.evaluate(()=>history.pushState({},'', '/c/other'));
      assert.equal(await page.locator('[data-voyager-return]').count(),0);
      assert.equal(await page.evaluate(()=>CSS.highlights.has('chatgpt-voyager-origin')),false);
      await page.addScriptTag({path:script});assert.equal(await page.locator('#chatgpt-voyager-return').count(),1);
      assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log('PASS: native Ask unchanged; no floating UI; per-answer arrow after Retry; quote cancellation; chained follow-ups; repeated return; reflow; regeneration; remount; timeout/retry; background; route cleanup.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
