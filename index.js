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

// Константы для размеров файлов
const MAX_VIDEO_SIZE_MB = 45 // Оставляем запас для Telegram лимита в 50 МБ
const MAX_DOCUMENT_SIZE_MB = 2000 // 2 ГБ лимит Telegram
const TARGET_SIZE_MB = 25 // Целевой размер для комфортной отправки

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
      filesize: info.filesize || 0,
    }
  } catch (error) {
    console.error("Ошибка получения информации о видео:", error)
    return {
      title: "Неизвестное видео",
      duration: 0,
      uploader: "Неизвестный автор",
      platform: "unknown",
      formats: [],
      filesize: 0,
    }
  }
}

// Функция для получения оптимального качества на основе длительности видео
function getOptimalQuality(duration, requestedQuality) {
  // Если видео длинное, автоматически понижаем качество
  if (duration > 600) {
    // Больше 10 минут
    if (requestedQuality === "1080") return "720"
    if (requestedQuality === "720") return "480"
  }

  if (duration > 1200) {
    // Больше 20 минут
    if (requestedQuality === "1080" || requestedQuality === "720") return "480"
    if (requestedQuality === "480") return "360"
  }

  return requestedQuality
}

// Улучшенная функция для скачивания видео с автоматическим выбором качества
async function downloadVideoWithSizeControl(url, outputPath, requestedQuality = "720", maxSizeMB = MAX_VIDEO_SIZE_MB) {
  const videoInfo = await getVideoInfo(url)
  const quality = getOptimalQuality(videoInfo.duration, requestedQuality)

  console.log(`Запрошенное качество: ${requestedQuality}p, оптимальное: ${quality}p`)
  console.log(`Длительность видео: ${videoInfo.duration} секунд`)

  // Список качеств для попыток (от запрошенного к минимальному)
  const qualityFallback = {
    1080: ["1080", "720", "480", "360"],
    720: ["720", "480", "360"],
    480: ["480", "360"],
    360: ["360"],
    best: ["720", "480", "360"],
    original: ["720", "480", "360"],
  }

  const qualitiesToTry = qualityFallback[quality] || ["720", "480", "360"]

  for (const currentQuality of qualitiesToTry) {
    try {
      console.log(`Пробуем качество: ${currentQuality}p`)

      const success = await downloadVideo(url, outputPath, currentQuality)
      if (!success) continue

      // Проверяем размер скачанного файла
      const files = fs
        .readdirSync(tempDir)
        .filter((file) => file.includes(path.basename(outputPath, path.extname(outputPath))))

      if (files.length === 0) continue

      const actualPath = path.join(tempDir, files[0])
      const stats = fs.statSync(actualPath)
      const sizeMB = stats.size / (1024 * 1024)

      console.log(`Размер файла в качестве ${currentQuality}p: ${sizeMB.toFixed(2)} МБ`)

      if (sizeMB <= maxSizeMB) {
        console.log(`✅ Качество ${currentQuality}p подходит по размеру`)
        return { success: true, actualPath, sizeMB, quality: currentQuality }
      } else {
        console.log(`❌ Качество ${currentQuality}p слишком большое, пробуем меньше`)
        cleanupFiles(actualPath)
        continue
      }
    } catch (error) {
      console.error(`Ошибка при скачивании в качестве ${currentQuality}p:`, error)
      continue
    }
  }

  // Если ничего не подошло, пробуем скачать в минимальном качестве для документа
  try {
    console.log("Скачиваем в минимальном качестве для отправки документом...")
    const success = await downloadVideo(url, outputPath, "360")
    if (success) {
      const files = fs
        .readdirSync(tempDir)
        .filter((file) => file.includes(path.basename(outputPath, path.extname(outputPath))))

      if (files.length > 0) {
        const actualPath = path.join(tempDir, files[0])
        const stats = fs.statSync(actualPath)
        const sizeMB = stats.size / (1024 * 1024)

        if (sizeMB <= MAX_DOCUMENT_SIZE_MB) {
          return { success: true, actualPath, sizeMB, quality: "360", asDocument: true }
        }
      }
    }
  } catch (error) {
    console.error("Ошибка при скачивании в минимальном качестве:", error)
  }

  return { success: false, error: "Не удалось скачать видео в подходящем размере" }
}

// Улучшенная функция для скачивания видео
async function downloadVideo(url, outputPath, quality = "720") {
  let formatSelector

  // Оптимизированные селекторы для меньшего размера файлов
  switch (quality) {
    case "1080":
      formatSelector =
        "bestvideo[height<=1080][filesize<50M][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][filesize<50M][ext=mp4]/best[height<=1080]"
      break
    case "720":
      formatSelector =
        "bestvideo[height<=720][filesize<35M][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][filesize<35M][ext=mp4]/best[height<=720]"
      break
    case "480":
      formatSelector =
        "bestvideo[height<=480][filesize<25M][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][filesize<25M][ext=mp4]/best[height<=480]"
      break
    case "360":
      formatSelector =
        "bestvideo[height<=360][filesize<15M][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][filesize<15M][ext=mp4]/best[height<=360]"
      break
    case "best":
      formatSelector = "best[filesize<35M][ext=mp4]/best[ext=mp4]"
      break
    case "original":
      formatSelector = "best"
      break
    default:
      formatSelector =
        "bestvideo[height<=720][filesize<35M][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][filesize<35M][ext=mp4]/best[height<=720]"
  }

  const ytDlpOptions = [
    "--no-playlist",
    `--format "${formatSelector}"`,
    '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
    '--referer "https://www.youtube.com/"',
    "--extractor-retries 3",
    "--fragment-retries 3",
    "--retry-sleep 1",
    "--no-check-certificate",
    "--merge-output-format mp4",
    "--no-write-sub", // Отключаем субтитры для экономии места
    "--no-write-auto-sub",
    // Добавляем ограничение скорости для стабильности
    "--limit-rate 10M",
  ].join(" ")

  const command = `yt-dlp ${ytDlpOptions} -o "${outputPath}" "${url}"`
  console.log(`Выполняется команда: yt-dlp с качеством ${quality}p`)

  try {
    const { stdout, stderr } = await execPromise(command, { timeout: 300000 })
    console.log("yt-dlp завершен успешно")
    if (stderr && !stderr.includes("WARNING")) {
      console.log("yt-dlp stderr:", stderr)
    }
    return true
  } catch (error) {
    console.error("Ошибка yt-dlp:", error)
    throw error
  }
}

// Функция для извлечения аудио
async function extractAudio(videoPath, audioPath) {
  const command = `ffmpeg -i "${videoPath}" -vn -acodec mp3 -ab 128k "${audioPath}" -y`
  console.log(`Выполняется команда: ${command}`)

  try {
    const { stdout, stderr } = await execPromise(command, { timeout: 180000 })
    console.log("ffmpeg завершен успешно")
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
    ["⭐ 720p (Рекомендуемое)", "📱 480p (Быстрое)"],
    ["💾 360p (Экономия)", "🔥 1080p (Если размер позволяет)"],
    ["🚀 Авто (Оптимальное)", "🏠 Главное меню"],
  ]).resize()
}

// Команда /start - приветствие с меню
bot.start((ctx) => {
  const welcomeMessage = `
🎬 Добро пожаловать в оптимизированный бот для скачивания видео!

🌟 Новые возможности:
• Автоматический выбор оптимального качества
• Контроль размера файлов
• Быстрая обработка
• Поддержка больших файлов

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
• Получите MP3 файл (128 kbps)

⚙️ Настройки качества:
• ⭐ 720p - Рекомендуемое (оптимально)
• 📱 480p - Быстрое скачивание
• 💾 360p - Экономия трафика
• 🔥 1080p - Если размер позволяет
• 🚀 Авто - Автоматический выбор

⚠️ Ограничения:
• Видео до 45 МБ отправляются как видео
• Больше 45 МБ - как документы
• Максимум 2 ГБ (лимит Telegram)

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
        `Текущее качество: ${session.quality || "720p (авто)"}\n\n` +
        `Отправьте ссылку на видео для скачивания.\n` +
        `Бот автоматически выберет оптимальное качество для быстрой отправки.`,
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "download_video", quality: session.quality || "720" })
    return
  }

  if (text === "🎵 Извлечь аудио") {
    ctx.reply(
      "🎵 Режим извлечения аудио активирован!\n\n" +
        "Отправьте ссылку на видео для извлечения аудио.\n" +
        "Аудио будет сохранено в формате MP3 (128 kbps).",
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
• Отправьте ссылку на видео
• Бот автоматически выберет оптимальное качество

🎵 <b>Извлечение аудио:</b>
• Нажмите "🎵 Извлечь аудио"
• Отправьте ссылку на видео

⚙️ <b>Качество видео:</b>
• 🚀 Авто - Автоматический выбор (рекомендуется)
• ⭐ 720p - Хорошее качество
• 📱 480p - Быстрое скачивание
• 💾 360p - Минимальный размер

⚠️ <b>Ограничения:</b>
• Файлы до 45 МБ отправляются как видео
• Больше 45 МБ - как документы
• Максимум 2 ГБ (лимит Telegram)

🌐 <b>Поддерживаемые сайты:</b>
YouTube, TikTok, Instagram, Twitter, Facebook, VK и 1000+ других!`,
      createMainMenu(),
    )
  }

  if (text === "⚙️ Настройки качества") {
    ctx.reply(
      `⚙️ Выберите качество видео:\n\n` +
        `Текущее: ${session.quality || "720"}p\n\n` +
        `🚀 Авто - Автоматический выбор оптимального качества\n` +
        `⭐ 720p - Рекомендуемое качество\n` +
        `📱 480p - Быстрое скачивание\n` +
        `💾 360p - Экономия трафика\n` +
        `🔥 1080p - Максимальное (если размер позволяет)`,
      createQualityMenu(),
    )
    return
  }

  // Обработка выбора качества
  if (text.includes("1080p")) {
    userSessions.set(userId, { ...session, quality: "1080" })
    ctx.reply("✅ Установлено качество: 1080p (будет понижено если файл большой)", createMainMenu())
    return
  }
  if (text.includes("720p")) {
    userSessions.set(userId, { ...session, quality: "720" })
    ctx.reply("✅ Установлено качество: 720p (рекомендуемое)", createMainMenu())
    return
  }
  if (text.includes("480p")) {
    userSessions.set(userId, { ...session, quality: "480" })
    ctx.reply("✅ Установлено качество: 480p (быстрое)", createMainMenu())
    return
  }
  if (text.includes("360p")) {
    userSessions.set(userId, { ...session, quality: "360" })
    ctx.reply("✅ Установлено качество: 360p (экономия трафика)", createMainMenu())
    return
  }
  if (text.includes("Авто")) {
    userSessions.set(userId, { ...session, quality: "auto" })
    ctx.reply("✅ Установлен автоматический выбор качества (рекомендуется)", createMainMenu())
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
      `⏳ Анализирую видео и выбираю оптимальное качество...\n` +
        "Это может занять до 3 минут.\n\n" +
        `📊 Запрошенное качество: ${quality}p\n` +
        `🤖 Бот автоматически оптимизирует размер файла`,
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
    console.log(`Запрошенное качество: ${quality}p`)
    console.log(`Длительность: ${videoInfo.duration} секунд`)

    // Обновляем сообщение
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        `⏳ Скачиваю видео...\n📹 ${videoInfo.title.substring(0, 50)}...\n⏱ Длительность: ${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, "0")}`,
      )
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Скачиваем видео с контролем размера
    const result = await downloadVideoWithSizeControl(url, videoPath, quality, MAX_VIDEO_SIZE_MB)

    if (!result.success) {
      throw new Error(result.error || "Не удалось скачать видео")
    }

    const { actualPath, sizeMB, quality: actualQuality, asDocument } = result

    console.log(`Итоговый размер файла: ${sizeMB.toFixed(2)} МБ в качестве ${actualQuality}p`)

    // Обновляем сообщение о процессе
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        `📤 Отправляю видео...\n💾 Размер: ${sizeMB.toFixed(2)} МБ\n📊 Качество: ${actualQuality}p`,
      )
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Создаем правильное имя файла
    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "") // Убираем специальные символы
      .replace(/\s+/g, "_") // Заменяем пробелы на подчеркивания
      .substring(0, 50) // Ограничиваем длину

    const caption =
      `✅ Видео скачано!\n\n` +
      `📹 ${videoInfo.title}\n` +
      `👤 ${videoInfo.uploader}\n` +
      `📊 Качество: ${actualQuality}p\n` +
      `💾 Размер: ${sizeMB.toFixed(2)} МБ` +
      (actualQuality !== quality
        ? `\n\n🤖 Качество автоматически оптимизировано с ${quality}p до ${actualQuality}p`
        : "")

    // Отправляем файл
    if (asDocument || sizeMB > MAX_VIDEO_SIZE_MB) {
      // Отправляем как документ
      await ctx.replyWithDocument(
        {
          source: actualPath,
          filename: `${cleanTitle}_${actualQuality}p.mp4`,
        },
        {
          caption: caption + `\n\n💡 Отправлено как документ из-за размера`,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    } else {
      // Отправляем как видео
      await ctx.replyWithVideo(
        { source: actualPath },
        {
          caption,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    }

    // Удаляем временный файл
    cleanupFiles(actualPath)

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
      errorMessage = "❌ Доступ к видео ограничен. Попробуйте другое видео или извлеките аудио."
    } else if (error.message.includes("Video unavailable")) {
      errorMessage = "❌ Видео недоступно. Возможно, оно приватное или удалено."
    } else if (error.message.includes("Unsupported URL")) {
      errorMessage = "❌ Данный сайт не поддерживается."
    } else if (error.message.includes("размер")) {
      errorMessage = "❌ Видео слишком большое даже в минимальном качестве. Попробуйте извлечь аудио."
    }

    ctx.reply(errorMessage, createMainMenu())

    // Удаляем сообщение о процессе
    try {
      await ctx.deleteMessage(processingMessage.message_id)
    } catch (deleteError) {
      console.log("Не удалось удалить сообщение о процессе")
    }
  }
}

// Функция обработки извлечения аудио
async function handleAudioExtraction(ctx, url) {
  let processingMessage
  try {
    processingMessage = await ctx.reply("⏳ Извлекаю аудио... Это может занять до 3 минут.")
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
    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "") // Убираем специальные символы
      .replace(/\s+/g, "_") // Заменяем пробелы на подчеркивания
      .substring(0, 50) // Ограничиваем длину

    const audioFileName = `${cleanTitle}.mp3`
    const audioPath = path.join(tempDir, audioFileName)

    console.log(`Начинаем скачивание видео для аудио: ${url}`)

    // Обновляем сообщение
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        `⏳ Скачиваю видео для извлечения аудио...\n📹 ${videoInfo.title.substring(0, 50)}...`,
      )
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

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
    await extractAudio(actualVideoPath, audioPath)

    const audioStats = fs.statSync(audioPath)
    const audioSizeMB = audioStats.size / (1024 * 1024)

    console.log(`Размер аудио файла: ${audioSizeMB.toFixed(2)} МБ`)

    // Проверяем размер аудио файла
    if (audioSizeMB > MAX_DOCUMENT_SIZE_MB) {
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

    const caption =
      `✅ Аудио извлечено!\n\n` +
      `🎵 ${videoInfo.title}\n` +
      `👤 ${videoInfo.uploader}\n` +
      `💾 Размер: ${audioSizeMB.toFixed(2)} МБ\n` +
      `🎧 Качество: 128 kbps MP3`

    // Отправляем аудио
    if (audioSizeMB <= 50) {
      await ctx.replyWithAudio(
        { source: audioPath },
        {
          caption,
          title: videoInfo.title,
          performer: videoInfo.uploader,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    } else {
      await ctx.replyWithDocument(
        {
          source: audioPath,
          filename: audioFileName,
        },
        {
          caption: caption + `\n\n💡 Отправлено как документ из-за размера`,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    }

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
      errorMessage = "❌ Доступ к видео ограничен."
    } else if (error.message.includes("Video unavailable")) {
      errorMessage = "❌ Видео недоступно."
    }

    ctx.reply(errorMessage, createMainMenu())

    // Удаляем сообщение о процессе
    try {
      await ctx.deleteMessage(processingMessage.message_id)
    } catch (deleteError) {
      console.log("Не удалось удалить сообщение о процессе")
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

    // Оценка размера файла
    let sizeEstimate = ""
    if (videoInfo.duration) {
      const estimatedSize720p = (videoInfo.duration * 0.5).toFixed(1) // Примерно 0.5 МБ/мин для 720p
      const estimatedSize480p = (videoInfo.duration * 0.3).toFixed(1) // Примерно 0.3 МБ/мин для 480p
      sizeEstimate = `\n📊 Примерный размер: 720p ≈ ${estimatedSize720p} МБ, 480p ≈ ${estimatedSize480p} МБ`
    }

    const infoMessage = `
ℹ️ Информация о видео:

📹 **Название:** ${videoInfo.title}
👤 **Автор:** ${videoInfo.uploader}
⏱ **Длительность:** ${duration}
🌐 **Платформа:** ${videoInfo.platform}
${availableQualities.length > 0 ? `📊 ${availableQualities[0]}` : ""}${sizeEstimate}

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

// Периодическая очистка временных файлов (каждые 15 минут)
setInterval(cleanupTempDir, 15 * 60 * 1000)

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
  res.send("🤖 Optimized Telegram Video Downloader Bot is running!")
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
    console.log(`✅ Оптимизированный бот @${botInfo.username} успешно запущен!`)
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
