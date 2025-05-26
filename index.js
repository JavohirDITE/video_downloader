const { Telegraf, Markup } = require("telegraf")
const { exec } = require("child_process")
const fs = require("fs")
const path = require("path")
const util = require("util")
const express = require("express")

// Преобразуем exec в промис для удобства использования
const execPromise = util.promisify(exec)

// Проверяем наличие токена
const BOT_TOKEN = process.env.BOT_TOKEN
if (!BOT_TOKEN) {
  console.error("❌ ОШИБКА: Переменная окружения BOT_TOKEN не установлена!")
  console.error("Пожалуйста, установите BOT_TOKEN в настройках Railway или в файле .env")
  process.exit(1)
}

console.log("✅ Токен бота найден, длина:", BOT_TOKEN.length)

// Создаем экземпляр бота с токеном из переменных окружения
const bot = new Telegraf(BOT_TOKEN)

// Создаем Express приложение для webhook
const app = express()
const PORT = process.env.PORT || 3000

// Создаем папки для временных файлов, если их нет
const tempDir = path.join(__dirname, "temp")
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true })
}

// Хранилище для пользовательских сессий
const userSessions = new Map()

// Функция для очистки временных файлов
function cleanupFiles(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`Удален файл: ${filePath}`)
    }
  } catch (error) {
    console.error(`Ошибка при удалении файла ${filePath}:`, error)
  }
}

// Функция для проверки валидности URL
function isValidUrl(string) {
  try {
    new URL(string)
    return true
  } catch (_) {
    return false
  }
}

// Функция для получения информации о видео
async function getVideoInfo(url) {
  const command = `yt-dlp --dump-json --no-playlist "${url}"`

  try {
    const { stdout } = await execPromise(command, { timeout: 30000 })
    const info = JSON.parse(stdout)
    return {
      title: info.title || "Неизвестное видео",
      duration: info.duration || 0,
      uploader: info.uploader || "Неизвестный автор",
      platform: info.extractor || "unknown",
    }
  } catch (error) {
    console.error("Ошибка получения информации о видео:", error)
    return {
      title: "Неизвестное видео",
      duration: 0,
      uploader: "Неизвестный автор",
      platform: "unknown",
    }
  }
}

// Функция для скачивания видео с выбранным качеством
async function downloadVideo(url, outputPath, quality = "720") {
  let formatSelector

  switch (quality) {
    case "1080":
      formatSelector = "best[height<=1080]/best"
      break
    case "720":
      formatSelector = "best[height<=720]/best"
      break
    case "480":
      formatSelector = "best[height<=480]/best"
      break
    case "360":
      formatSelector = "best[height<=360]/best"
      break
    default:
      formatSelector = "best[height<=720]/best"
  }

  const ytDlpOptions = [
    "--no-playlist",
    `--format "${formatSelector}"`,
    '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
    '--referer "https://www.youtube.com/"',
    '--add-header "Accept-Language:en-US,en;q=0.9"',
    '--add-header "Accept-Encoding:gzip, deflate"',
    '--add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"',
    '--add-header "Connection:keep-alive"',
    '--add-header "Upgrade-Insecure-Requests:1"',
    "--extractor-retries 3",
    "--fragment-retries 3",
    "--retry-sleep 1",
    "--no-check-certificate",
    "--prefer-free-formats",
    "--youtube-skip-dash-manifest",
  ].join(" ")

  const command = `yt-dlp ${ytDlpOptions} -o "${outputPath}" "${url}"`
  console.log(`Выполняется команда: yt-dlp с качеством ${quality}p`)

  try {
    const { stdout, stderr } = await execPromise(command, { timeout: 300000 })
    console.log("yt-dlp stdout:", stdout)
    if (stderr) console.log("yt-dlp stderr:", stderr)
    return true
  } catch (error) {
    console.error("Ошибка yt-dlp:", error)

    // Fallback для проблемных видео
    console.log("Пробуем альтернативный метод скачивания...")
    const fallbackCommand = `yt-dlp --no-playlist --format "worst[height<=480]/worst" --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)" -o "${outputPath}" "${url}"`

    try {
      const { stdout, stderr } = await execPromise(fallbackCommand, { timeout: 300000 })
      console.log("Альтернативный метод успешен:", stdout)
      return true
    } catch (fallbackError) {
      console.error("Альтернативный метод также не сработал:", fallbackError)
      throw error
    }
  }
}

// Функция для извлечения аудио с правильным названием
async function extractAudio(videoPath, audioPath, videoInfo) {
  const command = `ffmpeg -i "${videoPath}" -vn -acodec mp3 -ab 192k "${audioPath}" -y`
  console.log(`Выполняется команда: ${command}`)

  try {
    const { stdout, stderr } = await execPromise(command, { timeout: 180000 })
    console.log("ffmpeg stdout:", stdout)
    if (stderr) console.log("ffmpeg stderr:", stderr)
    return true
  } catch (error) {
    console.error("Ошибка ffmpeg:", error)
    throw error
  }
}

// Создание главного меню
function createMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📥 Скачать видео", "download_video")],
    [Markup.button.callback("🎵 Извлечь аудио", "extract_audio")],
    [Markup.button.callback("ℹ️ Информация о видео", "video_info")],
    [Markup.button.callback("❓ Помощь", "help")],
  ])
}

// Создание меню выбора качества
function createQualityMenu(action) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔥 1080p", `${action}_1080`), Markup.button.callback("⭐ 720p", `${action}_720`)],
    [Markup.button.callback("📱 480p", `${action}_480`), Markup.button.callback("💾 360p", `${action}_360`)],
    [Markup.button.callback("⬅️ Назад", "back_to_main")],
  ])
}

// Команда /start - приветствие с кнопками
bot.start((ctx) => {
  const welcomeMessage = `
🎬 Добро пожаловать в улучшенный бот для скачивания видео!

🌟 Новые возможности:
• Удобные кнопки для управления
• Выбор качества видео (360p - 1080p)
• Правильные названия файлов
• Информация о видео перед скачиванием

🌐 Поддерживаемые платформы:
YouTube, TikTok, Instagram, Twitter, Facebook, VK и 1000+ других!

👇 Выберите действие или отправьте ссылку на видео:`

  ctx.reply(welcomeMessage, createMainMenu())
})

// Обработка callback queries
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data
  const userId = ctx.from.id

  try {
    if (data === "download_video") {
      await ctx.editMessageText(
        "📥 Выберите качество для скачивания видео:\n\n" +
          "🔥 1080p - Лучшее качество (больше размер)\n" +
          "⭐ 720p - Рекомендуемое качество\n" +
          "📱 480p - Среднее качество\n" +
          "💾 360p - Экономия трафика",
        createQualityMenu("video"),
      )
    } else if (data === "extract_audio") {
      await ctx.editMessageText(
        "🎵 Отправьте ссылку на видео для извлечения аудио:\n\n" +
          "Аудио будет сохранено в формате MP3 (192 kbps) с правильным названием.",
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "back_to_main")]]),
      )
      userSessions.set(userId, { action: "extract_audio" })
    } else if (data === "video_info") {
      await ctx.editMessageText(
        "ℹ️ Отправьте ссылку на видео для получения информации:\n\n" +
          "Вы увидите название, автора, длительность и платформу.",
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "back_to_main")]]),
      )
      userSessions.set(userId, { action: "video_info" })
    } else if (data === "help") {
      const helpMessage = `
📖 Подробная справка:

🎥 Скачивание видео:
• Выберите "📥 Скачать видео"
• Выберите качество (360p-1080p)
• Отправьте ссылку на видео

🎵 Извлечение аудио:
• Выберите "🎵 Извлечь аудио"
• Отправьте ссылку на видео
• Получите MP3 файл с правильным названием

ℹ️ Информация о видео:
• Узнайте детали перед скачиванием
• Название, автор, длительность

⚠️ Ограничения:
• Максимальный размер: 50 МБ
• Время обработки: 1-5 минут
• YouTube может блокировать некоторые видео

🌐 Поддерживаемые сайты:
YouTube, TikTok, Instagram, Twitter, Facebook, VK и многие другие!`

      await ctx.editMessageText(
        helpMessage,
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "back_to_main")]]),
      )
    } else if (data === "back_to_main") {
      await ctx.editMessageText("👇 Выберите действие или отправьте ссылку на видео:", createMainMenu())
      userSessions.delete(userId)
    } else if (data.startsWith("video_")) {
      const quality = data.split("_")[1]
      await ctx.editMessageText(
        `📥 Выбрано качество: ${quality}p\n\n` + "Теперь отправьте ссылку на видео для скачивания:",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Изменить качество", "download_video")],
          [Markup.button.callback("⬅️ Назад", "back_to_main")],
        ]),
      )
      userSessions.set(userId, { action: "download_video", quality })
    }

    await ctx.answerCbQuery()
  } catch (error) {
    console.error("Ошибка обработки callback:", error)
    await ctx.answerCbQuery("Произошла ошибка")
  }
})

// Обработка текстовых сообщений
bot.on("text", async (ctx) => {
  const text = ctx.message.text
  const userId = ctx.from.id
  const session = userSessions.get(userId)

  // Если сообщение начинается с /, но это не известная команда
  if (text.startsWith("/")) {
    return ctx.reply("❌ Неизвестная команда. Используйте /start для начала работы.")
  }

  // Проверяем, является ли текст ссылкой
  if (!isValidUrl(text)) {
    return ctx.reply(
      "❌ Пожалуйста, отправьте корректную ссылку на видео.\n\n" + "Или используйте кнопки ниже:",
      createMainMenu(),
    )
  }

  // Обрабатываем ссылку в зависимости от сессии пользователя
  if (session) {
    if (session.action === "download_video") {
      await handleVideoDownload(ctx, text, session.quality || "720")
    } else if (session.action === "extract_audio") {
      await handleAudioExtraction(ctx, text)
    } else if (session.action === "video_info") {
      await handleVideoInfo(ctx, text)
    }
    userSessions.delete(userId)
  } else {
    // Если нет активной сессии, показываем меню
    await ctx.reply(
      "💡 Я вижу ссылку на видео! Что вы хотите сделать?",
      Markup.inlineKeyboard([
        [Markup.button.callback("📥 Скачать видео", "download_video")],
        [Markup.button.callback("🎵 Извлечь аудио", "extract_audio")],
        [Markup.button.callback("ℹ️ Информация", "video_info")],
      ]),
    )
    userSessions.set(userId, { url: text })
  }
})

// Функция обработки скачивания видео
async function handleVideoDownload(ctx, url, quality) {
  let processingMessage
  try {
    processingMessage = await ctx.reply(
      `⏳ Скачиваю видео в качестве ${quality}p...\n` + "Это может занять до 5 минут.",
    )
  } catch (error) {
    console.error("Ошибка при отправке сообщения:", error)
    return
  }

  try {
    // Получаем информацию о видео
    const videoInfo = await getVideoInfo(url)

    // Генерируем уникальное имя файла
    const timestamp = Date.now()
    const videoFileName = `video_${timestamp}.%(ext)s`
    const videoPath = path.join(tempDir, videoFileName)

    console.log(`Начинаем скачивание видео: ${url}`)

    // Скачиваем видео
    await downloadVideo(url, videoPath, quality)

    // Ищем скачанный файл
    const files = fs.readdirSync(tempDir).filter((file) => file.startsWith(`video_${timestamp}`))

    if (files.length === 0) {
      throw new Error("Файл не найден после скачивания")
    }

    const actualVideoPath = path.join(tempDir, files[0])
    const fileStats = fs.statSync(actualVideoPath)
    const fileSizeMB = fileStats.size / (1024 * 1024)

    console.log(`Размер файла: ${fileSizeMB.toFixed(2)} МБ`)

    // Проверяем размер файла
    if (fileSizeMB > 50) {
      cleanupFiles(actualVideoPath)
      try {
        return await ctx.editMessageText(
          "❌ Файл слишком большой (более 50 МБ).\n" +
            "Попробуйте выбрать меньшее качество или используйте извлечение аудио.",
          createMainMenu(),
        )
      } catch (editError) {
        return ctx.reply(
          "❌ Файл слишком большой (более 50 МБ).\n" + "Попробуйте выбрать меньшее качество.",
          createMainMenu(),
        )
      }
    }

    try {
      await ctx.editMessageText("📤 Отправляю видео...")
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Отправляем видео с информацией
    const caption =
      `✅ Видео скачано!\n\n` +
      `📹 ${videoInfo.title}\n` +
      `👤 ${videoInfo.uploader}\n` +
      `📊 Качество: ${quality}p\n` +
      `💾 Размер: ${fileSizeMB.toFixed(2)} МБ`

    await ctx.replyWithVideo(
      { source: actualVideoPath },
      {
        caption,
        reply_markup: createMainMenu().reply_markup,
      },
    )

    // Удаляем временный файл
    cleanupFiles(actualVideoPath)

    // Удаляем сообщение о процессе
    try {
      await ctx.deleteMessage(processingMessage.message_id)
    } catch (deleteError) {
      console.log("Не удалось удалить сообщение о процессе")
    }
  } catch (error) {
    console.error("Ошибка при обработке видео:", error)

    let errorMessage = "❌ Произошла ошибка при скачивании видео."

    if (error.message.includes("403") || error.message.includes("Forbidden")) {
      errorMessage = "❌ YouTube заблокировал скачивание этого видео.\nПопробуйте другое видео или извлеките аудио."
    } else if (error.message.includes("Video unavailable")) {
      errorMessage = "❌ Видео недоступно. Возможно, оно приватное или удалено."
    } else if (error.message.includes("Unsupported URL")) {
      errorMessage = "❌ Данный сайт не поддерживается."
    }

    try {
      await ctx.editMessageText(errorMessage, createMainMenu())
    } catch (editError) {
      ctx.reply(errorMessage, createMainMenu())
    }
  }
}

// Функция обработки извлечения аудио
async function handleAudioExtraction(ctx, url) {
  let processingMessage
  try {
    processingMessage = await ctx.reply("⏳ Извлекаю аудио... Это может занять до 5 минут.")
  } catch (error) {
    console.error("Ошибка при отправке сообщения:", error)
    return
  }

  try {
    // Получаем информацию о видео
    const videoInfo = await getVideoInfo(url)

    // Генерируем уникальные имена файлов
    const timestamp = Date.now()
    const videoFileName = `video_${timestamp}.%(ext)s`
    const videoPath = path.join(tempDir, videoFileName)

    // Создаем правильное имя для аудио файла
    let audioFileName
    if (videoInfo.platform.toLowerCase().includes("youtube")) {
      // Для YouTube используем название видео
      const cleanTitle = videoInfo.title
        .replace(/[^\w\s-]/g, "") // Убираем специальные символы
        .replace(/\s+/g, "_") // Заменяем пробелы на подчеркивания
        .substring(0, 50) // Ограничиваем длину
      audioFileName = `${cleanTitle}.mp3`
    } else {
      // Для остальных платформ просто "audio"
      audioFileName = `audio_${timestamp}.mp3`
    }

    const audioPath = path.join(tempDir, audioFileName)

    console.log(`Начинаем скачивание видео для аудио: ${url}`)

    // Скачиваем видео
    await downloadVideo(url, videoPath, "360") // Для аудио используем низкое качество

    // Ищем скачанный файл
    const files = fs.readdirSync(tempDir).filter((file) => file.startsWith(`video_${timestamp}`))

    if (files.length === 0) {
      throw new Error("Файл не найден после скачивания")
    }

    const actualVideoPath = path.join(tempDir, files[0])

    try {
      await ctx.editMessageText("🎵 Извлекаю аудио...")
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Извлекаем аудио
    await extractAudio(actualVideoPath, audioPath, videoInfo)

    const audioStats = fs.statSync(audioPath)
    const audioSizeMB = audioStats.size / (1024 * 1024)

    console.log(`Размер аудио файла: ${audioSizeMB.toFixed(2)} МБ`)

    // Проверяем размер аудио файла
    if (audioSizeMB > 50) {
      cleanupFiles(actualVideoPath)
      cleanupFiles(audioPath)
      try {
        return await ctx.editMessageText(
          "❌ Аудио файл слишком большой (более 50 МБ).\nПопробуйте видео покороче.",
          createMainMenu(),
        )
      } catch (editError) {
        return ctx.reply("❌ Аудио файл слишком большой.", createMainMenu())
      }
    }

    try {
      await ctx.editMessageText("📤 Отправляю аудио...")
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Отправляем аудио с правильными метаданными
    const caption =
      `✅ Аудио извлечено!\n\n` +
      `🎵 ${videoInfo.title}\n` +
      `👤 ${videoInfo.uploader}\n` +
      `💾 Размер: ${audioSizeMB.toFixed(2)} МБ`

    await ctx.replyWithAudio(
      { source: audioPath },
      {
        caption,
        title: videoInfo.title,
        performer: videoInfo.uploader,
        reply_markup: createMainMenu().reply_markup,
      },
    )

    // Удаляем временные файлы
    cleanupFiles(actualVideoPath)
    cleanupFiles(audioPath)

    // Удаляем сообщение о процессе
    try {
      await ctx.deleteMessage(processingMessage.message_id)
    } catch (deleteError) {
      console.log("Не удалось удалить сообщение о процессе")
    }
  } catch (error) {
    console.error("Ошибка при обработке аудио:", error)

    let errorMessage = "❌ Произошла ошибка при извлечении аудио."

    if (error.message.includes("403") || error.message.includes("Forbidden")) {
      errorMessage = "❌ YouTube заблокировал скачивание этого видео."
    } else if (error.message.includes("Video unavailable")) {
      errorMessage = "❌ Видео недоступно."
    }

    try {
      await ctx.editMessageText(errorMessage, createMainMenu())
    } catch (editError) {
      ctx.reply(errorMessage, createMainMenu())
    }
  }
}

// Функция получения информации о видео
async function handleVideoInfo(ctx, url) {
  let processingMessage
  try {
    processingMessage = await ctx.reply("⏳ Получаю информацию о видео...")
  } catch (error) {
    console.error("Ошибка при отправке сообщения:", error)
    return
  }

  try {
    const videoInfo = await getVideoInfo(url)

    const duration = videoInfo.duration
      ? `${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, "0")}`
      : "Неизвестно"

    const infoMessage = `
ℹ️ Информация о видео:

📹 **Название:** ${videoInfo.title}
👤 **Автор:** ${videoInfo.uploader}
⏱ **Длительность:** ${duration}
🌐 **Платформа:** ${videoInfo.platform}

Что вы хотите сделать с этим видео?`

    await ctx.editMessageText(
      infoMessage,
      Markup.inlineKeyboard([
        [Markup.button.callback("📥 Скачать видео", "download_video")],
        [Markup.button.callback("🎵 Извлечь аудио", "extract_audio")],
        [Markup.button.callback("⬅️ Назад", "back_to_main")],
      ]),
    )
  } catch (error) {
    console.error("Ошибка при получении информации:", error)
    try {
      await ctx.editMessageText("❌ Не удалось получить информацию о видео.", createMainMenu())
    } catch (editError) {
      ctx.reply("❌ Не удалось получить информацию о видео.", createMainMenu())
    }
  }
}

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error("Ошибка бота:", err)
  if (ctx) {
    try {
      ctx.reply("❌ Произошла внутренняя ошибка. Попробуйте позже.", createMainMenu())
    } catch (replyError) {
      console.error("Не удалось отправить сообщение об ошибке:", replyError)
    }
  }
})

// Очистка временных файлов при запуске
function cleanupTempDir() {
  try {
    const files = fs.readdirSync(tempDir)
    files.forEach((file) => {
      const filePath = path.join(tempDir, file)
      fs.unlinkSync(filePath)
    })
    console.log("🧹 Временные файлы очищены")
  } catch (error) {
    console.log("⚠️ Ошибка при очистке временных файлов:", error)
  }
}

// Очищаем временные файлы при запуске
cleanupTempDir()

// Периодическая очистка временных файлов (каждые 30 минут)
setInterval(cleanupTempDir, 30 * 60 * 1000)

// Очистка старых сессий (каждые 10 минут)
setInterval(
  () => {
    console.log(`Активных сессий: ${userSessions.size}`)
  },
  10 * 60 * 1000,
)

// Настройка webhook для Railway
app.use(express.json())

// Health check endpoint
app.get("/", (req, res) => {
  res.send("🤖 Improved Telegram Video Downloader Bot is running!")
})

// Webhook endpoint
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body)
  res.sendStatus(200)
})

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`)

  try {
    // Устанавливаем webhook
    const webhookUrl = process.env.RAILWAY_STATIC_URL
      ? `https://${process.env.RAILWAY_STATIC_URL}/webhook/${BOT_TOKEN}`
      : `http://localhost:${PORT}/webhook/${BOT_TOKEN}`

    console.log(`🔗 Устанавливаем webhook: ${webhookUrl}`)
    await bot.telegram.setWebhook(webhookUrl)
    console.log("✅ Webhook установлен успешно!")

    // Получаем информацию о боте
    const botInfo = await bot.telegram.getMe()
    console.log(`✅ Улучшенный бот @${botInfo.username} успешно запущен!`)
  } catch (error) {
    console.error("❌ Ошибка при установке webhook:", error)

    // Если webhook не работает, используем polling
    console.log("🔄 Переключаемся на polling...")
    try {
      await bot.telegram.deleteWebhook()
      await bot.launch()
      console.log("✅ Бот запущен в режиме polling!")
    } catch (pollingError) {
      console.error("❌ Ошибка при запуске polling:", pollingError)
      process.exit(1)
    }
  }
})

// Graceful shutdown
process.once("SIGINT", () => {
  console.log("🛑 Получен сигнал SIGINT, завершаем работу бота...")
  bot.stop("SIGINT")
  process.exit(0)
})

process.once("SIGTERM", () => {
  console.log("🛑 Получен сигнал SIGTERM, завершаем работу бота...")
  bot.stop("SIGTERM")
  process.exit(0)
})
