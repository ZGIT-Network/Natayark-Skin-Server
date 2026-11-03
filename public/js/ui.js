/* Natayark SkinServer — menus, forms and short surface transitions. */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var exits = new WeakMap();
  var listeners = new AbortController();

  function cancelExit(element) {
    var pending = exits.get(element);
    if (pending) pending();
  }

  function afterExit(element, done) {
    if (!element || exits.has(element)) return;
    if (reducedMotion.matches) { done(); return; }
    element.classList.add('is-closing');
    var timer;
    function cancel() {
      clearTimeout(timer);
      exits.delete(element);
      element.removeEventListener('animationend', ended);
      element.classList.remove('is-closing');
    }
    function finish() {
      cancel();
      done();
    }
    function ended(event) { if (event.target === element) finish(); }
    element.addEventListener('animationend', ended);
    timer = setTimeout(finish, 180);
    exits.set(element, cancel);
  }

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }
  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }
  function on(target, event, handler, options) {
    if (target) target.addEventListener(event, handler, Object.assign({}, typeof options === 'boolean' ? {capture:options} : options, {signal:listeners.signal}));
  }

  /* --- Theme ----------------------------------------------------------------- */
  var systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(theme, persist) {
    var root = document.documentElement;
    if (['system', 'light', 'dark'].indexOf(theme) < 0) theme = root.dataset.themeDefault || 'system';
    root.dataset.themeMode = theme;
    var dark = theme === 'dark' || (theme === 'system' && systemTheme.matches);
    root.classList.toggle('dark', dark);
    if (persist) {
      try { localStorage.setItem('mcnskin-theme', theme); } catch (e) {}
    }
    qsa('[data-theme-choice]').forEach(function (button) {
      button.setAttribute('aria-checked', String(button.dataset.themeChoice === theme));
    });
    qsa('[data-theme-symbol]').forEach(function (symbol) { symbol.hidden = symbol.dataset.themeSymbol !== theme; });
    qsa('[data-theme-select]').forEach(function (select) { select.value = theme; });
    window.dispatchEvent(new CustomEvent('themechange', { detail: { mode: theme, dark: dark } }));
  }

  function initTheme() {
    applyTheme(document.documentElement.dataset.themeMode, false);
    qsa('[data-theme-choice]').forEach(function (button) {
      on(button, 'click', function () {
        applyTheme(button.dataset.themeChoice, true);
        closeDropdown(button.closest('[data-dropdown]'));
      });
    });
    qsa('[data-theme-select]').forEach(function (select) { on(select, 'change', function () { applyTheme(select.value, true); }); });
    on(systemTheme, 'change', function () {
      if (document.documentElement.dataset.themeMode === 'system') applyTheme('system', false);
    });
    on(window, 'storage', function (event) {
      if (event.key === 'mcnskin-theme' || event.key === null) applyTheme(event.newValue, false);
    });
  }

  function initLocale() {
    on(document, 'submit', async function (event) {
      var form=event.target.closest('[data-locale-form]');
      if(!form || !window.fetch)return;
      event.preventDefault();
      if(form.dataset.saving==='true')return;
      var choice=event.submitter || qs('[name="locale"][aria-checked="true"]',form);
      if(!choice)return;
      var body=new URLSearchParams(new FormData(form)),destination=new URL(location.href);
      destination.searchParams.delete('lang');
      body.set('locale',choice.value);body.set('redirect',destination.pathname+destination.search+destination.hash);
      var buttons=qsa('button',form),scope=listeners.signal,controller=new AbortController();
      var fallback=document.documentElement.lang==='en'?'Unable to save language. Please try again.':'语言保存失败，请稍后重试。';
      form.dataset.saving='true';buttons.forEach(function(button){button.disabled=true;});
      var timer=setTimeout(function(){controller.abort();},10000);
      var operation=(async function(){
        var response=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{Accept:'application/json'},body:body,signal:controller.signal});
        var data=await response.json();
        if(!response.ok || data.code!==0)throw new Error(data.message || fallback);
        window.UI.localeVersion=(window.UI.localeVersion||0)+1;
        return data;
      })();
      window.UI.localePending=operation;
      try{
        var result=await operation;
        if(scope.aborted || window.SiteNavigation?.isNavigating)return;
        if(window.SiteNavigation)await window.SiteNavigation.visit(result.redirect,{replace:true,keepScroll:true});
        else location.assign(result.redirect);
      }catch(error){if(!scope.aborted)message.error(error.name==='AbortError'?fallback:error.message || fallback);}
      finally{
        clearTimeout(timer);if(window.UI.localePending===operation)window.UI.localePending=null;
        delete form.dataset.saving;buttons.forEach(function(button){button.disabled=false;});
      }
    });
  }

  /* --- Sidebar --------------------------------------------------------------- */
  function initSidebar() {
    var sidebar = qs('[data-sidebar]');
    if (!sidebar) return;
    var backdrop = null;
    function close() {
      sidebar.classList.remove('open');
      qsa('[data-sidebar-toggle]').forEach(function (button) { button.setAttribute('aria-expanded', 'false'); });
      if (backdrop) {
        var previousBackdrop = backdrop;
        backdrop = null;
        afterExit(previousBackdrop, function () { previousBackdrop.remove(); });
      }
      document.body.style.overflow = '';
    }
    function open() {
      sidebar.classList.add('open');
      qsa('[data-sidebar-toggle]').forEach(function (button) { button.setAttribute('aria-expanded', 'true'); });
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = 'sidebar-backdrop lg:hidden';
        backdrop.addEventListener('click', close);
        document.body.appendChild(backdrop);
      }
      document.body.style.overflow = 'hidden';
    }
    qsa('[data-sidebar-toggle]').forEach(function (button) {
      on(button, 'click', function () {
        if (sidebar.classList.contains('open')) close();
        else open();
      });
    });
    qsa('[data-sidebar-close]').forEach(function (button) {
      on(button, 'click', close);
    });
    qsa('a', sidebar).forEach(function (link) {
      on(link, 'click', function () {
        if (window.matchMedia('(max-width: 1023px)').matches) close();
      });
    });
    on(document, 'keydown', function (event) {
      if (event.key === 'Escape') close();
    });
    on(window.matchMedia('(min-width: 1024px)'), 'change', function (event) {
      if (event.matches) close();
    });
  }

  /* --- Dropdowns ------------------------------------------------------------- */
  var openDropdown = null;

  function closeDropdown(dropdown, immediate) {
    if (!dropdown) return;
    var menu = qs('[data-dropdown-menu]', dropdown);
    var trigger = qs('[data-dropdown-trigger]', dropdown);
    if (menu) {
      if (immediate) { cancelExit(menu); menu.hidden = true; }
      else afterExit(menu, function () { menu.hidden = true; });
    }
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (openDropdown === dropdown) openDropdown = null;
  }

  function initDropdowns() {
    qsa('[data-dropdown]').forEach(function (dropdown) {
      var trigger = qs('[data-dropdown-trigger]', dropdown);
      var menu = qs('[data-dropdown-menu]', dropdown);
      if (!trigger || !menu) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      on(trigger, 'click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (openDropdown && openDropdown !== dropdown) closeDropdown(openDropdown, true);
        var willOpen = trigger.getAttribute('aria-expanded') !== 'true';
        if (!willOpen) { closeDropdown(dropdown); return; }
        cancelExit(menu);
        menu.hidden = !willOpen;
        trigger.setAttribute('aria-expanded', String(willOpen));
        openDropdown = willOpen ? dropdown : null;
      });
      on(menu, 'click', function (event) {
        if (event.target.closest('[data-dropdown-item]')) closeDropdown(dropdown);
      });
    });
    on(document, 'click', function (event) {
      if (openDropdown && !openDropdown.contains(event.target)) closeDropdown(openDropdown);
    });
    on(document, 'keydown', function (event) {
      if (event.key === 'Escape' && openDropdown) {
        var trigger = qs('[data-dropdown-trigger]', openDropdown);
        closeDropdown(openDropdown);
        if (trigger) trigger.focus();
      }
    });
  }

  /* --- Tabs ------------------------------------------------------------------ */
  function activateTab(tabs, key) {
    var triggers = qsa('[data-tab]', tabs);
    var target = triggers.filter(function (trigger) {
      return trigger.getAttribute('data-tab') === key;
    })[0];
    if (!target) return;
    triggers.forEach(function (trigger) {
      var selected = trigger === target;
      trigger.setAttribute('aria-selected', String(selected));
      trigger.setAttribute('tabindex', selected ? '0' : '-1');
    });
    qsa('[data-tab-panel]', tabs).forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-tab-panel') !== key;
    });
    if (target.getAttribute('data-tab-hash') !== null) {
      try {
        history.replaceState(null, '', '#' + key);
      } catch (e) {}
    }
  }

  function initTabs() {
    qsa('[data-tabs]').forEach(function (tabs) {
      var triggers = qsa('[data-tab]', tabs);
      if (!triggers.length) return;
      var tablist = qs('[role="tablist"]', tabs);
      if (tablist && tabs.classList.contains('tabs-vertical')) {
        var desktop = window.matchMedia('(min-width: 1024px)');
        function updateOrientation() {
          tablist.setAttribute('aria-orientation', desktop.matches ? 'vertical' : 'horizontal');
        }
        updateOrientation();
        on(desktop, 'change', updateOrientation);
      }
      var initial = triggers.filter(function (trigger) {
        return trigger.getAttribute('aria-selected') === 'true';
      })[0];
      var hash = (location.hash || '').replace(/^#/, '');
      if (hash && triggers.some(function (trigger) { return trigger.getAttribute('data-tab') === hash; })) {
        initial = triggers.filter(function (trigger) { return trigger.getAttribute('data-tab') === hash; })[0];
      }
      activateTab(tabs, (initial || triggers[0]).getAttribute('data-tab'));
      triggers.forEach(function (trigger) {
        on(trigger, 'click', function () {
          activateTab(tabs, trigger.getAttribute('data-tab'));
        });
        on(trigger, 'keydown', function (event) {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          var index = triggers.indexOf(trigger);
          var delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
          var next = triggers[(index + delta + triggers.length) % triggers.length];
          next.focus();
          activateTab(tabs, next.getAttribute('data-tab'));
        });
      });
    });
  }

  /* --- Dialogs --------------------------------------------------------------- */
  function showDialog(idOrElement) {
    var dialog = typeof idOrElement === 'string' ? document.getElementById(idOrElement) : idOrElement;
    if (!dialog) return null;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    var autofocus = qs('[autofocus]', dialog) || qs('input:not([type=hidden]), textarea, select', dialog);
    if (autofocus && typeof autofocus.focus === 'function') {
      setTimeout(function () { autofocus.focus(); }, 30);
    }
    return dialog;
  }

  function closeDialog(idOrElement) {
    var dialog = typeof idOrElement === 'string' ? document.getElementById(idOrElement) : idOrElement;
    if (!dialog) return;
    afterExit(dialog, function () {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
    });
  }

  function initDialogs() {
    qsa('dialog.dialog').forEach(function (dialog) {
      on(dialog, 'cancel', function (event) { event.preventDefault(); closeDialog(dialog); });
      on(dialog, 'click', function (event) {
        if (event.target === dialog) closeDialog(dialog);
      });
    });
    on(document, 'click', function (event) {
      var opener = event.target.closest('[data-dialog-open]');
      if (opener) {
        event.preventDefault();
        showDialog(opener.getAttribute('data-dialog-open'));
        return;
      }
      var closer = event.target.closest('[data-dialog-close]');
      if (closer) {
        event.preventDefault();
        closeDialog(closer.closest('dialog'));
      }
    });
  }

  /* --- Toasts ---------------------------------------------------------------- */
  function toast(message, type, title) {
    var region = qs('.toast-region');
    if (!region) {
      region = document.createElement('div');
      region.className = 'toast-region';
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    var variant = type === 'error' || type === 'destructive' ? 'error' : type === 'success' ? 'success' : 'info';
    var node = document.createElement('div');
    node.className = 'toast toast-' + variant;
    node.setAttribute('role', 'status');
    node.innerHTML =
      '<div class="toast-text">' +
      (title ? '<div class="toast-title"></div>' : '') +
      '<div class="toast-body"></div></div>' +
      '<button type="button" class="toast-close" aria-label="关闭通知">关闭</button>';
    if (title) node.querySelector('.toast-title').textContent = title;
    node.querySelector('.toast-body').textContent = message;
    on(node.querySelector('.toast-close'), 'click', function () { node.remove(); });
    region.appendChild(node);
    setTimeout(function () {
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      node.style.transition = reducedMotion.matches ? 'none' : 'opacity .14s ease, transform .14s ease';
      setTimeout(function () { node.remove(); }, 200);
    }, type === 'error' ? 5200 : 3400);
    return node;
  }

  /* --- Confirm / prompt ------------------------------------------------------ */
  function makeDialog() {
    var dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.innerHTML =
      '<div class="dialog-header"><div class="dialog-title"></div><div class="dialog-description"></div></div>' +
      '<div class="dialog-body"></div>' +
      '<div class="dialog-footer"><button type="button" class="btn btn-outline" data-cancel></button><button type="button" class="btn" data-confirm></button></div>';
    document.body.appendChild(dialog);
    return dialog;
  }

  function confirmDialog(options) {
    options = options || {};
    return new Promise(function (resolve) {
      var dialog = makeDialog();
      dialog.querySelector('.dialog-title').textContent = options.title || '确认操作';
      var description = dialog.querySelector('.dialog-description');
      if (options.description) description.textContent = options.description;
      else description.remove();
      var body = dialog.querySelector('.dialog-body');
      body.remove();
      var cancel = dialog.querySelector('[data-cancel]');
      var confirm = dialog.querySelector('[data-confirm]');
      cancel.textContent = options.cancelText || '取消';
      confirm.textContent = options.confirmText || '确认';
      if (options.danger) confirm.classList.add('btn-destructive');
      else confirm.classList.add('btn-primary');
      function finish(value) {
        closeDialog(dialog);
        setTimeout(function () { dialog.remove(); }, 150);
        resolve(value);
      }
      on(cancel, 'click', function () { finish(false); });
      on(confirm, 'click', function () { finish(true); });
      on(dialog, 'cancel', function (event) { event.preventDefault(); finish(false); });
      on(dialog, 'click', function (event) { if (event.target === dialog) finish(false); });
      showDialog(dialog);
      confirm.focus();
    });
  }

  function promptDialog(options) {
    options = options || {};
    return new Promise(function (resolve) {
      var dialog = makeDialog();
      dialog.querySelector('.dialog-title').textContent = options.title || '请输入';
      var description = dialog.querySelector('.dialog-description');
      if (options.description) description.textContent = options.description;
      else description.remove();
      var body = dialog.querySelector('.dialog-body');
      body.innerHTML = '<label class="field"><span class="label"></span><input class="input" type="text"></label>';
      body.querySelector('.label').textContent = options.label || '';
      var input = body.querySelector('input');
      input.value = options.value || '';
      input.maxLength = options.maxLength || 255;
      if (options.placeholder) input.placeholder = options.placeholder;
      var cancel = dialog.querySelector('[data-cancel]');
      var confirm = dialog.querySelector('[data-confirm]');
      cancel.textContent = options.cancelText || '取消';
      confirm.textContent = options.confirmText || '确定';
      confirm.classList.add('btn-primary');
      function finish(value) {
        closeDialog(dialog);
        setTimeout(function () { dialog.remove(); }, 150);
        resolve(value);
      }
      on(cancel, 'click', function () { finish(null); });
      on(confirm, 'click', function () { finish(input.value.trim()); });
      on(input, 'keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(input.value.trim());
        }
      });
      on(dialog, 'cancel', function (event) { event.preventDefault(); finish(null); });
      on(dialog, 'click', function (event) { if (event.target === dialog) finish(null); });
      showDialog(dialog);
      input.focus();
      input.select();
    });
  }

  /* --- Copy ------------------------------------------------------------------ */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (error) {
        reject(error);
      } finally {
        area.remove();
      }
    });
  }

  function initCopy() {
    on(document, 'dragstart', function (event) {
      var source = event.target.closest('[data-launcher-drag]');
      if (!source || !event.dataTransfer) return;
      var root = source.dataset.launcherDrag;
      event.dataTransfer.setData('text/plain', 'authlib-injector:yggdrasil-server:' + encodeURIComponent(root));
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.dropEffect = 'copy';
    });
    on(document, 'click', function (event) {
      var button = event.target.closest('[data-copy]');
      if (!button) return;
      var selector = button.getAttribute('data-copy');
      var source = selector ? qs(selector) : null;
      var text = button.getAttribute('data-copy-text');
      if (source) text = source.value !== undefined && /^(INPUT|TEXTAREA)$/.test(source.tagName) ? source.value : source.textContent.trim();
      if (!text) return;
      copyText(text)
        .then(function () { message('已复制到剪贴板', 'success'); })
        .catch(function () { message('复制失败，请手动选择文本', 'error'); });
    });
  }

  /* --- File inputs ----------------------------------------------------------- */
  function initFileInputs() {
    qsa('[data-file-input]').forEach(function (input) {
      var nameTarget = input.getAttribute('data-file-name') ? qs(input.getAttribute('data-file-name')) : null;
      var preview = input.getAttribute('data-file-preview') ? qs(input.getAttribute('data-file-preview')) : null;
      var previewPanel = input.getAttribute('data-file-preview-panel') ? qs(input.getAttribute('data-file-preview-panel')) : null;
      var dropzone=input.closest('[data-file-dropzone]'),dropError=dropzone&&dropzone.parentElement.querySelector('[data-file-drop-error]'),dragDepth=0;
      function fileError(text){if(dropError){dropError.textContent=text||'';dropError.hidden=!text;}}
      if(dropzone){
        on(dropzone,'dragenter',function(event){if(!event.dataTransfer||!Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();dragDepth++;dropzone.classList.add('is-dragging');});
        on(dropzone,'dragover',function(event){if(!event.dataTransfer||!Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();event.dataTransfer.dropEffect='copy';});
        on(dropzone,'dragleave',function(event){event.preventDefault();if(--dragDepth<=0){dragDepth=0;dropzone.classList.remove('is-dragging');}});
        on(dropzone,'drop',function(event){
          event.preventDefault();dragDepth=0;dropzone.classList.remove('is-dragging');
          if(input.disabled||!event.dataTransfer)return;
          var files=event.dataTransfer.files;
          if(files.length!==1){fileError(dropzone.dataset.dropCountError);return;}
          var file=files[0];
          if(!/\.png$/i.test(file.name)&&file.type!=='image/png'){fileError(dropzone.dataset.dropTypeError);return;}
          if(file.size>Number(dropzone.dataset.maxFileSize)){fileError(dropzone.dataset.dropSizeError);return;}
          try{var transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
          catch(error){fileError(document.documentElement.lang==='en'?'Please click to choose the file in this browser.':'此浏览器请点击选择文件。');}
        });
      }
      on(input, 'change', function () {
        fileError('');
        var file = input.files && input.files[0];
        if (nameTarget) nameTarget.textContent = file ? file.name : '';
        if (previewPanel) previewPanel.hidden = !file;
        if (preview) {
          if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
          if (!file) {
            delete preview.dataset.objectUrl;
            preview.removeAttribute('src');
            preview.hidden = true;
            return;
          }
          var url = URL.createObjectURL(file);
          preview.dataset.objectUrl = url;
          preview.src = url;
          preview.hidden = false;
        }
      });
    });
  }

  /* --- Switches -------------------------------------------------------------- */
  function initSwitches() {
    qsa('[data-switch]').forEach(function (wrapper) {
      var input = qs('input[type="checkbox"]', wrapper);
      var target = wrapper.getAttribute('data-switch-target');
      var hidden = target ? qs(target) : null;
      if (!input) return;
      function sync() {
        if (hidden) hidden.value = input.checked ? 'true' : 'false';
      }
      on(input, 'change', sync);
      sync();
    });
  }

  /* --- Confirm forms --------------------------------------------------------- */
  function initLogout() {
    on(document, 'click', async function (event) {
      var link = event.target.closest('a[data-logout-confirm]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (link.dataset.confirming === 'true') return;
      link.dataset.confirming = 'true';
      var scope = listeners.signal;
      try {
        var confirmed = await confirmDialog({
          title: link.dataset.confirmTitle,
          description: link.dataset.confirm,
          confirmText: link.dataset.confirmText,
          cancelText: link.dataset.cancelText,
        });
        if (!confirmed || scope.aborted || !link.isConnected) return;
        var form = document.createElement('form');
        form.method = 'post';
        form.action = link.href;
        form.hidden = true;
        var csrf = document.createElement('input');
        csrf.type = 'hidden';
        csrf.name = 'csrf';
        csrf.value = window.__CSRF || '';
        form.appendChild(csrf);
        document.body.appendChild(form);
        form.submit();
      } finally { delete link.dataset.confirming; }
    });
  }

  function initConfirmForms() {
    on(document, 'submit', function (event) {
      var form = event.target.closest('form[data-confirm]');
      if (!form || form.dataset.confirmed === '1') return;
      event.preventDefault();
      var message = form.getAttribute('data-confirm') || '确认执行此操作？';
      confirmDialog({ title: form.getAttribute('data-confirm-title') || '确认操作', description: message, danger: form.hasAttribute('data-confirm-danger'), confirmText: form.getAttribute('data-confirm-text') || '确认', cancelText: form.getAttribute('data-cancel-text') || '取消' }).then(function (ok) {
        if (!ok) return;
        form.dataset.confirmed = '1';
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      });
    });
  }

  function initAppearance() {
    var form = qs('[data-appearance-form]');
    if (!form) return;
    function refresh() {
      qsa('input[type="color"]', form).forEach(function (input) {
        var label = qs('[data-color-value="' + input.name + '"]', form);
        if (label) label.textContent = input.value;
      });
      qsa('[data-color-sample]', form).forEach(function (sample) {
        var dark = sample.dataset.colorSample === 'dark';
        var color = form.elements[dark ? 'theme_primary_dark' : 'theme_primary'].value;
        var background = form.elements[dark ? 'theme_background_dark' : 'theme_background'].value;
        var rgb = color.slice(1).match(/../g).map(function (hex) { return parseInt(hex, 16); });
        var brightness = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        sample.style.setProperty('--sample-color', color);
        sample.style.setProperty('--sample-background', background);
        sample.style.setProperty('--sample-text', dark ? '#f5f7ff' : '#17202e');
        sample.style.setProperty('--sample-button-text', brightness > 145 ? '#17202e' : '#ffffff');
        var radiusOption = form.elements.theme_radius.selectedOptions[0];
        var radius = Number(radiusOption.dataset.radius);
        sample.style.setProperty('--sample-radius', radius + 'px');
        sample.style.setProperty('--sample-control-radius', radius * 0.75 + 'px');
      });
    }
    on(form, 'input', refresh);
    qsa('[data-palette-primary]', form).forEach(function (button) {
      on(button, 'click', function () {
        form.elements.theme_primary.value = button.dataset.palettePrimary;
        form.elements.theme_primary_dark.value = button.dataset.paletteDark;
        form.elements.theme_background.value = button.dataset.paletteBackground;
        form.elements.theme_background_dark.value = button.dataset.paletteNight;
        refresh();
      });
    });
    refresh();
  }

  function message(content, type, duration) {
    if (content && typeof content === 'object') { type = content.type; duration = content.duration; content = content.content; }
    content = String(content || '').slice(0, 500);
    type = ['success','error','warning','info'].indexOf(type) >= 0 ? type : 'info';
    var region = qs('.message-region');
    if (!region) {
      region = document.createElement('div'); region.className = 'message-region';
      region.setAttribute('aria-label', '操作反馈'); region.setAttribute('popover', 'manual');
      document.body.appendChild(region);
    }
    if (region.showPopover) {
      if (region.matches(':popover-open') && qs('dialog[open]')) region.hidePopover();
      if (!region.matches(':popover-open')) region.showPopover();
    }
    var previous = Array.from(region.children).find(function (node) { return !node.classList.contains('is-leaving') && node.dataset.content === content && node.dataset.type === type; });
    if (previous) { previous.__restart(); return previous.__handle; }
    if (region.children.length >= 3) region.firstElementChild.__handle.destroy(true);
    var node = document.createElement('div'); node.className = 'message message-' + type;
    node.dataset.content = content; node.dataset.type = type;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    var icons = window.__UI_ICONS || {};
    node.innerHTML = '<span class="message-icon" aria-hidden="true">' + (icons[type] || '') + '</span><span class="message-content"></span><button type="button" class="message-close" aria-label="关闭消息">' + (icons.close || '关闭') + '</button>';
    qs('.message-content',node).textContent = content;
    var timer, removed = false;
    function destroy(immediate) {
      if (removed) return; removed = true; clearTimeout(timer);
      function finish() { node.remove(); if (!region.children.length && region.hidePopover && region.matches(':popover-open')) region.hidePopover(); }
      if (immediate || reducedMotion.matches) { finish(); return; }
      node.classList.add('is-leaving'); setTimeout(finish, 140);
    }
    node.__handle = {destroy:destroy};
    node.__restart = function () { clearTimeout(timer); timer = setTimeout(destroy, duration || (type === 'error' ? 4500 : 2600)); };
    on(qs('.message-close',node),'click',function () { destroy(); });
    region.appendChild(node); node.__restart(); return node.__handle;
  }
  ['success','error','warning','info'].forEach(function (type) { message[type] = function (content) { return message(content,type); }; });

  function initImagePlaceholders() {
    qsa('.library-preview > img, .texture-preview > img').forEach(function (img) {
      var parent = img.parentElement;
      var skeleton = qs('.image-skeleton', parent);
      function finish(failed) {
        parent.dataset.imageState = failed ? 'error' : 'ready'; parent.setAttribute('aria-busy','false');
        if (!failed) { if (skeleton) skeleton.remove(); return; }
        img.hidden = true;
        if (skeleton) { skeleton.textContent = '预览暂不可用'; skeleton.removeAttribute('aria-hidden'); }
      }
      if (img.complete && img.naturalWidth) { finish(false); return; }
      if (!skeleton) { skeleton = document.createElement('span'); skeleton.className = 'image-skeleton'; skeleton.setAttribute('aria-hidden','true'); parent.appendChild(skeleton); }
      parent.dataset.imageState = 'loading'; parent.setAttribute('aria-busy','true');
      on(img,'load',function () { finish(false); },{once:true});
      on(img,'error',function () { finish(true); },{once:true});
      if (img.complete) finish(!img.naturalWidth);
    });
  }

  function initNavigationSkeleton() {
    var timer, watchdog, overlay, content, wasInert;
    function reset() {
      clearTimeout(timer); clearTimeout(watchdog);
      if (overlay) overlay.remove(); overlay = null;
      if (content) { content.inert = wasInert; content.removeAttribute('aria-busy'); }
      content = null;
    }
    function schedule(url) {
      reset();
      timer = setTimeout(function () {
        content = qs('[data-page-content]'); if (!content) return;
        wasInert = content.inert; content.inert = true; content.setAttribute('aria-busy','true');
        overlay = document.createElement('div'); overlay.className = 'page-skeleton'; overlay.setAttribute('aria-hidden','true');
        var cards = /\/(skinlib|textures|player|closet)/.test(url.pathname);
        overlay.innerHTML = '<div class="page-skeleton-heading skeleton-surface"></div><div class="page-skeleton-line skeleton-surface"></div>' +
          (cards ? '<div class="page-skeleton-grid">'+Array(4).fill('<div class="page-skeleton-card skeleton-surface"></div>').join('')+'</div>' : '<div class="page-skeleton-form">'+Array(5).fill('<span class="skeleton-surface"></span>').join('')+'</div>');
        content.appendChild(overlay); watchdog = setTimeout(reset,10000);
      },180);
    }
    on(document,'click',function (event) {
      if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;
      var anchor = event.target.closest('a[href]');
      if(!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target!=='_self'))return;
      var url = new URL(anchor.href,location.href);
      if(url.origin!==location.origin || url.searchParams.has('download') || (url.pathname===location.pathname && url.search===location.search) || /^\/(api|raw|textures|avatar|preview|\.well-known)(\/|$)/.test(url.pathname))return;
      queueMicrotask(function () { if(!event.defaultPrevented)schedule(url); });
    });
    on(document,'submit',function (event) {
      if(event.defaultPrevented || event.target.target==='_blank')return;
      var url = new URL(event.target.action || location.href,location.href);
      if(url.origin===location.origin)queueMicrotask(function () { if(!event.defaultPrevented)schedule(url); });
    });
    on(window,'pageshow',reset); on(window,'pagehide',reset);
    on(document,'site:navigation-start',function(event){schedule(new URL(event.detail.url));});
    on(document,'site:before-render',reset);
    on(document,'site:navigation-end',reset);
    on(document,'keydown',function (event) { if(event.key==='Escape')reset(); });
    if(window.navigation)on(window.navigation,'navigateerror',reset);
  }

  function initFeedback() {
    qsa('[data-feedback-message]').forEach(function (node) { message(node.dataset.feedbackMessage,node.dataset.messageType || 'success'); node.remove(); });
    var url = new URL(location.href), notice = url.searchParams.get('notice');
    var notices = {linked:'第三方账号已绑定',unlinked:'已解除第三方绑定','grant-revoked':'已撤销应用授权','sharing-disabled':'分享注册功能未启用','permission-denied':'需要管理员权限','session-expired':'会话已过期，请刷新页面后重试','registration-link-created':'注册链接已生成','registration-link-deleted':'注册链接已删除','registration-link-missing':'注册链接不存在或不属于你'};
    if (notices[notice]) { message(notices[notice],['sharing-disabled','permission-denied','session-expired','registration-link-missing'].includes(notice)?'warning':'success'); url.searchParams.delete('notice'); history.replaceState(history.state,'',url); }
  }

  function initPrivateIdentifiers() {
    var resetters = [];
    qsa('[data-private-identifier]').forEach(function (container) {
      var value = qs('[data-private-value]', container);
      var toggle = qs('[data-private-toggle]', container);
      var copy = qs('[data-private-copy]', container);
      if (!toggle || !copy || !value) return;
      var masked = value.textContent, pending, uuid;
      function reset() {
        value.textContent = masked;
        toggle.setAttribute('aria-pressed', 'false');
        toggle.setAttribute('aria-label', '显示完整 UUID');
      }
      resetters.push(reset);
      function load() {
        if (uuid) return Promise.resolve(uuid);
        if (!pending) pending = fetch(container.dataset.uuidUrl, {credentials:'same-origin',headers:{Accept:'application/json'}})
          .then(function (response) { if (!response.ok) throw new Error('无法读取 UUID，请刷新页面后重试'); return response.json(); })
          .then(function (data) { if (!/^[a-f0-9]{32}$/i.test(data.uuid)) throw new Error('UUID 无效'); uuid = data.uuid; return uuid; })
          .finally(function () { pending = null; });
        return pending;
      }
      on(toggle, 'click', function () {
        if (toggle.getAttribute('aria-pressed') === 'true') { reset(); return; }
        toggle.disabled = true;
        load().then(function (text) {
          if (document.hidden) return;
          value.textContent = text;
          toggle.setAttribute('aria-pressed', 'true');
          toggle.setAttribute('aria-label', '隐藏完整 UUID');
        }).catch(function (error) { message.error(error.message); }).finally(function () { toggle.disabled = false; });
      });
      on(copy, 'click', function () {
        copy.disabled = true;
        load().then(copyText).then(function () { message.success('UUID 已复制'); })
          .catch(function (error) { message.error(error.message); }).finally(function () { copy.disabled = false; });
      });
    });
    function resetAll() { resetters.forEach(function (reset) { reset(); }); }
    on(window, 'pagehide', resetAll);
    on(document, 'site:before-render', resetAll);
    on(document, 'visibilitychange', function () { if (document.hidden) resetAll(); });
  }

  function init() {
    listeners.abort(); listeners = new AbortController();
    openDropdown = null;
    initTheme();
    initLocale();
    initSidebar();
    initDropdowns();
    initTabs();
    initDialogs();
    initCopy();
    initFileInputs();
    initSwitches();
    initLogout();
    initConfirmForms();
    initAppearance();
    initPrivateIdentifiers();
    initImagePlaceholders();
    initNavigationSkeleton();
    initFeedback();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.UI = {
    mount: init,
    unmount: function () {
      qsa('[data-dropdown]').forEach(function (dropdown) { closeDropdown(dropdown, true); });
      qsa('dialog[open]').forEach(function (dialog) { dialog.dispatchEvent(new Event('cancel', {cancelable:true})); if(dialog.open && dialog.close)dialog.close(); });
      qsa('.sidebar-backdrop').forEach(function(node){node.remove();});
      var sidebar = qs('[data-sidebar]'); if(sidebar)sidebar.classList.remove('open');
      document.body.style.overflow=''; listeners.abort();
    },
    message: message,
    toast: function (content,type,title) { return title ? toast(content,type,title) : message(content,type); },
    notify: toast,
    confirm: confirmDialog,
    prompt: promptDialog,
    showDialog: showDialog,
    closeDialog: closeDialog,
    copy: copyText,
  };
})();
