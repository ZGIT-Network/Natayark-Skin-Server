(function () {
  'use strict';

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
    if (!response.ok) throw new Error(data.message || '请求失败');
    return data;
  }

  if (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (message) message.textContent = '';
      var button = form.querySelector('[type="submit"]');
      if (button) button.disabled = true;
      try {
        await send('POST', '/oauth/clients', Object.fromEntries(new FormData(form)));
        location.reload();
      } catch (error) {
        if (message) message.textContent = error.message;
        if (window.UI) window.UI.toast(error.message, 'error');
        if (button) button.disabled = false;
      }
    });
  }

  document.addEventListener('click', async function (event) {
    var button = event.target.closest('[data-revoke-client]');
    if (!button) return;
    var confirmed = window.UI
      ? await window.UI.confirm({ title: '撤销应用', description: '撤销该应用及其所有访问令牌？', confirmText: '撤销', danger: true })
      : window.confirm('撤销该应用及其所有访问令牌？');
    if (!confirmed) return;
    try {
      await send('DELETE', '/oauth/clients/' + encodeURIComponent(button.getAttribute('data-revoke-client')));
      location.reload();
    } catch (error) {
      if (message) message.textContent = error.message;
      if (window.UI) window.UI.toast(error.message, 'error');
    }
  });
})();
