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

// Создаем папки для временных файлов и базы данных
const tempDir = path.join(__dirname, "temp")
const dataDir = path.join(__dirname, "data")
const statsFile = path.join(dataDir, "stats.json")
const historyFile = path.join(dataDir, "history.json")

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true })
}
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

// Хранилище для пользовательских сессий
const userSessions = new Map()

// Константы для размеров файлов
const MAX_VIDEO_SIZE_MB = 45
const MAX_DOCUMENT_SIZE_MB = 2000
const TARGET_SIZE_MB = 25

// Инициализация статистики
let botStats = {
  totalDownloads: 0,
  totalUsers: 0,
  platformStats: {},
  qualityStats: {},
  startTime: Date.now(),
}

let userHistory = {}

// Загружаем статистику при запуске
function loadStats() {
  try {
    if (fs.existsSync(statsFile)) {
      botStats = { ...botStats, ...JSON.parse(fs.readFileSync(statsFile, "utf8")) }
    }
    if (fs.existsSync(historyFile)) {
      userHistory = JSON.parse(fs.readFileSync(historyFile, "utf8"))
    }
  } catch (error) {
    console.log("Создаем новые файлы статистики")
  }
}

// Сохраняем статистику
function saveStats() {
  try {
    fs.writeFileSync(statsFile, JSON.stringify(botStats, null, 2))
    fs.writeFileSync(historyFile, JSON.stringify(userHistory, null, 2))
  } catch (error) {
    console.error("Ошибка сохранения статистики:", error)
  }
}

// Обновляем статистику
function updateStats(userId, platform, quality, action = "download") {
  if (!userHistory[userId]) {
    userHistory[userId] = { downloads: 0, history: [], joinDate: Date.now() }
    botStats.totalUsers++
  }

  if (action === "download") {
    botStats.totalDownloads++
    userHistory[userId].downloads++
    userHistory[userId].history.unshift({
      platform,
      quality,
      timestamp: Date.now(),
    })

    // Ограничиваем историю 50 записями
    if (userHistory[userId].history.length > 50) {
      userHistory[userId].history = userHistory[userId].history.slice(0, 50)
    }

    botStats.platformStats[platform] = (botStats.platformStats[platform] || 0) + 1
    botStats.qualityStats[quality] = (botStats.qualityStats[quality] || 0) + 1
  }

  saveStats()
}

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
      thumbnail: info.thumbnail || null,
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
      thumbnail: null,
    }
  }
}

// Функция для получения превью видео
async function getVideoThumbnail(url, outputPath) {
  const command = `yt-dlp --write-thumbnail --skip-download --convert-thumbnails jpg -o "${outputPath}" "${url}"`

  try {
    await execPromise(command, { timeout: 30000 })

    // Ищем созданный файл превью
    const files = fs
      .readdirSync(tempDir)
      .filter(
        (file) =>
          file.includes(path.basename(outputPath, path.extname(outputPath))) &&
          (file.endsWith(".jpg") || file.endsWith(".jpeg") || file.endsWith(".png")),
      )

    if (files.length > 0) {
      return path.join(tempDir, files[0])
    }
    return null
  } catch (error) {
    console.error("Ошибка получения превью:", error)
    return null
  }
}

// Функция для сжатия видео
async function compressVideo(inputPath, outputPath, targetSizeMB = 25) {
  const stats = fs.statSync(inputPath)
  const inputSizeMB = stats.size / (1024 * 1024)

  if (inputSizeMB <= targetSizeMB) {
    // Файл уже достаточно мал
    fs.copyFileSync(inputPath, outputPath)
    return true
  }

  // Вычисляем битрейт для достижения целевого размера
  const { stdout } = await execPromise(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${inputPath}"`)
  const duration = Number.parseFloat(stdout.trim())

  if (!duration || duration <= 0) {
    throw new Error("Не удалось определить длительность видео")
  }

  // Целевой битрейт в kbps (оставляем запас)
  const targetBitrate = Math.floor(((targetSizeMB * 8 * 1024) / duration) * 0.9)

  const command = `ffmpeg -i "${inputPath}" -c:v libx264 -b:v ${targetBitrate}k -c:a aac -b:a 128k -preset fast "${outputPath}" -y`

  try {
    await execPromise(command, { timeout: 300000 })
    return true
  } catch (error) {
    console.error("Ошибка сжатия видео:", error)
    throw error
  }
}

// Функция для обрезки видео
async function trimVideo(inputPath, outputPath, startTime, endTime) {
  const duration = endTime - startTime
  const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} -c copy "${outputPath}" -y`

  try {
    await execPromise(command, { timeout: 180000 })
    return true
  } catch (error) {
    console.error("Ошибка обрезки видео:", error)
    throw error
  }
}

// Функция для изменения скорости видео
async function changeVideoSpeed(inputPath, outputPath, speed) {
  const videoFilter = `setpts=${1 / speed}*PTS`
  const audioFilter = `atempo=${speed}`

  const command = `ffmpeg -i "${inputPath}" -filter_complex "[0:v]${videoFilter}[v];[0:a]${audioFilter}[a]" -map "[v]" -map "[a]" "${outputPath}" -y`

  try {
    await execPromise(command, { timeout: 300000 })
    return true
  } catch (error) {
    console.error("Ошибка изменения скорости:", error)
    throw error
  }
}

// Функция для конвертации формата
async function convertFormat(inputPath, outputPath, format) {
  let command

  switch (format.toLowerCase()) {
    case "mp4":
      command = `ffmpeg -i "${inputPath}" -c:v libx264 -c:a aac "${outputPath}" -y`
      break
    case "avi":
      command = `ffmpeg -i "${inputPath}" -c:v libx264 -c:a mp3 "${outputPath}" -y`
      break
    case "mkv":
      command = `ffmpeg -i "${inputPath}" -c copy "${outputPath}" -y`
      break
    case "webm":
      command = `ffmpeg -i "${inputPath}" -c:v libvpx-vp9 -c:a libopus "${outputPath}" -y`
      break
    default:
      throw new Error(`Формат ${format} не поддерживается`)
  }

  try {
    await execPromise(command, { timeout: 300000 })
    return true
  } catch (error) {
    console.error("Ошибка конвертации:", error)
    throw error
  }
}

// Функция для извлечения субтитров
async function extractSubtitles(url, outputPath) {
  const command = `yt-dlp --write-subs --write-auto-subs --sub-langs "ru,en" --skip-download -o "${outputPath}" "${url}"`

  try {
    await execPromise(command, { timeout: 60000 })

    // Ищем файлы субтитров
    const files = fs
      .readdirSync(tempDir)
      .filter(
        (file) =>
          file.includes(path.basename(outputPath, path.extname(outputPath))) &&
          (file.endsWith(".vtt") || file.endsWith(".srt")),
      )

    return files.map((file) => path.join(tempDir, file))
  } catch (error) {
    console.error("Ошибка извлечения субтитров:", error)
    return []
  }
}

// Функция для скачивания плейлиста
async function downloadPlaylist(url, maxVideos = 5) {
  const command = `yt-dlp --flat-playlist --dump-json "${url}"`

  try {
    const { stdout } = await execPromise(command, { timeout: 30000 })
    const lines = stdout.trim().split("\n")
    const videos = []

    for (let i = 0; i < Math.min(lines.length, maxVideos); i++) {
      try {
        const video = JSON.parse(lines[i])
        videos.push({
          title: video.title || `Видео ${i + 1}`,
          url: video.url || video.webpage_url,
          duration: video.duration || 0,
        })
      } catch (parseError) {
        console.error("Ошибка парсинга видео из плейлиста:", parseError)
      }
    }

    return videos
  } catch (error) {
    console.error("Ошибка получения плейлиста:", error)
    return []
  }
}

// Функция для получения оптимального качества
function getOptimalQuality(duration, requestedQuality) {
  if (duration > 600) {
    if (requestedQuality === "1080") return "720"
    if (requestedQuality === "720") return "480"
  }

  if (duration > 1200) {
    if (requestedQuality === "1080" || requestedQuality === "720") return "480"
    if (requestedQuality === "480") return "360"
  }

  if (duration > 1800) {
    return "360"
  }

  return requestedQuality
}

// Основная функция скачивания видео
async function downloadVideoWithSizeControl(url, outputPath, requestedQuality = "720", maxSizeMB = MAX_VIDEO_SIZE_MB) {
  const videoInfo = await getVideoInfo(url)
  const platform = detectPlatform(url)
  const quality = getOptimalQuality(videoInfo.duration, requestedQuality)

  console.log(`Запрошенное качество: ${requestedQuality}p, оптимальное: ${quality}p`)
  console.log(`Длительность видео: ${videoInfo.duration} секунд`)
  console.log(`Платформа: ${platform}`)

  let qualityFallback

  if (platform === "tiktok" || platform === "instagram" || platform === "twitter") {
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
      continue
    }
  }

  return { success: false, error: `Не удалось скачать видео с платформы ${platform}` }
}

// Функция скачивания видео
async function downloadVideo(url, outputPath, quality = "720") {
  const platform = detectPlatform(url)
  let formatSelector

  if (platform === "tiktok") {
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
    formatSelector = quality === "360" ? "worst[ext=mp4]/worst" : "best[ext=mp4]/best"
  } else {
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

  if (platform === "youtube") {
    ytDlpOptions.push('--referer "https://www.youtube.com/"')
    ytDlpOptions.push("--merge-output-format mp4")
  } else if (platform === "tiktok") {
    ytDlpOptions.push('--add-header "Accept-Language:en-US,en;q=0.9"')
  } else {
    ytDlpOptions.push("--merge-output-format mp4")
  }

  const command = `yt-dlp ${ytDlpOptions.join(" ")} -o "${outputPath}" "${url}"`
  console.log(`Выполняется команда: yt-dlp с качеством ${quality}p для платформы ${platform}`)

  try {
    const { stdout, stderr } = await execPromise(command, { timeout: 300000 })
    console.log("yt-dlp завершен успешно")
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

// Создание главного меню
function createMainMenu() {
  return Markup.keyboard([
    ["📥 Скачать видео", "🎵 Только аудио"],
    ["📋 Плейлист", "🖼️ Превью видео"],
    ["🛠️ Обработка видео", "📊 Статистика"],
    ["⚙️ Настройки", "❓ Помощь"],
  ]).resize()
}

// Меню обработки видео
function createProcessingMenu() {
  return Markup.keyboard([
    ["🗜️ Сжать видео", "✂️ Обрезать видео"],
    ["🔄 Конвертировать", "⚡ Изменить скорость"],
    ["📝 Извлечь субтитры", "🏠 Главное меню"],
  ]).resize()
}

// Меню настроек качества
function createQualityMenu() {
  return Markup.keyboard([
    ["⭐ 720p (Рекомендуемое)", "📱 480p (Быстрое)"],
    ["💾 360p (Экономия)", "🔥 1080p (Максимальное)"],
    ["🚀 Авто (Оптимальное)", "🏠 Главное меню"],
  ]).resize()
}

// Меню форматов
function createFormatMenu() {
  return Markup.keyboard([["📹 MP4", "🎬 AVI"], ["📺 MKV", "🌐 WebM"], ["🏠 Главное меню"]]).resize()
}

// Команда /start
bot.start((ctx) => {
  const userId = ctx.from.id
  updateStats(userId, "system", "start", "join")

  const welcomeMessage = `
🎬 Добро пожаловать в продвинутый видео-загрузчик!

🌟 Основные возможности:
• 📥 Скачивание видео + аудио одновременно
• 🖼️ Превью видео перед скачиванием
• 📋 Поддержка плейлистов (до 5 видео)
• 🛠️ Обработка видео (сжатие, обрезка, конвертация)
• 📊 Статистика и история скачиваний

🎵 Дополнительные функции:
• 🎵 Извлечение только аудио
• 📝 Извлечение субтитров
• ⚡ Изменение скорости видео
• 🔄 Конвертация в разные форматы

🌐 Поддерживаемые платформы:
YouTube, TikTok, Instagram, Twitter/X, Facebook, VK, RuTube, OK.ru, Twitch, Dailymotion и 1000+ других!

👇 Выберите действие в меню ниже:`

  ctx.reply(welcomeMessage, createMainMenu())
})

// Команда помощи
bot.command("help", (ctx) => {
  const helpMessage = `
📖 Подробная справка по всем функциям:

📥 СКАЧИВАНИЕ:
• "📥 Скачать видео" - видео + аудио автоматически
• "🎵 Только аудио" - извлечение MP3 из видео
• "📋 Плейлист" - скачивание до 5 видео из плейлиста

🖼️ ПРЕВЬЮ:
• "🖼️ Превью видео" - получить скриншот перед скачиванием

🛠️ ОБРАБОТКА ВИДЕО:
• "🗜️ Сжать видео" - уменьшение размера файла
• "✂️ Обрезать видео" - вырезать фрагмент (формат: 00:30-02:15)
• "🔄 Конвертировать" - изменение формата (MP4, AVI, MKV, WebM)
• "⚡ Изменить скорость" - ускорение/замедление (0.5x - 2x)
• "�� Извлечь субтитры" - получить текст субтитров

📊 СТАТИСТИКА:
• Общая статистика бота
• Ваша личная история скачиваний
• Популярные платформы и качества

⚙️ НАСТРОЙКИ:
• Выбор качества видео (360p - 1080p)
• Автоматический выбор оптимального качества

💡 СОВЕТЫ:
• Используйте "Авто" качество для лучшего результата
• Большие файлы отправляются как документы
• Плейлисты ограничены 5 видео для экономии ресурсов
• Все функции обработки работают с уже скачанными видео`

  ctx.reply(helpMessage, createMainMenu())
})

// Обработка текстовых сообщений
bot.on("text", async (ctx) => {
  const text = ctx.message.text
  const userId = ctx.from.id
  const session = userSessions.get(userId) || {}

  // Главное меню
  if (text === "📥 Скачать видео") {
    ctx.reply(
      `📥 Режим скачивания видео + аудио активирован!\n\n` +
        `Текущее качество: ${session.quality || "720p (авто)"}\n\n` +
        `Отправьте ссылку на видео для скачивания.\n` +
        `Вы получите:\n` +
        `• 📹 Видео файл в выбранном качестве\n` +
        `• 🎵 MP3 аудио (128 kbps) автоматически`,
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "download_video" })
    return
  }

  if (text === "🎵 Только аудио") {
    ctx.reply(
      `🎵 Режим извлечения аудио активирован!\n\n` +
        `Отправьте ссылку на видео для извлечения аудио.\n` +
        `Вы получите:\n` +
        `• 🎵 MP3 файл (128 kbps)\n` +
        `• Быстрая обработка без скачивания видео`,
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "audio_only" })
    return
  }

  if (text === "📋 Плейлист") {
    ctx.reply(
      `📋 Режим скачивания плейлиста активирован!\n\n` +
        `Отправьте ссылку на плейлист YouTube или другой платформы.\n` +
        `Ограничения:\n` +
        `• Максимум 5 видео за раз\n` +
        `• Качество: ${session.quality || "720p"}\n` +
        `• Каждое видео + аудио автоматически`,
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "playlist" })
    return
  }

  if (text === "🖼️ Превью видео") {
    ctx.reply(
      `🖼️ Режим получения превью активирован!\n\n` +
        `Отправьте ссылку на видео для получения:\n` +
        `• 🖼️ Скриншот превью\n` +
        `• ℹ️ Подробная информация о видео\n` +
        `• 📊 Доступные качества и размеры`,
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "preview" })
    return
  }

  if (text === "🛠️ Обработка видео") {
    ctx.reply(
      `🛠️ Выберите тип обработки видео:\n\n` +
        `🗜️ Сжать видео - уменьшить размер файла\n` +
        `✂️ Обрезать видео - вырезать нужный фрагмент\n` +
        `🔄 Конвертировать - изменить формат файла\n` +
        `⚡ Изменить скорость - ускорить/замедлить\n` +
        `📝 Извлечь субтитры - получить текст`,
      createProcessingMenu(),
    )
    return
  }

  if (text === "📊 Статистика") {
    await showStatistics(ctx, userId)
    return
  }

  if (text === "⚙️ Настройки") {
    ctx.reply(
      `⚙️ Выберите качество видео:\n\n` +
        `Текущее: ${session.quality || "720"}p\n\n` +
        `🚀 Авто - Автоматический выбор оптимального качества\n` +
        `⭐ 720p - Рекомендуемое качество (баланс качества и размера)\n` +
        `📱 480p - Быстрое скачивание (меньший размер)\n` +
        `💾 360p - Экономия трафика (минимальный размер)\n` +
        `🔥 1080p - Максимальное качество (если размер позволяет)`,
      createQualityMenu(),
    )
    return
  }

  // Обработка меню обработки видео
  if (text === "🗜️ Сжать видео") {
    ctx.reply(
      `🗜️ Режим сжатия видео активирован!\n\n` +
        `Отправьте ссылку на видео для сжатия.\n` +
        `Видео будет сжато до ~25 МБ с сохранением качества.`,
      createProcessingMenu(),
    )
    userSessions.set(userId, { ...session, action: "compress" })
    return
  }

  if (text === "✂️ Обрезать видео") {
    ctx.reply(
      `✂️ Режим обрезки видео активирован!\n\n` +
        `Отправьте ссылку на видео и время обрезки в формате:\n` +
        `https://youtube.com/watch?v=... 00:30-02:15\n\n` +
        `Где:\n` +
        `• 00:30 - начало фрагмента (мин:сек)\n` +
        `• 02:15 - конец фрагмента (мин:сек)`,
      createProcessingMenu(),
    )
    userSessions.set(userId, { ...session, action: "trim" })
    return
  }

  if (text === "🔄 Конвертировать") {
    ctx.reply(`🔄 Режим конвертации активирован!\n\n` + `Сначала выберите формат:`, createFormatMenu())
    userSessions.set(userId, { ...session, action: "convert_select" })
    return
  }

  if (text === "⚡ Изменить скорость") {
    ctx.reply(
      `⚡ Режим изменения скорости активирован!\n\n` +
        `Отправьте ссылку на видео и скорость в формате:\n` +
        `https://youtube.com/watch?v=... 1.5\n\n` +
        `Доступные скорости:\n` +
        `• 0.5 - замедление в 2 раза\n` +
        `• 0.75 - замедление на 25%\n` +
        `• 1.25 - ускорение на 25%\n` +
        `• 1.5 - ускорение в 1.5 раза\n` +
        `• 2.0 - ускорение в 2 раза`,
      createProcessingMenu(),
    )
    userSessions.set(userId, { ...session, action: "speed" })
    return
  }

  if (text === "📝 Извлечь субтитры") {
    ctx.reply(
      `📝 Режим извлечения субтитров активирован!\n\n` +
        `Отправьте ссылку на видео для извлечения субтитров.\n` +
        `Поддерживаемые языки: русский, английский`,
      createProcessingMenu(),
    )
    userSessions.set(userId, { ...session, action: "subtitles" })
    return
  }

  // Обработка выбора формата
  if (["📹 MP4", "🎬 AVI", "📺 MKV", "🌐 WebM"].includes(text)) {
    const format = text.split(" ")[1].toLowerCase()
    ctx.reply(
      `Выбран формат: ${format.toUpperCase()}\n\n` + `Теперь отправьте ссылку на видео для конвертации.`,
      createProcessingMenu(),
    )
    userSessions.set(userId, { ...session, action: "convert", format })
    return
  }

  // Обработка выбора качества
  if (text.includes("1080p")) {
    userSessions.set(userId, { ...session, quality: "1080" })
    ctx.reply("✅ Установлено качество: 1080p", createMainMenu())
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
    ctx.reply("✅ Установлено качество: 360p (экономия)", createMainMenu())
    return
  }
  if (text.includes("Авто")) {
    userSessions.set(userId, { ...session, quality: "auto" })
    ctx.reply("✅ Установлен автоматический выбор качества", createMainMenu())
    return
  }

  if (text === "🏠 Главное меню") {
    ctx.reply("🏠 Главное меню:", createMainMenu())
    userSessions.delete(userId)
    return
  }

  if (text === "❓ Помощь") {
    bot.command("help")(ctx)
    return
  }

  // Обработка команд
  if (text.startsWith("/")) {
    return ctx.reply("❌ Неизвестная команда. Используйте /start для начала работы.", createMainMenu())
  }

  // Обработка ссылок и команд в зависимости от режима
  await handleUserInput(ctx, text, session)
})

// Функция обработки пользовательского ввода
async function handleUserInput(ctx, text, session) {
  const userId = ctx.from.id

  if (!session.action) {
    if (isValidUrl(text)) {
      const platform = detectPlatform(text)
      ctx.reply(
        `💡 Я вижу ссылку на видео с платформы: ${platform.toUpperCase()}\n\n` + "Выберите действие в меню:",
        createMainMenu(),
      )
    } else {
      ctx.reply("❌ Пожалуйста, выберите действие в меню или отправьте ссылку на видео.", createMainMenu())
    }
    return
  }

  switch (session.action) {
    case "download_video":
      if (isValidUrl(text)) {
        await handleVideoAndAudioDownload(ctx, text, session.quality || "720")
      } else {
        ctx.reply("❌ Пожалуйста, отправьте корректную ссылку на видео.", createMainMenu())
      }
      break

    case "audio_only":
      if (isValidUrl(text)) {
        await handleAudioOnlyDownload(ctx, text)
      } else {
        ctx.reply("❌ Пожалуйста, отправьте корректную ссылку на видео.", createMainMenu())
      }
      break

    case "playlist":
      if (isValidUrl(text)) {
        await handlePlaylistDownload(ctx, text, session.quality || "720")
      } else {
        ctx.reply("❌ Пожалуйста, отправьте корректную ссылку на плейлист.", createMainMenu())
      }
      break

    case "preview":
      if (isValidUrl(text)) {
        await handleVideoPreview(ctx, text)
      } else {
        ctx.reply("❌ Пожалуйста, отправьте корректную ссылку на видео.", createMainMenu())
      }
      break

    case "compress":
      if (isValidUrl(text)) {
        await handleVideoCompression(ctx, text)
      } else {
        ctx.reply("❌ Пожалуйста, отправьте корректную ссылку на видео.", createProcessingMenu())
      }
      break

    case "trim":
      await handleVideoTrimming(ctx, text)
      break

    case "convert":
      if (isValidUrl(text)) {
        await handleVideoConversion(ctx, text, session.format)
      } else {
        ctx.reply("❌ Пожалуйста, отправьте корректную ссылку на видео.", createProcessingMenu())
      }
      break

    case "speed":
      await handleVideoSpeedChange(ctx, text)
      break

    case "subtitles":
      if (isValidUrl(text)) {
        await handleSubtitleExtraction(ctx, text)
      } else {
        ctx.reply("❌ Пожалуйста, отправьте корректную ссылку на видео.", createProcessingMenu())
      }
      break

    default:
      ctx.reply("❌ Неизвестное действие. Выберите действие в меню.", createMainMenu())
  }
}

// Функция показа статистики
async function showStatistics(ctx, userId) {
  const userStats = userHistory[userId] || { downloads: 0, history: [], joinDate: Date.now() }
  const uptime = Math.floor((Date.now() - botStats.startTime) / 1000 / 60 / 60) // часы

  const topPlatforms =
    Object.entries(botStats.platformStats)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([platform, count]) => `${platform}: ${count}`)
      .join("\n") || "Нет данных"

  const topQualities =
    Object.entries(botStats.qualityStats)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([quality, count]) => `${quality}p: ${count}`)
      .join("\n") || "Нет данных"

  const recentHistory =
    userStats.history
      .slice(0, 5)
      .map((item) => {
        const date = new Date(item.timestamp).toLocaleDateString("ru-RU")
        return `${date} - ${item.platform} (${item.quality}p)`
      })
      .join("\n") || "История пуста"

  const statsMessage = `
📊 СТАТИСТИКА БОТА:

🌍 Общая статистика:
• Всего скачиваний: ${botStats.totalDownloads}
• Всего пользователей: ${botStats.totalUsers}
• Время работы: ${uptime} часов

📈 Популярные платформы:
${topPlatforms}

🎯 Популярные качества:
${topQualities}

👤 ВАША СТАТИСТИКА:

📥 Ваши скачивания: ${userStats.downloads}
📅 Дата регистрации: ${new Date(userStats.joinDate).toLocaleDateString("ru-RU")}

📋 Последние 5 скачиваний:
${recentHistory}

💡 Спасибо за использование бота!`

  ctx.reply(statsMessage, createMainMenu())
}

// Обработчики для разных типов действий

async function handleVideoAndAudioDownload(ctx, url, quality) {
  const userId = ctx.from.id
  let processingMessage

  try {
    const platform = detectPlatform(url)
    processingMessage = await ctx.reply(
      `⏳ Анализирую видео с ${platform.toUpperCase()}...\n` +
        "Это может занять до 3 минут.\n\n" +
        `📊 Запрошенное качество: ${quality}p\n` +
        `🎵 Аудио будет извлечено автоматически`,
    )

    const videoInfo = await getVideoInfo(url)
    const timestamp = Date.now()
    const videoFileName = `video_${timestamp}.%(ext)s`
    const videoPath = path.join(tempDir, videoFileName)

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMessage.message_id,
      null,
      `⏳ Скачиваю видео...\n📹 ${videoInfo.title.substring(0, 50)}...\n⏱ Длительность: ${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, "0")}`,
    )

    const result = await downloadVideoWithSizeControl(url, videoPath, quality, MAX_VIDEO_SIZE_MB)

    if (!result.success) {
      throw new Error(result.error || "Не удалось скачать видео")
    }

    const { actualPath, sizeMB, quality: actualQuality, platform: resultPlatform } = result

    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50)

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMessage.message_id,
      null,
      `🎵 Извлекаю аудио...\n💾 Размер видео: ${sizeMB.toFixed(2)} МБ`,
    )

    const audioFileName = `${cleanTitle}.mp3`
    const audioPath = path.join(tempDir, audioFileName)
    await extractAudio(actualPath, audioPath)

    const audioStats = fs.statSync(audioPath)
    const audioSizeMB = audioStats.size / (1024 * 1024)

    const caption = `✅ Видео + аудио готовы!\n\n📹 ${videoInfo.title}\n👤 ${videoInfo.uploader}\n🌐 Платформа: ${resultPlatform.toUpperCase()}\n📊 Качество: ${actualQuality}p\n💾 Размер видео: ${sizeMB.toFixed(2)} МБ\n🎵 Размер аудио: ${audioSizeMB.toFixed(2)} МБ`

    if (sizeMB > MAX_VIDEO_SIZE_MB) {
      await ctx.replyWithDocument(
        { source: actualPath, filename: `${cleanTitle}_${actualQuality}p.mp4` },
        { caption: caption + `\n\n💡 Видео отправлено как документ из-за размера` },
      )
    } else {
      await ctx.replyWithVideo({ source: actualPath }, { caption })
    }

    if (audioSizeMB <= 50) {
      await ctx.replyWithAudio(
        { source: audioPath },
        {
          caption: `🎵 Аудио извлечено из видео\n📊 Качество: 128 kbps MP3`,
          title: videoInfo.title,
          performer: videoInfo.uploader,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    } else {
      await ctx.replyWithDocument(
        { source: audioPath, filename: audioFileName },
        {
          caption: `🎵 Аудио извлечено из видео\n📊 Качество: 128 kbps MP3\n\n💡 Отправлено как документ из-за размера`,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    }

    updateStats(userId, resultPlatform, actualQuality, "download")
    cleanupFiles(actualPath)
    cleanupFiles(audioPath)
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка при обработке видео:", error)
    let errorMessage = "❌ Произошла ошибка при скачивании видео."

    if (error.message.includes("403")) {
      errorMessage = "❌ Доступ к видео ограничен."
    } else if (error.message.includes("Video unavailable")) {
      errorMessage = "❌ Видео недоступно."
    } else if (error.message.includes("timeout")) {
      errorMessage = "❌ Превышено время ожидания."
    }

    ctx.reply(errorMessage, createMainMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
    }
  }
}

async function handleAudioOnlyDownload(ctx, url) {
  const userId = ctx.from.id
  let processingMessage

  try {
    const platform = detectPlatform(url)
    processingMessage = await ctx.reply(`⏳ Извлекаю аудио с ${platform.toUpperCase()}...`)

    const videoInfo = await getVideoInfo(url)
    const timestamp = Date.now()
    const audioFileName = `audio_${timestamp}.mp3`
    const audioPath = path.join(tempDir, audioFileName)

    // Извлекаем аудио напрямую через yt-dlp
    const command = `yt-dlp -x --audio-format mp3 --audio-quality 128K -o "${audioPath}" "${url}"`
    await execPromise(command, { timeout: 180000 })

    const audioStats = fs.statSync(audioPath)
    const audioSizeMB = audioStats.size / (1024 * 1024)

    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50)

    if (audioSizeMB <= 50) {
      await ctx.replyWithAudio(
        { source: audioPath },
        {
          caption: `🎵 Аудио извлечено!\n📹 ${videoInfo.title}\n👤 ${videoInfo.uploader}\n📊 Качество: 128 kbps MP3\n💾 Размер: ${audioSizeMB.toFixed(2)} МБ`,
          title: videoInfo.title,
          performer: videoInfo.uploader,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    } else {
      await ctx.replyWithDocument(
        { source: audioPath, filename: `${cleanTitle}.mp3` },
        {
          caption: `🎵 Аудио извлечено!\n📹 ${videoInfo.title}\n👤 ${videoInfo.uploader}\n📊 Качество: 128 kbps MP3\n💾 Размер: ${audioSizeMB.toFixed(2)} МБ`,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    }

    updateStats(userId, platform, "audio", "download")
    cleanupFiles(audioPath)
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка извлечения аудио:", error)
    ctx.reply("❌ Не удалось извлечь аудио из видео.", createMainMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
    }
  }
}

async function handlePlaylistDownload(ctx, url, quality) {
  const userId = ctx.from.id
  let processingMessage

  try {
    processingMessage = await ctx.reply("⏳ Анализирую плейлист...")

    const videos = await downloadPlaylist(url, 5)
    if (videos.length === 0) {
      throw new Error("Плейлист пуст или недоступен")
    }

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i]

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        `📥 Скачиваю ${i + 1}/${videos.length}: ${video.title.substring(0, 30)}...`,
      )

      try {
        await handleVideoAndAudioDownload(ctx, video.url, quality)
        await new Promise((resolve) => setTimeout(resolve, 2000)) // Пауза между скачиваниями
      } catch (error) {
        console.error(`Ошибка скачивания видео ${i + 1}:`, error)
        await ctx.reply(`❌ Не удалось скачать видео ${i + 1}: ${video.title}`)
      }
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMessage.message_id,
      null,
      `✅ Плейлист обработан! Скачано ${videos.length} видео.`,
    )

    updateStats(userId, "playlist", quality, "download")
  } catch (error) {
    console.error("Ошибка обработки плейлиста:", error)
    ctx.reply("❌ Не удалось обработать плейлист.", createMainMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
    }
  }
}

async function handleVideoPreview(ctx, url) {
  let processingMessage

  try {
    const platform = detectPlatform(url)
    processingMessage = await ctx.reply(`⏳ Получаю превью с ${platform.toUpperCase()}...`)

    const videoInfo = await getVideoInfo(url)
    const timestamp = Date.now()
    const thumbnailPath = path.join(tempDir, `thumb_${timestamp}`)

    const thumbPath = await getVideoThumbnail(url, thumbnailPath)

    const duration = videoInfo.duration
      ? `${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, "0")}`
      : "Неизвестно"

    const infoMessage = `🖼️ Превью видео:\n\n📹 ${videoInfo.title}\n👤 ${videoInfo.uploader}\n🌐 Платформа: ${platform.toUpperCase()}\n⏱ Длительность: ${duration}\n${videoInfo.view_count > 0 ? `👀 Просмотров: ${videoInfo.view_count.toLocaleString()}\n` : ""}📊 Доступные качества: 360p, 480p, 720p, 1080p`

    if (thumbPath && fs.existsSync(thumbPath)) {
      await ctx.replyWithPhoto(
        { source: thumbPath },
        { caption: infoMessage, reply_markup: createMainMenu().reply_markup },
      )
      cleanupFiles(thumbPath)
    } else {
      await ctx.reply(infoMessage, createMainMenu())
    }

    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка получения превью:", error)
    ctx.reply("❌ Не удалось получить превью видео.", createMainMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
    }
  }
}

async function handleVideoCompression(ctx, url) {
  let processingMessage

  try {
    processingMessage = await ctx.reply("⏳ Скачиваю и сжимаю видео...")

    const videoInfo = await getVideoInfo(url)
    const timestamp = Date.now()
    const videoPath = path.join(tempDir, `video_${timestamp}.%(ext)s`)
    const compressedPath = path.join(tempDir, `compressed_${timestamp}.mp4`)

    const result = await downloadVideoWithSizeControl(url, videoPath, "720", 100) // Скачиваем в хорошем качестве
    if (!result.success) {
      throw new Error("Не удалось скачать видео")
    }

    await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, "🗜️ Сжимаю видео до 25 МБ...")

    await compressVideo(result.actualPath, compressedPath, 25)

    const compressedStats = fs.statSync(compressedPath)
    const compressedSizeMB = compressedStats.size / (1024 * 1024)

    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50)

    await ctx.replyWithVideo(
      { source: compressedPath },
      {
        caption: `🗜️ Видео сжато!\n📹 ${videoInfo.title}\n💾 Размер: ${compressedSizeMB.toFixed(2)} МБ\n📊 Сжатие: ${result.sizeMB.toFixed(2)} → ${compressedSizeMB.toFixed(2)} МБ`,
        reply_markup: createMainMenu().reply_markup,
      },
    )

    cleanupFiles(result.actualPath)
    cleanupFiles(compressedPath)
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка сжатия видео:", error)
    ctx.reply("❌ Не удалось сжать видео.", createProcessingMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
    }
  }
}

async function handleVideoTrimming(ctx, text) {
  const parts = text.split(" ")
  if (parts.length < 2) {
    ctx.reply("❌ Неверный формат. Используйте:\nhttps://youtube.com/watch?v=... 00:30-02:15", createProcessingMenu())
    return
  }

  const url = parts[0]
  const timeRange = parts[1]
  const timeMatch = timeRange.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/)

  if (!isValidUrl(url) || !timeMatch) {
    ctx.reply("❌ Неверный формат. Используйте:\nhttps://youtube.com/watch?v=... 00:30-02:15", createProcessingMenu())
    return
  }

  const startTime = Number.parseInt(timeMatch[1]) * 60 + Number.parseInt(timeMatch[2])
  const endTime = Number.parseInt(timeMatch[3]) * 60 + Number.parseInt(timeMatch[4])

  if (startTime >= endTime) {
    ctx.reply("❌ Время начала должно быть меньше времени окончания.", createProcessingMenu())
    return
  }

  let processingMessage

  try {
    processingMessage = await ctx.reply("⏳ Скачиваю и обрезаю видео...")

    const videoInfo = await getVideoInfo(url)
    const timestamp = Date.now()
    const videoPath = path.join(tempDir, `video_${timestamp}.%(ext)s`)
    const trimmedPath = path.join(tempDir, `trimmed_${timestamp}.mp4`)

    const result = await downloadVideoWithSizeControl(url, videoPath, "720", 100)
    if (!result.success) {
      throw new Error("Не удалось скачать видео")
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMessage.message_id,
      null,
      `✂️ Обрезаю видео (${Math.floor(startTime / 60)}:${(startTime % 60).toString().padStart(2, "0")} - ${Math.floor(endTime / 60)}:${(endTime % 60).toString().padStart(2, "0")})...`,
    )

    await trimVideo(result.actualPath, trimmedPath, startTime, endTime)

    const trimmedStats = fs.statSync(trimmedPath)
    const trimmedSizeMB = trimmedStats.size / (1024 * 1024)

    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50)

    await ctx.replyWithVideo(
      { source: trimmedPath },
      {
        caption: `✂️ Видео обрезано!\n📹 ${videoInfo.title}\n⏱ Фрагмент: ${Math.floor(startTime / 60)}:${(startTime % 60).toString().padStart(2, "0")} - ${Math.floor(endTime / 60)}:${(endTime % 60).toString().padStart(2, "0")}\n💾 Размер: ${trimmedSizeMB.toFixed(2)} МБ`,
        reply_markup: createMainMenu().reply_markup,
      },
    )

    cleanupFiles(result.actualPath)
    cleanupFiles(trimmedPath)
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка обрезки видео:", error)
    ctx.reply("❌ Не удалось обрезать видео.", createProcessingMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
    }
  }
}

async function handleVideoConversion(ctx, url, format) {
  let processingMessage

  try {
    processingMessage = await ctx.reply(`⏳ Скачиваю и конвертирую в ${format.toUpperCase()}...`)

    const videoInfo = await getVideoInfo(url)
    const timestamp = Date.now()
    const videoPath = path.join(tempDir, `video_${timestamp}.%(ext)s`)
    const convertedPath = path.join(tempDir, `converted_${timestamp}.${format}`)

    const result = await downloadVideoWithSizeControl(url, videoPath, "720", 100)
    if (!result.success) {
      throw new Error("Не удалось скачать видео")
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMessage.message_id,
      null,
      `🔄 Конвертирую в ${format.toUpperCase()}...`,
    )

    await convertFormat(result.actualPath, convertedPath, format)

    const convertedStats = fs.statSync(convertedPath)
    const convertedSizeMB = convertedStats.size / (1024 * 1024)

    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50)

    await ctx.replyWithDocument(
      { source: convertedPath, filename: `${cleanTitle}.${format}` },
      {
        caption: `🔄 Видео конвертировано!\n📹 ${videoInfo.title}\n📁 Формат: ${format.toUpperCase()}\n💾 Размер: ${convertedSizeMB.toFixed(2)} МБ`,
        reply_markup: createMainMenu().reply_markup,
      },
    )

    cleanupFiles(result.actualPath)
    cleanupFiles(convertedPath)
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка конвертации видео:", error)
    ctx.reply("❌ Не удалось конвертировать видео.", createProcessingMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
    }
  }
}

async function handleVideoSpeedChange(ctx, text) {
  const parts = text.split(" ")
  if (parts.length < 2) {
    ctx.reply("❌ Неверный формат. Используйте:\nhttps://youtube.com/watch?v=... 1.5", createProcessingMenu())
    return
  }

  const url = parts[0]
  const speed = Number.parseFloat(parts[1])

  if (!isValidUrl(url) || isNaN(speed) || speed < 0.5 || speed > 2.0) {
    ctx.reply("❌ Неверный формат или скорость. Скорость должна быть от 0.5 до 2.0", createProcessingMenu())
    return
  }

  let processingMessage

  try {
    processingMessage = await ctx.reply(`⏳ Скачиваю и изменяю скорость на ${speed}x...`)

    const videoInfo = await getVideoInfo(url)
    const timestamp = Date.now()
    const videoPath = path.join(tempDir, `video_${timestamp}.%(ext)s`)
    const speedPath = path.join(tempDir, `speed_${timestamp}.mp4`)

    const result = await downloadVideoWithSizeControl(url, videoPath, "720", 100)
    if (!result.success) {
      throw new Error("Не удалось скачать видео")
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMessage.message_id,
      null,
      `⚡ Изменяю скорость на ${speed}x...`,
    )

    await changeVideoSpeed(result.actualPath, speedPath, speed)

    const speedStats = fs.statSync(speedPath)
    const speedSizeMB = speedStats.size / (1024 * 1024)

    const cleanTitle = videoInfo.title
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50)

    if (speedSizeMB <= MAX_VIDEO_SIZE_MB) {
      await ctx.replyWithVideo(
        { source: speedPath },
        {
          caption: `⚡ Скорость изменена!\n📹 ${videoInfo.title}\n🚀 Скорость: ${speed}x\n💾 Размер: ${speedSizeMB.toFixed(2)} МБ`,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    } else {
      await ctx.replyWithDocument(
        { source: speedPath, filename: `${cleanTitle}_${speed}x.mp4` },
        {
          caption: `⚡ Скорость изменена!\n📹 ${videoInfo.title}\n🚀 Скорость: ${speed}x\n💾 Размер: ${speedSizeMB.toFixed(2)} МБ`,
          reply_markup: createMainMenu().reply_markup,
        },
      )
    }

    cleanupFiles(result.actualPath)
    cleanupFiles(speedPath)
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка изменения скорости:", error)
    ctx.reply("❌ Не удалось изменить скорость видео.", createProcessingMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
    }
  }
}

async function handleSubtitleExtraction(ctx, url) {
  let processingMessage

  try {
    const platform = detectPlatform(url)
    processingMessage = await ctx.reply(`⏳ Извлекаю субтитры с ${platform.toUpperCase()}...`)

    const videoInfo = await getVideoInfo(url)
    const timestamp = Date.now()
    const subtitlePath = path.join(tempDir, `subtitle_${timestamp}`)

    const subtitleFiles = await extractSubtitles(url, subtitlePath)

    if (subtitleFiles.length === 0) {
      throw new Error("Субтитры не найдены")
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMessage.message_id,
      null,
      `📝 Найдено ${subtitleFiles.length} файл(ов) субтитров`,
    )

    for (const subtitleFile of subtitleFiles) {
      const fileName = path.basename(subtitleFile)
      const language = fileName.includes(".ru.") ? "Русский" : fileName.includes(".en.") ? "English" : "Неизвестный"

      await ctx.replyWithDocument(
        { source: subtitleFile, filename: fileName },
        {
          caption: `📝 Субтитры извлечены!\n📹 ${videoInfo.title}\n🌐 Язык: ${language}\n📁 Формат: ${fileName.split(".").pop().toUpperCase()}`,
        },
      )

      cleanupFiles(subtitleFile)
    }

    await ctx.reply("✅ Все субтитры отправлены!", createMainMenu())
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка извлечения субтитров:", error)
    ctx.reply("❌ Не удалось извлечь субтитры. Возможно, они недоступны для этого видео.", createProcessingMenu())
    if (processingMessage) {
      try {
        await ctx.deleteMessage(processingMessage.message_id)
      } catch (e) {}
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

// Очистка временных файлов
function cleanupTempDir() {
  try {
    const files = fs.readdirSync(tempDir)
    files.forEach((file) => {
      const filePath = path.join(tempDir, file)
      const stats = fs.statSync(filePath)
      const ageMinutes = (Date.now() - stats.mtime.getTime()) / (1000 * 60)

      // Удаляем файлы старше 30 минут
      if (ageMinutes > 30) {
        fs.unlinkSync(filePath)
        console.log(`Удален старый файл: ${file}`)
      }
    })
    console.log("🧹 Очистка временных файлов завершена")
  } catch (error) {
    console.log("⚠️ Ошибка при очистке временных файлов:", error)
  }
}

// Загружаем статистику при запуске
loadStats()

// Очищаем временные файлы при запуске
cleanupTempDir()

// Периодическая очистка временных файлов (каждые 15 минут)
setInterval(cleanupTempDir, 15 * 60 * 1000)

// Сохранение статистики каждые 5 минут
setInterval(saveStats, 5 * 60 * 1000)

// Очистка старых сессий (каждые 10 минут)
setInterval(
  () => {
    console.log(`Активных сессий: ${userSessions.size}`)
    console.log(`Всего пользователей: ${botStats.totalUsers}`)
    console.log(`Всего скачиваний: ${botStats.totalDownloads}`)
  },
  10 * 60 * 1000,
)

// Настройка webhook для Railway
app.use(express.json())

// Health check endpoint
app.get("/", (req, res) => {
  res.send(`
    🤖 Advanced Video Downloader Bot is running!
    
    📊 Statistics:
    • Total downloads: ${botStats.totalDownloads}
    • Total users: ${botStats.totalUsers}
    • Uptime: ${Math.floor((Date.now() - botStats.startTime) / 1000 / 60 / 60)} hours
    
    🌟 Features:
    • Video + Audio download
    • Playlist support
    • Video compression
    • Format conversion
    • Speed change
    • Subtitle extraction
    • Video preview
    • Statistics tracking
  `)
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
    const webhookUrl = process.env.RAILWAY_STATIC_URL
      ? `https://${process.env.RAILWAY_STATIC_URL}/webhook/${BOT_TOKEN}`
      : `http://localhost:${PORT}/webhook/${BOT_TOKEN}`

    console.log(`🔗 Устанавливаем webhook: ${webhookUrl}`)
    await bot.telegram.setWebhook(webhookUrl)
    console.log("✅ Webhook установлен успешно!")

    const botInfo = await bot.telegram.getMe()
    console.log(`✅ Продвинутый видео-загрузчик @${botInfo.username} успешно запущен!`)
    console.log(`📊 Загружена статистика: ${botStats.totalDownloads} скачиваний, ${botStats.totalUsers} пользователей`)
  } catch (error) {
    console.error("❌ Ошибка при установке webhook:", error)

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
  saveStats()
  bot.stop("SIGINT")
  process.exit(0)
})

process.once("SIGTERM", () => {
  console.log("🛑 Получен сигнал SIGTERM, завершаем работу бота...")
  saveStats()
  bot.stop("SIGTERM")
  process.exit(0)
})
