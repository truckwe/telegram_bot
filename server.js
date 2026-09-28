const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

// =========================
// ENV
// =========================

const token = process.env.BOT_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;
const databaseUrl = process.env.NEON_DATABASE_URL;

if (!token) {
    console.error("❌ BOT_TOKEN не найден");
    process.exit(1);
}

if (!groqApiKey) {
    console.error("❌ GROQ_API_KEY не найден");
    process.exit(1);
}

if (!databaseUrl) {
    console.error("❌ NEON_DATABASE_URL не найден");
    process.exit(1);
}

// =========================
// DATABASE
// =========================

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
        rejectUnauthorized: false
    }
});

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id TEXT PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            credits INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    console.log("✅ Neon database connected");
    console.log("✅ Users table ready");
}

// =========================
// USERS
// =========================

async function ensureUser(user) {
    const telegramId = String(user.id);

    await pool.query(
        `
        INSERT INTO users (
            telegram_id,
            username,
            first_name
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (telegram_id)
        DO UPDATE SET
            username = EXCLUDED.username,
            first_name = EXCLUDED.first_name,
            updated_at = NOW()
        `,
        [
            telegramId,
            user.username || null,
            user.first_name || null
        ]
    );
}

async function getUser(telegramId) {
    const result = await pool.query(
        `
        SELECT *
        FROM users
        WHERE telegram_id = $1
        `,
        [String(telegramId)]
    );

    return result.rows[0] || null;
}

async function getCredits(telegramId) {
    const user = await getUser(telegramId);

    if (!user) {
        return 0;
    }

    return user.credits;
}

async function addCredits(telegramId, amount) {
    await pool.query(
        `
        UPDATE users
        SET
            credits = credits + $1,
            updated_at = NOW()
        WHERE telegram_id = $2
        `,
        [
            amount,
            String(telegramId)
        ]
    );
}

async function spendCredits(telegramId, amount) {
    const result = await pool.query(
        `
        UPDATE users
        SET
            credits = credits - $1,
            updated_at = NOW()
        WHERE telegram_id = $2
          AND credits >= $1
        RETURNING credits
        `,
        [
            amount,
            String(telegramId)
        ]
    );

    if (result.rows.length === 0) {
        return false;
    }

    return true;
}

// =========================
// TELEGRAM BOT
// =========================

const bot = new TelegramBot(token, {
    polling: true
});

// =========================
// SETTINGS
// =========================

const GROQ_MODEL = "qwen/qwen3.8-27b";

const MAX_OUTPUT_TOKENS = 1000;
const TEMPERATURE = 0.7;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_HISTORY_MESSAGES = 6;
const TELEGRAM_MESSAGE_LIMIT = 4000;

// Стоимость одной будущей генерации фото
const PHOTO_GENERATION_COST = 10;

// =========================
// SESSIONS
// =========================

const sessions = new Map();

function getSession(chatId) {
    const id = String(chatId);

    if (!sessions.has(id)) {
        sessions.set(id, {
            history: [],
            messageCount: 0
        });
    }

    return sessions.get(id);
}

function resetSession(chatId) {
    sessions.set(String(chatId), {
        history: [],
        messageCount: 0
    });
}

// =========================
// KEYBOARD
// =========================

function getMainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [
                    {
                        text: "💬 Чат"
                    },
                    {
                        text: "🎨 Генератор фото"
                    }
                ],
                [
                    {
                        text: "👤 Профиль"
                    },
                    {
                        text: "ℹ️ Помощь"
                    }
                ]
            ],
            resize_keyboard: true
        }
    };
}

// =========================
// GROQ
// =========================

async function groqRequest(messages) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${groqApiKey}`
                },

                body: JSON.stringify({
                    model: GROQ_MODEL,
                    messages,
                    temperature: TEMPERATURE,
                    max_tokens: MAX_OUTPUT_TOKENS
                }),

                signal: controller.signal
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Groq error:", data);

            throw new Error(
                data?.error?.message ||
                "Ошибка Groq API"
            );
        }

        return data?.choices?.[0]?.message?.content || "";
    } finally {
        clearTimeout(timeout);
    }
}

// =========================
// TEXT AI
// =========================

async function askGroq(history) {
    const messages = [
        {
            role: "system",
            content:
                "Ты дружелюбный AI-помощник deevik. " +
                "Отвечай понятно, полезно и по существу. " +
                "Отвечай на языке пользователя. " +
                "Не делай ответы unnecessarily длинными."
        },
        ...history
    ];

    return await groqRequest(messages);
}

// =========================
// IMAGE AI
// =========================

async function askGroqWithImage(
    history,
    imageUrl,
    userText
) {
    const messages = [
        {
            role: "system",
            content:
                "Ты дружелюбный AI-помощник deevik. " +
                "Ты умеешь анализировать изображения. " +
                "Отвечай понятно, точно и на языке пользователя."
        },
        ...history,

        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: userText
                },
                {
                    type: "image_url",
                    image_url: {
                        url: imageUrl
                    }
                }
            ]
        }
    ];

    return await groqRequest(messages);
}

// =========================
// ERROR TEXT
// =========================

function getFriendlyErrorText(error) {
    if (!error) {
        return "❌ Произошла неизвестная ошибка.";
    }

    if (error.name === "AbortError") {
        return "⏱️ AI отвечает слишком долго. Попробуй ещё раз.";
    }

    const message = String(error.message || "");

    if (
        message.toLowerCase().includes("rate limit")
    ) {
        return "⏳ Слишком много запросов. Попробуй немного позже.";
    }

    if (
        message.toLowerCase().includes("api key")
    ) {
        return "❌ Ошибка API-ключа Groq.";
    }

    return "❌ Не удалось получить ответ от AI. Попробуй ещё раз.";
}

// =========================
// SEND LONG MESSAGE
// =========================

async function sendLongMessage(chatId, text) {
    if (!text) {
        text = "Пустой ответ от AI.";
    }

    while (text.length > 0) {
        const part = text.slice(
            0,
            TELEGRAM_MESSAGE_LIMIT
        );

        text = text.slice(
            TELEGRAM_MESSAGE_LIMIT
        );

        await bot.sendMessage(
            chatId,
            part
        );
    }
}

// =========================
// TEXT MESSAGE
// =========================

async function handleAiMessage(
    chatId,
    text,
    session
) {
    session.history.push({
        role: "user",
        content: text
    });

    session.messageCount++;

    if (
        session.history.length >
        MAX_HISTORY_MESSAGES
    ) {
        session.history =
            session.history.slice(
                -MAX_HISTORY_MESSAGES
            );
    }

    try {
        await bot.sendChatAction(
            chatId,
            "typing"
        );

        const answer =
            await askGroq(
                session.history
            );

        session.history.push({
            role: "assistant",
            content: answer
        });

        if (
            session.history.length >
            MAX_HISTORY_MESSAGES
        ) {
            session.history =
                session.history.slice(
                    -MAX_HISTORY_MESSAGES
                );
        }

        await sendLongMessage(
            chatId,
            answer
        );

    } catch (error) {
        console.error(error);

        await bot.sendMessage(
            chatId,
            getFriendlyErrorText(error)
        );
    }
}

// =========================
// PHOTO MESSAGE
// =========================

async function handlePhotoMessage(
    chatId,
    msg,
    session
) {
    try {
        await bot.sendChatAction(
            chatId,
            "typing"
        );

        const photo =
            msg.photo[
                msg.photo.length - 1
            ];

        const file =
            await bot.getFile(
                photo.file_id
            );

        const imageUrl =
            `https://api.telegram.org/file/bot${token}/${file.file_path}`;

        const userText =
            msg.caption?.trim() ||
            "Что изображено на этом фото? Опиши его понятно.";

        const answer =
            await askGroqWithImage(
                session.history,
                imageUrl,
                userText
            );

        session.history.push({
            role: "user",
            content: userText
        });

        session.history.push({
            role: "assistant",
            content: answer
        });

        if (
            session.history.length >
            MAX_HISTORY_MESSAGES
        ) {
            session.history =
                session.history.slice(
                    -MAX_HISTORY_MESSAGES
                );
        }

        await sendLongMessage(
            chatId,
            answer
        );

    } catch (error) {
        console.error(
            "Photo error:",
            error
        );

        await bot.sendMessage(
            chatId,
            getFriendlyErrorText(error)
        );
    }
}

// =========================
// START
// =========================

bot.onText(
    /^\/start$/,
    async (msg) => {
        const chatId = msg.chat.id;

        try {
            await ensureUser(msg.from);

            await bot.sendMessage(
                chatId,
                "👋 Привет! Я — deevik AI.\n\n" +
                "💬 Могу общаться с тобой\n" +
                "📷 Могу анализировать фотографии\n" +
                "🎨 Скоро появится генератор фото\n" +
                "💰 Для генерации будут использоваться кредиты\n\n" +
                "Выбери действие ниже 👇",
                getMainKeyboard()
            );

        } catch (error) {
            console.error(
                "/start error:",
                error
            );

            await bot.sendMessage(
                chatId,
                "❌ Не удалось подключиться к базе данных."
            );
        }
    }
);

// =========================
// HELP
// =========================

bot.onText(
    /^\/help$/,
    async (msg) => {
        await bot.sendMessage(
            msg.chat.id,

            "ℹ️ Помощь\n\n" +
            "💬 Чат — общение с AI\n" +
            "📷 Отправь фотографию — AI её проанализирует\n" +
            "🎨 Генератор фото — платная генерация изображений\n" +
            "👤 Профиль — твой баланс кредитов\n" +
            "🤖 Новый чат — очистить историю разговора",

            getMainKeyboard()
        );
    }
);

// =========================
// PROFILE COMMAND
// =========================

bot.onText(
    /^\/profile$/,
    async (msg) => {
        try {
            await ensureUser(msg.from);

            const credits =
                await getCredits(
                    msg.from.id
                );

            await bot.sendMessage(
                msg.chat.id,

                "👤 Профиль\n\n" +
                `🆔 ID: ${msg.from.id}\n` +
                `💰 Кредиты: ${credits}\n\n` +
                `🎨 Генерация фото: ${PHOTO_GENERATION_COST} кредитов за изображение`,

                getMainKeyboard()
            );

        } catch (error) {
            console.error(
                "Profile error:",
                error
            );

            await bot.sendMessage(
                msg.chat.id,
                "❌ Не удалось загрузить профиль."
            );
        }
    }
);

// =========================
// NEW CHAT
// =========================

bot.onText(
    /^\/new$/,
    async (msg) => {
        resetSession(msg.chat.id);

        await bot.sendMessage(
            msg.chat.id,
            "🆕 Новый чат создан!",
            getMainKeyboard()
        );
    }
);

// =========================
// MAIN MESSAGE HANDLER
// =========================

bot.on(
    "message",
    async (msg) => {
        if (!msg.chat) {
            return;
        }

        const chatId = msg.chat.id;

        try {
            await ensureUser(msg.from);

            // Фото
            if (
                msg.photo &&
                msg.photo.length > 0
            ) {
                const session =
                    getSession(chatId);

                await handlePhotoMessage(
                    chatId,
                    msg,
                    session
                );

                return;
            }

            // Только текст
            if (!msg.text) {
                return;
            }

            const text =
                msg.text.trim();

            // Кнопка Чат
            if (text === "💬 Чат") {
                await bot.sendMessage(
                    chatId,
                    "💬 Режим чата включён.\n\nНапиши сообщение, и я отвечу 🤖",
                    getMainKeyboard()
                );

                return;
            }

            // Кнопка генератора
            if (
                text === "🎨 Генератор фото"
            ) {
                const credits =
                    await getCredits(
                        msg.from.id
                    );

                await bot.sendMessage(
                    chatId,

                    "🎨 Генератор фото\n\n" +
                    `💰 Твой баланс: ${credits} кредитов\n` +
                    `🖼️ Одна генерация: ${PHOTO_GENERATION_COST} кредитов\n\n` +
                    "Генератор пока находится в разработке 🚧\n" +
                    "Скоро здесь появится создание изображений.",

                    getMainKeyboard()
                );

                return;
            }

            // Профиль
            if (text === "👤 Профиль") {
                const credits =
                    await getCredits(
                        msg.from.id
                    );

                await bot.sendMessage(
                    chatId,

                    "👤 Профиль\n\n" +
                    `🆔 ID: ${msg.from.id}\n` +
                    `💰 Кредиты: ${credits}\n\n` +
                    `🎨 Генерация фото: ${PHOTO_GENERATION_COST} кредитов`,

                    getMainKeyboard()
                );

                return;
            }

            // Помощь
            if (text === "ℹ️ Помощь") {
                await bot.sendMessage(
                    chatId,

                    "ℹ️ Помощь\n\n" +
                    "💬 Чат — общение с AI\n" +
                    "📷 Фото — анализ изображения\n" +
                    "🎨 Генератор фото — скоро\n" +
                    "👤 Профиль — баланс кредитов\n\n" +
                    "🤖 /new — новый чат",

                    getMainKeyboard()
                );

                return;
            }

            // Новый чат
            if (
                text === "🤖 Новый чат"
            ) {
                resetSession(chatId);

                await bot.sendMessage(
                    chatId,
                    "🆕 История очищена. Начинаем новый чат!",
                    getMainKeyboard()
                );

                return;
            }

            // Обычный AI-запрос
            const session =
                getSession(chatId);

            await handleAiMessage(
                chatId,
                text,
                session
            );

        } catch (error) {
            console.error(
                "Message handler error:",
                error
            );

            try {
                await bot.sendMessage(
                    chatId,
                    "❌ Произошла ошибка. Попробуй ещё раз."
                );
            } catch {}
        }
    }
);

// =========================
// TELEGRAM ERRORS
// =========================

bot.on(
    "polling_error",
    (error) => {
        console.error(
            "Polling error:",
            error.message
        );
    }
);

bot.on(
    "error",
    (error) => {
        console.error(
            "Bot error:",
            error.message
        );
    }
);

// =========================
// RENDER HTTP SERVER
// =========================

const PORT =
    process.env.PORT || 3000;

const server =
    http.createServer(
        (req, res) => {
            res.writeHead(
                200,
                {
                    "Content-Type":
                        "text/plain; charset=utf-8"
                }
            );

            res.end(
                "deevik bot is running 🚀"
            );
        }
    );

// =========================
// START
// =========================

async function start() {
    try {
        await initDatabase();

        server.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log(
                    `🌐 HTTP server running on port ${PORT}`
                );
            }
        );

        const me =
            await bot.getMe();

        console.log(
            `🤖 Bot started: @${me.username}`
        );

    } catch (error) {
        console.error(
            "❌ Startup error:",
            error
        );

        process.exit(1);
    }
}

start();