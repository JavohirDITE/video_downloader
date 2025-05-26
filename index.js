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
      formats: info.formats || [],
    }
  } catch (error) {
    console.error("Ошибка получения информации о видео:", error)
    return {
      title: "Неизвестное видео",
      duration: 0,
      uploader: "Неизвестный автор",
      platform: "unknown",
      formats: [],
    }
  }
}

// Улучшенная функция для скачивания видео с правильным выбором качества
async function downloadVideo(url, outputPath, quality = "720") {
  let formatSelector

  // Более точные селекторы форматов для разных качеств
  switch (quality) {
    case "1080":
      formatSelector =
        "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]"
      break
    case "720":
      formatSelector = "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]"
      break
    case "480":
      formatSelector = "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]"
      break
    case "360":
      formatSelector = "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=360]"
      break
    case "best":
      formatSelector = "best[ext=mp4]/best"
      break
    case "original":
      formatSelector = "best"
      break
    default:
      formatSelector = "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]"
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
    "--merge-output-format mp4",
    "--embed-subs",
    "--write-auto-sub",
  ].join(" ")

  const command = `yt-dlp ${ytDlpOptions} -o "${outputPath}" "${url}"`
  console.log(`Выполняется команда: yt-dlp с качеством ${quality}p`)
  console.log(`Селектор формата: ${formatSelector}`)

  try {
    const { stdout, stderr } = await execPromise(command, { timeout: 300000 })
    console.log("yt-dlp stdout:", stdout)
    if (stderr) console.log("yt-dlp stderr:", stderr)
    return true
  } catch (error) {
    console.error("Ошибка yt-dlp:", error)

    // Fallback для проблемных видео с более простым селектором
    console.log("Пробуем альтернативный метод скачивания...")
    const fallbackSelector =
      quality === "360" ? "worst[ext=mp4]/worst" : `best[height<=${quality}][ext=mp4]/best[height<=${quality}]`
    const fallbackCommand = `yt-dlp --no-playlist --format "${fallbackSelector}" --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)" -o "${outputPath}" "${url}"`

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

// Функция для извлечения аудио
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

// Создание главного меню с обычными кнопками
function createMainMenu() {
  return Markup.keyboard([
    ["📥 Скачать видео", "🎵 Извлечь аудио"],
    ["ℹ️ Информация о видео", "❓ Помощь"],
    ["⚙️ Настройки качества"],
  ]).resize()
}

// Создание меню выбора качества
function createQualityMenu() {
  return Markup.keyboard([
    ["🔥 1080p (Лучшее)", "⭐ 720p (Рекомендуемое)"],
    ["📱 480p (Среднее)", "💾 360p (Экономия)"],
    ["🚀 Максимальное качество", "🎬 Оригинальное качество"],
    ["🏠 Главное меню"],
  ]).resize()
}

// Команда /start - приветствие с меню
bot.start((ctx) => {
  const welcomeMessage = `
🎬 Добро пожаловать в улучшенный бот для скачивания видео!

🌟 Новые возможности:
• Удобное меню для управления
• Улучшенный выбор качества видео
• Правильные названия файлов
• Информация о видео перед скачиванием

🌐 Поддерживаемые платформы:
YouTube, TikTok, Instagram, Twitter, Facebook, VK и 1000+ других!

👇 Выберите действие в меню ниже или отправьте ссылку на видео:`

  ctx.reply(welcomeMessage, createMainMenu())
})

// Команда помощи
bot.command("help", (ctx) => {
  const helpMessage = `
📖 Подробная справка:

🎥 Скачивание видео:
• Нажмите "📥 Скачать видео"
• Выберите качество в настройках
• Отправьте ссылку на видео

🎵 Извлечение аудио:
• Нажмите "🎵 Извлечь аудио"
• Отправьте ссылку на видео
• Получите MP3 файл

ℹ️ Информация о видео:
• Узнайте детали перед скачиванием
• Название, автор, длительность

⚙️ Настройки качества:
• 1080p - Лучшее качество (больше размер)
• 720p - Рекомендуемое (оптимально)
• 480p - Среднее качество
• 360p - Экономия трафика

⚠️ Ограничения:
• Максимальный размер: 2 ГБ (лимит Telegram)
• Время обработки: 1-10 минут (зависит от размера)
• Большие файлы отправляются дольше

🌐 Поддерживаемые сайты:
YouTube, TikTok, Instagram, Twitter, Facebook, VK и многие другие!`

  ctx.reply(helpMessage, createMainMenu())
})

// Обработка текстовых сообщений (меню)
bot.on("text", async (ctx) => {
  const text = ctx.message.text
  const userId = ctx.from.id
  const session = userSessions.get(userId) || {}

  // Обработка команд меню
  if (text === "📥 Скачать видео") {
    ctx.reply(
      `📥 Режим скачивания видео активирован!\n\n` +
        `Текущее качество: ${session.quality || "720p"}\n\n` +
        `Отправьте ссылку на видео для скачивания.\n` +
        `Для изменения качества используйте "⚙️ Настройки качества"`,
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "download_video", quality: session.quality || "720" })
    return
  }

  if (text === "🎵 Извлечь аудио") {
    ctx.reply(
      "🎵 Режим извлечения аудио активирован!\n\n" +
        "Отправьте ссылку на видео для извлечения аудио.\n" +
        "Аудио будет сохранено в формате MP3 (192 kbps).",
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "extract_audio" })
    return
  }

  if (text === "ℹ️ Информация о видео") {
    ctx.reply(
      "ℹ️ Режим получения информации активирован!\n\n" + "Отправьте ссылку на видео для получения подробной информации.",
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "video_info" })
    return
  }

  if (text === "❓ Помощь") {
    return ctx.replyWithHTML(
      `
📖 <b>Подробная справка:</b>

🎥 <b>Скачивание видео:</b>
• Нажмите "📥 Скачать видео"
• Выберите качество в настройках
• Отправьте ссылку на видео

🎵 <b>Извлечение аудио:</b>
• Нажмите "🎵 Извлечь аудио"
• Отправьте ссылку на видео

⚙️ <b>Качество видео:</b>
• 🔥 1080p - Максимальное качество
• ⭐ 720p - Рекомендуемое (по умолчанию)
• 📱 480p - Среднее качество
• 💾 360p - Минимальный размер

⚠️ <b>Ограничения:</b>
• Максимальный размер файла: 2 ГБ (лимит Telegram)
• Время обработки: 1-10 минут (зависит от размера)
• Большие файлы отправляются дольше

🌐 <b>Поддерживаемые сайты:</b>
YouTube, TikTok, Instagram, Twitter, Facebook, VK и 1000+ других!`,
      createMainMenu(),
    )
  }

  if (text === "⚙️ Настройки качества") {
    ctx.reply(
      `⚙️ Выберите качество видео:\n\n` +
        `Текущее: ${session.quality || "720"}p\n\n` +
        `🔥 1080p - Лучшее качество (больше размер)\n` +
        `⭐ 720p - Рекомендуемое качество\n` +
        `📱 480p - Среднее качество\n` +
        `💾 360p - Экономия трафика`,
      createQualityMenu(),
    )
    return
  }

  // Обработка выбора качества
  if (text.includes("1080p")) {
    userSessions.set(userId, { ...session, quality: "1080" })
    ctx.reply("✅ Установлено качество: 1080p (Лучшее качество)", createMainMenu())
    return
  }
  if (text.includes("720p")) {
    userSessions.set(userId, { ...session, quality: "720" })
    ctx.reply("✅ Установлено качество: 720p (Рекомендуемое)", createMainMenu())
    return
  }
  if (text.includes("480p")) {
    userSessions.set(userId, { ...session, quality: "480" })
    ctx.reply("✅ Установлено качество: 480p (Среднее)", createMainMenu())
    return
  }
  if (text.includes("360p")) {
    userSessions.set(userId, { ...session, quality: "360" })
    ctx.reply("✅ Установлено качество: 360p (Экономия трафика)", createMainMenu())
    return
  }

  if (text.includes("Максимальное качество")) {
    userSessions.set(userId, { ...session, quality: "best" })
    ctx.reply("✅ Установлено максимальное качество (может быть очень большой файл!)", createMainMenu())
    return
  }
  if (text.includes("Оригинальное качество")) {
    userSessions.set(userId, { ...session, quality: "original" })
    ctx.reply("✅ Установлено оригинальное качество (без перекодирования)", createMainMenu())
    return
  }

  if (text === "🏠 Главное меню") {
    ctx.reply("🏠 Главное меню:", createMainMenu())
    userSessions.delete(userId)
    return
  }

  // Если сообщение начинается с /, но это не известная команда
  if (text.startsWith("/")) {
    return ctx.reply("❌ Неизвестная команда. Используйте /start для начала работы.", createMainMenu())
  }

  // Проверяем, является ли текст ссылкой
  if (!isValidUrl(text)) {
    return ctx.reply(
      "❌ Пожалуйста, отправьте корректную ссылку на видео.\n\n" + "Или выберите действие в меню:",
      createMainMenu(),
    )
  }

  // Обрабатываем ссылку в зависимости от активного режима
  if (session.action === "download_video") {
    await handleVideoDownload(ctx, text, session.quality || "720")
  } else if (session.action === "extract_audio") {
    await handleAudioExtraction(ctx, text)
  } else if (session.action === "video_info") {
    await handleVideoInfo(ctx, text)
  } else {
    // Если нет активного режима, предлагаем выбрать действие
    ctx.reply("💡 Я вижу ссылку на видео! Выберите действие в меню:", createMainMenu())
  }
})

// Функция обработки скачивания видео
async function handleVideoDownload(ctx, url, quality) {
  let processingMessage
  try {
    processingMessage = await ctx.reply(
      `⏳ Скачиваю видео в качестве ${quality}p...\n` +
        "Это может занять до 5 минут.\n\n" +
        `📊 Выбранное качество: ${quality}p\n` +
        `🔄 Для изменения качества используйте "⚙️ Настройки качества"`,
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
    console.log(`Качество: ${quality}p`)

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

    // Информируем о размере файла
    if (fileSizeMB > 50) {
      await ctx.reply(
        `⚠️ Внимание! Файл довольно большой: ${fileSizeMB.toFixed(2)} МБ\n` + `Отправка может занять больше времени...`,
      )
    }

    // Проверяем критический размер (2 ГБ - лимит Telegram)
    if (fileSizeMB > 2048) {
      cleanupFiles(actualVideoPath)
      return await ctx.reply(
        `❌ Файл слишком большой: ${fileSizeMB.toFixed(2)} МБ\n` +
          `Максимальный размер для Telegram: 2 ГБ\n` +
          `Попробуйте выбрать меньшее качество.`,
        createMainMenu(),
      )
    }

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, "📤 Отправляю видео...")
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

    ctx.reply(errorMessage, createMainMenu())
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

    // Скачиваем видео в низком качестве для аудио
    await downloadVideo(url, videoPath, "360")

    // Ищем скачанный файл
    const files = fs.readdirSync(tempDir).filter((file) => file.startsWith(`video_${timestamp}`))

    if (files.length === 0) {
      throw new Error("Файл не найден после скачивания")
    }

    const actualVideoPath = path.join(tempDir, files[0])

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, "🎵 Извлекаю аудио...")
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Извлекаем аудио
    await extractAudio(actualVideoPath, audioPath, videoInfo)

    const audioStats = fs.statSync(audioPath)
    const audioSizeMB = audioStats.size / (1024 * 1024)

    console.log(`Размер аудио файла: ${audioSizeMB.toFixed(2)} МБ`)

    // Информируем о размере аудио файла
    if (audioSizeMB > 50) {
      await ctx.reply(
        `⚠️ Аудио файл довольно большой: ${audioSizeMB.toFixed(2)} МБ\n` + `Отправка может занять больше времени...`,
      )
    }

    // Проверяем критический размер для аудио (2 ГБ)
    if (audioSizeMB > 2048) {
      cleanupFiles(actualVideoPath)
      cleanupFiles(audioPath)
      return await ctx.reply(
        `❌ Аудио файл слишком большой: ${audioSizeMB.toFixed(2)} МБ\n` +
          `Максимальный размер для Telegram: 2 ГБ\n` +
          `Попробуйте видео покороче.`,
        createMainMenu(),
      )
    }

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, "📤 Отправляю аудио...")
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

    ctx.reply(errorMessage, createMainMenu())
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

    // Получаем доступные качества
    const availableQualities = []
    if (videoInfo.formats && videoInfo.formats.length > 0) {
      const heights = [
        ...new Set(
          videoInfo.formats
            .filter((f) => f.height)
            .map((f) => f.height)
            .sort((a, b) => b - a),
        ),
      ]

      if (heights.length > 0) {
        availableQualities.push(`Доступные качества: ${heights.join("p, ")}p`)
      }
    }

    const infoMessage = `
ℹ️ Информация о видео:

📹 **Название:** ${videoInfo.title}
👤 **Автор:** ${videoInfo.uploader}
⏱ **Длительность:** ${duration}
🌐 **Платформа:** ${videoInfo.platform}
${availableQualities.length > 0 ? `📊 ${availableQualities[0]}` : ""}

Выберите действие в меню ниже:`

    await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, infoMessage, {
      reply_markup: createMainMenu().reply_markup,
    })
  } catch (error) {
    console.error("Ошибка при получении информации:", error)
    ctx.reply("❌ Не удалось получить информацию о видео.", createMainMenu())
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
  res.send("🤖 Improved Telegram Video Downloader Bot with Menu is running!")
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
    console.log(`✅ Улучшенный бот с меню @${botInfo.username} успешно запущен!`)
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
