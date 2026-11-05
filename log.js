/**
 * log.js — отдельный плагин диагностики
 * Version: 1.1.0
 *
 * Ничего не блокирует, только показывает лог в левом верхнем углу:
 *   ⏳ — запрос висит дольше 5 сек без ответа
 *   🐢 — запрос выполнился, но медленно (дольше 2 сек)
 *   ❌ — запрос завершился ошибкой (статус 0, 4xx, 5xx)
 *   🎞 — ошибка видео в плеере (код ошибки медиа)
 *   WS: — WebSocket-подключение
 * Рекламные запросы (/api/ad/get/) не показываются — их блокирует kp.js.
 * Включать и выключать в Расширениях Lampa по необходимости.
 */

(function () {
    'use strict';

    var lines = [];
    var box = null;

    function show() {
        if (document.body) {
            if (!box) {
                box = document.createElement('div');
                box.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;background:rgba(0,0,0,0.9);color:#0f0;font-size:13px;padding:8px;max-width:900px;border-radius:6px;pointer-events:none;line-height:1.5;word-break:break-all;';
                document.body.appendChild(box);
            }
            box.innerHTML = '<b>KP diag 1.1</b><br>' + lines.slice(-12).join('<br>');
        }
    }

    function log(msg) {
        var t = new Date();
        var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
        lines.push(hh + ' ' + msg);
        setTimeout(show, 50);
    }

    function short(url) {
        var s = String(url || '');
        s = s.replace('https://', '').replace('http://', '').replace('wss://', '');
        return s.substring(0, 70);
    }

    function isIgnored(url) {
        var u = String(url || '');
        return u.indexOf('/api/ad/get/') !== -1 || u.indexOf('github.io') !== -1;
    }

    // ---------- XHR ----------
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this._lgUrl = url || '';
        origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        var xhr = this;
        var url = xhr._lgUrl;
        var start = Date.now();
        var done = false;
        var pendingTimer;

        if (!isIgnored(url)) {
            pendingTimer = setTimeout(function () {
                if (!done) { log('⏳ висит: ' + short(url)); }
            }, 5000);

            xhr.addEventListener('loadend', function () {
                var ms = Date.now() - start;
                var st = 0;
                done = true;
                clearTimeout(pendingTimer);
                try { st = xhr.status; } catch (e) {}
                if (st === 0 || st >= 400) {
                    log('❌ ' + st + ' (' + ms + 'мс): ' + short(url));
                } else if (ms > 2000) {
                    log('🐢 ' + ms + 'мс: ' + short(url));
                }
            });
        }
        origSend.apply(xhr, arguments);
    };

    // ---------- fetch ----------
    var origFetch = window.fetch;
    window.fetch = function (input) {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        var start = Date.now();
        var done = false;
        var pendingTimer;
        var p = origFetch.apply(this, arguments);

        if (!isIgnored(url)) {
            pendingTimer = setTimeout(function () {
                if (!done) { log('⏳ висит (F): ' + short(url)); }
            }, 5000);
            p.then(function (res) {
                var ms = Date.now() - start;
                done = true;
                clearTimeout(pendingTimer);
                if (!res.ok) { log('❌ ' + res.status + ' F (' + ms + 'мс): ' + short(url)); }
                else if (ms > 2000) { log('🐢 F ' + ms + 'мс: ' + short(url)); }
            }, function () {
                var ms = Date.now() - start;
                done = true;
                clearTimeout(pendingTimer);
                log('❌ сеть F (' + ms + 'мс): ' + short(url));
            });
        }
        return p;
    };

    // ---------- WebSocket ----------
    var OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
        log('WS: ' + short(url));
        if (protocols) { return new OrigWS(url, protocols); }
        return new OrigWS(url);
    };
    window.WebSocket.prototype = OrigWS.prototype;

    // ---------- Ошибки видео ----------
    var MEDIA_ERR = { 1: 'прервано', 2: 'сеть', 3: 'декодирование', 4: 'формат не поддерживается' };

    document.addEventListener('error', function (e) {
        var t = e.target, code, src;
        if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) {
            code = t.error ? t.error.code : 0;
            src = t.currentSrc || t.src || '';
            log('🎞 ошибка видео: ' + (MEDIA_ERR[code] || code) + ' ' + short(src));
        }
    }, true);

    log('запущен');
})();
