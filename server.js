// server.js
// Telegram-бот на node-telegram-bot-api + AI-чат через OpenRouter.
// Оптимизирован для максимально быстрой генерации ответов.
// Работает как обычный Render Free Web Service:
//   - Telegram polling (не webhook)
//   - встроенный HTTP-сервер (модуль http, без Express) слушает process.env.PORT
// Запуск: npm start
//
// Секреты берутся ТОЛЬКО из переменных окружения:
//   BOT_TOKEN            — токен Telegram-бота
//   OPENROUTER_API_KEY   — ключ OpenRouter
// Ничего секретного в коде не хранится.

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');

// ==== Проверка переменных окружения ====
const token = process.env.BOT_TOKEN;
const openRouterApiKey = process.env.OPENROUTER_API_KEY;

if (!token) {
  console.error('❌ Bot error: переменная окружения BOT_TOKEN не установлена.');
  console.error('   Добавьте BOT_TOKEN (токен из @BotFather) в переменные окружения и запустите бота снова.');
  process.exit(1);
}

if (!openRouterApiKey) {
  console.error('❌ Bot error: переменная окружения OPENROUTER_API_KEY не установлена.');
  console.error('   Добавьте OPENROUTER_API_KEY (ключ с openrouter.ai) в переменные окружения и запустите бота снова.');
  process.exit(1);
}

console.log('🤖 Bot starting...');

// ==== Создание бота (режим polling — бот сам опрашивает Telegram) ====
const bot = new TelegramBot(token, { polling: true });

// ==== Настройки AI-чата (оптимизировано под скорость) ====
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Конкретная быстрая модель вместо роутера "openrouter/free" — роутер сам
// выбирает модель на своё усмотрение и иногда попадает на медленную.
// gpt-oss-20b — компактная MoE-модель (3.6B активных параметров),
// специально оптимизированная под низкую задержку ответа.
const OPENROUTER_MODEL = 'openai/gpt-oss-20b:free';

// Ограничиваем длину ответа — большие ответы генерируются заметно дольше.
const MAX_OUTPUT_TOKENS = 600;

const TEMPERATURE = 0.7;

// Таймаут одного запроса к OpenRouter. Если модель "зависла" — не ждём
// бесконечно, а корректно сообщаем об этом пользователю.
const REQUEST_TIMEOUT_MS = 20000;

// Сколько последних сообщений (и от пользователя, и от AI суммарно) хранить
// в истории одного диалога. Короче история — быстрее и дешевле ответ,
// но пользователь ещё должен ощущать связный контекст.
const MAX_HISTORY_MESSAGES = 6;

// Максимальная длина одного сообщения в Telegram — 4096 символов,
// берём с запасом, чтобы не наткнуться на лимит.
const TELEGRAM_MESSAGE_LIMIT = 4000;

const SYSTEM_PROMPT =
  'Ты — дружелюбный AI-ассистент внутри Telegram-бота. ' +
  'Отвечай кратко, по делу и на том языке, на котором пишет пользователь.';

// ==== Память диалогов (в оперативной памяти процесса, без базы данных) ====
// chatId -> { history: [{role, content}, ...], messageCount: number }
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { history: [], messageCount: 0 });
  }
  return sessions.get(chatId);
}

function addToHistory(session, role, content) {
  session.history.push({ role, content });
  // Не даём истории бесконечно расти — оставляем только последние сообщения
  if (session.history.length > MAX_HISTORY_MESSAGES) {
    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
  }
}

// ==== Inline-клавиатура для главного меню ====
const mainKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🤖 Новый чат', callback_data: 'action_new' }],
      [{ text: '👤 Профиль', callback_data: 'action_profile' }],
      [{ text: 'ℹ️ Помощь', callback_data: 'action_help' }]
    ]
  }
};

// ==== Тексты сообщений ====
const WELCOME_TEXT =
  '👋 Привет! Теперь я AI-ассистент на базе OpenRouter.\n\n' +
  'Просто напиши мне любое сообщение — и я отвечу с помощью нейросети. ' +
  'Я запоминаю несколько последних сообщений, чтобы понимать контекст разговора.\n\n' +
  'Используй кнопки ниже, чтобы начать 👇';

const HELP_TEXT =
  'ℹ️ Что я умею:\n\n' +
  '🤖 Я — AI-ассистент. Напиши мне любое сообщение обычным текстом, и я отвечу с помощью нейросети (OpenRouter).\n' +
  '💬 Я помню последние сообщения разговора, чтобы отвечать с учётом контекста.\n\n' +
  'Команды:\n' +
  '/start — приветствие и главное меню\n' +
  '/help — эта инструкция\n' +
  '/profile — информация о вашем профиле\n' +
  '/new — начать новый диалог (очистить историю)\n\n' +
  'Также можно пользоваться кнопками под сообщениями.';

function getProfileText(user, session) {
  const id = user.id;
  const username = user.username ? '@' + user.username : 'не указан';
  const firstName = user.first_name || 'не указано';
  const messageCount = session ? session.messageCount : 0;

  return (
    '👤 Ваш профиль:\n\n' +
    `🆔 Telegram ID: ${id}\n` +
    `📛 Имя: ${firstName}\n` +
    `🔗 Username: ${username}\n` +
    `💬 Сообщений отправлено: ${messageCount}`
  );
}

async function sendWelcome(chatId) {
  await bot.sendMessage(chatId, WELCOME_TEXT, mainKeyboard);
}

// ==== Обращение к OpenRouter ====
function splitMessage(text, maxLen = TELEGRAM_MESSAGE_LIMIT) {
  const parts = [];
  let rest = text;
  while (rest.length > maxLen) {
    parts.push(rest.slice(0, maxLen));
    rest = rest.slice(maxLen);
  }
  parts.push(rest);
  return parts;
}

async function askOpenRouter(history) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;

  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: TEMPERATURE,
        // Снижаем уровень "рассуждений" модели — для простых вопросов вроде
        // "привет" или "2+2" глубокое рассуждение не нужно и только замедляет ответ.
        reasoning: { effort: 'low' }
      }),
      signal: controller.signal
    });
  } catch (networkErr) {
    if (networkErr.name === 'AbortError') {
      const err = new Error(`OpenRouter не ответил за ${REQUEST_TIMEOUT_MS / 1000} секунд (timeout).`);
      err.kind = 'timeout';
      throw err;
    }
    // Например, нет сети или OpenRouter недоступен
    const err = new Error(`OpenRouter недоступен: ${networkErr.message}`);
    err.kind = 'network';
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch (_) {
      // тело не удалось прочитать — не критично
    }

    const err = new Error(`OpenRouter вернул ошибку ${response.status}: ${bodyText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;

  if (!content || !content.trim()) {
    const err = new Error('OpenRouter вернул пустой ответ.');
    err.kind = 'empty';
    throw err;
  }

  return content.trim();
}

function getFriendlyErrorText(err) {
  if (err.status === 401 || err.status === 403) {
    return '⚠️ Проблема с ключом доступа к AI. Сообщите об этом администратору бота.';
  }
  if (err.status === 429) {
    return '⚠️ Сейчас слишком много запросов к AI (лимит бесплатной модели исчерпан). Попробуй через минуту.';
  }
  if (err.status && err.status >= 500) {
    return '⚠️ AI-сервис сейчас недоступен. Попробуй немного позже.';
  }
  if (err.kind === 'timeout') {
    return '⚠️ AI слишком долго не отвечал, запрос прерван. Попробуй ещё раз.';
  }
  if (err.kind === 'network') {
    return '⚠️ Не получилось связаться с AI-сервисом. Проверь, что всё в порядке, и попробуй ещё раз.';
  }
  if (err.kind === 'empty') {
    return '⚠️ AI не смог сформировать ответ. Попробуй переформулировать вопрос.';
  }
  return '⚠️ Что-то пошло не так при обращении к AI. Попробуй ещё раз чуть позже.';
}

async function handleAiMessage(chatId, text, session) {
  let thinkingMsg = null;

  try {
    thinkingMsg = await bot.sendMessage(chatId, '⏳ Думаю...');
  } catch (err) {
    console.error('❌ Bot error:', err.message);
    return;
  }

  try {
    addToHistory(session, 'user', text);

    const reply = await askOpenRouter(session.history);

    addToHistory(session, 'assistant', reply);

    const chunks = splitMessage(reply);

    await bot.editMessageText(chunks[0], {
      chat_id: chatId,
      message_id: thinkingMsg.message_id
    });

    for (let i = 1; i < chunks.length; i++) {
      await bot.sendMessage(chatId, chunks[i]);
    }
  } catch (err) {
    console.error('❌ Bot error:', err.message);

    const friendlyText = getFriendlyErrorText(err);

    try {
      await bot.editMessageText(friendlyText, {
        chat_id: chatId,
        message_id: thinkingMsg.message_id
      });
    } catch (editErr) {
      console.error('❌ Bot error:', editErr.message);
    }
  }
}

// ==== Обработка текстовых сообщений и команд ====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Игнорируем сообщения без текста (фото, стикеры, голосовые и т.д.)
  if (!text) {
    return;
  }

  const session = getSession(chatId);
  session.messageCount += 1;

  try {
    if (text === '/start') {
      await sendWelcome(chatId);
    } else if (text === '/help') {
      await bot.sendMessage(chatId, HELP_TEXT);
    } else if (text === '/profile') {
      await bot.sendMessage(chatId, getProfileText(msg.from, session));
    } else if (text === '/new') {
      session.history = [];
      await bot.sendMessage(chatId, '🆕 Новый диалог начат!');
    } else if (text.startsWith('/')) {
      // Неизвестная команда — показываем помощь
      await bot.sendMessage(chatId, '❓ Я не знаю такую команду.\n\n' + HELP_TEXT);
    } else {
      // Обычное сообщение — отправляем в AI
      await handleAiMessage(chatId, text, session);
    }
  } catch (err) {
    console.error('❌ Bot error:', err.message);
  }
});

// ==== Обработка нажатий на inline-кнопки ====
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  try {
    if (data === 'action_new') {
      session.history = [];
      await bot.sendMessage(chatId, '🆕 Новый диалог начат!');
    } else if (data === 'action_help') {
      await bot.sendMessage(chatId, HELP_TEXT);
    } else if (data === 'action_profile') {
      await bot.sendMessage(chatId, getProfileText(query.from, session));
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
// не нужен: хватает встроенного модуля http.
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