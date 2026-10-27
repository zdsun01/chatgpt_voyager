(() => {
  'use strict';
  // One document per open panel, no preloading or persistent conversation cache.
  if (window !== window.top || document.getElementById('voyager-side-chat')) return;
  const ID='voyager-side-chat', OPEN='data-voyager-side-open';
  const host=document.createElement('div');host.id=ID;
  host.style.cssText='all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483100;';
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>
    :host{--side-bg:#fafbfc;--side-fg:#263442;--side-line:#dce4ec;--side-muted:#667685;color-scheme:light}
    :host-context(.dark),:host-context([data-theme=dark]){--side-bg:#202123;--side-fg:#eceff3;--side-line:#3e454d;--side-muted:#aab5c1;color-scheme:dark}
    *{box-sizing:border-box}[hidden]{display:none!important}
    .panel{position:fixed;right:0;top:0;bottom:0;width:var(--voyager-side-width,44vw);display:flex;flex-direction:column;pointer-events:auto;background:var(--side-bg);color:var(--side-fg);border-left:1px solid var(--side-line);box-shadow:-8px 0 24px #18314a0a;font:14px/1.5 system-ui,sans-serif}
    .bar{display:flex;align-items:center;gap:10px;flex:none;height:52px;padding:8px 16px;border-bottom:1px solid var(--side-line)}
    .bar strong{flex:1;font-size:14px;font-weight:600}.bar svg{width:19px;height:19px}
    button{color:inherit;font:inherit;cursor:pointer;border:0;background:transparent;border-radius:8px}
    button:focus-visible{outline:2px solid #549fdc;outline-offset:2px}.close{font-size:24px;width:32px;height:32px}.close:hover{background:#8c9daf25}
    .stage{flex:1;min-height:0;position:relative;overflow:hidden}
    iframe{display:block;border:0;width:100%;height:100%;background:var(--side-bg)}
    .status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:28px;background:var(--side-bg);text-align:center}
    .status p{margin:12px 0;color:var(--side-muted);max-width:300px}.retry{padding:8px 18px;border:1px solid var(--side-line)}
    .note{font-size:12px;color:var(--side-muted);padding:5px 16px;border-top:1px solid var(--side-line);flex:none}
    .resize{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;touch-action:none;z-index:2}.resize:focus-visible{outline:2px solid #549fdc;outline-offset:-2px}
  </style><section class="panel" role="region" aria-label="侧边聊天" hidden>
    <div class="resize" role="separator" tabindex="0" aria-label="调整侧边聊天宽度" aria-orientation="vertical"></div>
    <header class="bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11a9 9 0 1 0-9 9c1.6 0 3.1-.4 4.4-1.1L21 21l-1.1-4.4A8.94 8.94 0 0 0 21 11Z"/><path d="M12 7v8m-4-4h8"/></svg><strong>侧边聊天</strong><button class="close" aria-label="关闭侧边聊天" title="关闭并丢弃临时聊天">×</button></header>
    <div class="stage"><div class="status" role="status"><div><p class="message">正在打开独立临时聊天…</p><button class="retry" hidden>重新加载</button></div></div></div>
    <div class="note">独立临时聊天 · 关闭后不保留在聊天历史中</div>
  </section>`;
  const panel=shadow.querySelector('.panel'),stage=shadow.querySelector('.stage'),status=shadow.querySelector('.status');
  const message=shadow.querySelector('.message'),retry=shadow.querySelector('.retry'),separator=shadow.querySelector('.resize');
  const layout=document.createElement('style');layout.id='voyager-side-layout';
  layout.textContent=`html[${OPEN}] body{width:calc(100% - var(--voyager-side-width))!important;min-width:0!important}
    html[${OPEN}] [data-app-shell-frame]{width:calc((100vw - var(--voyager-side-width)) / var(--codex-window-zoom,1) - var(--debug-panel-width,0px))!important}
    @media(max-width:700px){html[${OPEN}] body{width:100%!important}html[${OPEN}] [data-app-shell-frame]{width:calc(100vw / var(--codex-window-zoom,1) - var(--debug-panel-width,0px))!important}}`;
  document.documentElement.append(layout,host);
  let frame=null,child=null,childObserver=null,loadTimer=0,childFrame=0,menuFrame=0;
  let opened=false,ready=false,generation=0,preferredWidth=null,trigger=null,previousFocus=null,dragging=false;
  const sessionCleanup=[];
  const isVisible=e=>Boolean(e?.isConnected && !e.closest('[hidden],[inert],[aria-hidden=true]') && e.getClientRects().length);
  const label=e=>(e.getAttribute('aria-label')||e.textContent||'').trim();
  const temporaryClose=/^(?:关闭临时聊天|退出临时聊天|Close temporary chat|Turn off temporary chat)$/i;
  // After the first native reply the mode toggle is replaced by "Save chat".
  const temporarySave=/^(?:保存聊天|保存此聊天|保存对话|Save chat|Save this chat)$/i;
  const unsafeAction=/^(?:关闭临时聊天|退出临时聊天|保存聊天|保存此聊天|保存对话|保留聊天|Close temporary chat|Turn off temporary chat|Save chat|Save this chat|Keep chat)$/i;
  const sideNavigation=/^(?:显示\s*[/／]\s*隐藏侧边栏|打开侧边栏|关闭侧边栏|展开侧边栏|收起侧边栏|切换侧边栏|新建聊天|新聊天|Show\s*[/／]\s*hide sidebar|Toggle sidebar|Open sidebar|Close sidebar|New chat)(?:$|\s*(?:Ctrl|Control|⌘|Command))/i;
  function isSideNavigation(control) {
    return sideNavigation.test(label(control)) || sideNavigation.test(control.getAttribute('title')||'') ||
      ['open-sidebar-button','close-sidebar-button','new-chat-button'].includes(control.getAttribute('data-testid'));
  }

  function width(value) {
    const w=innerWidth<=700?innerWidth:Math.max(320,Math.min(value,innerWidth-360,720));
    document.documentElement.style.setProperty('--voyager-side-width',`${w}px`);
    separator.setAttribute('aria-valuenow',String(Math.round(w)));
    separator.setAttribute('aria-valuemin','320');separator.setAttribute('aria-valuemax',String(Math.max(320,innerWidth-360)));
  }
  function notifyLayout(){window.dispatchEvent(new Event('resize'));}
  function showState(text,failed=false) {
    message.textContent=text;retry.hidden=!failed;status.hidden=false;
    if(frame){frame.style.visibility='hidden';frame.style.pointerEvents='none';}
    ready=false;
  }
  function clearChild() {
    childObserver?.disconnect();childObserver=null;
    if(childFrame && child)child.defaultView.cancelAnimationFrame(childFrame);
    childFrame=0;
    for(const remove of sessionCleanup.splice(0))remove();
    child=null;ready=false;
  }
  function releaseFrame() {
    clearTimeout(loadTimer);loadTimer=0;clearChild();
    frame?.remove();frame=null;
  }
  function addListener(target,name,handler,options) {
    target.addEventListener(name,handler,options);
    sessionCleanup.push(()=>target.removeEventListener(name,handler,options));
  }
  function isTemporary() {
    if(!child)return false;
    try {
      const url=new URL(child.defaultView.location.href);
      if(url.origin!==location.origin || url.searchParams.get('temporary-chat')!=='true' || !/^\/(?:c\/[\w-]+)?\/?$/.test(url.pathname))return false;
      return Array.from(child.querySelectorAll('button')).some(b=>(temporaryClose.test(label(b)) || temporarySave.test(label(b))) &&
        !b.closest('[data-app-shell-active-page="false"],[hidden],[inert]'));
    }catch{return false;}
  }
  function inspectChild() {
    childFrame=0;if(!opened || !child)return;
    // A native mode indicator is required; a query parameter alone is insufficient.
    if(!isTemporary()) {
      showState('正在确认临时聊天模式…');return;
    }
    for(const b of child.querySelectorAll('button,[role=button],a[href],[role=menuitem]')) {
      if(unsafeAction.test(label(b)) || isSideNavigation(b))b.setAttribute('data-voyager-side-disabled','');
    }
    const editor=child.querySelector('#prompt-textarea,[data-composer-markdown][contenteditable=true]');
    if(!editor)return;
    ready=true;clearTimeout(loadTimer);status.hidden=true;
    frame.style.visibility='visible';frame.style.pointerEvents=dragging?'none':'auto';
  }
  function queueChild() {
    if(!childFrame && child)childFrame=child.defaultView.requestAnimationFrame(inspectChild);
  }
  function attachChild() {
    clearChild();if(!opened || !frame)return;
    try {
      const doc=frame.contentDocument;
      if(!doc?.body || doc.location.origin!==location.origin)throw Error('unavailable');
      child=doc;
      const style=doc.createElement('style');style.textContent=`
        [data-app-shell-sidebar],#app-shell-sidebar,[data-voyager-side-disabled],#chatgpt-question-timeline,#chatgpt-voyager-return{display:none!important}
        html,body{min-width:0!important}body{width:100%!important}
      `;doc.head.append(style);
      const guard=event=>{
        if(event.type==='keydown' && event.ctrlKey && event.altKey && event.key.toLowerCase()==='s'){event.preventDefault();close();return;}
        if(event.type==='keydown' && !['Enter',' '].includes(event.key))return;
        const target=event.target instanceof doc.defaultView.Element?event.target:null;
        if(!target)return;
        const control=target.closest('button,[role=button],[role=menuitem]');
        const anchor=target.closest('a[href]');
        const temporary=isTemporary();
        if((control && (unsafeAction.test(label(control)) || isSideNavigation(control))) || anchor || !temporary) {
          event.preventDefault();event.stopImmediatePropagation();
          if(!temporary)showState('临时聊天模式已退出，请重新加载侧边聊天。',true);
          else if(anchor && (event.type==='click' || event.key==='Enter')) {
            const destination=new URL(anchor.href,doc.location.href);
            // Citation links may open separately; never navigate this panel into saved history.
            if(['https:','http:'].includes(destination.protocol) && destination.origin!==location.origin)
              window.open(destination.href,'_blank','noopener,noreferrer');
          }
        }
      };
      addListener(doc,'click',guard,true);addListener(doc,'submit',guard,true);addListener(doc,'keydown',guard,true);
      addListener(doc.defaultView,'popstate',queueChild);
      if(doc.defaultView.navigation)addListener(doc.defaultView.navigation,'currententrychange',queueChild);
      childObserver=new MutationObserver(changes=>{
        if(changes.some(c=>c.type==='attributes' || [...c.addedNodes,...c.removedNodes].some(n=>n.nodeType===1 &&
          (n.matches('button,[role=button],[role=menuitem],main,[contenteditable],a') || n.querySelector('button,[role=button],[role=menuitem],[contenteditable],a[href]')))))queueChild();
      });
      childObserver.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-label','title','data-testid']});
      inspectChild();
    } catch {showState('无法加载临时侧边聊天，请重新加载后再试。',true);}
  }
  function start() {
    const current=++generation;releaseFrame();showState('正在打开独立临时聊天…');
    frame=document.createElement('iframe');frame.title='独立临时侧边聊天';
    frame.referrerPolicy='no-referrer';
    frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-downloads');
    frame.style.visibility='hidden';frame.style.pointerEvents='none';
    frame.addEventListener('load',()=>{if(current===generation)attachChild();});
    // No parent conversation URL, messages, project ID or attachments are passed.
    frame.src=new URL('/?temporary-chat=true',location.origin).href;
    stage.prepend(frame);
    loadTimer=setTimeout(()=>{if(opened && current===generation && !ready)showState('临时聊天未能加载。请确认已登录 ChatGPT，再点重新加载。',true);},20000);
  }
  function open() {
    if(opened){shadow.querySelector('.close').focus();return;}
    opened=true;previousFocus=document.activeElement;
    panel.hidden=false;document.documentElement.setAttribute(OPEN,'');
    width(preferredWidth||innerWidth*.44);notifyLayout();start();
  }
  function close() {
    if(!opened)return;
    opened=false;generation++;dragging=false;releaseFrame();
    panel.hidden=true;document.documentElement.removeAttribute(OPEN);
    document.documentElement.style.removeProperty('--voyager-side-width');notifyLayout();
    if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});previousFocus=null;
  }
  shadow.querySelector('.close').addEventListener('click',close);retry.addEventListener('click',start);
  separator.addEventListener('pointerdown',event=>{dragging=true;separator.setPointerCapture(event.pointerId);if(frame)frame.style.pointerEvents='none';event.preventDefault();});
  separator.addEventListener('pointermove',event=>{if(dragging){preferredWidth=innerWidth-event.clientX;width(preferredWidth);}});
  const endDrag=()=>{if(!dragging)return;dragging=false;if(frame && ready)frame.style.pointerEvents='auto';notifyLayout();};
  separator.addEventListener('pointerup',endDrag);separator.addEventListener('pointercancel',endDrag);
  separator.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();
    preferredWidth=panel.getBoundingClientRect().width+(event.key==='ArrowLeft'?24:-24);width(preferredWidth);notifyLayout();
  });
  window.addEventListener('resize',()=>{if(opened)width(preferredWidth||innerWidth*.44);},{passive:true});
  document.addEventListener('keydown',event=>{
    if(event.ctrlKey && event.altKey && event.key.toLowerCase()==='s') {event.preventDefault();opened?close():open();}
  },true);
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('button');
    if(button && (/^(?:更多|More)$/i.test(label(button)) || button.getAttribute('aria-haspopup')==='menu') && !button.closest('[data-turn-key]'))trigger=button;
  },true);
  function installMenu() {
    menuFrame=0;
    for(const menu of document.querySelectorAll('[role=menu]')) {
      if(!isVisible(menu) || menu.querySelector('[data-voyager-side-menu]'))continue;
      const items=Array.from(menu.querySelectorAll('[role=menuitem]'));
      if(!items.some(e=>/^(?:重命名|Rename)/i.test(label(e))) || !items.some(e=>/^(?:归档|Archive)/i.test(label(e))))continue;
      const item=document.createElement('div');item.setAttribute('role','menuitem');item.tabIndex=0;
      item.setAttribute('data-voyager-side-menu','');item.className=items[0].className;
      // Native classes supply padding, typography and hover color. Override their
      // structural layout explicitly: some menu roots default to a centered column.
      item.style.cssText='display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:flex-start!important;flex-wrap:nowrap!important;text-align:start!important;gap:10px;cursor:pointer;';
      item.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11a9 9 0 1 0-9 9c1.6 0 3.1-.4 4.4-1.1L21 21l-1.1-4.4A8.94 8.94 0 0 0 21 11Z"/><path d="M12 7v8m-4-4h8"/></svg><span>新建侧边聊天</span>';
      const nativeIcon=items[0].querySelector('svg');
      if(nativeIcon) {
        const iconRect=nativeIcon.getBoundingClientRect(),itemRect=items[0].getBoundingClientRect();
        const walker=document.createTreeWalker(items[0],NodeFilter.SHOW_TEXT);
        let textNode;
        while((textNode=walker.nextNode())) {
          if(!textNode.textContent.trim() || nativeIcon.contains(textNode))continue;
          const range=document.createRange();range.selectNodeContents(textNode);
          const textRect=range.getBoundingClientRect();
          if(iconRect.width>0 && textRect.width>0 && textRect.left>=iconRect.right) {
            item.style.paddingInlineStart=`${Math.max(0,iconRect.left-itemRect.left)}px`;
            item.style.gap=`${Math.max(0,textRect.left-iconRect.right)}px`;
            item.style.minHeight=`${itemRect.height}px`;
            const textStyle=getComputedStyle(textNode.parentElement);
            const caption=item.querySelector('span');
            caption.style.fontSize=textStyle.fontSize;caption.style.fontWeight=textStyle.fontWeight;
            caption.style.lineHeight=textStyle.lineHeight;
            break;
          }
        }
        if(iconRect.width>0 && iconRect.height>0) {
          item.querySelector('svg').style.cssText=`width:${iconRect.width}px;height:${iconRect.height}px;flex:none;`;
        }
      }
      item.querySelector('span').style.whiteSpace='nowrap';
      const activate=event=>{
        event.preventDefault();event.stopPropagation();
        const activeTrigger=trigger?.getAttribute('aria-expanded')==='true'?trigger:
          document.querySelector('button[aria-haspopup="menu"][aria-expanded="true"]');
        activeTrigger?.click();open();
      };
      item.addEventListener('click',activate);item.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key))activate(event);});
      const pin=items.find(e=>/^(?:置顶|取消置顶|Pin|Unpin)/i.test(label(e)));
      (pin||items[0]).after(item);
    }
  }
  const menuObserver=new MutationObserver(changes=>{
    if(menuFrame)return;
    if(changes.some(c=>[...c.addedNodes].some(n=>n.nodeType===1 && !n.hasAttribute('data-voyager-side-menu') &&
      (n.matches('[role=menu],[role=menuitem]') || n.querySelector('[role=menu]')))))menuFrame=requestAnimationFrame(installMenu);
  });
  menuObserver.observe(document.body,{childList:true,subtree:true});installMenu();
  window.addEventListener('pagehide',()=>{close();menuObserver.disconnect();cancelAnimationFrame(menuFrame);menuFrame=0;});
  window.addEventListener('pageshow',()=>{menuObserver.observe(document.body,{childList:true,subtree:true});});
})();
