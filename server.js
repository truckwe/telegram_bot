// server.js
// Telegram-бот на node-telegram-bot-api + AI-чат через OpenRouter.
// Поддерживает текст и фотографии.
// Работает как Render Free Web Service:
//   - Telegram polling
//   - встроенный HTTP-сервер
//
// Секреты:
//   BOT_TOKEN
//   OPENROUTER_API_KEY

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');

// ==== Проверка переменных окружения ====

const token = process.env.BOT_TOKEN;
const openRouterApiKey = process.env.OPENROUTER_API_KEY;

if (!token) {
  console.error('❌ Bot error: BOT_TOKEN не установлен.');
  process.exit(1);
}

if (!openRouterApiKey) {
  console.error('❌ Bot error: OPENROUTER_API_KEY не установлен.');
  process.exit(1);
}

console.log('🤖 Bot starting...');

// ==== Telegram ====

const bot = new TelegramBot(token, {
  polling: true
});

// ==== OpenRouter ====

const OPENROUTER_URL =
  'https://openrouter.ai/api/v1/chat/completions';

// Бесплатная vision-модель
const OPENROUTER_MODEL =
  'qwen/qwen3.8-27b:free';

const MAX_OUTPUT_TOKENS = 600;

const TEMPERATURE = 0.7;

const REQUEST_TIMEOUT_MS = 30000;

const MAX_HISTORY_MESSAGES = 6;

const TELEGRAM_MESSAGE_LIMIT = 4000;

const SYSTEM_PROMPT =
  'Ты — дружелюбный AI-ассистент внутри Telegram-бота. ' +
  'Отвечай кратко, понятно и по делу. ' +
  'Отвечай на языке пользователя. ' +
  'Если пользователь отправил изображение, внимательно анализируй его.';

// ==== Память диалогов ====

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      history: [],
      messageCount: 0
    });
  }

  return sessions.get(chatId);
}

function addToHistory(session, role, content) {
  session.history.push({
    role,
    content
  });

  if (session.history.length > MAX_HISTORY_MESSAGES) {
    session.history =
      session.history.slice(-MAX_HISTORY_MESSAGES);
  }
}

// ==== Главное меню ====

const mainKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: '🤖 Новый чат',
          callback_data: 'action_new'
        }
      ],
      [
        {
          text: '👤 Профиль',
          callback_data: 'action_profile'
        }
      ],
      [
        {
          text: 'ℹ️ Помощь',
          callback_data: 'action_help'
        }
      ]
    ]
  }
};

// ==== Тексты ====

const WELCOME_TEXT =
  '👋 Привет! Теперь я AI-ассистент.\n\n' +
  '💬 Пиши мне текст.\n' +
  '📷 Также можешь отправлять фотографии — я смогу их анализировать.\n\n' +
  'Просто отправь сообщение 👇';

const HELP_TEXT =
  'ℹ️ Что я умею:\n\n' +
  '🤖 Отвечаю на текстовые сообщения.\n' +
  '📷 Анализирую фотографии.\n' +
  '🧠 Помню несколько последних сообщений.\n\n' +
  'Команды:\n' +
  '/start — главное меню\n' +
  '/help — помощь\n' +
  '/profile — профиль\n' +
  '/new — новый диалог';

function getProfileText(user, session) {
  const id = user.id;

  const username =
    user.username
      ? '@' + user.username
      : 'не указан';

  const firstName =
    user.first_name || 'не указано';

  const messageCount =
    session ? session.messageCount : 0;

  return (
    '👤 Ваш профиль:\n\n' +
    `🆔 Telegram ID: ${id}\n` +
    `📛 Имя: ${firstName}\n` +
    `🔗 Username: ${username}\n` +
    `💬 Сообщений отправлено: ${messageCount}`
  );
}

async function sendWelcome(chatId) {
  await bot.sendMessage(
    chatId,
    WELCOME_TEXT,
    mainKeyboard
  );
}

// ==== Разделение длинных сообщений ====

function splitMessage(
  text,
  maxLen = TELEGRAM_MESSAGE_LIMIT
) {
  const parts = [];

  let rest = text;

  while (rest.length > maxLen) {
    parts.push(
      rest.slice(0, maxLen)
    );

    rest =
      rest.slice(maxLen);
  }

  if (rest.length > 0) {
    parts.push(rest);
  }

  return parts;
}

// ==================================================
// СКАЧИВАНИЕ ФОТО ИЗ TELEGRAM
// ==================================================

async function getTelegramPhotoBase64(fileId) {
  const file =
    await bot.getFile(fileId);

  if (!file.file_path) {
    throw new Error(
      'Telegram не вернул путь к файлу'
    );
  }

  const fileUrl =
    `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  const response =
    await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(
      `Не удалось скачать фото из Telegram: ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  const base64 =
    buffer.toString('base64');

  let mimeType =
    'image/jpeg';

  if (
    file.file_path.endsWith('.png')
  ) {
    mimeType =
      'image/png';
  } else if (
    file.file_path.endsWith('.webp')
  ) {
    mimeType =
      'image/webp';
  } else if (
    file.file_path.endsWith('.jpg') ||
    file.file_path.endsWith('.jpeg')
  ) {
    mimeType =
      'image/jpeg';
  }

  return `data:${mimeType};base64,${base64}`;
}

// ==================================================
// OPENROUTER
// ==================================================

async function askOpenRouter(history) {
  const controller =
    new AbortController();

  const timeoutId =
    setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

  let response;

  try {
    response =
      await fetch(
        OPENROUTER_URL,
        {
          method: 'POST',

          headers: {
            Authorization:
              `Bearer ${openRouterApiKey}`,

            'Content-Type':
              'application/json'
          },

          body: JSON.stringify({
            model:
              OPENROUTER_MODEL,

            messages: [
              {
                role: 'system',
                content: SYSTEM_PROMPT
              },
              ...history
            ],

            max_tokens:
              MAX_OUTPUT_TOKENS,

            temperature:
              TEMPERATURE
          }),

          signal:
            controller.signal
        }
      );

  } catch (networkErr) {

    if (
      networkErr.name === 'AbortError'
    ) {
      const err =
        new Error(
          `OpenRouter не ответил за ${REQUEST_TIMEOUT_MS / 1000} секунд.`
        );

      err.kind =
        'timeout';

      throw err;
    }

    const err =
      new Error(
        `OpenRouter недоступен: ${networkErr.message}`
      );

    err.kind =
      'network';

    throw err;

  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let bodyText = '';

    try {
      bodyText =
        await response.text();
    } catch (_) {}

    const err =
      new Error(
        `OpenRouter вернул ошибку ${response.status}: ${bodyText}`
      );

    err.status =
      response.status;

    throw err;
  }

  const data =
    await response.json();

  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message
      ? data.choices[0].message.content
      : null;

  if (
    !content ||
    !content.trim()
  ) {
    const err =
      new Error(
        'OpenRouter вернул пустой ответ.'
      );

    err.kind =
      'empty';

    throw err;
  }

  return content.trim();
}

// ==================================================
// Ошибки
// ==================================================

function getFriendlyErrorText(err) {

  if (
    err.status === 401 ||
    err.status === 403
  ) {
    return (
      '⚠️ Проблема с ключом доступа к AI.'
    );
  }

  if (err.status === 404) {
    return (
      '⚠️ Выбранная AI-модель сейчас недоступна.'
    );
  }

  if (err.status === 429) {
    return (
      '⚠️ Бесплатная модель сейчас перегружена или достигнут лимит. Попробуй через минуту.'
    );
  }

  if (
    err.status &&
    err.status >= 500
  ) {
    return (
      '⚠️ AI-сервис сейчас недоступен. Попробуй немного позже.'
    );
  }

  if (
    err.kind === 'timeout'
  ) {
    return (
      '⚠️ AI слишком долго не отвечал. Попробуй ещё раз.'
    );
  }

  if (
    err.kind === 'network'
  ) {
    return (
      '⚠️ Не получилось связаться с AI-сервисом.'
    );
  }

  if (
    err.kind === 'empty'
  ) {
    return (
      '⚠️ AI вернул пустой ответ.'
    );
  }

  return (
    '⚠️ Что-то пошло не так при обращении к AI. Попробуй ещё раз.'
  );
}

// ==================================================
// Отправка AI-ответа
// ==================================================

async function handleAiMessage(
  chatId,
  content,
  historyContent,
  session
) {
  let thinkingMsg = null;

  try {
    thinkingMsg =
      await bot.sendMessage(
        chatId,
        '⏳ Думаю...'
      );
  } catch (err) {
    console.error(
      '❌ Bot error:',
      err.message
    );

    return;
  }

  try {
    addToHistory(
      session,
      'user',
      historyContent
    );

    const reply =
      await askOpenRouter(
        session.history
      );

    addToHistory(
      session,
      'assistant',
      reply
    );

    const chunks =
      splitMessage(reply);

    await bot.editMessageText(
      chunks[0],
      {
        chat_id:
          chatId,

        message_id:
          thinkingMsg.message_id
      }
    );

    for (
      let i = 1;
      i < chunks.length;
      i++
    ) {
      await bot.sendMessage(
        chatId,
        chunks[i]
      );
    }

  } catch (err) {

    console.error(
      '❌ Bot error:',
      err.message
    );

    const friendlyText =
      getFriendlyErrorText(err);

    try {
      await bot.editMessageText(
        friendlyText,
        {
          chat_id:
            chatId,

          message_id:
            thinkingMsg.message_id
        }
      );
    } catch (editErr) {
      console.error(
        '❌ Bot error:',
        editErr.message
      );
    }
  }
}

// ==================================================
// ОБРАБОТКА СООБЩЕНИЙ
// ==================================================

bot.on(
  'message',
  async (msg) => {

    const chatId =
      msg.chat.id;

    const session =
      getSession(chatId);

    session.messageCount += 1;

    const text =
      msg.text;

    // ==============================================
    // КОМАНДЫ
    // ==============================================

    if (text === '/start') {
      await sendWelcome(chatId);
      return;
    }

    if (text === '/help') {
      await bot.sendMessage(
        chatId,
        HELP_TEXT
      );
      return;
    }

    if (text === '/profile') {
      await bot.sendMessage(
        chatId,
        getProfileText(
          msg.from,
          session
        )
      );
      return;
    }

    if (text === '/new') {
      session.history = [];

      await bot.sendMessage(
        chatId,
        '🆕 Новый диалог начат!'
      );

      return;
    }

    if (
      text &&
      text.startsWith('/')
    ) {
      await bot.sendMessage(
        chatId,
        '❓ Я не знаю такую команду.\n\n' +
        HELP_TEXT
      );

      return;
    }

    // ==============================================
    // ФОТО
    // ==============================================

    if (
      msg.photo &&
      msg.photo.length > 0
    ) {

      let thinkingMsg = null;

      try {

        thinkingMsg =
          await bot.sendMessage(
            chatId,
            '📷 Анализирую фото...'
          );

        // Берём самое большое доступное фото
        const largestPhoto =
          msg.photo[
            msg.photo.length - 1
          ];

        const imageData =
          await getTelegramPhotoBase64(
            largestPhoto.file_id
          );

        const userText =
          msg.caption ||
          'Что изображено на этой фотографии? Опиши её подробно.';

        const imageContent = [
          {
            type: 'text',
            text: userText
          },
          {
            type: 'image_url',
            image_url: {
              url: imageData
            }
          }
        ];

        // В историю сохраняем понятную запись,
        // а не огромный base64.
        const historyText =
          `[Фото пользователя] ${userText}`;

        // Заменяем сообщение "Анализирую..."
        // на обычное "Думаю..."
        await bot.editMessageText(
          '⏳ Думаю...',
          {
            chat_id:
              chatId,

            message_id:
              thinkingMsg.message_id
          }
        );

        addToHistory(
          session,
          'user',
          imageContent
        );

        const reply =
          await askOpenRouter(
            session.history
          );

        addToHistory(
          session,
          'assistant',
          reply
        );

        // Исправляем последний user-message
        // в памяти на короткое описание.
        const userHistoryIndex =
          session.history.length - 2;

        if (
          userHistoryIndex >= 0 &&
          session.history[userHistoryIndex].role === 'user'
        ) {
          session.history[userHistoryIndex].content =
            historyText;
        }

        const chunks =
          splitMessage(reply);

        await bot.editMessageText(
          chunks[0],
          {
            chat_id:
              chatId,

            message_id:
              thinkingMsg.message_id
          }
        );

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {
          await bot.sendMessage(
            chatId,
            chunks[i]
          );
        }

      } catch (err) {

        console.error(
          '❌ Photo/AI error:',
          err.message
        );

        const friendlyText =
          getFriendlyErrorText(err);

        if (thinkingMsg) {
          try {
            await bot.editMessageText(
              friendlyText,
              {
                chat_id:
                  chatId,

                message_id:
                  thinkingMsg.message_id
              }
            );
          } catch (_) {}
        } else {
          await bot.sendMessage(
            chatId,
            friendlyText
          );
        }
      }

      return;
    }

    // ==============================================
    // ТЕКСТ
    // ==============================================

    if (text) {

      await handleAiMessage(
        chatId,
        text,
        text,
        session
      );

      return;
    }

    // Остальные типы сообщений пока игнорируем
  }
);

// ==================================================
// INLINE-КНОПКИ
// ==================================================

bot.on(
  'callback_query',
  async (query) => {

    const chatId =
      query.message.chat.id;

    const data =
      query.data;

    const session =
      getSession(chatId);

    try {

      if (
        data === 'action_new'
      ) {
        session.history = [];

        await bot.sendMessage(
          chatId,
          '🆕 Новый диалог начат!'
        );
      }

      else if (
        data === 'action_help'
      ) {
        await bot.sendMessage(
          chatId,
          HELP_TEXT
        );
      }

      else if (
        data === 'action_profile'
      ) {
        await bot.sendMessage(
          chatId,
          getProfileText(
            query.from,
            session
          )
        );
      }

      await bot.answerCallbackQuery(
        query.id
      );

    } catch (err) {

      console.error(
        '❌ Bot error:',
        err.message
      );

      try {
        await bot.answerCallbackQuery(
          query.id
        );
      } catch (_) {}
    }
  }
);

// ==================================================
// TELEGRAM POLLING ERROR
// ==================================================

bot.on(
  'polling_error',
  (err) => {
    console.error(
      '❌ Bot error:',
      err.message
    );
  }
);

// ==================================================
// PROCESS ERRORS
// ==================================================

process.on(
  'unhandledRejection',
  (reason) => {
    console.error(
      '❌ Bot error:',
      reason
    );
  }
);

process.on(
  'uncaughtException',
  (err) => {
    console.error(
      '❌ Bot error:',
      err.message
    );
  }
);

// ==================================================
// RENDER HTTP SERVER
// ==================================================

const PORT =
  process.env.PORT || 3000;

const server =
  http.createServer(
    (req, res) => {

      res.writeHead(
        200,
        {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      );

      res.end(
        'Bot is running'
      );
    }
  );

server.on(
  'error',
  (err) => {

    console.error(
      '❌ Bot error: HTTP-сервер не смог запуститься.',
      err.message
    );

    process.exit(1);
  }
);

server.listen(
  PORT,
  () => {
    console.log(
      `🌐 HTTP server listening on port ${PORT}`
    );
  }
);

// ==================================================
// TELEGRAM CHECK
// ==================================================

bot.getMe()
  .then((me) => {

    console.log(
      `✅ Bot is running (@${me.username})`
    );

  })
  .catch((err) => {

    console.error(
      '❌ Bot error: не удалось подключиться к Telegram.',
      err.message
    );

    process.exit(1);
  });