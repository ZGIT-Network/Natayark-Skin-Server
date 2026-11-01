(function () {
  'use strict';
  var active;
  function mount(){
  if(active)active.abort();
  var scope=active=new AbortController();
  function on(target,event,handler){target.addEventListener(event,handler,{signal:scope.signal});}
  function refresh(){if(!scope.signal.aborted){if(window.SiteNavigation)window.SiteNavigation.refresh();else location.reload();}}

  var form = document.getElementById('create-client');
  var message = document.getElementById('client-message');

  async function send(method, url, body) {
    var response = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: method === 'GET' ? undefined : JSON.stringify(Object.assign({ csrf: window.__CSRF }, body || {})),
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.code === 1) throw new Error(data.message || '请求失败');
    return data;
  }

  if (form) {
    on(form, 'submit', async function (event) {
      event.preventDefault();
      if (message) message.textContent = '';
      var button = form.querySelector('[type="submit"]');
      if (button) button.disabled = true;
      try {
        await send('POST', '/oauth/clients', Object.fromEntries(new FormData(form)));
        refresh();
      } catch (error) {
        if (message) message.textContent = error.message;
        if (window.UI) window.UI.toast(error.message, 'error');
        if (button) button.disabled = false;
      }
    });
  }

  on(document, 'click', async function (event) {
    var button = event.target.closest('[data-revoke-client]');
    if (!button) return;
    var confirmed = window.UI
      ? await window.UI.confirm({ title: '撤销应用', description: '撤销该应用及其所有访问令牌？', confirmText: '撤销', danger: true })
      : window.confirm('撤销该应用及其所有访问令牌？');
    if (!confirmed) return;
    try {
      await send('DELETE', '/oauth/clients/' + encodeURIComponent(button.getAttribute('data-revoke-client')));
      refresh();
    } catch (error) {
      if (message) message.textContent = error.message;
      if (window.UI) window.UI.toast(error.message, 'error');
    }
  });
  var tokenForm = document.getElementById('create-personal-token');
  if (tokenForm) on(tokenForm, 'submit',async function (event) {
    event.preventDefault(); var button = tokenForm.querySelector('[type="submit"]'); button.disabled = true;
    try {
      var data = await send('POST','/oauth/personal-access-tokens',{scopes:new FormData(tokenForm).getAll('scopes')});
      if(scope.signal.aborted)return;
      tokenForm.querySelector('[data-new-token]').value = data.accessToken;
      tokenForm.querySelector('[data-token-result]').hidden = false;
      if(window.UI)window.UI.message.success('令牌已创建，请复制保存');
    } catch(error) {if(window.UI)window.UI.message.error(error.message);}
    finally {button.disabled = false;}
  });
  on(document, 'click',async function (event) {
    var copy = event.target.closest('[data-copy-new-token]'), revoke = event.target.closest('[data-revoke-token]');
    try {
      if(copy){await navigator.clipboard.writeText(tokenForm.querySelector('[data-new-token]').value);if(window.UI)window.UI.message.success('令牌已复制');}
      if(revoke){
        if(!await window.UI.confirm({title:'撤销访问令牌',description:'使用该令牌的脚本会立即失去访问权限。',confirmText:'撤销',danger:true}))return;
        await send('DELETE','/oauth/personal-access-tokens/' + encodeURIComponent(revoke.dataset.revokeToken));
        if(window.UI)window.UI.message.success('令牌已撤销');revoke.closest('tr').remove();
      }
    }catch(error){if(window.UI)window.UI.message.error(error.message);}
  });
  function clearToken(){if(tokenForm){tokenForm.querySelector('[data-new-token]').value='';tokenForm.querySelector('[data-token-result]').hidden=true;}}
  on(window, 'pagehide',clearToken);
  on(document,'site:before-render',clearToken);
  }
  window.ApplicationActions={mount:mount,unmount:function(){if(active)active.abort();}};
  if(!window.SiteNavigation || !window.SiteNavigation.isRendering)mount();
})();
