# NUURA — бот записи + API для сайта

## Что это
Телеграм-бот, который хранит расписание и записи, и отдаёт их сайту по HTTP.

## Переменные окружения
Смотри `.env.example` — там описана каждая.

## Запуск на Railway
1. Залей папку в репозиторий на GitHub
2. Railway → New Project → Deploy from GitHub repo
3. Variables → добавь переменные из `.env.example`
4. Settings → Volumes → добавь volume, путь `/data`
5. Settings → Networking → Generate Domain

После деплоя открой выданный адрес — должно написать «NUURA bot is running».

## Адреса для сайта
Все требуют заголовок `X-API-Key` со значением из `API_KEY`.

- `GET /api/config` — услуги, мастера, даты
- `GET /api/slots?master=sabina&date=2026-10-12&service=manicure` — свободное время
- `POST /api/book` — создать запись
  ```json
  { "service":"manicure", "master":"sabina", "date":"2026-10-12",
    "time":"15:00", "name":"Нигора", "phone":"+998 90 123 45 67",
    "source":"site" }
  ```
  В ответ придёт `bookingId` и `remindUrl` — ссылка для кнопки «Напомнить за 2 часа».

## Админка
Напиши боту `/admin` с аккаунта, чей ID указан в `ADMIN_IDS`.
