# Предоставленный перечень технологий

Источник: файл message.txt от пользователя, 20.10.2026. Это сведения о проектах, а не независимая проверка текущих production-версий. SHA-256 исходного файла: `11c1eb1420440f96a014d0fbe23f3fdeb34180beff8502153f0d575b94cbfa48`.

# Стек фронтенда по проектам

## frontend-mono

Монорепозиторий на Turborepo, приложение — База Линий 2.

1. React 18.2.0
2. react-dom 18.2
3. TypeScript 5.4
4. Turborepo 1.13.4
5. Vite 5.2
6. @vitejs/plugin-react 4.2
7. vite-plugin-svgr 4.2
8. vite-tsconfig-paths 4.3
9. vite-plugin-dts 3.9
10. react-router-dom 6.4
11. react-router 6.4
12. @reduxjs/toolkit 1.9
13. react-redux 8.0
14. redux-persist 6.0
15. redux-logger 3.0
16. RTK Query (в составе @reduxjs/toolkit)
17. @rtk-query/codegen-openapi 1.0 — генерация ручек из OpenAPI
18. axios 1.2
19. async-mutex 0.4 — refresh сессии под мьютексом
20. final-form 4.20
21. react-final-form 6.5
22. react-imask 6.4
23. react-input-mask 3.0-alpha
24. @tanstack/react-table 8.7
25. @tanstack/react-virtual 3.0-beta
26. @tanstack/match-sorter-utils 8.7
27. match-sorter 6.3
28. framer-motion 8.5
29. downshift 7.2 — автокомплит
30. @popperjs/core 2.11
31. react-popper 2.3
32. react-grid-system 8.1
33. react-paginate 8.1
34. react-photo-view 1.2
35. react-toastify 11.0
36. react-draggable 4.4
37. react-intersection-observer 9.4
38. react-dropdown-tree-select 2.8
39. react-h5-audio-player 3.8
40. react-datepicker 4.25
41. date-fns 2.29
42. react-dnd 16
43. react-dnd-html5-backend 16
44. react-dropzone 14.3
45. xlsx 0.18
46. maplibre-gl 5.6
47. recharts 3.1
48. react-icons 5.5
49. lodash 4.17
50. classnames 2.3
51. web-vitals 2.1
52. sass 1.56
53. stylelint 15.8 (clean-order, css-modules, recess-order, recommended-scss, standard-scss, scss)
54. Biome 1.7.2
55. husky 9
56. lint-staged 15
57. @testing-library/react 13.4
58. @testing-library/jest-dom 5.16
59. @testing-library/user-event 13.5

Пакет `@lenremont/phoner` (софтфон):

1. jssip 3.10
2. xstate 4.38
3. @xstate/react 3.2
4. @xstate/inspect 0.8
5. react-query 3.39
6. react-hotkeys-hook 4.4
7. localforage 1.10
8. dayjs 1.11
9. clsx 1.2
10. nanoid 4.0
11. Storybook 7
12. PostCSS (preset-env, nested, mixins, import, extend)

---

## customer-crm

Админ-панель приложения клиента.

1. React 18.3.1
2. react-dom 18.3.1
3. TypeScript 5.5
4. Vite 5.4
5. @vitejs/plugin-react 4.3
6. react-router-dom 7.18
7. zustand 5.0.14
8. @reduxjs/toolkit 2.12
9. react-redux 9.3
10. RTK Query (в составе @reduxjs/toolkit)
11. react-hook-form 7.81
12. @hookform/resolvers 5.4
13. zod 4.4
14. @tanstack/react-table 8.21
15. react-dnd 16
16. react-dnd-html5-backend 16
17. react-dropzone 17
18. react-datepicker 9.1
19. date-fns 4.4
20. recharts 3.9
21. lucide-react 1.34
22. sass 1.77 (SCSS-модули)
23. Biome 2.5.4
24. lefthook 2.1.10

---

## customer-app

PWA клиента.

1. React 18.3.1
2. react-dom 18.3.1
3. TypeScript 5.6
4. Vite 5.4
5. @vitejs/plugin-react 4.3
6. vite-plugin-pwa 1.3
7. workbox-precaching 7.4
8. workbox-routing 7.4
9. workbox-strategies 7.4
10. workbox-expiration 7.4
11. workbox-cacheable-response 7.4
12. react-router-dom 7.18
13. zustand 5.0.15
14. @reduxjs/toolkit 2.12
15. react-redux 9.3
16. RTK Query (в составе @reduxjs/toolkit)
17. react-hook-form 7.87
18. @hookform/resolvers 5.9
19. zod 4.5
20. @tanstack/react-table 8.21
21. react-dnd 16
22. react-dnd-html5-backend 16
23. react-dropzone 17
24. lucide-react 1.31
25. sass 1.83 (SCSS-модули)
26. Biome 2.5.7
27. lefthook 2.1

---

## delivery-app

PWA курьера.

1. React 18.3.1
2. react-dom 18.3.1
3. TypeScript 5.5
4. Vite 5.4
5. @vitejs/plugin-react 4.3
6. vite-plugin-pwa 1.3
7. workbox-precaching 7.4
8. workbox-routing 7.4
9. workbox-strategies 7.4
10. workbox-expiration 7.4
11. workbox-cacheable-response 7.4
12. react-router-dom 7.18
13. React Context (локальное состояние)
14. @reduxjs/toolkit 2.12
15. react-redux 9.3
16. RTK Query (в составе @reduxjs/toolkit)
17. maplibre-gl 5.24
18. @types/geojson
19. date-fns 4.4
20. lucide-react 1.28
21. sass 1.77 (SCSS-модули)
22. Biome 2.5.4
23. lefthook 2.1.10

---

## app

«Поинт 2.0».

1. React 18.3.1
2. react-dom 18.3.1
3. TypeScript 5.5
4. Vite 5.4
5. @vitejs/plugin-react 4.3
6. react-router-dom 7.18
7. zustand 5.0.14
8. React Context
9. @reduxjs/toolkit 2.12
10. react-redux 9.3
11. RTK Query (в составе @reduxjs/toolkit)
12. react-hook-form 7.81
13. @hookform/resolvers 5.4
14. zod 4.4
15. @tanstack/react-table 8.21
16. react-dnd 16
17. react-dnd-html5-backend 16
18. react-dropzone 17
19. react-datepicker 9.1
20. date-fns 4.4
21. maplibre-gl 5.24
22. recharts 3.9
23. sass 1.77 (SCSS-модули)
24. Biome 2.5.4
25. lefthook 2.1.10

# Стек бэкенда по проектам

## basa

Старая База (CRM Lenremont), кастомный PHP-фреймворк.

1. PHP 7.4
2. illuminate/support 5.5, illuminate/routing 5.5, illuminate/events 5.5
3. symfony/http-foundation 3.3.6, symfony/console 3.3
4. twig/twig 2.16
5. vlucas/phpdotenv 4.3
6. doctrine/dbal 2.13
7. ruckusing/ruckusing-migrations 1.1
8. enqueue/enqueue 0.8 (dbal, fs) — очереди
9. guzzlehttp/guzzle 6.5
10. firebase/php-jwt 6.4
11. kreait/firebase-php 4.44
12. pusher/pusher-php-server 4.1
13. predis/predis 2.3 — Redis
14. phpoffice/phpspreadsheet 1.29
15. endroid/qr-code 2.5
16. giggsey/libphonenumber-for-php 8.13
17. telegram-bot/api 2.5
18. graylog2/gelf-php 1.7
19. sentry/sdk 3.6
20. monolog/monolog 1.27
21. MySQL / Memcached
22. Webpack 4 / Babel 6 / TinyMCE 4 — фронт-ассеты
23. PHPUnit 7

---

## point

«Поинт» — кастомный PHP-фреймворк (точки / мастера / ATS).

1. PHP ≥ 7.4
2. illuminate/support 5.5, illuminate/routing 5.5, illuminate/events 5.5
3. symfony/http-foundation 3.3.6, symfony/http-kernel 3.3, symfony/console 3.3
4. twig/twig 2.16
5. doctrine/orm 2.5, doctrine/dbal 2.6
6. vlucas/phpdotenv 4.3
7. ruckusing/ruckusing-migrations 1.1
8. enqueue/enqueue 0.8 (dbal, fs) — очереди
9. guzzlehttp/guzzle 6.5
10. firebase/php-jwt 6.10
11. phpoffice/phpspreadsheet 1.29, phpoffice/phpexcel 1.8
12. endroid/qr-code 2.5
13. giggsey/libphonenumber-for-php 8.13
14. phpmailer/phpmailer 5.2
15. phpseclib/phpseclib 2.0
16. mobiledetect/mobiledetectlib 2.8
17. kriswallsmith/assetic 1.4
18. nesbot/carbon 2.0
19. graylog2/gelf-php 1.7
20. sentry/sdk 2.2
21. monolog/monolog 1.27
22. MySQL
23. Redis
24. PHPUnit 6.5

---

## records

API записей звонков (CDR, blacklist, voicemail) на ClickHouse.

1. PHP ≥ 7.4
2. Laravel Lumen 5.8.13
3. dingo/api 2.4
4. smi2/phpclickhouse 1.5
5. the-tinderbox/clickhouse-builder 6.1
6. ClickHouse
7. propaganistas/laravel-phone 4.2
8. wapmorgan/mp3info 0.0.4
9. hedii/laravel-gelf-logger 4.1 — Graylog
10. bugsnag/bugsnag-laravel 2.28
11. guzzlehttp/guzzle 7.9
12. symfony/lock 4.3
13. PHPUnit 7

---

## basa-backend

База 2 — бэкенд CRM (Lenremont BASA).

1. PHP 8.1
2. Laravel 9.52
3. laravel/sanctum 3.3
4. laravel/horizon 5.29 — очереди (Redis)
5. laravel/telescope 4.17
6. darkaonline/l5-swagger 8.6 — OpenAPI `/api/docs`
7. predis/predis 2.2 — Redis
8. guzzlehttp/guzzle 7.9
9. maatwebsite/excel 3.1 / phpoffice/phpspreadsheet 1.29
10. intervention/image 2.7
11. kalnoy/nestedset 6.0
12. tucker-eric/eloquentfilter 3.4
13. staudenmeir/eloquent-json-relations 1.7
14. iksaku/laravel-mass-update 1.0
15. lenremont/dto 0.0.14
16. movemoveapp/laravel-dadata 1.0
17. laravel-notification-channels/fcm 3.2
18. laravel-notification-channels/smsc-ru 3.4
19. kreait/laravel-firebase / kreait/firebase-php 7.16
20. giggsey/libphonenumber-for-php 8.13
21. hedii/laravel-gelf-logger 7.1 — Graylog
22. sentry/sentry-laravel 3.8
23. MySQL
24. Vite 3 / laravel-vite-plugin 0.6 / axios 1.1 — ассеты
25. Laravel Pint
26. PHPUnit 9.5

---

## phoner-backend

Бэкенд софтфона (звонки из браузера, ARI, записи).

1. PHP 8.1
2. Laravel 10.48
3. laravel/sanctum 3.3
4. laravel/ui 4.5
5. beyondcode/laravel-websockets 1.14
6. pusher/pusher-php-server 7.2 / laravel-echo + pusher-js (фронт)
7. cybercog/laravel-clickhouse, glushkovds/phpclickhouse-laravel 1.20
8. smi2/phpclickhouse 1.5, the-tinderbox/clickhouse-builder 6.1
9. ClickHouse
10. firebase/php-jwt 6.11
11. cuyz/valinor
12. spatie/data-transfer-object 3.9
13. lenremont/bridge 0.0.14, lenremont/dto 0.0.14
14. wapmorgan/mp3info 0.1
15. giggsey/libphonenumber-for-php 8.13
16. hedii/laravel-gelf-logger 8.1 — Graylog
17. darkaonline/l5-swagger 8.5 (dev) — `/api/documentation`
18. guzzlehttp/guzzle 7.9
19. monolog/monolog 3.4
20. Vite 4.5 / laravel-vite-plugin 0.7 / Bootstrap 5.2 / Sass / jssip 3.10 — UI эмулятора
21. Laravel Pint
22. PHPUnit 10.1

---

## master-api

API приложения мастера (заказы, звонки, уведомления, realtime).

1. PHP 8.2
2. Laravel 12.8
3. laravel/sanctum 4.0
4. laravel/reverb 1.5 — WebSockets
5. darkaonline/l5-swagger 9.0 — OpenAPI
6. intervention/image 3.11
7. guzzlehttp/guzzle 7.9
8. pusher/pusher-php-server 7.2
9. MySQL (несколько подключений)
10. Redis (phpredis)
11. Vite 6.2 / laravel-vite-plugin 1.2 / Tailwind CSS 4 / axios 1.8 — ассеты
12. Laravel Pint / Pail
13. PHPUnit 11.5
14. Docker: php:8.2-fpm-alpine, nginx

---

## payment-api

API платежей (новый).

1. PHP 8.2
2. Laravel 12.13
3. laravel/sanctum 4.1
4. opcodesio/log-viewer 3.17
5. guzzlehttp/guzzle 7.9
6. MySQL (несколько подключений)
7. Redis (phpredis)
8. Vite 6.2 / laravel-vite-plugin 1.2 / Tailwind CSS 4 / axios 1.8 — ассеты
9. Laravel Pint / Pail
10. PHPUnit 11.5
11. Docker: php:8.2-fpm-alpine, nginx

---

## login-app

Сервис авторизации (замена legacy `login`).

1. PHP 8.2
2. Laravel 12.53
3. firebase/php-jwt 7.0
4. guzzlehttp/guzzle 7.10
5. MySQL
6. Redis (phpredis)
7. Vite 7 / laravel-vite-plugin 2 / Bootstrap 5.3 / Sass / axios 1.11 — ассеты
8. Laravel Pint / Pail
9. PHPUnit 11.5
10. Docker: php:8.2-fpm-alpine

# Стек мобильного приложения мастеров

## repairman-app

Мобильное приложение мастеров (`lenren_master`, `com.lenren.master`). Flutter, feature-based архитектура (BLoC + get_it). Версия приложения: 1.1.15+107.

1. Flutter 3.41.0 (FVM)
2. Dart SDK ^3.8.1 (lock: ≥3.11)
3. flutter_localizations
4. bloc 9.2 / flutter_bloc 9.1 — состояние
5. get_it 9.2 — DI
6. auto_route 11.1 — навигация
7. dio 5.9 + retrofit 4.9 — HTTP API
8. dio_smart_retry 7.0
9. pretty_dio_logger 1.4
10. json_annotation 4.10 / json_serializable 6.12
11. equatable 2.0
12. drift 2.31 + drift_flutter 0.2 + sqlite3 2.9 / sqlite3_flutter_libs — локальная БД
13. shared_preferences 2.5
14. path_provider 2.1 / path 1.9
15. firebase_core 4.4 / firebase_messaging 16.1 — FCM
16. flutter_local_notifications 21.0
17. dart_pusher_channels 1.2 — realtime (Pusher)
18. connectivity_plus 7.0
19. permission_handler 12.0
20. geolocator 14.0
21. maplibre_gl 0.25 / flutter_map 8.2 / latlong2 0.9 — карты
22. camera 0.11 / image_picker 1.2 / file_picker 10.3
23. cached_network_image 3.4 / flutter_cache_manager 3.4
24. flutter_svg 2.2
25. audioplayers 6.5
26. ffmpeg_kit_flutter_new_audio 2.5 — аудио
27. background_downloader 9.5
28. open_file 3.5 / share_plus 12.0 / image_gallery_saver_plus 4.0
29. syncfusion_flutter_charts 32.2 — графики
30. calendar_date_picker2 2.0 / calendar_view 1.4
31. infinite_scroll_pagination 5.1 / very_good_infinite_list 0.9
32. slang 4.12 / slang_flutter 4.12 — i18n (locale: ru)
33. intl 0.20 / timeago 3.7 / timezone 0.11 / flutter_timezone 5.0
34. mask_text_input_formatter 2.9
35. another_flushbar 1.12
36. flutter_keyboard_visibility 6.0
37. keep_screen_on 5.0 / wakelock_plus 1.4
38. url_launcher 6.3 / app_settings 7.0
39. package_info_plus 9.0 / device_info_plus 12.3
40. logger 2.6 / rxdart 0.27 / synchronized 3.4
41. collection 1.19 / async 2.13 / dart_extensions 2.2 / http 1.6
42. flutter_native_splash 2.4
43. Шрифт Inter (assets)

Платформы:

1. Android: minSdk 24, compileSdk/targetSdk 36, Kotlin 2.1, NDK 28.1
2. iOS: deployment target 15.3

Codegen / tooling:

1. build_runner 2.11
2. retrofit_generator 10.2
3. auto_route_generator 10.5
4. drift_dev 2.31
5. slang_build_runner 4.12
6. flutter_gen_runner 5.12 — ассеты → `lib/core/ui/generated`
7. flutter_lints 6.0
8. Mason (bricks: screen, feature)
9. FVM / Makefile (`pub`, `gen`, `build` apk/aab/ipa)

Фичи (`lib/feature`): auth, splash, tabs, monitor, orders, active_order, calendar, events, chats, files, notification, profile, report, more, vassals, app_update.

