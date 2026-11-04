/**
 * log.js — отдельный плагин для поиска рекламных запросов
 * Version: 1.0.0
 *
 * Ничего не блокирует, только показывает лог на экране (левый верхний угол):
 *   X:  — XHR запрос с подозрительным адресом
 *   F:  — fetch запрос с подозрительным адресом
 *   WS: — WebSocket подключение
 *   🎬  — адрес рекламного видео внутри .ad-preroll / .ad-video-block
 * Включать и выключать в Расширениях Lampa по необходимости.
 */

(function () {
    'use strict';

    var lines = [];
    var box = null;
    var SUSPECT = ['ad', 'vast', 'vmap', 'preroll', 'banner', 'yandex', 'between', 'mytarget', 'getcode'];
    var SAFE = ['service-kp.com', 'srvkp.com', 'cdntogo.net', 'themoviedb', 'tmdb', 'lampa', 'modss', 'github.io', 'metric/stat'];

    function show() {
        if (document.body) {
            if (!box) {
                box = document.createElement('div');
                box.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;background:rgba(0,0,0,0.9);color:#0f0;font-size:13px;padding:8px;max-width:900px;border-radius:6px;pointer-events:none;line-height:1.5;word-break:break-all;';
                document.body.appendChild(box);
            }
            box.innerHTML = '<b>KP diag</b><br>' + lines.slice(-10).join('<br>');
        }
    }

    function log(msg) {
        lines.push(msg);
        setTimeout(show, 50);
    }

    function isSuspect(url) {
        var u = String(url || '').toLowerCase(), k, hit = false, safe = false;
        for (k = 0; k < SUSPECT.length; k++) { if (u.indexOf(SUSPECT[k]) !== -1) { hit = true; } }
        for (k = 0; k < SAFE.length; k++) { if (u.indexOf(SAFE[k]) !== -1) { safe = true; } }
        return hit && !safe;
    }

    // XHR
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (isSuspect(url)) { log('X: ' + String(url).substring(0, 90)); }
        origOpen.apply(this, arguments);
    };

    // fetch
    var origFetch = window.fetch;
    window.fetch = function (url) {
        var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
        if (isSuspect(u)) { log('F: ' + String(u).substring(0, 90)); }
        return origFetch.apply(this, arguments);
    };

    // WebSocket
    var OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
        log('WS: ' + String(url).substring(0, 90));
        if (protocols) { return new OrigWS(url, protocols); }
        return new OrigWS(url);
    };
    window.WebSocket.prototype = OrigWS.prototype;

    // Рекламное видео
    function inAdBlock(el) {
        var p = el, found = false, c;
        while (p && !found) {
            c = typeof p.className === 'string' ? p.className : '';
            if (c.indexOf('ad-preroll') !== -1 || c.indexOf('ad-video-block') !== -1) { found = true; }
            p = p.parentNode;
        }
        return found;
    }

    function onMedia(e) {
        var t = e.target, src;
        if (t && t.tagName === 'VIDEO' && inAdBlock(t)) {
            src = t.currentSrc || t.src || '(без src)';
            if (t._kpdSrc !== src) {
                t._kpdSrc = src;
                log('🎬 ' + e.type + ': ' + String(src).substring(0, 90));
            }
        }
    }
    document.addEventListener('loadstart', onMedia, true);
    document.addEventListener('play', onMedia, true);

    log('запущен');
})();
