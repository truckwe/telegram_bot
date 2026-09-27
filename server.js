// Telegram AI-бот на Groq
// Секреты:
// BOT_TOKEN
// GROQ_API_KEY

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;

if (!token) {
  console.error('❌ Не установлена переменная BOT_TOKEN');
  process.exit(1);
}

if (!groqApiKey) {
  console.error('❌ Не установлена переменная GROQ_API_KEY');
  process.exit(1);
}

console.log('🤖 Bot starting...');

const bot = new TelegramBot(token, {
  polling: true
});

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'qwen/qwen3.8-27b';

const MAX_OUTPUT_TOKENS = 600;
const TEMPERATURE = 0.7;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_HISTORY_MESSAGES = 6;
const TELEGRAM_MESSAGE_LIMIT = 4000;

const SYSTEM_PROMPT =
  'Ты — дружелюбный AI-ассистент внутри Telegram-бота. ' +
  'Отвечай кратко, понятно и по делу. ' +
  'Отвечай на том языке, на котором пишет пользователь.';

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

const WELCOME_TEXT =
  '👋 Привет! Я AI-ассистент.\n\n' +
  'Просто напиши мне сообщение — и я постараюсь помочь.\n\n' +
  'Я помню несколько последних сообщений разговора.\n\n' +
  'Используй кнопки ниже 👇';

const HELP_TEXT =
  'ℹ️ Что я умею:\n\n' +
  '🤖 Отвечаю на вопросы с помощью AI.\n' +
  '💬 Помню последние сообщения разговора.\n\n' +
  'Команды:\n' +
  '/start — главное меню\n' +
  '/help — помощь\n' +
  '/profile — профиль\n' +
  '/new — новый диалог\n\n' +
  'Просто напиши сообщение, чтобы начать.';

function getProfileText(user, session) {
  const id = user.id;
  const username = user.username
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

function splitMessage(
  text,
  maxLen = TELEGRAM_MESSAGE_LIMIT
) {
  const parts = [];

  let rest = text;

  while (rest.length > maxLen) {
    parts.push(rest.slice(0, maxLen));
    rest = rest.slice(maxLen);
  }

  if (rest.length > 0) {
    parts.push(rest);
  }

  return parts;
}

async function askGroq(history) {
  const controller =
    new AbortController();

  const timeoutId =
    setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

  let response;

  try {
    response = await fetch(
      GROQ_URL,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${groqApiKey}`,

          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          model: GROQ_MODEL,

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
            TEMPERATURE,

          reasoning_effort: 'none'
        }),

        signal: controller.signal
      }
    );
  } catch (networkErr) {
    if (
      networkErr.name ===
      'AbortError'
    ) {
      const err = new Error(
        'Groq не ответил вовремя.'
      );

      err.kind = 'timeout';

      throw err;
    }

    const err = new Error(
      `Groq недоступен: ${networkErr.message}`
    );

    err.kind = 'network';

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

    const err = new Error(
      `Groq вернул ошибку ${response.status}: ${bodyText}`
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
    const err = new Error(
      'Groq вернул пустой ответ.'
    );

    err.kind = 'empty';

    throw err;
  }

  return content.trim();
}

function getFriendlyErrorText(err) {
  if (
    err.status === 401 ||
    err.status === 403
  ) {
    return (
      '⚠️ Проблема с ключом Groq. ' +
      'Проверь GROQ_API_KEY в Render.'
    );
  }

  if (err.status === 429) {
    return (
      '⚠️ Достигнут лимит Groq. ' +
      'Попробуй немного позже.'
    );
  }

  if (
    err.status &&
    err.status >= 500
  ) {
    return (
      '⚠️ Сервис Groq сейчас недоступен. ' +
      'Попробуй позже.'
    );
  }

  if (err.kind === 'timeout') {
    return (
      '⚠️ AI слишком долго отвечал. ' +
      'Попробуй ещё раз.'
    );
  }

  if (err.kind === 'network') {
    return (
      '⚠️ Не удалось подключиться к Groq. ' +
      'Попробуй ещё раз.'
    );
  }

  if (err.kind === 'empty') {
    return (
      '⚠️ AI вернул пустой ответ.'
    );
  }

  return (
    '⚠️ Что-то пошло не так. ' +
    'Попробуй ещё раз.'
  );
}

async function handleAiMessage(
  chatId,
  text,
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
      '❌ Telegram error:',
      err.message
    );

    return;
  }

  try {
    addToHistory(
      session,
      'user',
      text
    );

    const reply =
      await askGroq(
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
        chat_id: chatId,
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
      '❌ AI error:',
      err.message
    );

    const friendlyText =
      getFriendlyErrorText(err);

    try {
      await bot.editMessageText(
        friendlyText,
        {
          chat_id: chatId,
          message_id:
            thinkingMsg.message_id
        }
      );
    } catch (editErr) {
      console.error(
        '❌ Telegram error:',
        editErr.message
      );
    }
  }
}

bot.on(
  'message',
  async (msg) => {
    const chatId =
      msg.chat.id;

    const text =
      msg.text;

    if (!text) {
      return;
    }

    const session =
      getSession(chatId);

    session.messageCount++;

    try {
      if (text === '/start') {
        await sendWelcome(
          chatId
        );
      }

      else if (text === '/help') {
        await bot.sendMessage(
          chatId,
          HELP_TEXT
        );
      }

      else if (text === '/profile') {
        await bot.sendMessage(
          chatId,
          getProfileText(
            msg.from,
            session
          )
        );
      }

      else if (text === '/new') {
        session.history = [];

        await bot.sendMessage(
          chatId,
          '🆕 Новый диалог начат!'
        );
      }

      else if (
        text.startsWith('/')
      ) {
        await bot.sendMessage(
          chatId,
          '❓ Я не знаю такую команду.\n\n' +
          HELP_TEXT
        );
      }

      else {
        await handleAiMessage(
          chatId,
          text,
          session
        );
      }
    } catch (err) {
      console.error(
        '❌ Bot error:',
        err.message
      );
    }
  }
);

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
        '❌ Callback error:',
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

bot.on(
  'polling_error',
  (err) => {
    console.error(
      '❌ Polling error:',
      err.message
    );
  }
);

process.on(
  'unhandledRejection',
  (reason) => {
    console.error(
      '❌ Unhandled rejection:',
      reason
    );
  }
);

process.on(
  'uncaughtException',
  (err) => {
    console.error(
      '❌ Uncaught exception:',
      err
    );
  }
);

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
      '❌ HTTP server error:',
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

bot.getMe()
  .then((me) => {
    console.log(
      `✅ Bot is running (@${me.username})`
    );
  })
  .catch((err) => {
    console.error(
      '❌ Не удалось подключиться к Telegram:',
      err.message
    );

    process.exit(1);
  });