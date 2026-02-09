# Facebook Auto Reply Bot

Авто-бот для ответов на комментарии Facebook с ИИ.

## Что делает

- Слушает комментарии на странице через Webhooks.
- Дочитывает текст комментария через Graph API.
- Генерирует ответ через OpenAI Responses API.
- Публикует ответ в Facebook автоматически.
- Предотвращает дубли ответов.

## Стек

- Facebook Graph API
- Webhooks
- Node.js + Express
- OpenAI Responses API
- Render (или любой другой хостинг)

## Переменные окружения

- `FB_PAGE_TOKEN` — Page Access Token.
- `FB_VERIFY_TOKEN` — строка для проверки webhook.
- `OPENAI_API_KEY` — ключ OpenAI.
- `OPENAI_MODEL` — модель (например, `gpt-4.1-mini`).
- `PORT` — порт сервера (опционально).

## Настройка webhook

1. Поднимите сервер и убедитесь, что доступен эндпоинт `GET /webhook`.
2. В Meta Developers выберите продукт **Page**.
3. Callback URL: `https://<your-domain>/webhook`
4. Verify token: значение `FB_VERIFY_TOKEN`.
5. Подпишитесь на поле `feed`.

## Как работает сервер

- `GET /webhook` — валидация Facebook (возвращает `hub.challenge`).
- `POST /webhook` — обработка новых комментариев, генерация и публикация ответа.

## Локальный запуск

```bash
export FB_PAGE_TOKEN="..."
export FB_VERIFY_TOKEN="..."
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-4.1-mini"
npm install
npm start
```
