/* Progressive HTML navigation: keep the document and shared application shell alive. */
(function () {
  'use strict';
  if (window.SiteNavigation || !window.fetch || !window.AbortController) return;
  var pending, serial=0, currentUrl=location.href, entrance=[];
  var historyIndex=Number.isInteger(history.state?.natayarkNavigation?.index)?history.state.natayarkNavigation.index:0;
  var reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  var scripts=new Map();
  var assets={'/js/app.js':'AppActions','/js/applications.js':'ApplicationActions','/vendor/skinview3d.js':'SkinPreviews'};
  function emit(name,detail){document.dispatchEvent(new CustomEvent(name,{detail:detail}));}
  function eligible(url){return url.origin===location.origin && !url.searchParams.has('download') && /^\/(?:$|user(?:\/|$)|admin(?:\/|$)|skinlib(?:\/|$))/.test(url.pathname);}
  function id(){return Date.now().toString(36)+'-'+(++serial);}
  function record(){
    var state=Object.assign({},history.state),previous=state.natayarkNavigation||{};
    state.natayarkNavigation={id:previous.id||id(),index:previous.index??historyIndex,x:scrollX,y:scrollY,sidebar:document.querySelector('[data-sidebar] nav')?.scrollTop||0};
    history.replaceState(state,'',location.href);
    return state;
  }
  function cancel(reason){
    if(!pending)return;
    pending.controller.abort(reason||'cancelled');
    pending.animations.forEach(animation=>animation.cancel());
  }
  function clearEntrance(){
    entrance.forEach(animation=>animation.cancel());
    entrance=[];
  }
  function motionTargets(main){
    if(!main)return [];
    var targets=[];
    for(var child of main.children){
      if(child.matches('script,style,dialog,[hidden],.page-skeleton'))continue;
      if(child.matches('.grid,.editor-layout,.library-grid'))targets.push(...child.children);
      else targets.push(child);
    }
    return targets.filter(function(element){
      var rect=element.getBoundingClientRect();
      return element.animate && !element.matches('script,style,dialog,[hidden]') && rect.width>0 && rect.height>0 && rect.bottom>0 && rect.top<innerHeight;
    }).slice(0,16);
  }
  function offset(element,direction,distance,y){
    var rect=element.getBoundingClientRect();
    var room=direction>0?document.documentElement.clientWidth-rect.right:rect.left;
    return 'translate3d('+(direction*Math.max(0,Math.min(distance,room-1)))+'px,'+y+'px,0)';
  }
  function enterPage(main,direction){
    clearEntrance();
    if(reducedMotion.matches)return;
    var batch=motionTargets(main).map(function(element,index){
      return element.animate([
        {opacity:0.65,transform:offset(element,direction,element.matches('.page-header')?10:16,element.matches('.page-header')?0:6)},
        {opacity:1,transform:'translate3d(0,0,0)'}
      ],{id:'page-enter',duration:260,delay:Math.min(index*22,66),easing:'cubic-bezier(.22,1,.36,1)',fill:'backwards'});
    });
    entrance=batch;
    Promise.all(batch.map(animation=>animation.finished.catch(function(){}))).then(function(){
      if(entrance===batch)entrance=[];
      batch.forEach(animation=>animation.cancel());
    });
  }
  async function loadAsset(src){
    var url=new URL(src,location.href),module=assets[url.pathname];
    if(!module || window[module])return;
    if(!scripts.has(url.pathname))scripts.set(url.pathname,new Promise(function(resolve,reject){
      var script=document.createElement('script');script.src=url.href;
      script.onload=resolve;script.onerror=function(){scripts.delete(url.pathname);script.remove();reject(new Error('页面组件加载失败'));};
      document.body.appendChild(script);
    }));
    await scripts.get(url.pathname);
    if(!window[module]){scripts.delete(url.pathname);throw new Error('页面组件未能初始化');}
  }
  function copyContents(current,next){if(current&&next)current.replaceChildren(...Array.from(next.childNodes).map(node=>document.importNode(node,true)));}
  function updateHead(next){
    document.title=next.title;document.documentElement.lang=next.documentElement.lang;
    for(var selector of ['meta[name="csrf-token"]','meta[name="description"]','#site-theme','style[data-site-custom-css]','link[rel="shortcut icon"]']){
      var old=document.head.querySelector(selector),fresh=next.head.querySelector(selector);
      if(fresh){var clone=document.importNode(fresh,true);if(old)old.replaceWith(clone);else document.head.appendChild(clone);}else if(old)old.remove();
    }
    window.__CSRF=next.querySelector('meta[name="csrf-token"]')?.content||'';
    window.__USER_ID=Number(next.body.dataset.userId)||0;
    document.querySelectorAll('input[type="hidden"][name="csrf"],input[type="hidden"][name="_token"]').forEach(input=>{input.value=window.__CSRF;});
  }
  function replacePage(next){
    var main=document.querySelector('[data-page-content]'),fresh=next.querySelector('[data-page-content]');
    var shell=document.body.dataset.pageShell;
    var localeChanged=document.documentElement.lang!==next.documentElement.lang;
    if(shell==='app' && next.body.dataset.pageShell==='app'){
      var sidebar=document.querySelector('[data-sidebar]'),position=sidebar?.querySelector('nav')?.scrollTop||0;
      copyContents(sidebar?.querySelector('nav'),next.querySelector('[data-sidebar] nav'));
      copyContents(sidebar?.querySelector('a[href="/user"]'),next.querySelector('[data-sidebar] a[href="/user"]'));
      copyContents(document.querySelector('.sidebar-brand'),next.querySelector('.sidebar-brand'));
      if(localeChanged){
        copyContents(document.querySelector('.topbar'),next.querySelector('.topbar'));
        copyContents(sidebar?.querySelector('.sidebar-footer'),next.querySelector('[data-sidebar] .sidebar-footer'));
      }else{
        copyContents(document.querySelector('.topbar [data-user-menu]'),next.querySelector('.topbar [data-user-menu]'));
        copyContents(document.querySelector('.topbar [data-locale-menu]'),next.querySelector('.topbar [data-locale-menu]'));
        var quote=document.querySelector('.topbar [data-site-quote]'),nextQuote=next.querySelector('.topbar [data-site-quote]');
        if(quote&&!nextQuote)quote.remove();
        else if(!quote&&nextQuote)document.querySelector('.topbar').insertBefore(document.importNode(nextQuote,true),document.querySelector('[data-topbar-actions]'));
      }
      copyContents(document.querySelector('.page-footer'),next.querySelector('.page-footer'));
      main.replaceWith(document.importNode(fresh,true));
      if(sidebar)sidebar.querySelector('nav').scrollTop=position;
    }else if(shell==='home' && next.body.dataset.pageShell==='home'){
      main.replaceWith(document.importNode(fresh,true));
      copyContents(document.querySelector('.home-header'),next.querySelector('.home-header'));
      document.querySelector('.home-header').className=next.querySelector('.home-header').className;
      copyContents(document.querySelector('.home-footer'),next.querySelector('.home-footer'));
      document.body.className=next.body.className;
    }else{
      document.body.replaceChildren(...Array.from(next.body.childNodes).map(node=>document.importNode(node,true)));
      document.body.className=next.body.className;
    }
    document.body.dataset.pageShell=next.body.dataset.pageShell;
    document.body.dataset.userId=next.body.dataset.userId;
  }
  async function visit(href,options){
    options=options||{};
    var url=new URL(href,location.href);
    if(!eligible(url) || document.body.dataset.pageShell==='auth'){location.assign(url.href);return;}
    var interruptedPop=pending?.pop;
    cancel('superseded');
    var saved=options.pop?options.state:interruptedPop?history.state:record();
    var targetIndex=saved?.natayarkNavigation?.index;
    var direction=options.pop && (!Number.isInteger(targetIndex) || targetIndex<historyIndex)?-1:1;
    var task=pending={controller:new AbortController(),animations:[],pop:!!options.pop};
    window.SiteNavigation.isNavigating=true;
    var timeout=setTimeout(function(){task.controller.abort('timeout');},15000);
    emit('site:navigation-start',{url:url.href});
    try{
      var response,html,destination,localeVersion;
      do{
        // A navigation racing a language save must render the newly saved preference.
        if(window.UI?.localePending)await window.UI.localePending.catch(function(){});
        localeVersion=window.UI?.localeVersion||0;
        response=await fetch(url.href,{credentials:'same-origin',cache:'no-store',headers:{Accept:'text/html'},signal:task.controller.signal});
        if(task!==pending || task.controller.signal.aborted)return;
        destination=new URL(response.url);
        if(destination.origin===url.origin && destination.pathname===url.pathname && destination.search===url.search && !destination.hash)destination.hash=url.hash;
        if(destination.origin!==location.origin || !response.headers.get('content-type')?.includes('text/html') || response.headers.get('content-disposition')?.includes('attachment')){location.assign(destination.href);return;}
        html=await response.text();
        if(window.UI?.localePending)await window.UI.localePending.catch(function(){});
      }while(localeVersion!==(window.UI?.localeVersion||0));
      var next=new DOMParser().parseFromString(html,'text/html');
      if(!next.querySelector('[data-page-content]') || !next.body.dataset.pageShell || next.body.dataset.userId!==document.body.dataset.userId || next.body.dataset.pageShell==='auth'){
        location.assign(destination.href);return;
      }
      if(task!==pending || task.controller.signal.aborted)return;
      var sources=Array.from(next.querySelectorAll('script[src]')).map(script=>script.getAttribute('src'));
      // Server-rendered HTML is data here. Never eval arbitrary response scripts.
      next.querySelectorAll('script').forEach(script=>script.remove());
      // Load optional modules before replacing the working page; cancellation stays safe.
      window.SiteNavigation.isRendering=true;
      for(var src of sources)await loadAsset(src);
      if(task!==pending || task.controller.signal.aborted)return;
      emit('site:before-render',{url:destination.href});
      var main=document.querySelector('[data-page-content]');
      clearEntrance();
      if(!reducedMotion.matches){
        task.animations=motionTargets(main).map(function(element){
          return element.animate([
            {opacity:1,transform:'translate3d(0,0,0)'},
            {opacity:0.8,transform:offset(element,-direction,6,-2)}
          ],{id:'page-exit',duration:80,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'});
        });
        await Promise.all(task.animations.map(animation=>animation.finished.catch(function(){})));
      }
      if(window.UI?.localePending)await window.UI.localePending.catch(function(){});
      if(task!==pending || task.controller.signal.aborted)return;
      if(localeVersion!==(window.UI?.localeVersion||0))return visit(url.href,options);
      window.SiteNavigation.isRendering=true;
      for(var module of ['UI','AppActions','ApplicationActions','SkinPreviews'])window[module]?.unmount?.();
      task.committed=true;
      replacePage(next);updateHead(next);
      var state=options.pop?(saved||{}):options.replace?(saved||{}):{natayarkNavigation:{id:id(),index:(targetIndex??historyIndex)+1,x:0,y:0,sidebar:0}};
      if(options.pop || options.replace)history.replaceState(state,'',destination.href);else history.pushState(state,'',destination.href);
      historyIndex=state.natayarkNavigation?.index??(options.pop?historyIndex-1:historyIndex);
      currentUrl=location.href;
      window.UI?.mount();
      if(sources.some(src=>new URL(src,location.href).pathname==='/js/app.js'))window.AppActions?.mount();
      if(sources.some(src=>new URL(src,location.href).pathname==='/js/applications.js'))window.ApplicationActions?.mount();
      if(document.querySelector('[data-skin-viewer]'))window.SkinPreviews?.mount();
      var position=state.natayarkNavigation;
      if(options.pop || options.keepScroll){scrollTo({left:position?.x||0,top:position?.y||0,behavior:'instant'});var sidebar=document.querySelector('[data-sidebar] nav');if(sidebar && options.pop)sidebar.scrollTop=position?.sidebar||0;}
      else if(destination.hash){try{document.getElementById(decodeURIComponent(destination.hash.slice(1)))?.scrollIntoView();}catch{} }
      else scrollTo({left:0,top:0,behavior:'instant'});
      var heading=document.querySelector('[data-page-content] h1');
      if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
      currentUrl=location.href;record();
      enterPage(document.querySelector('[data-page-content]'),direction);
      emit('site:page-load',{url:currentUrl});
    }catch(error){
      if(task!==pending || task.controller.signal.aborted && task.controller.signal.reason!=='timeout')return;
      if(task.committed || options.pop){location.replace(url.href);return;}
      window.UI?.message.error(task.controller.signal.reason==='timeout'?'页面加载超时，请重试':'页面加载失败，请检查网络后重试');
    }finally{
      clearTimeout(timeout);
      if(task===pending){
        task.animations.forEach(animation=>animation.cancel());
        pending=null;window.SiteNavigation.isRendering=false;window.SiteNavigation.isNavigating=false;emit('site:navigation-end',{});
      }
    }
  }
  window.SiteNavigation={visit:visit,refresh:function(){return visit(location.href,{replace:true,keepScroll:true});},isRendering:false,isNavigating:false};
  function init(){
    history.scrollRestoration='manual';record();
    enterPage(document.querySelector('[data-page-content]'),1);
    reducedMotion.addEventListener('change',function(){
      if(reducedMotion.matches){clearEntrance();pending?.animations.forEach(animation=>animation.cancel());}
    });
    document.addEventListener('click',function(event){
      if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;
      var anchor=event.target.closest('a[href]');
      if(!anchor || anchor.hasAttribute('download') || anchor.target && anchor.target!=='_self' || anchor.closest('[data-native-navigation]') || anchor.isContentEditable)return;
      var url=new URL(anchor.href,location.href);
      if(!eligible(url))return;
      if(url.pathname===location.pathname && url.search===location.search){if(!url.hash)event.preventDefault();return;}
      event.preventDefault();void visit(url.href);
    });
    document.addEventListener('submit',function(event){
      var form=event.target;
      if(event.defaultPrevented || form.method.toLowerCase()!=='get' || form.target && form.target!=='_self' || form.closest('[data-native-navigation]'))return;
      var url=new URL(form.action||location.href,location.href);if(!eligible(url))return;
      var params=new URLSearchParams(new FormData(form));if(event.submitter?.name)params.append(event.submitter.name,event.submitter.value);url.search=params.toString();
      event.preventDefault();void visit(url.href);
    });
    window.addEventListener('popstate',function(event){
      var from=new URL(currentUrl),to=new URL(location.href);
      if(from.pathname===to.pathname && from.search===to.search && from.hash!==to.hash){currentUrl=location.href;return;}
      void visit(location.href,{pop:true,state:event.state});
    });
    window.addEventListener('hashchange',function(){currentUrl=location.href;});
    var frame;
    window.addEventListener('scroll',function(){cancelAnimationFrame(frame);frame=requestAnimationFrame(function(){if(!pending)record();});},{passive:true});
    document.addEventListener('keydown',function(event){if(event.key==='Escape' && !pending?.pop)cancel();});
    window.addEventListener('pagehide',function(){cancel();clearEntrance();emit('site:before-render',{});});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
