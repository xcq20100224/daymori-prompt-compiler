// ==UserScript==
// @name         Robot UI Pro + Voice Persistent Patch
// @namespace    daymori.robot.patch
// @version      0.4.0
// @description  Persistent Pro patch with voice control, operation console, and optional LLM parsing for robot UI.
// @author       You
// @match        http://192.168.4.1/*
// @match        http://192.168.4.1:*/*
// @match        http://192.168.8.5/*
// @match        http://192.168.8.5:*/*
// @include      http://192.168.*.*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var STYLE_ID = 'robot-ui-pro-style';
  var BADGE_ID = 'robot-ui-pro-badge';
  var PANEL_ID = 'robot-ui-voice-panel';
  var OBSERVER_KEY = '__robotUiProObserver';
  var VOICE_CFG_KEY = 'robot.ui.voice.llm';
  var patched = false;

  var PROVIDER_PRESETS = {
    openai: {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini'
    },
    deepseek: {
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat'
    },
    qwen: {
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-plus'
    },
    custom: {
      endpoint: '',
      model: ''
    }
  };

  function removeIfExists(id) {
    var el = document.getElementById(id);
    if (el) el.remove();
  }

  function byText(selector, keyword) {
    var all = Array.prototype.slice.call(document.querySelectorAll(selector));
    var key = String(keyword || '').replace(/\s+/g, '');
    if (!key) return null;
    for (var i = 0; i < all.length; i++) {
      var txt = String(all[i].textContent || '').replace(/\s+/g, '');
      if (txt.indexOf(key) >= 0) return all[i];
    }
    return null;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      ':root{--pro-blue:#2f68ff;--pro-red:#ff5f6d;--pro-panel:#0d1e45;--pro-panel-2:#13295f;}',
      'button,[role="button"]{border-radius:14px!important;font-weight:700!important;}',
      '.robot-ui-pro-stop,.robot-ui-pro-stop *{background:linear-gradient(180deg,#ff6f79,var(--pro-red))!important;color:#fff!important;}',
      '#' + BADGE_ID + '{position:fixed;top:10px;right:12px;z-index:2147483647;background:rgba(25,44,94,.9);color:#dfe9ff;border:1px solid rgba(93,128,255,.85);border-radius:999px;padding:6px 10px;font-size:12px;backdrop-filter:blur(4px);}',
      '#' + PANEL_ID + '{position:fixed;right:12px;bottom:86px;z-index:2147483647;width:280px;background:linear-gradient(180deg,var(--pro-panel),var(--pro-panel-2));border:1px solid rgba(93,128,255,.55);border-radius:12px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);color:#e9f0ff;font-family:Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;}',
      '#robot-ui-voice-title{font-size:13px;font-weight:700;margin:0 0 8px 0;color:#dce7ff;}',
      '#robot-ui-voice-btn{width:100%;border:none;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:700;cursor:pointer;background:linear-gradient(180deg,#2f68ff,#2457d7);color:#fff;}',
      '#robot-ui-voice-btn.listening{background:linear-gradient(180deg,#ff6f79,#ff4b5b);}',
      '#robot-ui-voice-last{margin-top:8px;font-size:12px;line-height:1.4;min-height:32px;white-space:pre-wrap;}',
      '#robot-ui-voice-status{margin-top:6px;font-size:11px;color:#aecdff;}',
      '#robot-ui-voice-conf{margin-top:8px;font-size:11px;color:#b9cbf9;cursor:pointer;user-select:none;}',
      '#robot-ui-voice-settings{display:none;margin-top:8px;border-top:1px solid rgba(120,150,220,.4);padding-top:8px;}',
      '#robot-ui-voice-settings.show{display:block;}',
      '#robot-ui-voice-settings input{width:100%;margin-top:5px;background:#0a1738;border:1px solid rgba(102,133,214,.6);border-radius:8px;color:#e6eeff;padding:6px 8px;font-size:11px;}',
      '#robot-ui-voice-settings select{width:100%;margin-top:5px;background:#0a1738;border:1px solid rgba(102,133,214,.6);border-radius:8px;color:#e6eeff;padding:6px 8px;font-size:11px;}',
      '#robot-ui-voice-settings label{display:block;font-size:11px;margin-top:5px;color:#c7d8ff;}',
      '#robot-ui-voice-actions{display:flex;gap:6px;margin-top:8px;}',
      '#robot-ui-voice-save,#robot-ui-voice-test{flex:1;border:none;border-radius:8px;padding:6px 8px;color:#fff;font-size:11px;cursor:pointer;}',
      '#robot-ui-voice-save{background:#1f4dc9;}',
      '#robot-ui-voice-test{background:#2e7d32;}',
      '#robot-ui-op-wrap{margin-top:10px;border-top:1px solid rgba(120,150,220,.4);padding-top:8px;}',
      '#robot-ui-op-title{font-size:12px;font-weight:700;color:#dce7ff;margin-bottom:6px;}',
      '#robot-ui-op-input{width:100%;background:#0a1738;border:1px solid rgba(102,133,214,.6);border-radius:8px;color:#e6eeff;padding:7px 8px;font-size:12px;}',
      '#robot-ui-op-row{display:flex;gap:6px;margin-top:6px;}',
      '#robot-ui-op-run,#robot-ui-op-stop{flex:1;border:none;border-radius:8px;padding:6px 8px;color:#fff;font-size:11px;cursor:pointer;}',
      '#robot-ui-op-run{background:#2457d7;}',
      '#robot-ui-op-stop{background:#d64555;}',
      '.robot-ui-op-quick{margin-top:6px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}',
      '.robot-ui-op-quick button{border:none;border-radius:8px;padding:6px 0;background:#1f315f;color:#dbe7ff;font-size:11px;cursor:pointer;}'
    ].join('');
    document.head.appendChild(style);
  }

  function defaultVoiceConfig() {
    return {
      enabled: false,
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: ''
    };
  }

  function loadVoiceConfig() {
    try {
      var raw = localStorage.getItem(VOICE_CFG_KEY);
      if (!raw) return defaultVoiceConfig();
      var parsed = JSON.parse(raw);
      return {
        enabled: !!parsed.enabled,
        provider: parsed.provider || 'openai',
        endpoint: parsed.endpoint || defaultVoiceConfig().endpoint,
        model: parsed.model || defaultVoiceConfig().model,
        apiKey: parsed.apiKey || ''
      };
    } catch (_) {
      return defaultVoiceConfig();
    }
  }

  function saveVoiceConfig(cfg) {
    localStorage.setItem(VOICE_CFG_KEY, JSON.stringify(cfg));
  }

  function applyPreset(provider, endpointInput, modelInput, keepModel) {
    var p = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    endpointInput.value = p.endpoint || endpointInput.value || '';
    if (!keepModel || !String(modelInput.value || '').trim()) {
      modelInput.value = p.model || modelInput.value || '';
    }
  }

  function normalizeActionToken(raw) {
    var token = String(raw || '').trim().toLowerCase();
    if (!token) return null;

    // Strip markdown and punctuation wrappers.
    token = token.replace(/^```[a-z]*|```$/g, '').trim();
    token = token.replace(/[\s"'`.,，。:：;；!?！？()\[\]{}]/g, '');

    // JSON response fallback.
    if (token.indexOf('{') >= 0 || token.indexOf('action') >= 0) {
      try {
        var json = JSON.parse(String(raw || '').trim());
        if (json && json.action) token = String(json.action).toLowerCase();
      } catch (_) {}
    }

    var map = {
      forward: 'forward',
      goforward: 'forward',
      ahead: 'forward',
      '前进': 'forward',
      '向前': 'forward',
      backward: 'backward',
      back: 'backward',
      goback: 'backward',
      '后退': 'backward',
      '向后': 'backward',
      left: 'left',
      turnleft: 'left',
      '左转': 'left',
      '向左': 'left',
      right: 'right',
      turnright: 'right',
      '右转': 'right',
      '向右': 'right',
      stop: 'stop',
      brake: 'stop',
      '停止': 'stop',
      '停下': 'stop',
      grab: 'grab',
      pickup: 'grab',
      '抓取': 'grab',
      '抓住': 'grab',
      release: 'release',
      open: 'release',
      '释放': 'release',
      '松开': 'release',
      gravity: 'gravity',
      gyroscope: 'gravity',
      '重力遥控': 'gravity',
      '重力': 'gravity',
      none: 'none',
      null: 'none',
      unknown: 'none'
    };

    return map[token] || null;
  }

  function clickActionByName(action) {
    var map = {
      forward: ['前进', '▲'],
      backward: ['后退', '▼'],
      left: ['左转', '◀'],
      right: ['右转', '▶'],
      stop: ['停止', '停'],
      grab: ['抓取'],
      release: ['释放'],
      gravity: ['重力遥控']
    };
    var keys = map[action] || [];
    for (var i = 0; i < keys.length; i++) {
      var btn = byText('button,[role="button"],div[role="button"]', keys[i]);
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function parseActionLocal(text) {
    var t = String(text || '').toLowerCase();
    if (!t) return null;
    if (/停止|停下|刹车|stop/.test(t)) return 'stop';
    if (/前进|向前|forward/.test(t)) return 'forward';
    if (/后退|向后|back|backward/.test(t)) return 'backward';
    if (/左转|向左|left/.test(t)) return 'left';
    if (/右转|向右|right/.test(t)) return 'right';
    if (/抓取|抓住|夹住|grab/.test(t)) return 'grab';
    if (/释放|松开|release/.test(t)) return 'release';
    if (/重力|遥控|gravity/.test(t)) return 'gravity';
    return null;
  }

  function parseActionWithLlm(text, cfg) {
    if (!cfg || !cfg.enabled || !cfg.endpoint || !cfg.model || !cfg.apiKey) {
      return Promise.resolve(null);
    }

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (controller) {
      timer = setTimeout(function () {
        try { controller.abort(); } catch (_) {}
      }, 12000);
    }

    return fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      signal: controller ? controller.signal : undefined,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: 'You are a strict command mapper. Output one token only: forward,backward,left,right,stop,grab,release,gravity,none' },
          { role: 'user', content: '用户语音：' + text }
        ],
        temperature: 0
      })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var messageContent = String(((((data || {}).choices || [])[0] || {}).message || {}).content || '').trim();
        var outputText = String((data || {}).output_text || '').trim();
        var raw = messageContent || outputText;
        var normalized = normalizeActionToken(raw);
        if (!normalized || normalized === 'none') return null;
        return normalized;
      })
      .catch(function () { return null; })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });
  }

  function testLlmConnectivity(cfg) {
    if (!cfg || !cfg.endpoint || !cfg.model || !cfg.apiKey) {
      return Promise.resolve({ ok: false, msg: '请先补全 endpoint / model / api key' });
    }
    return parseActionWithLlm('测试：请返回 none', cfg)
      .then(function () { return { ok: true, msg: '连接测试完成（接口可访问）' }; })
      .catch(function () { return { ok: false, msg: '连接测试失败' }; });
  }

  function createVoicePanel() {
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = '' +
      '<div id="robot-ui-voice-title">语音操控系统</div>' +
      '<button id="robot-ui-voice-btn">🎤 开始语音</button>' +
      '<div id="robot-ui-voice-last">最近识别：无</div>' +
      '<div id="robot-ui-voice-status">状态：待机</div>' +
      '<div id="robot-ui-voice-conf">高级设置（语音大模型）</div>' +
      '<div id="robot-ui-voice-settings">' +
      '  <label><input id="robot-ui-voice-llm-enabled" type="checkbox" /> 启用大模型语义解析</label>' +
      '  <label>Provider</label><select id="robot-ui-voice-llm-provider"><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="qwen">Qwen(阿里兼容)</option><option value="custom">Custom</option></select>' +
      '  <label>Endpoint</label><input id="robot-ui-voice-llm-endpoint" placeholder="https://api.openai.com/v1/chat/completions" />' +
      '  <label>Model</label><input id="robot-ui-voice-llm-model" placeholder="gpt-4o-mini" />' +
      '  <label>API Key</label><input id="robot-ui-voice-llm-key" type="password" placeholder="sk-..." />' +
      '  <div id="robot-ui-voice-actions"><button id="robot-ui-voice-save">保存设置</button><button id="robot-ui-voice-test">连接测试</button></div>' +
      '</div>' +
      '<div id="robot-ui-op-wrap">' +
      '  <div id="robot-ui-op-title">操作系统</div>' +
      '  <input id="robot-ui-op-input" placeholder="输入命令：前进/后退/左转/右转/停止/抓取/释放/重力遥控" />' +
      '  <div id="robot-ui-op-row"><button id="robot-ui-op-run">执行命令</button><button id="robot-ui-op-stop">紧急停止</button></div>' +
      '  <div class="robot-ui-op-quick">' +
      '    <button data-op-action="forward">前进</button>' +
      '    <button data-op-action="left">左转</button>' +
      '    <button data-op-action="right">右转</button>' +
      '    <button data-op-action="backward">后退</button>' +
      '    <button data-op-action="grab">抓取</button>' +
      '    <button data-op-action="release">释放</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(panel);
    return panel;
  }

  function setupVoiceSystem() {
    if (document.getElementById(PANEL_ID)) return;
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    var panel = createVoicePanel();
    var btn = panel.querySelector('#robot-ui-voice-btn');
    var last = panel.querySelector('#robot-ui-voice-last');
    var status = panel.querySelector('#robot-ui-voice-status');
    var conf = panel.querySelector('#robot-ui-voice-conf');
    var settings = panel.querySelector('#robot-ui-voice-settings');
    var saveBtn = panel.querySelector('#robot-ui-voice-save');
    var testBtn = panel.querySelector('#robot-ui-voice-test');
    var llmEnabled = panel.querySelector('#robot-ui-voice-llm-enabled');
    var llmProvider = panel.querySelector('#robot-ui-voice-llm-provider');
    var llmEndpoint = panel.querySelector('#robot-ui-voice-llm-endpoint');
    var llmModel = panel.querySelector('#robot-ui-voice-llm-model');
    var llmKey = panel.querySelector('#robot-ui-voice-llm-key');
    var opInput = panel.querySelector('#robot-ui-op-input');
    var opRun = panel.querySelector('#robot-ui-op-run');
    var opStop = panel.querySelector('#robot-ui-op-stop');
    var opQuick = panel.querySelectorAll('[data-op-action]');

    var cfg = loadVoiceConfig();
    llmEnabled.checked = !!cfg.enabled;
    llmProvider.value = cfg.provider || 'openai';
    llmEndpoint.value = cfg.endpoint || '';
    llmModel.value = cfg.model || '';
    llmKey.value = cfg.apiKey || '';

    if (!String(llmEndpoint.value || '').trim()) {
      applyPreset(llmProvider.value, llmEndpoint, llmModel, false);
    }

    conf.addEventListener('click', function () {
      settings.classList.toggle('show');
    });

    llmProvider.addEventListener('change', function () {
      applyPreset(llmProvider.value, llmEndpoint, llmModel, false);
    });

    saveBtn.addEventListener('click', function () {
      cfg = {
        enabled: !!llmEnabled.checked,
        provider: String(llmProvider.value || 'custom'),
        endpoint: String(llmEndpoint.value || '').trim(),
        model: String(llmModel.value || '').trim(),
        apiKey: String(llmKey.value || '').trim()
      };
      saveVoiceConfig(cfg);
      status.textContent = '状态：已保存语音大模型配置';
    });

    testBtn.addEventListener('click', function () {
      cfg = {
        enabled: true,
        provider: String(llmProvider.value || 'custom'),
        endpoint: String(llmEndpoint.value || '').trim(),
        model: String(llmModel.value || '').trim(),
        apiKey: String(llmKey.value || '').trim()
      };
      status.textContent = '状态：正在测试连接...';
      testLlmConnectivity(cfg).then(function (res) {
        status.textContent = '状态：' + res.msg;
      });
    });

    function runOperationCommand(text) {
      var action = parseActionLocal(text);
      if (!action) {
        status.textContent = '状态：操作系统未识别命令';
        return;
      }
      var ok = clickActionByName(action);
      status.textContent = ok ? ('状态：操作系统已执行 ' + action) : ('状态：操作系统未找到按钮 ' + action);
    }

    opRun.addEventListener('click', function () {
      runOperationCommand(String(opInput.value || ''));
    });

    opInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        runOperationCommand(String(opInput.value || ''));
      }
    });

    opStop.addEventListener('click', function () {
      var ok = clickActionByName('stop');
      status.textContent = ok ? '状态：操作系统已执行 stop' : '状态：操作系统未找到 stop 按钮';
    });

    for (var i = 0; i < opQuick.length; i++) {
      opQuick[i].addEventListener('click', function () {
        var action = this.getAttribute('data-op-action');
        var ok = clickActionByName(action);
        status.textContent = ok ? ('状态：操作系统已执行 ' + action) : ('状态：操作系统未找到按钮 ' + action);
      });
    }

    if (!SpeechRecognition) {
      btn.disabled = true;
      status.textContent = '状态：当前浏览器不支持语音识别';
      return;
    }

    var recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;

    var listening = false;
    function setListening(v) {
      listening = v;
      btn.classList.toggle('listening', v);
      btn.textContent = v ? '🛑 停止语音' : '🎤 开始语音';
    }

    recognition.onstart = function () {
      setListening(true);
      status.textContent = '状态：正在听...';
    };

    recognition.onend = function () {
      setListening(false);
    };

    recognition.onerror = function (e) {
      status.textContent = '状态：语音识别失败 ' + (e && e.error ? e.error : 'unknown');
    };

    recognition.onresult = function (event) {
      var text = '';
      try {
        text = event.results[0][0].transcript || '';
      } catch (_) {
        text = '';
      }
      text = String(text || '').trim();
      last.textContent = '最近识别：' + (text || '无');
      if (!text) {
        status.textContent = '状态：未识别到有效语音';
        return;
      }

      status.textContent = '状态：解析中...';
      cfg = loadVoiceConfig();
      parseActionWithLlm(text, cfg).then(function (llmAction) {
        var action = llmAction || parseActionLocal(text);
        if (!action) {
          status.textContent = '状态：未匹配到动作';
          return;
        }
        var ok = clickActionByName(action);
        status.textContent = ok ? ('状态：已执行 ' + action) : ('状态：动作按钮未找到 ' + action);
      });
    };

    btn.addEventListener('click', function () {
      try {
        if (listening) {
          recognition.stop();
        } else {
          recognition.start();
        }
      } catch (_) {
        status.textContent = '状态：启动失败';
      }
    });
  }

  function patchUi() {
    document.title = '辰龙机器人控制台 Pro';
    var titleEl = byText('h1,h2,h3,div,span,p', '控制台');
    if (titleEl) titleEl.textContent = '辰龙机器人控制台 Pro';

    var stopBtn = byText('button,[role="button"],div[role="button"]', '停止') || byText('button,[role="button"],div[role="button"]', '停');
    if (stopBtn) stopBtn.classList.add('robot-ui-pro-stop');

    if (!document.getElementById(BADGE_ID)) {
      var badge = document.createElement('div');
      badge.id = BADGE_ID;
      badge.textContent = 'PRO 已生效';
      document.body.appendChild(badge);
    }
  }

  function startPatchLoop() {
    if (patched) return;
    patched = true;

    removeIfExists(PANEL_ID);
    removeIfExists(BADGE_ID);
    injectStyle();
    patchUi();
    setupVoiceSystem();

    if (window[OBSERVER_KEY]) {
      try { window[OBSERVER_KEY].disconnect(); } catch (_) {}
      window[OBSERVER_KEY] = null;
    }

    var observer = new MutationObserver(function () {
      patchUi();
      setupVoiceSystem();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window[OBSERVER_KEY] = observer;
  }

  function boot() {
    if (document.body && document.head) {
      startPatchLoop();
      return;
    }
    setTimeout(boot, 120);
  }

  boot();
})();
