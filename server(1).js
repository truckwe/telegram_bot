// server.js
// Простой Telegram-бот на библиотеке node-telegram-bot-api.
// Плюс минимальный HTTP-сервер (без Express) — нужен, чтобы Render
// принимал проект как обычный Web Service на Free-плане.
// Запуск: npm start
// Токен берётся ТОЛЬКО из переменной окружения BOT_TOKEN.

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');

// ==== Проверка токена ====
const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('❌ Bot error: переменная окружения BOT_TOKEN не установлена.');
  console.error('   Добавьте BOT_TOKEN (токен из @BotFather) в переменные окружения и запустите бота снова.');
  process.exit(1);
}

console.log('🤖 Bot starting...');

// ==== Создание бота (режим polling — бот сам опрашивает Telegram) ====
const bot = new TelegramBot(token, { polling: true });

// ==== Inline-клавиатура для главного меню ====
const mainKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🚀 Начать', callback_data: 'action_start' }],
      [{ text: 'ℹ️ Помощь', callback_data: 'action_help' }],
      [{ text: '👤 Профиль', callback_data: 'action_profile' }]
    ]
  }
};

// ==== Тексты сообщений ====
const WELCOME_TEXT =
  '👋 Привет! Я новый Telegram-бот.\n\n' +
  'Используй кнопки ниже, чтобы начать.';

const HELP_TEXT =
  'ℹ️ Как пользоваться ботом:\n\n' +
  '/start — начать работу с ботом и открыть меню\n' +
  '/help — показать эту инструкцию\n' +
  '/profile — показать информацию о вашем профиле\n\n' +
  'Также можно пользоваться кнопками под сообщениями бота.';

function getProfileText(user) {
  const id = user.id;
  const username = user.username ? '@' + user.username : 'не указан';
  const firstName = user.first_name || 'не указано';

  return (
    '👤 Ваш профиль:\n\n' +
    `🆔 Telegram ID: ${id}\n` +
    `📛 Имя: ${firstName}\n` +
    `🔗 Username: ${username}`
  );
}

async function sendWelcome(chatId) {
  await bot.sendMessage(chatId, WELCOME_TEXT, mainKeyboard);
}

// ==== Обработка текстовых сообщений и команд ====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Игнорируем сообщения без текста (фото, стикеры, голосовые и т.д.)
  if (!text) {
    return;
  }

  try {
    if (text === '/start') {
      await sendWelcome(chatId);
    } else if (text === '/help') {
      await bot.sendMessage(chatId, HELP_TEXT);
    } else if (text === '/profile') {
      await bot.sendMessage(chatId, getProfileText(msg.from));
    } else if (text.startsWith('/')) {
      // Неизвестная команда
      await bot.sendMessage(chatId, '❓ Я пока не знаю такую команду. Используй /help.');
    }
    // Обычный текст (не команду) просто игнорируем — это первая версия бота.
  } catch (err) {
    console.error('❌ Bot error:', err.message);
  }
});

// ==== Обработка нажатий на inline-кнопки ====
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    if (data === 'action_start') {
      await bot.sendMessage(chatId, '🚀 Отлично! Бот готов к работе.');
    } else if (data === 'action_help') {
      await bot.sendMessage(chatId, HELP_TEXT);
    } else if (data === 'action_profile') {
      await bot.sendMessage(chatId, getProfileText(query.from));
    }

    // Обязательно отвечаем на callback_query, иначе кнопка "крутится" вечно
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('❌ Bot error:', err.message);
    try {
      await bot.answerCallbackQuery(query.id);
    } catch (innerErr) {
      console.error('❌ Bot error:', innerErr.message);
    }
  }
});

// ==== Обработка ошибок Telegram API (например, обрыв сети во время polling) ====
bot.on('polling_error', (err) => {
  console.error('❌ Bot error:', err.message);
});

// ==== Обработка ошибок самого процесса Node.js ====
process.on('unhandledRejection', (reason) => {
  console.error('❌ Bot error:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Bot error:', err.message);
});

// ==== Минимальный HTTP-сервер ====
// Render Free Web Service требует, чтобы приложение слушало порт из
// process.env.PORT — иначе деплой считается неуспешным. Express тут
// не нужен: хватает встроенного модуля http. Сервер не делает ничего
// сложного — просто отвечает "OK", чтобы Render видел, что сервис жив.
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot is running');
});

server.on('error', (err) => {
  console.error('❌ Bot error: HTTP-сервер не смог запуститься.', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

// ==== Проверка подключения к Telegram при старте ====
bot.getMe()
  .then((me) => {
    console.log(`✅ Bot is running (@${me.username})`);
  })
  .catch((err) => {
    console.error('❌ Bot error: не удалось подключиться к Telegram. Проверьте BOT_TOKEN.', err.message);
    process.exit(1);
  });
