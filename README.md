# Telegram Bot

Простой Telegram-бот на Node.js (`node-telegram-bot-api`), готовый к запуску локально и к деплою на Render.

## 1. Установка зависимостей

Перейдите в папку проекта и установите зависимости:

```bash
cd telegram-bot
npm install
```

## 2. Получение токена бота

1. Откройте Telegram и напишите [@BotFather](https://t.me/BotFather).
2. Отправьте команду `/newbot` и следуйте инструкциям.
3. BotFather выдаст токен вида `123456789:ABCdefGhIJKlmNoPQRstuVwxyZ`. Сохраните его — он понадобится дальше.

**Токен нигде не хранится в коде** — бот читает его из переменной окружения `BOT_TOKEN`.

## 3. Запуск локально

Перед запуском нужно передать токен через переменную окружения `BOT_TOKEN`.

**macOS / Linux:**

```bash
BOT_TOKEN=ваш_токен npm start
```

**Windows (PowerShell):**

```powershell
$env:BOT_TOKEN="ваш_токен"; npm start
```

**Windows (cmd.exe):**

```cmd
set BOT_TOKEN=ваш_токен && npm start
```

Если всё верно, в консоли появится:

```
🤖 Bot starting...
✅ Bot is running (@ваш_бот)
```

Если `BOT_TOKEN` не задан, бот выведет понятную ошибку и завершится — это ожидаемое поведение.

## 4. Загрузка проекта на GitHub

```bash
git init
git add .
git commit -m "Первая версия Telegram-бота"
```

Создайте новый пустой репозиторий на [github.com](https://github.com/new), затем:

```bash
git remote add origin https://github.com/ВАШ_НИКНЕЙМ/НАЗВАНИЕ_РЕПОЗИТОРИЯ.git
git branch -M main
git push -u origin main
```

Файл `.gitignore` уже настроен так, что `node_modules` и `.env` не попадут в репозиторий.

## 5. Подключение GitHub к Render

1. Зайдите на [render.com](https://render.com) и войдите (можно через GitHub).
2. Нажмите **New +** → **Background Worker** (это правильный тип сервиса для бота на polling — ему не нужен веб-порт; если такого пункта нет в интерфейсе, подойдёт и **Web Service**).
3. Выберите **Build and deploy from a Git repository** и подключите свой GitHub-аккаунт.
4. Выберите репозиторий с ботом.

## 6. Настройки на Render

При создании сервиса укажите:

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment Variable**:
  - Key: `BOT_TOKEN`
  - Value: ваш настоящий токен от @BotFather

Переменную окружения добавляют в разделе **Environment** настроек сервиса.

## 7. Проверка, что бот работает

1. В логах Render должно появиться:
   ```
   🤖 Bot starting...
   ✅ Bot is running (@ваш_бот)
   ```
2. Откройте своего бота в Telegram и отправьте `/start`.
3. Бот должен прислать приветствие с тремя кнопками: 🚀 Начать, ℹ️ Помощь, 👤 Профиль.
4. Проверьте команды `/help`, `/profile` и нажатия на кнопки.

Если что-то пошло не так — смотрите логи в разделе **Logs** на Render, все ошибки там будут начинаться с `❌ Bot error:`.
