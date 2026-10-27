const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');

(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1400,height:900}});
    const errors=[],requests=[];let mode='temporary';
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://chatgpt.com/**',async route=>{
      const url=new URL(route.request().url());
      if(url.searchParams.get('temporary-chat')==='true'){
        requests.push({url:url.href,referer:route.request().headers().referer});
        return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>
          body{margin:0;font:15px system-ui;background:#fafbfc}main{padding:20px}#messages{min-height:200px}
          [data-composer-markdown]{border:1px solid #ccc;min-height:80px;padding:8px}
          </style><nav id="app-shell-sidebar">SAVED HISTORY SHOULD BE HIDDEN</nav><main>
          ${mode==='temporary'?'<button aria-label="关闭临时聊天">Exit temporary</button><h1>临时聊天</h1>':'<h1>普通聊天</h1>'}
          <p>独立临时聊天，不会显示在历史记录中。</p><div id="messages"></div><form>
          <div data-composer-markdown contenteditable="true" role="textbox" aria-label="询问 ChatGPT"></div>
          <button aria-label="发送">发送</button></form><button id="save">${mode==='temporary'?'保存聊天':'其他操作'}</button>
          <a href="/c/existing-private-chat">旧聊天</a></main><script>
          window.saved=false;window.exited=false;
          document.querySelector('#save').onclick=()=>window.saved=true;
          const exit=document.querySelector('[aria-label="关闭临时聊天"]');if(exit)exit.onclick=()=>window.exited=true;
          document.querySelector('form').onsubmit=e=>{e.preventDefault();const p=document.createElement('p');p.textContent='回复：'+document.querySelector('[contenteditable]').textContent;document.querySelector('#messages').append(p);document.querySelector('[contenteditable]').textContent='';};
          </script>`});
      }
      return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><style>
        body{margin:0;font:16px system-ui}header{display:flex;justify-content:end;height:50px}main{padding:24px}
        #scroll{height:620px;overflow:auto}article{min-height:600px}.menu{position:fixed;right:45px;top:55px;background:white;border:1px solid #ddd;padding:12px;z-index:100}
        [role=menuitem]{padding:10px;min-width:180px}</style>
        <div data-app-shell-frame style="width:100vw"><header><button id="more" aria-label="更多" aria-expanded="false">…</button><button>分享</button></header>
        <main id="scroll" data-app-action-timeline-scroll><div data-chatgpt-conversation-selection-target="parent">
          <article data-turn-key="parent-A"><div data-user-message-bubble>主聊天私密标记 PARENT_CONTEXT_NOT_TO_COPY</div><div data-message-author-role="assistant">主聊天回答</div></article>
          <article data-turn-key="parent-B"><div data-user-message-bubble>原位置</div></article>
        </div></main><div contenteditable="true" id="draft">未发送的主聊天草稿</div></div><script>
        window.deleted=0;document.querySelector('#more').onclick=()=>{
          const old=document.querySelector('[role=menu]');if(old){old.remove();document.querySelector('#more').setAttribute('aria-expanded','false');return;}
          const menu=document.createElement('div');menu.className='menu';menu.setAttribute('role','menu');
          menu.innerHTML='<div role="menuitem">重命名</div><div role="menuitem">置顶</div><div role="menuitem">归档</div><div role="menuitem" id="delete">删除</div>';
          document.body.append(menu);document.querySelector('#delete').onclick=()=>window.deleted++;
          document.querySelector('#more').setAttribute('aria-expanded','true');
        };</script>`});
    });
    await page.goto('https://chatgpt.com/c/parent');
    await page.addScriptTag({path:path.join(__dirname,'../extension/content.js')});
    const script=path.join(__dirname,'../extension/side-chat.js');await page.addScriptTag({path:script});
    const panel=page.locator('#voyager-side-chat .panel');
    const frame=()=>page.frameLocator('iframe[title="独立临时侧边聊天"]');
    assert.equal(await page.locator('iframe').count(),0,'must not preload');
    await page.evaluate(()=>document.querySelector('#scroll').scrollTop=300);
    const scrollBefore=await page.locator('#scroll').evaluate(e=>e.scrollTop);
    await page.getByRole('button',{name:'更多',exact:true}).click();
    await page.getByRole('menuitem',{name:'新建侧边聊天',exact:true}).click();
    await frame().getByRole('textbox',{name:'询问 ChatGPT'}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#voyager-side-chat').shadowRoot.querySelector('.status').hidden);
    assert.equal(await page.locator('iframe').count(),1);
    assert.equal(await page.locator('[role=menu]').count(),0);
    assert.equal(await page.locator('#draft').innerText(),'未发送的主聊天草稿');
    assert.equal(await page.locator('#scroll').evaluate(e=>e.scrollTop),scrollBefore);
    assert.ok(await page.locator('body').evaluate(e=>e.getBoundingClientRect().width)<1000);
    assert.ok(await page.locator('[data-app-shell-frame]').evaluate(e=>e.getBoundingClientRect().right)<1000,'viewport-sized app shell must shrink too');
    assert.ok((await page.locator('#chatgpt-question-timeline .rail').boundingBox()).x<800);
    assert.ok(!(await frame().locator('body').innerText()).includes('PARENT_CONTEXT_NOT_TO_COPY'));
    assert.equal(await frame().locator('#app-shell-sidebar').isVisible(),false);
    assert.equal(await frame().getByRole('button',{name:'关闭临时聊天'}).isVisible(),false);
    assert.equal(await frame().getByRole('button',{name:'保存聊天'}).isVisible(),false);
    await frame().getByRole('textbox',{name:'询问 ChatGPT'}).fill('测试独立侧边聊天');
    await frame().getByRole('button',{name:'发送',exact:true}).click();
    assert.equal(await frame().locator('#messages').innerText(),'回复：测试独立侧边聊天');
    await page.screenshot({path:path.join(__dirname,'../test-results/side-chat-preview.png')});
    const native=page.frames().find(f=>f.url().includes('temporary-chat=true'));
    await native.evaluate(()=>document.querySelector('#save').click());assert.equal(await native.evaluate(()=>window.saved),false);
    await native.evaluate(()=>document.querySelector('[aria-label="关闭临时聊天"]').click());assert.equal(await native.evaluate(()=>window.exited),false);
    // Observed live: first send keeps ?temporary-chat=true, but replaces the mode toggle with Save chat.
    await native.evaluate(()=>{
      document.querySelector('[aria-label="关闭临时聊天"]').remove();
      history.replaceState({},'', '/c/temporary-test?temporary-chat=true');
    });
    await frame().getByRole('textbox',{name:'询问 ChatGPT'}).fill('第二条测试');
    await frame().getByRole('button',{name:'发送',exact:true}).click();
    assert.ok((await frame().locator('#messages').innerText()).includes('回复：第二条测试'));
    assert.equal(await native.evaluate(()=>{
      const tab=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
      document.querySelector('a').dispatchEvent(tab);return tab.defaultPrevented;
    }),false,'Tab must remain usable on a blocked navigation link');
    await native.evaluate(()=>document.querySelector('a').click());
    assert.equal(native.url(),'https://chatgpt.com/c/temporary-test?temporary-chat=true','old chat links cannot replace temporary chat');
    const oldWidth=(await panel.boundingBox()).width;
    await page.getByRole('separator',{name:'调整侧边聊天宽度'}).press('ArrowLeft');
    assert.ok((await panel.boundingBox()).width>oldWidth);
    await page.getByRole('button',{name:'关闭侧边聊天',exact:true}).click();
    assert.equal(await page.locator('iframe').count(),0);
    assert.equal(await page.locator('body').evaluate(e=>Math.round(e.getBoundingClientRect().width)),1400);
    assert.equal(await page.evaluate(()=>window.deleted),0,'never delete the main conversation');
    // Reopening starts a new blank document, not a hidden copy of the previous chat.
    await page.keyboard.press('Control+Alt+s');
    await frame().getByRole('textbox',{name:'询问 ChatGPT'}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#voyager-side-chat').shadowRoot.querySelector('.status').hidden);
    assert.equal(await frame().locator('#messages').innerText(),'');
    await page.addScriptTag({path:script});assert.equal(await page.locator('#voyager-side-chat').count(),1);
    await page.keyboard.press('Control+Alt+s');assert.equal(await page.locator('iframe').count(),0);
    // Query flags are not proof: ordinary-chat content must remain unusable.
    mode='ordinary';await page.keyboard.press('Control+Alt+s');
    await frame().getByRole('heading',{name:'普通聊天'}).waitFor({state:'attached'});
    assert.equal(await page.locator('#voyager-side-chat .status').isVisible(),true);
    assert.equal(await page.locator('iframe').evaluate(e=>getComputedStyle(e).visibility),'hidden');
    const rejected=page.frames().find(f=>f.url().includes('temporary-chat=true'));
    await rejected.evaluate(()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(await rejected.locator('#messages').innerText(),'');
    await page.getByRole('button',{name:'关闭侧边聊天'}).click();
    mode='temporary';await page.setViewportSize({width:500,height:800});await page.keyboard.press('Control+Alt+s');
    await frame().getByRole('heading',{name:'临时聊天'}).waitFor({state:'attached'});
    assert.equal(Math.round((await panel.boundingBox()).width),500);
    await page.getByRole('button',{name:'关闭侧边聊天'}).click();
    assert.ok(requests.length>=4);assert.ok(requests.every(r=>r.url==='https://chatgpt.com/?temporary-chat=true' && !r.referer));
    assert.deepEqual(errors,[]);await page.close();
    console.log('PASS: menu/shortcut; no preload; one isolated temporary document; no main-chat copy; guarded temporary mode; native send; close destroys frame; blank reopen; resize/mobile; main draft/position preserved; no history deletion; no parent URL referral.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
