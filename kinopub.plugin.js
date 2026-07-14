/**
 * ============================================================
 *  Kino.pub Plugin for Lampa (Tizen OS / Samsung TV)
 *  Version: 1.0.0
 *
 *  Особенности:
 *  - "Неубиваемая" авторизация через OAuth2 Device Flow
 *  - Автообновление access_token через refresh_token
 *    (срабатывает за 10 минут до истечения)
 *  - Хранение токенов в Lampa.Storage (переживает перезагрузку TV)
 *  - Поиск контента и передача HLS/MP4 во встроенный плеер Lampa
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
            expire_time:   'kinopub_expire_time'   // Unix-время в секундах
        },

        // За сколько секунд до истечения токена делать превентивное обновление
        refresh_threshold_sec: 600  // 10 минут
    };

    // ============================================================
    //  ХРАНИЛИЩЕ ТОКЕНОВ
    //  Тонкая обёртка над Lampa.Storage для удобства.
    // ============================================================
    var TokenStore = {
        save: function (data) {
            Lampa.Storage.set(CONFIG.storage.access_token,  data.access_token);
            Lampa.Storage.set(CONFIG.storage.refresh_token, data.refresh_token);
            // expire_time — абсолютный Unix-timestamp (секунды)
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
    //  Простые обёртки над XMLHttpRequest (совместимо с Tizen).
    // ============================================================
    var Http = {
        /**
         * GET-запрос.
         * @param {string}   url
         * @param {object}   headers  — дополнительные заголовки
         * @param {function} onSuccess(data)
         * @param {function} onError(status, text)
         */
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

        /**
         * POST-запрос с application/x-www-form-urlencoded телом.
         * @param {string}   url
         * @param {object}   params  — объект ключ/значение
         * @param {function} onSuccess(data)
         * @param {function} onError(status, text)
         */
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
    //  Ключевая логика: getValidToken() всегда возвращает
    //  актуальный access_token, при необходимости обновляя его.
    // ============================================================
    var TokenManager = {
        // Флаг: идёт ли сейчас запрос на обновление (чтобы не дублировать)
        _refreshing: false,
        // Очередь коллбэков, ожидающих завершения обновления
        _queue: [],

        /**
         * Получить действующий токен.
         * Если токен истёк (или истечёт менее чем через threshold) —
         * сначала обновить, затем вернуть новый.
         *
         * @param {function} onReady(access_token)
         * @param {function} onFail(error_text)
         */
        getValidToken: function (onReady, onFail) {
            var data = TokenStore.get();

            if (!data.access_token) {
                onFail('not_authorized');
                return;
            }

            var nowSec = Math.floor(Date.now() / 1000);
            var needsRefresh = (data.expire_time - nowSec) < CONFIG.refresh_threshold_sec;

            if (!needsRefresh) {
                // Токен свежий — возвращаем сразу
                onReady(data.access_token);
                return;
            }

            // Токен нужно обновить
            if (this._refreshing) {
                // Уже идёт обновление — встаём в очередь
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

                    // Отдаём свежий токен всем ожидающим
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
    //  Все запросы к API проходят через getValidToken().
    // ============================================================
    var KinoPubApi = {
        /**
         * Универсальный аутентифицированный GET.
         */
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

        /**
         * Поиск контента по названию.
         * GET /items?title=...&type=movie|serial
         */
        search: function (title, onSuccess, onError) {
            this.authGet('/items', { title: title }, onSuccess, onError);
        },

        /**
         * Получить детали элемента (медиафайлы, качества, сезоны).
         * GET /items/{id}
         */
        getItem: function (id, onSuccess, onError) {
            this.authGet('/items/' + id, {}, onSuccess, onError);
        },

        /**
         * Запросить код устройства для авторизации.
         * POST /oauth2/device
         */
        requestDeviceCode: function (onSuccess, onError) {
            Http.post(
                CONFIG.api_base + '/oauth2/device',
                {
                    grant_type: 'device_code',
                    client_id:  CONFIG.client_id,
                    client_secret: CONFIG.client_secret
                },
                onSuccess,
                onError
            );
        },

        /**
         * Polling: проверить, активировал ли пользователь устройство.
         * POST /oauth2/device (или /oauth2/token с device_code)
         */
        pollDeviceToken: function (code, onSuccess, onPending, onError) {
            Http.post(
                CONFIG.api_base + '/oauth2/token',
                {
                    grant_type:  'device_code',
                    client_id:   CONFIG.client_id,
                    client_secret: CONFIG.client_secret,
                    code:        code
                },
                function (resp) {
                    if (resp.access_token) {
                        onSuccess(resp);
                    } else {
                        onPending();
                    }
                },
                function (status) {
                    // 400 = authorization_pending — это нормально
                    if (status === 400) { onPending(); }
                    else { onError(status); }
                }
            );
        }
    };

    // ============================================================
    //  ЭКРАН АВТОРИЗАЦИИ
    //  Показывает пользователю код и инструкцию.
    //  Делает polling каждые interval секунд.
    // ============================================================
    var AuthScreen = {
        _pollTimer: null,

        show: function () {
            var self = this;

            // Запрашиваем код устройства
            KinoPubApi.requestDeviceCode(
                function (resp) {
                    self._startPolling(resp);
                },
                function () {
                    Lampa.Noty.show('Kino.pub: ошибка получения кода авторизации');
                }
            );
        },

        _startPolling: function (resp) {
            var self      = this;
            var code      = resp.code;           // код для ввода пользователем
            var interval  = (resp.interval || 5) * 1000; // мс между попытками
            var expiresIn = (resp.expires_in || 300) * 1000;
            var deadline  = Date.now() + expiresIn;

            // Формируем HTML для модального окна Lampa
            var html =
                '<div style="text-align:center;padding:20px;font-size:16px;line-height:1.6;">' +
                    '<p>Откройте в браузере:</p>' +
                    '<p style="font-size:22px;font-weight:bold;color:#e5c100;">' + CONFIG.activate_url + '</p>' +
                    '<p>и введите код:</p>' +
                    '<p style="font-size:48px;font-weight:bold;letter-spacing:8px;color:#fff;">' + (resp.user_code || code) + '</p>' +
                    '<p id="kinopub-auth-status" style="color:#aaa;">Ожидание подтверждения…</p>' +
                '</div>';

            Lampa.Modal.open({
                title:  'Авторизация Kino.pub',
                html:   html,
                onBack: function () {
                    self._stopPolling();
                    Lampa.Modal.close();
                }
            });

            // Polling
            self._pollTimer = setInterval(function () {
                if (Date.now() > deadline) {
                    self._stopPolling();
                    AuthScreen._setStatus('Код истёк. Попробуйте снова.');
                    return;
                }

                KinoPubApi.pollDeviceToken(
                    code,
                    function (tokenData) {
                        // Успех!
                        self._stopPolling();
                        TokenStore.save(tokenData);
                        AuthScreen._setStatus('✓ Авторизован!');
                        setTimeout(function () { Lampa.Modal.close(); }, 1500);
                        Lampa.Noty.show('Kino.pub: устройство успешно авторизовано');
                    },
                    function () {
                        // Ещё не подтвердили — ждём
                    },
                    function () {
                        self._stopPolling();
                        AuthScreen._setStatus('Ошибка авторизации. Попробуйте снова.');
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
    //  Извлекает HLS/MP4 ссылки из ответа API и строит
    //  структуру, понятную плееру Lampa.
    // ============================================================
    var MediaHelper = {
        /**
         * Из item.videos[0].files строим массив source-объектов
         * для Lampa.Player.play().
         *
         * Kino.pub возвращает примерно:
         *  videos: [{
         *    files: [
         *      { quality: '1080p', url: 'https://...m3u8', codec: 'h264' },
         *      { quality: '720p',  url: 'https://...mp4',  codec: 'h264' }
         *    ],
         *    audios: [{ id: 1, title: 'Русский' }, ...]
         *  }]
         */
        buildSources: function (item) {
            var sources = [];
            var videos  = (item && item.videos) ? item.videos : [];

            videos.forEach(function (video) {
                var files = video.files || [];
                files.forEach(function (f) {
                    if (!f.url) return;
                    sources.push({
                        url:     f.url,
                        quality: f.quality || 'auto',
                        title:   item.title || '',
                        // Lampa распознаёт тип по расширению или явному полю
                        type:    f.url.indexOf('.m3u8') !== -1 ? 'hls' : 'mp4'
                    });
                });
            });

            // Сортируем: сначала наибольшее качество
            sources.sort(function (a, b) {
                return parseInt(b.quality, 10) - parseInt(a.quality, 10);
            });

            return sources;
        },

        /**
         * Формируем список аудиодорожек для первого видео.
         */
        buildAudioTracks: function (item) {
            var tracks = [];
            var videos = (item && item.videos) ? item.videos : [];
            if (videos.length === 0) return tracks;
            (videos[0].audios || []).forEach(function (a) {
                tracks.push({ id: a.id, title: a.title || ('Track ' + a.id) });
            });
            return tracks;
        }
    };

    // ============================================================
    //  ПОИСК И ИНТЕГРАЦИЯ С КАРТОЧКАМИ LAMPA
    // ============================================================
    var KinoPubSearch = {
        /**
         * Поиск и немедленный запуск воспроизведения в плеере Lampa.
         * @param {string} title — название фильма/сериала
         */
        playByTitle: function (title) {
            Lampa.Noty.show('Kino.pub: поиск «' + title + '»…');

            KinoPubApi.search(title, function (resp) {
                var items = resp.items || [];
                if (items.length === 0) {
                    Lampa.Noty.show('Kino.pub: ничего не найдено');
                    return;
                }

                // Берём первый результат (наиболее релевантный)
                var found = items[0];
                KinoPubSearch._loadAndPlay(found.id, found.title || title);

            }, function () {
                Lampa.Noty.show('Kino.pub: ошибка поиска');
            });
        },

        /**
         * Загрузить детали по ID и запустить плеер.
         */
        _loadAndPlay: function (id, title) {
            KinoPubApi.getItem(id, function (resp) {
                var item    = resp.item || {};
                var sources = MediaHelper.buildSources(item);
                var audios  = MediaHelper.buildAudioTracks(item);

                if (sources.length === 0) {
                    Lampa.Noty.show('Kino.pub: медиафайлы не найдены');
                    return;
                }

                // Передаём в плеер Lampa
                Lampa.Player.play({
                    title:   title,
                    url:     sources[0].url,
                    quality: KinoPubSearch._buildQualityMap(sources),
                    // Аудиодорожки — если плеер поддерживает
                    audios:  audios
                });

                Lampa.Player.playlist(sources.map(function (s) {
                    return { title: s.quality, url: s.url, type: s.type };
                }));

            }, function () {
                Lampa.Noty.show('Kino.pub: ошибка загрузки медиа');
            });
        },

        /**
         * Строим объект { '1080p': url, '720p': url, ... }
         * для параметра quality плеера Lampa.
         */
        _buildQualityMap: function (sources) {
            var map = {};
            sources.forEach(function (s) { map[s.quality] = s.url; });
            return map;
        }
    };

    // ============================================================
    //  НАСТРОЙКИ / UI LAMPA
    //  Добавляет пункт "Kino.pub" в раздел "Плагины".
    // ============================================================
    var SettingsUI = {
        init: function () {
            // Добавляем пункт меню в настройки Lampa
            Lampa.SettingsApi.addParam({
                component: 'kinopub',
                param:     {
                    name:    'kinopub_auth',
                    type:    'trigger',       // кнопка-триггер
                    default: ''
                },
                field: {
                    name: 'Kino.pub',
                    description: TokenStore.isAuthorized()
                        ? 'Статус: Авторизован ✓'
                        : 'Статус: Не авторизован — нажмите для входа'
                },
                onChange: function () {
                    if (TokenStore.isAuthorized()) {
                        // Уже авторизованы — предлагаем выйти или переавторизоваться
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
                                    SettingsUI._refreshDescription('Статус: Не авторизован — нажмите для входа');
                                }
                            }
                        });
                    } else {
                        AuthScreen.show();
                    }
                }
            });

            // Добавляем компонент в раздел "Плагины"
            Lampa.SettingsApi.addComponent({
                component:   'kinopub',
                name:        'Kino.pub',
                icon:        '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>'
            });
        },

        _refreshDescription: function (text) {
            // Обновить подпись пункта меню без перезагрузки
            try {
                Lampa.SettingsApi.updateParam('kinopub', 'kinopub_auth', { description: text });
            } catch (e) { /* API может не поддерживать динамическое обновление */ }
        }
    };

    // ============================================================
    //  ПЕРЕХВАТ СОБЫТИЙ LAMPA
    //  Слушаем открытие карточки фильма и поисковые запросы.
    // ============================================================
    var EventBridge = {
        init: function () {
            /**
             * Событие: пользователь нажал "Смотреть" на карточке.
             * Lampa должна прислать объект card с полем title.
             */
            Lampa.Listener.follow('player:before_start', function (e) {
                // Если источник уже определён (не наш плагин) — не перехватываем
                if (e && e.source) return;
                if (e && e.card && e.card.title) {
                    e.preventDefault && e.preventDefault();
                    KinoPubSearch.playByTitle(e.card.title);
                }
            });

            /**
             * Событие: пользователь ввёл поисковый запрос.
             * Можно добавить кнопку "Искать в Kino.pub" в результаты.
             */
            Lampa.Listener.follow('search:results', function (e) {
                if (!TokenStore.isAuthorized()) return;
                var query = e && e.query;
                if (!query) return;

                // Добавляем кнопку в интерфейс поиска (если API позволяет)
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
    //  ИНИЦИАЛИЗАЦИЯ ПЛАГИНА
    // ============================================================
    function initPlugin() {
        // Регистрируем компонент в Lampa
        Lampa.Component.add('kinopub', {
            create: function () {
                // Компонент пуст — вся логика через настройки и события
            },
            destroy: function () {
                AuthScreen._stopPolling();
            }
        });

        // Добавляем UI в настройки
        SettingsUI.init();

        // Подключаем перехватчики событий
        EventBridge.init();

        console.log('[Kino.pub] Плагин инициализирован. Авторизован:', TokenStore.isAuthorized());
    }

    // ============================================================
    //  ТОЧКА ВХОДА
    //  Ждём готовности Lampa, затем запускаемся.
    // ============================================================
    if (window.Lampa && Lampa.Listener) {
        // Lampa уже загружена
        Lampa.Listener.follow('app:ready', initPlugin);
    } else {
        // На случай, если плагин загрузился раньше Lampa
        document.addEventListener('DOMContentLoaded', function () {
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.follow('app:ready', initPlugin);
            } else {
                // Последний fallback — через таймер
                var check = setInterval(function () {
                    if (window.Lampa && Lampa.Listener) {
                        clearInterval(check);
                        Lampa.Listener.follow('app:ready', initPlugin);
                    }
                }, 500);
            }
        });
    }

})();
