/* MCNSKIN client actions — fetch-based, no jQuery/Bootstrap dependency. */
(function () {
  'use strict';

  document.querySelectorAll('form[data-action="unlink-identity"]').forEach(function (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!await confirmAction({title:'解除绑定',description:'确认解除此第三方账号与本站的绑定？',danger:true})) return;
      var button=form.querySelector('[type="submit"]'); button.disabled=true;
      try {
        var response=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{Accept:'application/json'},body:new URLSearchParams(new FormData(form))});
        var data=await response.json();
        if(!response.ok||data.code===1)throw new Error(data.message||'解绑失败');
        window.location.href='/user/connections?notice=unlinked';
      } catch(error) { button.disabled=false; if(window.UI)window.UI.message.error(error.message); }
    });
  });

  var CSRF = window.__CSRF || '';

  function api(method, url, body) {
    if (body === undefined && method !== 'GET' && method !== 'HEAD') body = {};
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(Object.assign({ csrf: CSRF }, body)),
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok || data.code === 1) throw new Error(data.message || '请求失败 (' + resp.status + ')');
        return data;
      });
    });
  }

  function showMessage(content, isError) {
    if (window.UI) window.UI.message(content, isError ? 'error' : 'success');
  }

  function confirmAction(options) {
    if (window.UI) return window.UI.confirm(options);
    return Promise.resolve(window.confirm(options.description || '确认操作？'));
  }

  function promptAction(options) {
    if (window.UI) return window.UI.prompt(options);
    return Promise.resolve(window.prompt(options.title || '请输入', options.value || ''));
  }

  function reloadLater(delay) {
    setTimeout(function () { window.location.reload(); }, delay || 450);
  }

  function formError(form, message) {
    var element = form.querySelector('[data-form-error]');
    if (element) {
      element.textContent = message;
      element.classList.remove('hidden');
    } else {
      showMessage(message, true);
    }
  }

  function closeDialogOf(element) {
    var dialog = element ? element.closest('dialog') : null;
    if (dialog && window.UI) window.UI.closeDialog(dialog);
  }

  /* --- Sign-in bonus --------------------------------------------------------- */
  var signBtn = document.getElementById('sign-btn');
  if (signBtn) {
    signBtn.addEventListener('click', function () {
      signBtn.disabled = true;
      api('POST', '/user/sign').then(function (data) {
        showMessage(data.message || '签到成功');
        var score = document.querySelector('[data-user-score]');
        if (score) score.textContent = String(parseInt(score.textContent, 10) + data.acquired);
        var message = document.getElementById('sign-msg');
        if (message) message.textContent = '今天已签到';
      }).catch(function (error) {
        signBtn.disabled = false;
        showMessage(error.message, true);
      });
    });
  }

  /* --- Add player ------------------------------------------------------------ */
  document.querySelectorAll('form[data-action="add-player"]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = form.querySelector('[name="name"]');
      var name = input ? input.value.trim() : '';
      if (!name) return;
      var submit = form.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      api('POST', '/api/player', { name: name }).then(function () {
        closeDialogOf(form);
        reloadLater();
      }).catch(function (error) {
        if (submit) submit.disabled = false;
        formError(form, error.message);
      });
    });
  });

  /* --- Delegated actions ----------------------------------------------------- */
  document.addEventListener('click', async function (event) {
    var element = event.target.closest('[data-action]');
    if (!element) return;
    var action = element.getAttribute('data-action');

    try {
      if (action === 'rename-player') {
        var newName = await promptAction({
          title: '重命名角色', label: '新的角色名', value: element.getAttribute('data-name') || '', maxLength: 16,
        });
        if (!newName) return;
        var renamed = await api('PUT', '/api/player/' + element.getAttribute('data-pid') + '/name', { name: newName });
        showMessage(renamed.message || '重命名成功');
        reloadLater();
      } else if (action === 'rename-texture') {
        var textureName = await promptAction({ title: '重命名材质', label: '材质名称', value: element.getAttribute('data-name') || '', maxLength: 50 });
        if (!textureName) return;
        await api('PUT', '/texture/' + element.getAttribute('data-tid') + '/name', { name: textureName });
        showMessage('材质名称已更新');
        reloadLater();
      } else if (action === 'delete-player') {
        var deleteName = element.getAttribute('data-name') || '该角色';
        var confirmed = await confirmAction({
          title: '删除角色',
          description: '确认删除角色「' + deleteName + '」？此操作不可撤销。',
          confirmText: '删除',
          danger: true,
        });
        if (!confirmed) return;
        var deleted = await api('DELETE', '/api/player/' + element.getAttribute('data-pid'));
        showMessage(deleted.message || '角色已删除');
        reloadLater();
      } else if (action === 'use-texture') {
        var pid = element.getAttribute('data-pid');
        var type = element.getAttribute('data-type');
        var tid = parseInt(element.getAttribute('data-tid'), 10);
        var body = type === 'cape' ? { cape: tid } : { skin: tid };
        var used = await api('PUT', '/api/player/' + pid + '/textures', body);
        showMessage(used.message || '材质已更新');
        closeDialogOf(element);
        reloadLater();
      } else if (action === 'clear-texture') {
        var cleared = await api('DELETE', '/api/player/' + element.getAttribute('data-pid') + '/textures/' + element.getAttribute('data-type'));
        showMessage(cleared.message || '材质已清除');
        closeDialogOf(element);
        reloadLater();
      } else if (action === 'rename-closet') {
        var closetName = await promptAction({
          title: '重命名衣柜物品', label: '新的名称', value: element.getAttribute('data-name') || '', maxLength: 50,
        });
        if (closetName === null) return;
        var closetRenamed = await api('PUT', '/api/closet/' + element.getAttribute('data-tid'), { name: closetName });
        showMessage(closetRenamed.message || '重命名成功');
        reloadLater();
      } else if (action === 'remove-closet') {
        var remove = await confirmAction({ title: '移出衣柜', description: '确认将这件材质移出衣柜？', confirmText: '移除', danger: true });
        if (!remove) return;
        var removed = await api('DELETE', '/api/closet/' + element.getAttribute('data-tid'));
        showMessage(removed.message || '已移出衣柜');
        reloadLater();
      } else if (action === 'add-closet') {
        var added = await api('POST', '/api/closet', { tid: parseInt(element.getAttribute('data-tid'), 10) });
        showMessage(added.message || '已添加到衣柜');
        reloadLater();
      } else if (action === 'toggle-privacy') {
        var makePublic = element.getAttribute('data-public') !== '1';
        var toggled = await api('PUT', '/api/skinlib/' + element.getAttribute('data-tid') + '/privacy', { public: makePublic ? '1' : '0' });
        showMessage(toggled.message || '已更新');
        reloadLater();
      } else if (action === 'delete-texture') {
        var removeTexture = await confirmAction({
          title: '删除材质', description: '确认删除该材质？使用它的角色将失去该材质。', confirmText: '删除', danger: true,
        });
        if (!removeTexture) return;
        var textureDeleted = await api('DELETE', '/api/skinlib/' + element.getAttribute('data-tid'));
        showMessage(textureDeleted.message || '材质已删除');
        window.location.href = '/skinlib';
      } else if (action === 'apply-texture') {
        element.disabled = true;
        var applyType = element.getAttribute('data-type');
        var applyBody = applyType === 'cape'
          ? { cape: parseInt(element.getAttribute('data-tid'), 10) }
          : { skin: parseInt(element.getAttribute('data-tid'), 10) };
        var applied;
        try {
          applied = await api('PUT', '/api/player/' + element.getAttribute('data-pid') + '/textures', applyBody);
        } catch (error) {
          element.disabled = false;
          throw error;
        }
        element.textContent = element.getAttribute('data-player-name') + ' · 已应用';
        showMessage(applied.message || '材质已应用');
      } else if (action === 'review-report') {
        var approve = element.getAttribute('data-approve') === '1';
        if (approve) {
          var confirmApprove = await confirmAction({ title: '同意举报', description: '确认同意举报并删除该材质？', confirmText: '同意并删除', danger: true });
          if (!confirmApprove) return;
        }
        var reviewed = await api('POST', '/api/admin/report/' + element.getAttribute('data-id') + '/review', { approve: approve ? '1' : '0' });
        showMessage(reviewed.message || '已处理');
        reloadLater();
      } else if (action === 'admin-edit-user') {
        var userDialog = document.getElementById('dialog-edit-user');
        if (!userDialog) return;
        document.getElementById('edit-user-uid').textContent = '#' + element.getAttribute('data-uid');
        var userForm = userDialog.querySelector('form');
        userForm.dataset.uid = element.getAttribute('data-uid');
        userForm.querySelector('[name="email"]').value = element.getAttribute('data-email') || '';
        userForm.querySelector('[name="nickname"]').value = element.getAttribute('data-nickname') || '';
        userForm.querySelector('[name="score"]').value = element.getAttribute('data-score') || '0';
        userForm.querySelector('[name="password"]').value = '';
        var userError = userForm.querySelector('[data-form-error]');
        if (userError) userError.classList.add('hidden');
        window.UI.showDialog(userDialog);
      } else if (action === 'admin-delete-user') {
        var removeUser = await confirmAction({ title: '删除用户', description: '确认删除该用户？其角色与衣柜将一并删除。', confirmText: '删除', danger: true });
        if (!removeUser) return;
        var userDeleted = await api('DELETE', '/api/admin/user/' + element.getAttribute('data-uid'));
        showMessage(userDeleted.message || '用户已删除');
        reloadLater();
      } else if (action === 'admin-edit-player') {
        var playerDialog = document.getElementById('dialog-edit-player');
        if (!playerDialog) return;
        document.getElementById('edit-player-pid').textContent = '#' + element.getAttribute('data-pid');
        var playerForm = playerDialog.querySelector('form');
        playerForm.dataset.pid = element.getAttribute('data-pid');
        playerForm.querySelector('[name="name"]').value = element.getAttribute('data-name') || '';
        playerForm.querySelector('[name="uid"]').value = element.getAttribute('data-uid') || '0';
        playerForm.querySelector('[name="skin"]').value = element.getAttribute('data-skin') || '0';
        playerForm.querySelector('[name="cape"]').value = element.getAttribute('data-cape') || '0';
        var playerError = playerForm.querySelector('[data-form-error]');
        if (playerError) playerError.classList.add('hidden');
        window.UI.showDialog(playerDialog);
      } else if (action === 'admin-delete-player') {
        var removePlayer = await confirmAction({ title: '删除角色', description: '确认删除该角色？', confirmText: '删除', danger: true });
        if (!removePlayer) return;
        var playerDeleted = await api('DELETE', '/api/admin/player/' + element.getAttribute('data-pid'));
        showMessage(playerDeleted.message || '角色已删除');
        reloadLater();
      } else if (action === 'admin-delete-texture') {
        var removeTextureAdmin = await confirmAction({ title: '删除材质', description: '确认删除该材质？', confirmText: '删除', danger: true });
        if (!removeTextureAdmin) return;
        var adminTextureDeleted = await api('DELETE', '/api/skinlib/' + element.getAttribute('data-tid'));
        showMessage(adminTextureDeleted.message || '材质已删除');
        reloadLater();
      }
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  /* --- Submit buttons inside dialogs ---------------------------------------- */
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-submit-form]');
    if (!button) return;
    var form = button.closest('dialog').querySelector('form[data-action="' + button.getAttribute('data-submit-form') + '"]');
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    else if (form) form.submit();
  });

  /* --- Inline admin selects -------------------------------------------------- */
  document.addEventListener('change', function (event) {
    var select = event.target.closest('[data-action="admin-set-user"]');
    if (!select) return;
    api('PUT', '/api/admin/user/' + select.getAttribute('data-uid'), {
      field: select.getAttribute('data-field'),
      value: select.value,
    }).then(function (data) {
      showMessage(data.message || '已更新');
    }).catch(function (error) {
      showMessage(error.message, true);
      reloadLater(900);
    });
  });

  /* --- Admin user form ------------------------------------------------------- */
  document.querySelectorAll('form[data-action="admin-save-user"]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var uid = form.dataset.uid;
      if (!uid) return;
      var updates = [
        { field: 'email', value: form.querySelector('[name="email"]').value },
        { field: 'nickname', value: form.querySelector('[name="nickname"]').value },
        { field: 'score', value: form.querySelector('[name="score"]').value },
      ];
      var password = form.querySelector('[name="password"]').value;
      if (password) updates.push({ field: 'password', value: password });
      Promise.all(updates.map(function (update) {
        return api('PUT', '/api/admin/user/' + uid, update);
      })).then(function () {
        showMessage('已保存');
        closeDialogOf(form);
        reloadLater();
      }).catch(function (error) {
        formError(form, error.message);
      });
    });
  });

  /* --- Admin player form ----------------------------------------------------- */
  document.querySelectorAll('form[data-action="admin-save-player"]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var pid = form.dataset.pid;
      if (!pid) return;
      var updates = [
        { field: 'name', value: form.querySelector('[name="name"]').value },
        { field: 'owner', value: form.querySelector('[name="uid"]').value },
        { field: 'skin', value: form.querySelector('[name="skin"]').value },
        { field: 'cape', value: form.querySelector('[name="cape"]').value },
      ];
      Promise.all(updates.map(function (update) {
        return api('PUT', '/api/admin/player/' + pid, update);
      })).then(function () {
        showMessage('已保存');
        closeDialogOf(form);
        reloadLater();
      }).catch(function (error) {
        formError(form, error.message);
      });
    });
  });

  /* --- Texture description --------------------------------------------------- */
  document.querySelectorAll('form[data-action="texture-model"]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      api('PUT', '/texture/' + form.dataset.tid + '/type', { type: form.elements.type.value }).then(function () {
        showMessage('皮肤模型已更新'); reloadLater();
      }).catch(function (error) { button.disabled = false; showMessage(error.message, true); });
    });
  });
  document.querySelectorAll('form[data-action="save-description"]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      api('PUT', '/api/skinlib/' + form.dataset.tid + '/description', {
        description: form.querySelector('[name="description"]').value,
      }).then(function (data) {
        showMessage(data.message || '已保存');
        reloadLater();
      }).catch(function (error) {
        showMessage(error.message, true);
      });
    });
  });

  /* --- Report form ----------------------------------------------------------- */
  document.querySelectorAll('form[data-action="submit-report"]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      api('POST', '/api/skinlib/' + form.dataset.tid + '/report', {
        reason: form.querySelector('[name="reason"]').value,
      }).then(function (data) {
        showMessage(data.message || '举报已提交');
        closeDialogOf(form);
        reloadLater();
      }).catch(function (error) {
        formError(form, error.message);
      });
    });
  });

  /* --- Upload ---------------------------------------------------------------- */
  var uploadForm = document.getElementById('upload-form');
  if (uploadForm) {
    var uploadFile = uploadForm.querySelector('[name="file"]');
    var uploadName = uploadForm.querySelector('[name="name"]');
    var uploadType = uploadForm.querySelector('[name="type"]');
    var uploadModel = uploadForm.querySelector('[name="model"]');
    var estimate = document.getElementById('upload-estimate');
    function updateUploadEstimate() {
      uploadModel.disabled = uploadType.value === 'cape';
      var file = uploadFile.files && uploadFile.files[0];
      if (!estimate) return;
      estimate.hidden = !file;
      if (!file) return;
      var size = Math.ceil(file.size / 1024);
      var visibility = uploadForm.querySelector('[name="public"]:checked');
      var rate = Number(visibility && visibility.value === '1' ? uploadForm.dataset.publicStorage : uploadForm.dataset.privateStorage);
      var cost = size * rate + Number(uploadForm.dataset.closetCost) - Number(uploadForm.dataset.uploadAward);
      var insufficient = cost > Number(uploadForm.dataset.score);
      estimate.textContent = '文件 ' + size + ' KB · ' + (cost < 0 ? '预计获得 ' + (-cost) : '预计消耗 ' + cost) + ' 积分（已计入衣柜费用和上传奖励）' + (insufficient ? '，当前积分不足。' : '。');
      estimate.classList.toggle('text-destructive', insufficient);
      estimate.classList.toggle('text-muted-foreground', !insufficient);
    }
    uploadFile.addEventListener('change', function () {
      var file = uploadFile.files && uploadFile.files[0];
      if (file && !uploadName.value.trim()) uploadName.value = file.name.replace(/\.png$/i, '').slice(0, 50);
    });
    uploadForm.addEventListener('change', updateUploadEstimate);
    updateUploadEstimate();
    uploadForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var errorElement = document.getElementById('upload-error');
      if (errorElement) errorElement.classList.add('hidden');
      var data = new FormData(uploadForm);
      data.append('csrf', CSRF);
      var button = uploadForm.querySelector('[type="submit"]');
      if (button) button.disabled = true;
      fetch('/api/skinlib', { method: 'POST', body: data, credentials: 'same-origin' })
        .then(function (response) { return response.json(); })
        .then(function (result) {
          if (result.code === 0 && result.redirect) {
            window.location.href = result.redirect;
          } else if (result.code === 2 && result.redirect) {
            showMessage(result.message || '该材质已存在');
            window.location.href = result.redirect;
          } else {
            throw new Error(result.message || '上传失败');
          }
        })
        .catch(function (error) {
          if (errorElement) {
            errorElement.textContent = error.message;
            errorElement.classList.remove('hidden');
          }
          showMessage(error.message, true);
          if (button) button.disabled = false;
        });
    });
  }
})();
