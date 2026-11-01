// Local browser fixture for the documented reCAPTCHA v2 client API. Never contacts Google.
(function () {
  var widgets = []; window.__captchaWidgets = widgets; window.__captchaExecutions = 0;
  function complete(widget) {
    widget.response = 'browser-' + Date.now() + '-' + Math.random().toString(36).slice(2); widget.field.value = widget.response;
    if (widget.button) widget.button.setAttribute('aria-checked', 'true'); widget.options.callback(widget.response);
  }
  window.grecaptcha = {
    render: function (target, options) {
      var field = document.createElement('textarea'); field.name = 'g-recaptcha-response'; field.hidden = true; target.appendChild(field);
      var widget = { target: target, options: options, field: field, response: '' }; widgets.push(widget);
      var view = document.createElement('div'); view.dataset.fixtureTheme = options.theme; view.style.cssText = 'box-sizing:border-box;width:' + (options.size === 'compact' ? '164' : '304') + 'px;padding:12px;border:1px solid #9098a0;font:13px sans-serif;background:' + (options.theme === 'dark' ? '#252a32;color:#eee' : '#fafafa;color:#333');
      if (options.size === 'invisible') { view.textContent = 'CAPTCHA · local test fixture'; view.style.cssText += ';position:fixed;right:8px;bottom:8px;width:256px;z-index:100;'; }
      else { var button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'checkbox'); button.setAttribute('aria-checked', 'false'); button.textContent = 'Verify (local test fixture)'; button.addEventListener('click', function () { complete(widget); }); view.appendChild(button); widget.button = button; }
      target.appendChild(view); return widgets.length - 1;
    },
    getResponse: function (id) { return widgets[id].response; },
    reset: function (id) { widgets[id].response = ''; widgets[id].field.value = ''; },
    execute: function (id) {
      window.__captchaExecutions++; var widget = widgets[id];
      if (window.__captchaBehavior === 'hold') return;
      setTimeout(function () { if (window.__captchaBehavior === 'error') widget.options['error-callback'](); else complete(widget); }, 20);
    },
  };
  window.natayarkCaptchaReady();
})();
