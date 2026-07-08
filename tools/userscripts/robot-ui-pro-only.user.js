// ==UserScript==
// @name         Robot UI Pro Title Only
// @namespace    daymori.robot.patch
// @version      0.1.0
// @description  Keep only the Pro title patch and persist across refresh.
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

  function ensurePro(text) {
    var s = String(text || '').trim();
    if (!s) return '辰龙机器人控制台 Pro';
    if (/\bpro\b/i.test(s)) return s;
    return s + ' Pro';
  }

  function patchTitleOnly() {
    document.title = ensurePro(document.title || '辰龙机器人控制台');

    var h2 = document.querySelector('h2');
    if (h2 && /控制台/.test(String(h2.textContent || ''))) {
      h2.textContent = ensurePro(h2.textContent);
      return;
    }

    var nodes = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'));
    for (var i = 0; i < nodes.length; i++) {
      var t = String(nodes[i].textContent || '');
      if (/控制台/.test(t)) {
        nodes[i].textContent = ensurePro(t);
        return;
      }
    }
  }

  function boot() {
    patchTitleOnly();
    var obs = new MutationObserver(function () {
      patchTitleOnly();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
