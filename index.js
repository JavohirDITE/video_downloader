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

// Функция для определения платформы по URL
function detectPlatform(url) {
  const urlLower = url.toLowerCase()

  if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
    return "youtube"
  } else if (
    urlLower.includes("tiktok.com") ||
    urlLower.includes("vm.tiktok.com") ||
    urlLower.includes("vt.tiktok.com")
  ) {
    return "tiktok"
  } else if (urlLower.includes("instagram.com")) {
    return "instagram"
  } else if (urlLower.includes("twitter.com") || urlLower.includes("x.com")) {
    return "twitter"
  } else if (urlLower.includes("facebook.com") || urlLower.includes("fb.com")) {
    return "facebook"
  } else if (urlLower.includes("vk.com")) {
    return "vk"
  } else if (urlLower.includes("rutube.ru")) {
    return "rutube"
  } else if (urlLower.includes("ok.ru")) {
    return "ok"
  } else if (urlLower.includes("twitch.tv")) {
    return "twitch"
  } else if (urlLower.includes("dailymotion.com")) {
    return "dailymotion"
  } else {
    return "other"
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
      view_count: info.view_count || 0,
      upload_date: info.upload_date || null,
      description: info.description || "",
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
      view_count: 0,
      upload_date: null,
      description: "",
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

  if (duration > 1800) {
    // Больше 30 минут
    return "360"
  }

  return requestedQuality
}

// Улучшенная функция для скачивания видео с автоматическим выбором качества
async function downloadVideoWithSizeControl(url, outputPath, requestedQuality = "720", maxSizeMB = MAX_VIDEO_SIZE_MB) {
  const videoInfo = await getVideoInfo(url)
  const platform = detectPlatform(url)
  const quality = getOptimalQuality(videoInfo.duration, requestedQuality)

  console.log(`Запрошенное качество: ${requestedQuality}p, оптимальное: ${quality}p`)
  console.log(`Длительность видео: ${videoInfo.duration} секунд`)
  console.log(`Платформа: ${platform}`)

  // Список качеств для попыток в зависимости от платформы
  let qualityFallback

  if (platform === "tiktok" || platform === "instagram" || platform === "twitter") {
    // Для платформ с ограниченными форматами
    qualityFallback = {
      1080: ["best", "worst"],
      720: ["best", "worst"],
      480: ["worst", "best"],
      360: ["worst"],
      best: ["best", "worst"],
      original: ["best", "worst"],
      auto: ["best", "worst"],
    }
  } else {
    // Для YouTube и других платформ с полной поддержкой
    qualityFallback = {
      1080: ["1080", "720", "480", "360"],
      720: ["720", "480", "360"],
      480: ["480", "360"],
      360: ["360"],
      best: ["720", "480", "360"],
      original: ["720", "480", "360"],
      auto: ["720", "480", "360"],
    }
  }

  const qualitiesToTry = qualityFallback[quality] || ["best", "worst"]

  for (const currentQuality of qualitiesToTry) {
    try {
      console.log(`Пробуем качество: ${currentQuality} для платформы ${platform}`)

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

      console.log(`Размер файла в качестве ${currentQuality}: ${sizeMB.toFixed(2)} МБ`)

      if (sizeMB <= maxSizeMB) {
        console.log(`✅ Качество ${currentQuality} подходит по размеру`)
        return { success: true, actualPath, sizeMB, quality: currentQuality, platform }
      } else {
        console.log(`❌ Качество ${currentQuality} слишком большое, пробуем меньше`)
        cleanupFiles(actualPath)
        continue
      }
    } catch (error) {
      console.error(`Ошибка при скачивании в качестве ${currentQuality}:`, error)

      // Для TikTok и других платформ пробуем более простой селектор
      if (platform === "tiktok" || platform === "instagram") {
        try {
          console.log(`Пробуем упрощенный селектор для ${platform}...`)
          const simpleSuccess = await downloadVideoSimple(url, outputPath)
          if (simpleSuccess) {
            const files = fs
              .readdirSync(tempDir)
              .filter((file) => file.includes(path.basename(outputPath, path.extname(outputPath))))

            if (files.length > 0) {
              const actualPath = path.join(tempDir, files[0])
              const stats = fs.statSync(actualPath)
              const sizeMB = stats.size / (1024 * 1024)

              if (sizeMB <= MAX_DOCUMENT_SIZE_MB) {
                return { success: true, actualPath, sizeMB, quality: "auto", platform, asDocument: sizeMB > maxSizeMB }
              }
            }
          }
        } catch (simpleError) {
          console.error("Упрощенный метод также не сработал:", simpleError)
        }
      }
      continue
    }
  }

  return { success: false, error: `Не удалось скачать видео с платформы ${platform}` }
}

// Улучшенная функция для скачивания видео с поддержкой разных платформ
async function downloadVideo(url, outputPath, quality = "720") {
  // Определяем платформу по URL
  const platform = detectPlatform(url)
  let formatSelector

  // Специальные селекторы для разных платформ
  if (platform === "tiktok") {
    // TikTok имеет ограниченные форматы
    switch (quality) {
      case "1080":
      case "720":
        formatSelector = "best[ext=mp4]/best"
        break
      case "480":
      case "360":
        formatSelector = "worst[ext=mp4]/worst"
        break
      default:
        formatSelector = "best[ext=mp4]/best"
    }
  } else if (platform === "instagram") {
    // Instagram специфические форматы
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
        formatSelector = "worst/best"
        break
      default:
        formatSelector = "best[height<=720]/best"
    }
  } else if (platform === "twitter") {
    // Twitter/X форматы
    formatSelector = quality === "360" ? "worst[ext=mp4]/worst" : "best[ext=mp4]/best"
  } else if (platform === "rutube") {
    // RuTube форматы
    formatSelector = `best[height<=${quality === "360" ? "360" : quality === "480" ? "480" : quality === "720" ? "720" : "1080"}]/best`
  } else {
    // YouTube и другие платформы с полной поддержкой форматов
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
  }

  const ytDlpOptions = [
    "--no-playlist",
    `--format "${formatSelector}"`,
    '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
    "--extractor-retries 3",
    "--fragment-retries 3",
    "--retry-sleep 1",
    "--no-check-certificate",
    "--no-write-sub",
    "--no-write-auto-sub",
    "--limit-rate 15M",
  ]

  // Добавляем специфичные для платформы опции
  if (platform === "youtube") {
    ytDlpOptions.push('--referer "https://www.youtube.com/"')
    ytDlpOptions.push("--merge-output-format mp4")
  } else if (platform === "tiktok") {
    // TikTok не нужен merge, так как видео уже в mp4
    ytDlpOptions.push('--add-header "Accept-Language:en-US,en;q=0.9"')
  } else if (platform === "instagram") {
    ytDlpOptions.push("--merge-output-format mp4")
  } else if (platform === "rutube") {
    ytDlpOptions.push("--merge-output-format mp4")
  } else {
    ytDlpOptions.push("--merge-output-format mp4")
  }

  const command = `yt-dlp ${ytDlpOptions.join(" ")} -o "${outputPath}" "${url}"`
  console.log(`Выполняется команда: yt-dlp с качеством ${quality}p для платформы ${platform}`)

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

// Упрощенная функция скачивания для проблемных платформ
async function downloadVideoSimple(url, outputPath) {
  const command = `yt-dlp --no-playlist -f "best" --no-check-certificate -o "${outputPath}" "${url}"`
  console.log("Выполняется упрощенная команда yt-dlp")

  try {
    const { stdout, stderr } = await execPromise(command, { timeout: 300000 })
    console.log("Упрощенное скачивание завершено успешно")
    return true
  } catch (error) {
    console.error("Ошибка упрощенного скачивания:", error)
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
    ["📥 Скачать видео + аудио"],
    ["ℹ️ Информация о видео", "⚙️ Настройки качества"],
    ["❓ Помощь"],
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
🎬 Добро пожаловать в видео-загрузчик!

🌟 Возможности:
• 📥 Скачивание видео + аудио одновременно
• 🤖 Автоматический выбор оптимального качества
• 📊 Контроль размера файлов
• ⚡ Быстрая обработка
• 📱 Поддержка больших файлов (до 2 ГБ)

🎵 Что вы получите:
• Видео файл в выбранном качестве
• MP3 аудио (128 kbps) автоматически
• Все за один запрос!

🌐 Поддерживаемые платформы:
YouTube, TikTok, Instagram, Twitter/X, Facebook, VK, RuTube, OK.ru, Twitch, Dailymotion и 1000+ других!

👇 Выберите действие в меню ниже или отправьте ссылку на видео:`

  ctx.reply(welcomeMessage, createMainMenu())
})

// Команда помощи
bot.command("help", (ctx) => {
  const helpMessage = `
📖 Подробная справка:

🎥 Скачивание видео + аудио:
• Нажмите "📥 Скачать видео + аудио"
• Выберите качество в настройках
• Отправьте ссылку на видео
• Получите видео файл + MP3 аудио

ℹ️ Информация о видео:
• Получите подробную информацию о видео
• Длительность, автор, качество
• Примерный размер файла

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
YouTube, TikTok, Instagram, Twitter, Facebook, VK, RuTube, OK.ru, Twitch, Dailymotion и многие другие!

💡 Советы:
• Для длинных видео автоматически выбирается меньшее качество
• Используйте "Авто" для оптимального результата
• Большие файлы отправляются как документы
• Аудио всегда извлекается автоматически`

  ctx.reply(helpMessage, createMainMenu())
})

// Обработка текстовых сообщений (меню)
bot.on("text", async (ctx) => {
  const text = ctx.message.text
  const userId = ctx.from.id
  const session = userSessions.get(userId) || {}

  // Обработка команд меню
  if (text === "📥 Скачать видео + аудио") {
    ctx.reply(
      `📥 Режим скачивания видео + аудио активирован!

` +
        `Текущее качество: ${session.quality || "720p (авто)"}

` +
        `Отправьте ссылку на видео для скачивания.
` +
        `Вы получите:
` +
        `• 📹 Видео файл в выбранном качестве
` +
        `• 🎵 MP3 аудио (128 kbps) автоматически

` +
        `🌐 Поддерживаемые платформы:
` +
        `YouTube, TikTok, Instagram, Twitter, Facebook, VK, RuTube, OK.ru, Twitch, Dailymotion и многие другие!`,
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "download_video", quality: session.quality || "720" })
    return
  }

  if (text === "ℹ️ Информация о видео") {
    ctx.reply(
      "ℹ️ Режим получения информации активирован!\n\n" +
        "Отправьте ссылку на видео для получения подробной информации:\n" +
        "• Название и автор\n" +
        "• Длительность\n" +
        "• Доступные качества\n" +
        "• Примерный размер файла\n" +
        "• Количество просмотров",
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "video_info" })
    return
  }

  if (text === "❓ Помощь") {
    return ctx.replyWithHTML(
      `
📖 <b>Подробная справка:</b>

🎥 <b>Скачивание видео + аудио:</b>
• Нажмите "📥 Скачать видео + аудио"
• Отправьте ссылку на видео
• Получите видео файл + MP3 аудио автоматически

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
YouTube, TikTok, Instagram, Twitter, Facebook, VK, RuTube, OK.ru, Twitch, Dailymotion и 1000+ других!

🎵 <b>Аудио:</b>
• Автоматически извлекается из каждого видео
• Формат: MP3 128 kbps
• Отправляется вместе с видео`,
      createMainMenu(),
    )
  }

  if (text === "⚙️ Настройки качества") {
    ctx.reply(
      `⚙️ Выберите качество видео:

` +
        `Текущее: ${session.quality || "720"}p

` +
        `🚀 Авто - Автоматический выбор оптимального качества
` +
        `⭐ 720p - Рекомендуемое качество (баланс качества и размера)
` +
        `📱 480p - Быстрое скачивание (меньший размер)
` +
        `💾 360p - Экономия трафика (минимальный размер)
` +
        `🔥 1080p - Максимальное качество (если размер позволяет)

` +
        `💡 Для длинных видео качество автоматически понижается
` +
        `🎵 Аудио всегда извлекается в качестве 128 kbps MP3`,
      createQualityMenu(),
    )
    return
  }

  // Обработка выбора качества
  if (text.includes("1080p")) {
    userSessions.set(userId, { ...session, quality: "1080" })
    ctx.reply("✅ Установлено качество: 1080p\n(будет понижено автоматически если файл большой)", createMainMenu())
    return
  }
  if (text.includes("720p")) {
    userSessions.set(userId, { ...session, quality: "720" })
    ctx.reply("✅ Установлено качество: 720p (рекомендуемое)", createMainMenu())
    return
  }
  if (text.includes("480p")) {
    userSessions.set(userId, { ...session, quality: "480" })
    ctx.reply("✅ Установлено качество: 480p (быстрое скачивание)", createMainMenu())
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
      "❌ Пожалуйста, отправьте корректную ссылку на видео.\n\n" +
        "🌐 Поддерживаемые платформы:\n" +
        "YouTube, TikTok, Instagram, Twitter, Facebook, VK, RuTube, OK.ru, Twitch, Dailymotion и многие другие!\n\n" +
        "Или выберите действие в меню:",
      createMainMenu(),
    )
  }

  // Обрабатываем ссылку в зависимости от активного режима
  if (session.action === "download_video") {
    await handleVideoAndAudioDownload(ctx, text, session.quality || "720")
  } else if (session.action === "video_info") {
    await handleVideoInfo(ctx, text)
  } else {
    // Если нет активного режима, предлагаем выбрать действие
    const platform = detectPlatform(text)
    ctx.reply(
      `💡 Я вижу ссылку на видео с платформы: ${platform.toUpperCase()}

` + "Выберите действие в меню:",
      createMainMenu(),
    )
  }
})

// Объединенная функция обработки скачивания видео + аудио
async function handleVideoAndAudioDownload(ctx, url, quality) {
  let processingMessage
  try {
    const platform = detectPlatform(url)
    processingMessage = await ctx.reply(
    `⏳ Анализирую видео с ${platform.toUpperCase()}...
` +
      "Это может занять до 3 минут.

" +
      `📊 Запрошенное качество: ${quality}p
` +
      `🎵 Аудио будет извлечено автоматически
` +
      `🤖 Бот автоматически оптимизирует размер файла`,
  )
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

    console.log(`Начинаем скачивание видео: ${url}`)
    console.log(`Запрошенное качество: ${quality}p`)
    console.log(`Длительность: ${videoInfo.duration} секунд`)

    // Обновляем сообщение
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        `⏳ Скачиваю видео...
📹 ${videoInfo.title.substring(0, 50)}...
⏱ Длительность: ${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, "0")}
👤 Автор: ${videoInfo.uploader}`,
      )
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Скачиваем видео с контролем размера
    const result = await downloadVideoWithSizeControl(url, videoPath, quality, MAX_VIDEO_SIZE_MB)

    if (!result.success) {
      throw new Error(result.error || "Не удалось скачать видео")
    }

    const { actualPath, sizeMB, quality: actualQuality, asDocument, platform: resultPlatform } = result

    console.log(`Итоговый размер файла: ${sizeMB.toFixed(2)} МБ в качестве ${actualQuality}p`)

    // Создаем правильное имя файла
    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "") // Убираем специальные символы
      .replace(/\s+/g, "_") // Заменяем пробелы на подчеркивания
      .substring(0, 50) // Ограничиваем длину

    // Обновляем сообщение - начинаем извлечение аудио
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        "🎵 Извлекаю аудио...\n" + `💾 Размер видео: ${sizeMB.toFixed(2)} МБ\n` + `📊 Качество: ${actualQuality}p`,
      )
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Извлекаем аудио
    const audioFileName = `${cleanTitle}.mp3`
    const audioPath = path.join(tempDir, audioFileName)

    await extractAudio(actualPath, audioPath)

    const audioStats = fs.statSync(audioPath)
    const audioSizeMB = audioStats.size / (1024 * 1024)

    console.log(`Размер аудио файла: ${audioSizeMB.toFixed(2)} МБ`)

    // Обновляем сообщение - отправляем файлы
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        `📤 Отправляю видео + аудио...
📹 Видео: ${sizeMB.toFixed(2)} МБ
🎵 Аудио: ${audioSizeMB.toFixed(2)} МБ`,
      )
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    const caption =
      `✅ Видео + аудио готовы!

` +
      `📹 ${videoInfo.title}
` +
      `👤 ${videoInfo.uploader}
` +
      `🌐 Платформа: ${resultPlatform.toUpperCase()}
` +
      `📊 Качество видео: ${actualQuality}p
` +
      `💾 Размер видео: ${sizeMB.toFixed(2)} МБ
` +
      `🎵 Размер аудио: ${audioSizeMB.toFixed(2)} МБ` +
      (videoInfo.view_count > 0
        ? `
👀 Просмотров: ${videoInfo.view_count.toLocaleString()}`
        : "") +
      (actualQuality !== quality
        ? `

🤖 Качество автоматически оптимизировано с ${quality}p до ${actualQuality}p`
        : "")

    // Отправляем видео
    if (asDocument || sizeMB > MAX_VIDEO_SIZE_MB) {
      // Отправляем как документ
      await ctx.replyWithDocument(
        {
          source: actualPath,
          filename: `${cleanTitle}_${actualQuality}p.mp4`,
        },
        {
          caption:
            caption +
            `

💡 Видео отправлено как документ из-за размера`,
        },
      )
    } else {
      // Отправляем как видео
      await ctx.replyWithVideo(
        { source: actualPath },
        {
          caption,
        },
      )
    }

    // Отправляем аудио
    if (audioSizeMB <= 50) {
      await ctx.replyWithAudio(
        { source: audioPath },
        {
          caption: `🎵 Аудио извлечено из видео
📊 Качество: 128 kbps MP3`,
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
          caption: `🎵 Аудио извлечено из видео
📊 Качество: 128 kbps MP3

💡 Отправлено как документ из-за размера`,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    }

    // Удаляем временные файлы
    cleanupFiles(actualPath)
    cleanupFiles(audioPath)

    // Удаляем сообщение о процессе
    try {
      await ctx.deleteMessage(processingMessage.message_id)
    } catch (deleteError) {
      console.log(\"Не удалось удалить сообщение о процессе")
    }
  } catch (error) {
    console.error("Ошибка при обработке видео:", error)

    let errorMessage = "❌ Произошла ошибка при скачивании видео."

    if (error.message.includes("403") || error.message.includes("Forbidden")) {
      errorMessage = "❌ Доступ к видео ограничен. Попробуйте другое видео."
    } else if (error.message.includes("Video unavailable")) {
      errorMessage = "❌ Видео недоступно. Возможно, оно приватное или удалено."
    } else if (error.message.includes("Unsupported URL")) {
      errorMessage = "❌ Данный сайт не поддерживается."
    } else if (error.message.includes("размер")) {
      errorMessage = "❌ Видео слишком большое даже в минимальном качестве."
    } else if (error.message.includes("TikTok") || error.message.includes("tiktok")) {
      errorMessage = "❌ Проблема с TikTok видео. Попробуйте другую ссылку."
    } else if (error.message.includes("format")) {
      errorMessage = "❌ Запрошенный формат недоступен. Попробуйте другое качество."
    } else if (error.message.includes("timeout")) {
      errorMessage = "❌ Превышено время ожидания. Попробуйте позже или выберите меньшее качество."
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
    const platform = detectPlatform(url)
    processingMessage = await ctx.reply(`⏳ Получаю информацию о видео с ${platform.toUpperCase()}...`)
  } catch (error) {
    console.error("Ошибка при отправке сообщения:", error)
    return
  }

  try {
    const videoInfo = await getVideoInfo(url)
    const platform = detectPlatform(url)

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
        availableQualities.push(`📊 Доступные качества: ${heights.join("p, ")}p`)
      }
    }

    // Оценка размера файла
    let sizeEstimate = ""
    if (videoInfo.duration) {
      const estimatedSize720p = (videoInfo.duration * 0.5).toFixed(1) // Примерно 0.5 МБ/мин для 720p
      const estimatedSize480p = (videoInfo.duration * 0.3).toFixed(1) // Примерно 0.3 МБ/мин для 480p
      const estimatedAudioSize = (videoInfo.duration * 0.1).toFixed(1) // Примерно 0.1 МБ/мин для MP3
      sizeEstimate = `
📊 Примерный размер:
• Видео 720p ≈ ${estimatedSize720p} МБ
• Видео 480p ≈ ${estimatedSize480p} МБ
• Аудио MP3 ≈ ${estimatedAudioSize} МБ`
    }

    // Форматируем дату загрузки
    let uploadDate = ""
    if (videoInfo.upload_date) {
      const year = videoInfo.upload_date.substring(0, 4)
      const month = videoInfo.upload_date.substring(4, 6)
      const day = videoInfo.upload_date.substring(6, 8)
      uploadDate = `
📅 Дата загрузки: ${day}.${month}.${year}`
    }

    const infoMessage = `
ℹ️ Информация о видео:

📹 **Название:** ${videoInfo.title}
👤 **Автор:** ${videoInfo.uploader}
🌐 **Платформа:** ${platform.toUpperCase()}
⏱ **Длительность:** ${duration}${uploadDate}
${videoInfo.view_count > 0 ? `👀 **Просмотров:** ${videoInfo.view_count.toLocaleString()}` : ""}
${availableQualities.length > 0 ? `${availableQualities[0]}` : ""}${sizeEstimate}

${
  videoInfo.description && videoInfo.description.length > 0
    ? `📝 **Описание:** ${videoInfo.description.substring(0, 200)}${videoInfo.description.length > 200 ? "..." : ""}

`
    : ""
}💡 При скачивании вы получите видео + MP3 аудио автоматически!

Выберите действие в меню ниже:`

    await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, infoMessage, {
      parse_mode: "Markdown",
    })

    // Отправляем новое сообщение с меню
    await ctx.reply("Выберите действие:", createMainMenu())
  } catch (error) {
    console.error("Ошибка при получении информации:", error)
    ctx.reply(
      "❌ Не удалось получить информацию о видео. Возможно, видео недоступно или ссылка неверная.",
      createMainMenu(),
    )
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
  res.send("🤖 Simple Video + Audio Downloader Bot is running!")
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
    console.log(`✅ Видео + Аудио загрузчик @${botInfo.username} успешно запущен!`)
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
