/**
 * ============================================================
 *  Kino.pub Plugin for Lampa (Tizen OS / Samsung TV)
 *  Version: 1.1.0
 *
 *  Особенности:
 *  - "Неубиваемая" авторизация через OAuth2 Device Flow
 *  - Автообновление access_token через refresh_token
 *    (срабатывает за 10 минут до истечения)
 *  - Хранение токенов в Lampa.Storage (переживает перезагрузку TV)
 *  - Поиск контента и передача HLS/MP4 во встроенный плеер Lampa
 *  - Совместимо с Lampa 3.x (точка входа через polling)
 * ============================================================
 */

(function () {
    'use strict';

    // ============================================================
    //  КОНФИГУРАЦИЯ
    //  Если хотите заменить ключи — меняйте только здесь.
    // ============================================================
    var CONFIG = {
        // Публичные ключи open-source клиентов Kino.pub (Kodi/AppleTV)
        client_id:     'xbmc',
        client_secret: 'cgg3gtiwtlqlIDSq',

        // Базовый URL API
        api_base: 'https://api.service-kp.com/v1',

        // Страница активации устройства (показывается пользователю)
        activate_url: 'https://kpub.org/device',

        // Ключи в Lampa.Storage
        storage: {
            access_token:  'kinopub_access_token',
            refresh_token: 'kinopub_refresh_token',
            expire_time:   'kinopub_expire_time'
        },

        // За сколько секунд до истечения токена делать превентивное обновление
        refresh_threshold_sec: 600  // 10 минут
    };

    // ============================================================
    //  ХРАНИЛИЩЕ ТОКЕНОВ
    // ============================================================
    var TokenStore = {
        save: function (data) {
            Lampa.Storage.set(CONFIG.storage.access_token,  data.access_token);
            Lampa.Storage.set(CONFIG.storage.refresh_token, data.refresh_token);
            var expire = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
            Lampa.Storage.set(CONFIG.storage.expire_time, expire);
        },

        get: function () {
            return {
                access_token:  Lampa.Storage.get(CONFIG.storage.access_token,  ''),
                refresh_token: Lampa.Storage.get(CONFIG.storage.refresh_token, ''),
                expire_time:   parseInt(Lampa.Storage.get(CONFIG.storage.expire_time, '0'), 10)
            };
        },

        clear: function () {
            Lampa.Storage.set(CONFIG.storage.access_token,  '');
            Lampa.Storage.set(CONFIG.storage.refresh_token, '');
            Lampa.Storage.set(CONFIG.storage.expire_time,   0);
        },

        isAuthorized: function () {
            return !!Lampa.Storage.get(CONFIG.storage.access_token, '');
        }
    };

    // ============================================================
    //  HTTP-УТИЛИТЫ
    // ============================================================
    var Http = {
        get: function (url, headers, onSuccess, onError) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.setRequestHeader('Accept', 'application/json');
            if (headers) {
                Object.keys(headers).forEach(function (k) {
                    xhr.setRequestHeader(k, headers[k]);
                });
            }
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { onSuccess(JSON.parse(xhr.responseText)); }
                    catch (e) { onError(0, 'JSON parse error'); }
                } else {
                    onError(xhr.status, xhr.statusText);
                }
            };
            xhr.onerror = function () { onError(0, 'Network error'); };
            xhr.send();
        },

        post: function (url, params, onSuccess, onError) {
            var body = Object.keys(params)
                .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
                .join('&');

            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.setRequestHeader('Accept', 'application/json');
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { onSuccess(JSON.parse(xhr.responseText)); }
                    catch (e) { onError(0, 'JSON parse error'); }
                } else {
                    onError(xhr.status, xhr.statusText);
                }
            };
            xhr.onerror = function () { onError(0, 'Network error'); };
            xhr.send(body);
        }
    };

    // ============================================================
    //  ТОКЕН-МЕНЕДЖЕР
    // ============================================================
    var TokenManager = {
        _refreshing: false,
        _queue: [],

        getValidToken: function (onReady, onFail) {
            var data = TokenStore.get();

            if (!data.access_token) {
                onFail('not_authorized');
                return;
            }

            var nowSec = Math.floor(Date.now() / 1000);
            var needsRefresh = (data.expire_time - nowSec) < CONFIG.refresh_threshold_sec;

            if (!needsRefresh) {
                onReady(data.access_token);
                return;
            }

            if (this._refreshing) {
                this._queue.push({ ok: onReady, fail: onFail });
                return;
            }

            this._refreshing = true;
            var self = this;

            Http.post(
                CONFIG.api_base + '/oauth2/token',
                {
                    grant_type:    'refresh_token',
                    client_id:     CONFIG.client_id,
                    client_secret: CONFIG.client_secret,
                    refresh_token: data.refresh_token
                },
                function (resp) {
                    TokenStore.save(resp);
                    self._refreshing = false;
                    var newToken = resp.access_token;
                    onReady(newToken);
                    self._queue.forEach(function (cb) { cb.ok(newToken); });
                    self._queue = [];
                },
                function (status, text) {
                    self._refreshing = false;
                    var msg = 'Token refresh failed: ' + status + ' ' + text;
                    onFail(msg);
                    self._queue.forEach(function (cb) { cb.fail(msg); });
                    self._queue = [];
                }
            );
        }
    };

    // ============================================================
    //  API-КЛИЕНТ KINO.PUB
    // ============================================================
    var KinoPubApi = {
        authGet: function (path, params, onSuccess, onError) {
            TokenManager.getValidToken(
                function (token) {
                    var query = Object.keys(params || {})
                        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
                        .join('&');
                    var url = CONFIG.api_base + path + (query ? '?' + query : '');
                    Http.get(url, { Authorization: 'Bearer ' + token }, onSuccess, onError);
                },
                onError
            );
        },

        search: function (title, onSuccess, onError) {
            this.authGet('/items', { title: title }, onSuccess, onError);
        },

        getItem: function (id, onSuccess, onError) {
            this.authGet('/items/' + id, {}, onSuccess, onError);
        },

        requestDeviceCode: function (onSuccess, onError) {
            Http.post(
                CONFIG.api_base + '/oauth2/device',
                {
                    grant_type:    'device_code',
                    client_id:     CONFIG.client_id,
                    client_secret: CONFIG.client_secret
                },
                onSuccess,
                onError
            );
        },

        pollDeviceToken: function (code, onSuccess, onPending, onError) {
            Http.post(
                CONFIG.api_base + '/oauth2/token',
                {
                    grant_type:    'device_code',
                    client_id:     CONFIG.client_id,
                    client_secret: CONFIG.client_secret,
                    code:          code
                },
                function (resp) {
                    if (resp.access_token) { onSuccess(resp); }
                    else { onPending(); }
                },
                function (status) {
                    if (status === 400) { onPending(); }
                    else { onError(status); }
                }
            );
        }
    };

    // ============================================================
    //  ЭКРАН АВТОРИЗАЦИИ
    // ============================================================
    var AuthScreen = {
        _pollTimer: null,

        show: function () {
            var self = this;
            KinoPubApi.requestDeviceCode(
                function (resp) { self._startPolling(resp); },
                function () { Lampa.Noty.show('Kino.pub: ошибка получения кода авторизации'); }
            );
        },

        _startPolling: function (resp) {
            var self      = this;
            var code      = resp.code;
            var interval  = (resp.interval || 5) * 1000;
            var deadline  = Date.now() + ((resp.expires_in || 300) * 1000);

            var html =
                '<div style="text-align:center;padding:20px;font-size:16px;line-height:1.8;">' +
                    '<p style="margin:0 0 8px;">Откройте в браузере:</p>' +
                    '<p style="font-size:20px;font-weight:bold;color:#e5c100;margin:0 0 16px;">' + CONFIG.activate_url + '</p>' +
                    '<p style="margin:0 0 8px;">и введите код:</p>' +
                    '<p style="font-size:52px;font-weight:bold;letter-spacing:10px;color:#fff;margin:0 0 20px;">' + (resp.user_code || code) + '</p>' +
                    '<p id="kinopub-auth-status" style="color:#aaa;margin:0;">Ожидание подтверждения…</p>' +
                '</div>';

            Lampa.Modal.open({
                title:  'Авторизация Kino.pub',
                html:   html,
                onBack: function () {
                    self._stopPolling();
                    Lampa.Modal.close();
                }
            });

            self._pollTimer = setInterval(function () {
                if (Date.now() > deadline) {
                    self._stopPolling();
                    AuthScreen._setStatus('Код истёк. Закройте и попробуйте снова.');
                    return;
                }

                KinoPubApi.pollDeviceToken(
                    code,
                    function (tokenData) {
                        self._stopPolling();
                        TokenStore.save(tokenData);
                        AuthScreen._setStatus('✓ Авторизован!');
                        setTimeout(function () { Lampa.Modal.close(); }, 1500);
                        Lampa.Noty.show('Kino.pub: устройство успешно авторизовано');
                    },
                    function () { /* ждём */ },
                    function () {
                        self._stopPolling();
                        AuthScreen._setStatus('Ошибка. Закройте и попробуйте снова.');
                    }
                );
            }, interval);
        },

        _stopPolling: function () {
            if (this._pollTimer) {
                clearInterval(this._pollTimer);
                this._pollTimer = null;
            }
        },

        _setStatus: function (text) {
            var el = document.getElementById('kinopub-auth-status');
            if (el) { el.textContent = text; }
        }
    };

    // ============================================================
    //  МЕДИА-ХЕЛПЕР
    // ============================================================
    var MediaHelper = {
        buildSources: function (item) {
            var sources = [];
            var videos  = (item && item.videos) ? item.videos : [];

            videos.forEach(function (video) {
                (video.files || []).forEach(function (f) {
                    if (!f.url) return;
                    sources.push({
                        url:     f.url,
                        quality: f.quality || 'auto',
                        title:   item.title || '',
                        type:    f.url.indexOf('.m3u8') !== -1 ? 'hls' : 'mp4'
                    });
                });
            });

            sources.sort(function (a, b) {
                return parseInt(b.quality, 10) - parseInt(a.quality, 10);
            });

            return sources;
        },

        buildAudioTracks: function (item) {
            var tracks = [];
            var videos = (item && item.videos) ? item.videos : [];
            if (!videos.length) return tracks;
            (videos[0].audios || []).forEach(function (a) {
                tracks.push({ id: a.id, title: a.title || ('Track ' + a.id) });
            });
            return tracks;
        }
    };

    // ============================================================
    //  ПОИСК И ВОСПРОИЗВЕДЕНИЕ
    // ============================================================
    var KinoPubSearch = {
        playByTitle: function (title) {
            Lampa.Noty.show('Kino.pub: поиск «' + title + '»…');

            KinoPubApi.search(title, function (resp) {
                var items = resp.items || [];
                if (!items.length) {
                    Lampa.Noty.show('Kino.pub: ничего не найдено');
                    return;
                }
                var found = items[0];
                KinoPubSearch._loadAndPlay(found.id, found.title || title);
            }, function () {
                Lampa.Noty.show('Kino.pub: ошибка поиска');
            });
        },

        _loadAndPlay: function (id, title) {
            KinoPubApi.getItem(id, function (resp) {
                var item    = resp.item || {};
                var sources = MediaHelper.buildSources(item);
                var audios  = MediaHelper.buildAudioTracks(item);

                if (!sources.length) {
                    Lampa.Noty.show('Kino.pub: медиафайлы не найдены');
                    return;
                }

                Lampa.Player.play({
                    title:   title,
                    url:     sources[0].url,
                    quality: KinoPubSearch._buildQualityMap(sources),
                    audios:  audios
                });

                Lampa.Player.playlist(sources.map(function (s) {
                    return { title: s.quality, url: s.url, type: s.type };
                }));

            }, function () {
                Lampa.Noty.show('Kino.pub: ошибка загрузки медиа');
            });
        },

        _buildQualityMap: function (sources) {
            var map = {};
            sources.forEach(function (s) { map[s.quality] = s.url; });
            return map;
        }
    };

    // ============================================================
    //  UI В НАСТРОЙКАХ LAMPA
    // ============================================================
    var SettingsUI = {
        init: function () {
            Lampa.SettingsApi.addParam({
                component: 'kinopub',
                param: {
                    name:    'kinopub_auth',
                    type:    'trigger',
                    default: ''
                },
                field: {
                    name: 'Kino.pub — Авторизация',
                    description: TokenStore.isAuthorized()
                        ? 'Статус: Авторизован ✓'
                        : 'Нажмите, чтобы войти через kpub.org/device'
                },
                onChange: function () {
                    if (TokenStore.isAuthorized()) {
                        Lampa.Select.show({
                            title: 'Kino.pub',
                            items: [
                                { title: 'Переавторизоваться', action: 'reauth' },
                                { title: 'Выйти (сбросить токен)', action: 'logout' },
                                { title: 'Отмена', action: 'cancel' }
                            ],
                            onSelect: function (item) {
                                if (item.action === 'reauth') {
                                    AuthScreen.show();
                                } else if (item.action === 'logout') {
                                    TokenStore.clear();
                                    Lampa.Noty.show('Kino.pub: выход выполнен');
                                }
                            }
                        });
                    } else {
                        AuthScreen.show();
                    }
                }
            });

            Lampa.SettingsApi.addComponent({
                component: 'kinopub',
                name:      'Kino.pub',
                icon:      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>'
            });
        }
    };

    // ============================================================
    //  ПЕРЕХВАТ СОБЫТИЙ LAMPA
    // ============================================================
    var EventBridge = {
        init: function () {
            Lampa.Listener.follow('player:before_start', function (e) {
                if (e && e.source) return;
                if (e && e.card && e.card.title) {
                    e.preventDefault && e.preventDefault();
                    KinoPubSearch.playByTitle(e.card.title);
                }
            });

            Lampa.Listener.follow('search:results', function (e) {
                if (!TokenStore.isAuthorized()) return;
                var query = e && e.query;
                if (!query) return;
                if (e.addSource) {
                    e.addSource({
                        name:   'Kino.pub',
                        action: function () { KinoPubSearch.playByTitle(query); }
                    });
                }
            });
        }
    };

    // ============================================================
    //  ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function initPlugin() {
        // Защита от двойного запуска
        if (window._kinopubInited) return;
        window._kinopubInited = true;

        try { Lampa.Component.add('kinopub', { create: function () {}, destroy: function () { AuthScreen._stopPolling(); } }); }
        catch (e) {}

        SettingsUI.init();
        EventBridge.init();

        console.log('[Kino.pub] Плагин инициализирован. Авторизован:', TokenStore.isAuthorized());
    }

    // ============================================================
    //  ТОЧКА ВХОДА — polling до готовности Lampa (Lampa 3.x)
    // ============================================================
    function tryInit() {
        if (
            window.Lampa &&
            Lampa.Storage &&
            Lampa.Listener &&
            Lampa.SettingsApi &&
            Lampa.Noty
        ) {
            initPlugin();
        } else {
            setTimeout(tryInit, 200);
        }
    }

    tryInit();

})();
