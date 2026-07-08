(function () {
  try {
    var old = document.getElementById('robot-ui-pro-style');
    if (old) old.remove();
    var oldBadge = document.getElementById('robot-ui-pro-badge');
    if (oldBadge) oldBadge.remove();
    var oldPanel = document.getElementById('robot-ui-voice-panel');
    if (oldPanel) oldPanel.remove();
    if (window.__robotUiProObserver) {
      try { window.__robotUiProObserver.disconnect(); } catch (_) {}
      window.__robotUiProObserver = null;
    }

    var style = document.createElement('style');
    style.id = 'robot-ui-pro-style';
    style.textContent = [
      ':root{--pro-blue:#2f68ff;--pro-red:#ff5f6d;--pro-panel:#0d1e45;--pro-panel-2:#13295f;}',
      'button,[role="button"]{border-radius:14px!important;font-weight:700!important;}',
      '.robot-ui-pro-stop,.robot-ui-pro-stop *{background:linear-gradient(180deg,#ff6f79,var(--pro-red))!important;color:#fff!important;}',
      '#robot-ui-pro-badge{position:fixed;top:10px;right:12px;z-index:2147483647;background:rgba(25,44,94,.9);color:#dfe9ff;border:1px solid rgba(93,128,255,.85);border-radius:999px;padding:6px 10px;font-size:12px;backdrop-filter:blur(4px);}',
      '#robot-ui-voice-panel{position:fixed;right:12px;bottom:86px;z-index:2147483647;width:280px;background:linear-gradient(180deg,var(--pro-panel),var(--pro-panel-2));border:1px solid rgba(93,128,255,.55);border-radius:12px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);color:#e9f0ff;font-family:Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;}',
      '#robot-ui-voice-title{font-size:13px;font-weight:700;margin:0 0 8px 0;color:#dce7ff;}',
      '#robot-ui-voice-row{display:flex;gap:8px;align-items:center;}',
      '#robot-ui-voice-btn{flex:1;border:none;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:700;cursor:pointer;background:linear-gradient(180deg,#2f68ff,#2457d7);color:#fff;}',
      '#robot-ui-voice-btn.listening{background:linear-gradient(180deg,#ff6f79,#ff4b5b);}',
      '#robot-ui-voice-last{margin-top:8px;font-size:12px;line-height:1.4;opacity:.95;min-height:32px;white-space:pre-wrap;}',
      '#robot-ui-voice-status{margin-top:6px;font-size:11px;color:#aecdff;}',
      '#robot-ui-voice-conf{margin-top:8px;font-size:11px;color:#b9cbf9;cursor:pointer;user-select:none;}',
      '#robot-ui-voice-settings{display:none;margin-top:8px;border-top:1px solid rgba(120,150,220,.4);padding-top:8px;}',
      '#robot-ui-voice-settings.show{display:block;}',
      '#robot-ui-voice-settings input{width:100%;margin-top:5px;background:#0a1738;border:1px solid rgba(102,133,214,.6);border-radius:8px;color:#e6eeff;padding:6px 8px;font-size:11px;}',
      '#robot-ui-voice-settings label{display:block;font-size:11px;margin-top:5px;color:#c7d8ff;}',
      '#robot-ui-voice-save{margin-top:8px;border:none;border-radius:8px;padding:6px 8px;background:#1f4dc9;color:#fff;font-size:11px;cursor:pointer;}'
    ].join('');
    document.head.appendChild(style);

    var storageKey = 'robot.ui.voice.llm';
    var defaultLlm = {
      enabled: false,
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: ''
    };

    function loadLlmConfig() {
      try {
        var raw = localStorage.getItem(storageKey);
        if (!raw) return defaultLlm;
        var parsed = JSON.parse(raw);
        return {
          enabled: !!parsed.enabled,
          endpoint: parsed.endpoint || defaultLlm.endpoint,
          model: parsed.model || defaultLlm.model,
          apiKey: parsed.apiKey || ''
        };
      } catch (_) {
        return defaultLlm;
      }
    }

    function saveLlmConfig(cfg) {
      localStorage.setItem(storageKey, JSON.stringify(cfg));
    }

    function byText(selector, keyword) {
      var all = Array.prototype.slice.call(document.querySelectorAll(selector));
      var key = String(keyword || '').replace(/\s+/g, '');
      if (!key) return null;
      for (var i = 0; i < all.length; i++) {
        var t = String(all[i].textContent || '').replace(/\s+/g, '');
        if (t.indexOf(key) >= 0) return all[i];
      }
      return null;
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

    function llmPromptForAction(userText) {
      return [
        '你是机器人语音指令解析器。',
        '将用户话术严格映射成一个动作关键词，只能输出以下之一：',
        'forward,backward,left,right,stop,grab,release,gravity,none',
        '不要输出任何多余文本。',
        '用户输入：' + userText
      ].join('\n');
    }

    function parseActionWithLlm(text, cfg) {
      if (!cfg || !cfg.enabled || !cfg.endpoint || !cfg.apiKey || !cfg.model) {
        return Promise.resolve(null);
      }
      return fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: 'You convert voice text to one command token.' },
            { role: 'user', content: llmPromptForAction(text) }
          ],
          temperature: 0
        })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var out = (((data || {}).choices || [])[0] || {}).message || {};
          var content = String(out.content || '').trim().toLowerCase();
          var valid = ['forward', 'backward', 'left', 'right', 'stop', 'grab', 'release', 'gravity', 'none'];
          if (valid.indexOf(content) >= 0) return content === 'none' ? null : content;
          return null;
        })
        .catch(function () { return null; });
    }

    function createVoicePanel() {
      var panel = document.createElement('div');
      panel.id = 'robot-ui-voice-panel';
      panel.innerHTML = '' +
        '<div id="robot-ui-voice-title">语音操控系统</div>' +
        '<div id="robot-ui-voice-row"><button id="robot-ui-voice-btn">🎤 开始语音</button></div>' +
        '<div id="robot-ui-voice-last">最近识别：无</div>' +
        '<div id="robot-ui-voice-status">状态：待机</div>' +
        '<div id="robot-ui-voice-conf">高级设置（语音大模型）</div>' +
        '<div id="robot-ui-voice-settings">' +
        '  <label><input id="robot-ui-voice-llm-enabled" type="checkbox" /> 启用大模型语义解析</label>' +
        '  <label>Endpoint</label><input id="robot-ui-voice-llm-endpoint" placeholder="https://api.openai.com/v1/chat/completions" />' +
        '  <label>Model</label><input id="robot-ui-voice-llm-model" placeholder="gpt-4o-mini" />' +
        '  <label>API Key</label><input id="robot-ui-voice-llm-key" type="password" placeholder="sk-..." />' +
        '  <button id="robot-ui-voice-save">保存设置</button>' +
        '</div>';
      document.body.appendChild(panel);
      return panel;
    }

    function setupVoiceSystem() {
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      var panel = createVoicePanel();
      var btn = panel.querySelector('#robot-ui-voice-btn');
      var last = panel.querySelector('#robot-ui-voice-last');
      var status = panel.querySelector('#robot-ui-voice-status');
      var conf = panel.querySelector('#robot-ui-voice-conf');
      var settings = panel.querySelector('#robot-ui-voice-settings');
      var save = panel.querySelector('#robot-ui-voice-save');
      var llmEnabled = panel.querySelector('#robot-ui-voice-llm-enabled');
      var llmEndpoint = panel.querySelector('#robot-ui-voice-llm-endpoint');
      var llmModel = panel.querySelector('#robot-ui-voice-llm-model');
      var llmKey = panel.querySelector('#robot-ui-voice-llm-key');

      var cfg = loadLlmConfig();
      llmEnabled.checked = !!cfg.enabled;
      llmEndpoint.value = cfg.endpoint || '';
      llmModel.value = cfg.model || '';
      llmKey.value = cfg.apiKey || '';

      conf.addEventListener('click', function () {
        settings.classList.toggle('show');
      });

      save.addEventListener('click', function () {
        cfg = {
          enabled: !!llmEnabled.checked,
          endpoint: String(llmEndpoint.value || '').trim(),
          model: String(llmModel.value || '').trim(),
          apiKey: String(llmKey.value || '').trim()
        };
        saveLlmConfig(cfg);
        status.textContent = '状态：已保存语音大模型配置';
      });

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
        cfg = loadLlmConfig();
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
        } catch (e) {
          status.textContent = '状态：启动失败 ' + (e && e.message ? e.message : 'unknown');
        }
      });
    }

    function patch() {
      document.title = '辰龙机器人控制台 Pro';
      var titleEl = byText('h1,h2,h3,div,span,p', '控制台');
      if (titleEl) titleEl.textContent = '辰龙机器人控制台 Pro';

      var stopBtn = byText('button,[role="button"],div[role="button"]', '停止') || byText('button,[role="button"],div[role="button"]', '停');
      if (stopBtn) stopBtn.classList.add('robot-ui-pro-stop');

      var badge = document.getElementById('robot-ui-pro-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'robot-ui-pro-badge';
        badge.textContent = 'PRO 已生效';
        document.body.appendChild(badge);
      }
    }

    patch();
    setupVoiceSystem();

    var observer = new MutationObserver(function () { patch(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__robotUiProObserver = observer;
  } catch (e) {
    console.error('robot-ui-pro inject failed:', e);
  }
})();
