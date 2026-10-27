const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');

(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const mode of ['layout','scroll-reset','remount','late-render','interrupt']) {
      const page=await browser.newPage({viewport:{width:1100,height:750}});
      await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:`
        <meta charset="utf-8"><style>body{font:16px system-ui}#scroll{height:450px;overflow:auto;overflow-anchor:none}
        article{min-height:1200px}#space{height:100px}#ask{position:fixed;top:0;right:0}</style>
        <main><div id="scroll" data-app-action-timeline-scroll><div data-chatgpt-conversation-selection-target="settle">
        <article data-turn-key="A"><div data-user-message-bubble>initial</div>
        <section data-message-id="answer-A" data-message-author-role="assistant"><div id="space"></div><p id="original">The quoted source passage.</p><div style="height:1000px"></div></section></article>
        </div></div></main><button id="ask">向 ChatGPT 提问</button><div data-composer-body>
        <div id="quote"></div><div data-composer-markdown contenteditable="true">question B</div><button aria-label="发送">Send</button></div>`}));
      await page.goto('https://chatgpt.com/c/settle');
      await page.evaluate(()=>{
        const editor=document.querySelector('[data-composer-markdown]');
        document.querySelector('#ask').onclick=()=>{document.querySelector('#quote').textContent=getSelection().toString();getSelection().removeAllRanges();};
        document.querySelector('[aria-label="发送"]').onclick=()=>{
          const article=document.createElement('article');article.dataset.turnKey='B';
          article.innerHTML='<div data-user-message-bubble></div><section data-message-id="answer-B" data-message-author-role="assistant">Reply B</section><button aria-label="重新生成回复">retry</button>';
          article.querySelector('[data-user-message-bubble]').textContent=editor.textContent;
          document.querySelector('[data-chatgpt-conversation-selection-target]').append(article);
        };
      });
      await page.addScriptTag({path:path.join(__dirname,'../extension/return-origin.js')});
      await page.evaluate(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('#original'));getSelection().removeAllRanges();getSelection().addRange(r);});
      await page.locator('#ask').click();await page.getByRole('button',{name:'发送',exact:true}).click();
      const arrow=page.locator('[data-voyager-return]');await arrow.waitFor();
      // Once the target is found, virtual lists can still resize, correct scroll,
      // or remount a row. A single scroll followed by immediate cleanup loses it.
      await page.evaluate(mode=>{
        const scroll=document.querySelector('#scroll');scroll.scrollTop=1100;
        const source=document.querySelector('[data-message-id="answer-A"]');
        if(mode==='late-render')source.style.display='none';
        const original=scroll.scrollTo.bind(scroll);window.scrollCalls=0;
        scroll.scrollTo=(...args)=>{window.scrollCalls++;return original(...args);};
        document.querySelector('[data-voyager-return]').addEventListener('click',()=>{
          setTimeout(()=>{
            if(mode==='layout')document.querySelector('#space').style.height='1800px';
            if(mode==='scroll-reset')scroll.scrollTop=1100;
            if(mode==='remount'){
              const clone=source.cloneNode(true);source.remove();
              setTimeout(()=>{clone.querySelector('#space').style.height='1800px';document.querySelector('[data-turn-key="A"]').append(clone);},120);
            }
            if(mode==='late-render')source.style.display='block';
            if(mode==='interrupt'){
              scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:600}));
              scroll.scrollTop=1100;window.interruptedAt=scroll.scrollTop;
            }
          },180);
        },{once:true});
      },mode);
      await arrow.click();await page.waitForTimeout(1600);
      if(mode==='interrupt') {
        assert.equal(await page.evaluate(()=>document.querySelector('#scroll').scrollTop),await page.evaluate(()=>window.interruptedAt));
      } else {
        const position=await page.evaluate(()=>{
          const r=document.querySelector('#original').getBoundingClientRect(),v=document.querySelector('#scroll').getBoundingClientRect();
          return {top:r.top,bottom:r.bottom,viewTop:v.top,viewBottom:v.bottom};
        });
        assert.ok(position.top>=position.viewTop && position.bottom<=position.viewBottom,`${mode}: first click must leave original visible: ${JSON.stringify(position)}`);
        assert.equal(await arrow.getAttribute('title'),'返回原文');
      }
      assert.equal(await arrow.isEnabled(),true);
      const calls=await page.evaluate(()=>window.scrollCalls);
      await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>window.scrollCalls),calls,'no idle corrections after completion');
      await page.close();
    }
    console.log('PASS: first-click recovery after delayed layout, native scroll reset, remount, style-only reveal; user interruption; bounded cleanup.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
