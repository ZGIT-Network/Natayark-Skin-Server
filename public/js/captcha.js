(function () {
  'use strict';
  var states = [];
  function inform(state, key) {
    var text = state.holder.getAttribute('data-' + key) || '';
    if (window.UI && window.UI.message && typeof window.UI.message.error === 'function') window.UI.message.error(text);
    else if (state.feedback) { state.feedback.hidden = false; state.feedback.textContent = text; }
  }
  function release(state) {
    clearTimeout(state.timeout); state.pending = false; state.form.removeAttribute('aria-busy');
    if (state.submitter) state.submitter.disabled = false;
  }
  function render(state) {
    if (!window.grecaptcha || typeof window.grecaptcha.render !== 'function') return;
    release(state); var version = ++state.version;
    state.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    state.compact = state.holder.clientWidth < 304;
    var target = document.createElement('div'); state.holder.replaceChildren(target);
    try {
      state.id = window.grecaptcha.render(target, {
        sitekey: state.holder.getAttribute('data-sitekey'), theme: state.theme,
        size: state.invisible ? 'invisible' : (state.compact ? 'compact' : 'normal'), badge: 'bottomright',
        callback: function () {
          if (version !== state.version) return;
          var submitter = state.submitter, pending = state.pending; release(state);
          if (state.feedback) state.feedback.hidden = true;
          if (state.invisible && pending) state.form.requestSubmit(submitter || undefined);
        },
        'expired-callback': function () { if (version === state.version) { release(state); inform(state, 'expired'); } },
        'error-callback': function () { if (version === state.version) { release(state); inform(state, 'error'); } },
      });
    } catch (error) { state.id = null; inform(state, 'error'); }
  }
  document.querySelectorAll('[data-captcha-widget]').forEach(function (holder) {
    var form = holder.closest('form'); if (!form) return;
    var state = { holder: holder, form: form, feedback: holder.nextElementSibling, id: null,
      invisible: holder.getAttribute('data-invisible') === 'true', pending: false, version: 0, submitter: null };
    states.push(state);
    form.addEventListener('submit', function (event) {
      if (state.id === null || !window.grecaptcha) { event.preventDefault(); inform(state, state.failed ? 'error' : 'loading'); return; }
      if (window.grecaptcha.getResponse(state.id)) return;
      event.preventDefault();
      if (!state.invisible) { inform(state, 'required'); return; }
      if (state.pending) return;
      state.submitter = event.submitter || form.querySelector('[type="submit"]');
      state.pending = true; form.setAttribute('aria-busy', 'true'); if (state.submitter) state.submitter.disabled = true;
      state.timeout = setTimeout(function () { release(state); window.grecaptcha.reset(state.id); inform(state, 'expired'); }, 120000);
      try {
        var execution = window.grecaptcha.execute(state.id);
        if (execution && typeof execution.catch === 'function') execution.catch(function () { release(state); inform(state, 'error'); });
      } catch (error) { release(state); inform(state, 'error'); }
    });
  });
  // Defined before loading Google's async script, including the cached-resource case.
  window.natayarkCaptchaReady = function () { states.forEach(render); };
  document.addEventListener('error', function (event) {
    if (event.target && event.target.tagName === 'SCRIPT' && /\/recaptcha\/api\.js/.test(event.target.src || '')) states.forEach(function (state) { state.failed = true; release(state); inform(state, 'error'); });
  }, true);
  new MutationObserver(function () {
    var theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    states.forEach(function (state) { if (state.id !== null && state.theme !== theme) render(state); });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  if (window.ResizeObserver) new ResizeObserver(function () {
    states.forEach(function (state) { if (state.id !== null && !state.invisible && state.compact !== (state.holder.clientWidth < 304)) render(state); });
  }).observe(document.documentElement);
  window.addEventListener('pagehide', function () { states.forEach(release); });
  window.addEventListener('pageshow', function (event) { if (event.persisted) states.forEach(function (state) { if (state.id !== null) window.grecaptcha.reset(state.id); }); });
})();
