const { Telegraf, Markup } = require("telegraf")
const { exec } = require("child_process")
const fs = require("fs")
const path = require("path")
const util = require("util")
const express = require("express")
const axios = require("axios")
const FormData = require("form-data")
const crypto = require("crypto")

// Преобразуем exec в промис для удобства использования
const execPromise = util.promisify(exec)

// Проверяем наличие токена
const BOT_TOKEN = process.env.BOT_TOKEN
if (!BOT_TOKEN) {
  console.error("❌ ОШИБКА: Переменная окружения BOT_TOKEN не установлена!")
  console.error("Пожалуйста, установите BOT_TOKEN в настройках Railway или в файле .env")
  process.exit(1)
}

// ACRCloud настройки
const ACRCLOUD_CONFIG = {
  host: process.env.ACRCLOUD_HOST || "identify-ap-southeast-1.acrcloud.com",
  access_key: process.env.ACRCLOUD_ACCESS_KEY,
  access_secret: process.env.ACRCLOUD_ACCESS_SECRET,
  timeout: 10000,
}

// Проверяем настройки ACRCloud
if (!ACRCLOUD_CONFIG.access_key || !ACRCLOUD_CONFIG.access_secret) {
  console.warn("⚠️ ПРЕДУПРЕЖДЕНИЕ: ACRCloud API ключи не настроены. Функция распознавания музыки будет недоступна.")
  console.warn("Установите ACRCLOUD_ACCESS_KEY и ACRCLOUD_ACCESS_SECRET для включения функции.")
}

console.log("✅ Токен бота найден, длина:", BOT_TOKEN.length)
console.log("🎵 ACRCloud настройки:", ACRCLOUD_CONFIG.access_key ? "✅ Настроены" : "❌ Не настроены")

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
const MAX_AUDIO_DURATION_FOR_RECOGNITION = 60 // Максимальная длительность аудио для распознавания (секунды)

// Константы для музыкального поиска
const ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/"
const LASTFM_API_KEY = process.env.LASTFM_API_KEY || "your_lastfm_api_key_here" // Опционально

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
  } else {
    return "other"
  }
}

// Функция для создания подписи ACRCloud
function buildStringToSign(method, uri, accessKey, dataType, signatureVersion, timestamp) {
  return [method, uri, accessKey, dataType, signatureVersion, timestamp].join("\n")
}

// Функция для создания подписи
function sign(signString, accessSecret) {
  return crypto.createHmac("sha1", accessSecret).update(Buffer.from(signString, "utf-8")).digest().toString("base64")
}

// Функция распознавания музыки через ACRCloud API
async function recognizeMusic(audioBuffer) {
  if (!ACRCLOUD_CONFIG.access_key || !ACRCLOUD_CONFIG.access_secret) {
    throw new Error("ACRCloud API ключи не настроены")
  }

  const method = "POST"
  const uri = "/v1/identify"
  const dataType = "audio"
  const signatureVersion = "1"
  const timestamp = new Date().getTime()

  const stringToSign = buildStringToSign(method, uri, ACRCLOUD_CONFIG.access_key, dataType, signatureVersion, timestamp)
  const signature = sign(stringToSign, ACRCLOUD_CONFIG.access_secret)

  const formData = new FormData()
  formData.append("sample", audioBuffer, {
    filename: "sample.wav",
    contentType: "audio/wav",
  })
  formData.append("access_key", ACRCLOUD_CONFIG.access_key)
  formData.append("data_type", dataType)
  formData.append("signature_version", signatureVersion)
  formData.append("signature", signature)
  formData.append("sample_bytes", audioBuffer.length.toString())
  formData.append("timestamp", timestamp.toString())

  try {
    const response = await axios.post(`https://${ACRCLOUD_CONFIG.host}${uri}`, formData, {
      headers: {
        ...formData.getHeaders(),
      },
      timeout: ACRCLOUD_CONFIG.timeout,
    })

    return response.data
  } catch (error) {
    console.error("Ошибка ACRCloud API:", error)
    throw error
  }
}

// Функция для поиска музыки через iTunes API
async function searchMusicItunes(query, entity = "song", limit = 10) {
  try {
    const response = await axios.get(ITUNES_SEARCH_URL, {
      params: {
        term: query,
        entity: entity,
        limit: limit,
        country: "US",
        media: "music",
      },
      timeout: 10000,
    })

    return response.data.results || []
  } catch (error) {
    console.error("Ошибка поиска iTunes:", error)
    throw error
  }
}

// Функция поиска популярных треков исполнителя через Last.fm (если API ключ доступен)
async function searchArtistTopTracks(artist, limit = 10) {
  if (!LASTFM_API_KEY || LASTFM_API_KEY === "your_lastfm_api_key_here") {
    // Если нет Last.fm API, используем iTunes
    return await searchMusicItunes(`${artist}`, "song", limit)
  }

  try {
    const response = await axios.get(LASTFM_API_URL, {
      params: {
        method: "artist.gettoptracks",
        artist: artist,
        api_key: LASTFM_API_KEY,
        format: "json",
        limit: limit,
      },
      timeout: 10000,
    })

    if (response.data.toptracks && response.data.toptracks.track) {
      return response.data.toptracks.track.map((track) => ({
        trackName: track.name,
        artistName: track.artist.name,
        playcount: track.playcount,
        url: track.url,
      }))
    }

    return []
  } catch (error) {
    console.error("Ошибка поиска Last.fm:", error)
    // Fallback на iTunes
    return await searchMusicItunes(`${artist}`, "song", limit)
  }
}

// Функция для форматирования результатов поиска
function formatSearchResults(results, searchType) {
  if (!results || results.length === 0) {
    return "❌ Ничего не найдено. Попробуйте изменить запрос."
  }

  let message = `🎵 Найдено ${results.length} результатов:\n\n`

  // Берем только первые 8 результатов и правильно их нумеруем
  const limitedResults = results.slice(0, 8)

  limitedResults.forEach((result, index) => {
    const number = index + 1

    if (result.trackName || result.trackCensoredName) {
      // iTunes результат
      const trackName = result.trackName || result.trackCensoredName || "Неизвестный трек"
      const artistName = result.artistName || "Неизвестный исполнитель"
      const albumName = result.collectionName || "Неизвестный альбом"
      const releaseDate = result.releaseDate ? new Date(result.releaseDate).getFullYear() : "Неизвестно"

      let duration = "Неизвестно"
      if (result.trackTimeMillis) {
        const minutes = Math.floor(result.trackTimeMillis / 60000)
        const seconds = Math.floor((result.trackTimeMillis % 60000) / 1000)
        duration = `${minutes}:${seconds.toString().padStart(2, "0")}`
      }

      message += `${number}. 🎵 **${trackName}**\n`
      message += `   👤 ${artistName}\n`
      message += `   💿 ${albumName} (${releaseDate})\n`
      message += `   ⏱ ${duration}\n`

      if (result.trackViewUrl) {
        message += `   🔗 [iTunes](${result.trackViewUrl})\n`
      }
      if (result.previewUrl) {
        message += `   🎧 [Превью 30сек](${result.previewUrl})\n`
      }
      message += `\n`
    } else if (result.playcount) {
      // Last.fm результат
      message += `${number}. 🎵 **${result.trackName}**\n`
      message += `   👤 ${result.artistName}\n`
      message += `   📊 Прослушиваний: ${Number.parseInt(result.playcount).toLocaleString()}\n`
      if (result.url) {
        message += `   🔗 [Last.fm](${result.url})\n`
      }
      message += `\n`
    }
  })

  if (results.length > 8) {
    message += `... и еще ${results.length - 8} результатов\n\n`
  }

  message += `💡 Совет: Для более точного поиска используйте формат "Исполнитель - Название"`

  return message
}

// Функция получения популярных треков
async function getPopularTracks() {
  try {
    // Поиск популярных треков разных жанров
    const genres = ["pop", "rock", "hip-hop", "electronic", "indie", "country", "r&b"]
    const randomGenre = genres[Math.floor(Math.random() * genres.length)]

    const results = await searchMusicItunes(randomGenre, "song", 20)

    // Фильтруем и сортируем результаты
    const filteredResults = results
      .filter((track) => track.trackName && track.artistName) // Убираем треки без названия
      .sort((a, b) => {
        // Сортируем по популярности (используем разные метрики)
        const aScore = (a.trackPrice || 0) + (a.collectionPrice || 0)
        const bScore = (b.trackPrice || 0) + (b.collectionPrice || 0)
        return bScore - aScore
      })

    return filteredResults.slice(0, 10)
  } catch (error) {
    console.error("Ошибка получения популярных треков:", error)
    throw error
  }
}

// Функция для конвертации аудио в нужный формат для распознавания
async function convertAudioForRecognition(inputPath, outputPath) {
  // Конвертируем в WAV 16kHz mono для лучшего распознавания
  const command = `ffmpeg -i "${inputPath}" -ar 16000 -ac 1 -f wav "${outputPath}" -y`
  console.log(`Конвертация аудио для распознавания: ${command}`)

  try {
    const { stdout, stderr } = await execPromise(command, { timeout: 60000 })
    console.log("Конвертация завершена успешно")
    return true
  } catch (error) {
    console.error("Ошибка конвертации аудио:", error)
    throw error
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
    "--limit-rate 10M",
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
    ["📥 Скачать видео", "🎵 Извлечь аудио"],
    ["🎶 Распознать музыку", "🔍 Поиск музыки"],
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

// Создание меню поиска музыки
function createMusicSearchMenu() {
  return Markup.keyboard([
    ["🎤 Поиск по исполнителю", "🎵 Поиск по названию"],
    ["🎼 Поиск по исполнителю + название", "🔥 Популярные треки"],
    ["🏠 Главное меню"],
  ]).resize()
}

// Команда /start - приветствие с меню
bot.start((ctx) => {
  const musicFeature = ACRCLOUD_CONFIG.access_key
    ? "• 🎶 Распознавание музыки как в Shazam\n• 🔍 Поиск музыки по исполнителю и названию"
    : "• 🔍 Поиск музыки по исполнителю и названию"

  const welcomeMessage = `
🎬 Добро пожаловать в многофункциональный бот!

🌟 Возможности:
• Автоматический выбор оптимального качества
• Контроль размера файлов
• Быстрая обработка
• Поддержка больших файлов
${musicFeature}

🌐 Поддерживаемые платформы:
YouTube, TikTok, Instagram, Twitter, Facebook, VK и 1000+ других!

👇 Выберите действие в меню ниже или отправьте ссылку на видео:`

  ctx.reply(welcomeMessage, createMainMenu())
})

// Команда помощи
bot.command("help", (ctx) => {
  const musicHelp = ACRCLOUD_CONFIG.access_key
    ? `
🎶 Распознавание музыки:
• Нажмите "🎶 Распознать музыку"
• Отправьте голосовое сообщение или аудиофайл
• Получите название трека и исполнителя

🔍 Поиск музыки:
• 🎤 Поиск по исполнителю - все песни артиста
• 🎵 Поиск по названию - найти конкретную песню  
• 🎼 Комбинированный поиск - исполнитель + название
• 🔥 Популярные треки - актуальные хиты`
    : `
🔍 Поиск музыки:
• 🎤 Поиск по исполнителю - все песни артиста
• 🎵 Поиск по названию - найти конкретную песню  
• 🎼 Комбинированный поиск - исполнитель + название
• 🔥 Популярные треки - актуальные хиты`

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
${musicHelp}

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
• Распознавание музыки: до 60 секунд

🌐 Поддерживаемые сайты:
YouTube, TikTok, Instagram, Twitter, Facebook, VK и многие другие!`

  ctx.reply(helpMessage, createMainMenu())
})

// Обработка голосовых сообщений
bot.on("voice", async (ctx) => {
  if (!ACRCLOUD_CONFIG.access_key) {
    return ctx.reply("❌ Функция распознавания музыки не настроена.", createMainMenu())
  }

  const session = userSessions.get(ctx.from.id) || {}

  if (session.action === "recognize_music") {
    await handleMusicRecognition(ctx, "voice")
  } else {
    ctx.reply(
      "🎶 Я получил голосовое сообщение!\n\n" +
        'Если хотите распознать музыку, нажмите "🎶 Распознать музыку" и отправьте голосовое сообщение снова.',
      createMainMenu(),
    )
  }
})

// Обработка аудиофайлов
bot.on("audio", async (ctx) => {
  if (!ACRCLOUD_CONFIG.access_key) {
    return ctx.reply("❌ Функция распознавания музыки не настроена.", createMainMenu())
  }

  const session = userSessions.get(ctx.from.id) || {}

  if (session.action === "recognize_music") {
    await handleMusicRecognition(ctx, "audio")
  } else {
    ctx.reply(
      "🎶 Я получил аудиофайл!\n\n" +
        'Если хотите распознать музыку, нажмите "🎶 Распознать музыку" и отправьте аудиофайл снова.',
      createMainMenu(),
    )
  }
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

  if (text === "🎶 Распознать музыку") {
    if (!ACRCLOUD_CONFIG.access_key) {
      return ctx.reply("❌ Функция распознавания музыки не настроена.", createMainMenu())
    }

    ctx.reply(
      "🎶 Режим распознавания музыки активирован!\n\n" +
        "📱 Отправьте голосовое сообщение или аудиофайл\n" +
        "🎵 Я определю название трека и исполнителя\n" +
        "⏱ Максимальная длительность: 60 секунд\n\n" +
        "💡 Для лучшего результата используйте качественную запись без шумов.",
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "recognize_music" })
    return
  }

  if (text === "🔍 Поиск музыки") {
    ctx.reply(
      "🔍 Выберите тип поиска музыки:\n\n" +
        "🎤 **Поиск по исполнителю** - найти все песни артиста\n" +
        "🎵 **Поиск по названию** - найти конкретную песню\n" +
        "🎼 **Комбинированный поиск** - исполнитель + название\n" +
        "🔥 **Популярные треки** - актуальные хиты\n\n" +
        "💡 Примеры запросов:\n" +
        "• По исполнителю: `Billie Eilish`\n" +
        "• По названию: `Shape of You`\n" +
        "• Комбинированный: `Ed Sheeran - Perfect`",
      createMusicSearchMenu(),
    )
    return
  }

  if (text === "🎤 Поиск по исполнителю") {
    ctx.reply(
      "🎤 Поиск по исполнителю активирован!\n\n" +
        "Отправьте имя исполнителя для поиска его популярных треков.\n\n" +
        "💡 Примеры:\n" +
        "• `Billie Eilish`\n" +
        "• `The Weeknd`\n" +
        "• `Моргенштерн`\n" +
        "• `Дима Билан`",
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "search_by_artist" })
    return
  }

  if (text === "🎵 Поиск по названию") {
    ctx.reply(
      "🎵 Поиск по названию трека активирован!\n\n" +
        "Отправьте название песни для поиска.\n\n" +
        "💡 Примеры:\n" +
        "• `Shape of You`\n" +
        "• `Bad Guy`\n" +
        "• `Мокрые кроссы`\n" +
        "• `Деспасито`",
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "search_by_title" })
    return
  }

  if (text === "🎼 Поиск по исполнителю + название") {
    ctx.reply(
      "🎼 Комбинированный поиск активирован!\n\n" +
        "Отправьте запрос в формате: `Исполнитель - Название`\n\n" +
        "💡 Примеры:\n" +
        "• `Ed Sheeran - Perfect`\n" +
        "• `Billie Eilish - Bad Guy`\n" +
        "• `Моргенштерн - Cadillac`\n" +
        "• `The Weeknd - Blinding Lights`",
      createMainMenu(),
    )
    userSessions.set(userId, { ...session, action: "search_combined" })
    return
  }

  if (text === "🔥 Популярные треки") {
    await handlePopularTracks(ctx)
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
    const musicHelp = ACRCLOUD_CONFIG.access_key
      ? `
🎶 <b>Распознавание музыки:</b>
• Нажмите "🎶 Распознать музыку"
• Отправьте голосовое сообщение или аудиофайл
• Получите название и исполнителя

🔍 <b>Поиск музыки:</b>
• 🎤 По исполнителю - все песни артиста
• 🎵 По названию - найти конкретную песню  
• 🎼 Комбинированный - исполнитель + название
• 🔥 Популярные треки`
      : `
🔍 <b>Поиск музыки:</b>
• 🎤 По исполнителю - все песни артиста
• 🎵 По названию - найти конкретную песню  
• 🎼 Комбинированный - исполнитель + название
• 🔥 Популярные треки`

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
${musicHelp}

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

  // Обработка выбора каче��тва
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

  // Обработка поисковых запросов
  if (session.action === "search_by_artist") {
    await handleMusicSearch(ctx, text, "artist")
    return
  }

  if (session.action === "search_by_title") {
    await handleMusicSearch(ctx, text, "title")
    return
  }

  if (session.action === "search_combined") {
    await handleMusicSearch(ctx, text, "combined")
    return
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

// Функция обработки поиска музыки
async function handleMusicSearch(ctx, query, searchType) {
  let processingMessage
  try {
    processingMessage = await ctx.reply("🔍 Ищу музыку... Это может занять до 10 секунд.")
  } catch (error) {
    console.error("Ошибка при отправке сообщения:", error)
    return
  }

  try {
    let results = []

    // Очищаем запрос от лишних символов
    const cleanQuery = query.trim().replace(/[^\w\s-]/g, "")

    if (!cleanQuery) {
      throw new Error("Пустой запрос")
    }

    switch (searchType) {
      case "artist":
        // Поиск по исполнителю
        results = await searchArtistTopTracks(cleanQuery, 10)
        break

      case "title":
        // Поиск по названию
        results = await searchMusicItunes(cleanQuery, "song", 10)
        break

      case "combined":
        // Комбинированный поиск
        results = await searchMusicItunes(cleanQuery, "song", 10)
        break

      default:
        results = await searchMusicItunes(cleanQuery, "song", 10)
    }

    const formattedResults = formatSearchResults(results, searchType)

    await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, formattedResults, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    })

    // Отправляем новое сообщение с меню
    await ctx.reply("Выберите действие:", createMainMenu())

    // Сбрасываем сессию после поиска
    userSessions.delete(ctx.from.id)
  } catch (error) {
    console.error("Ошибка при поиске музыки:", error)

    let errorMessage = "❌ Произошла ошибка при поиске музыки."

    if (error.message.includes("timeout")) {
      errorMessage = "❌ Превышено время ожидания. Попробуйте еще раз."
    } else if (error.message.includes("network")) {
      errorMessage = "❌ Проблема с сетью. Попробуйте позже."
    } else if (error.message.includes("Пустой запрос")) {
      errorMessage = "❌ Введите корректный поисковый запрос."
    }

    await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, errorMessage)
    await ctx.reply("Выберите действие:", createMainMenu())

    // Сбрасываем сессию при ошибке
    userSessions.delete(ctx.from.id)
  }
}

// Функция обработки популярных треков
async function handlePopularTracks(ctx) {
  let processingMessage
  try {
    processingMessage = await ctx.reply("🔥 Загружаю популярные треки...")
  } catch (error) {
    console.error("Ошибка при отправке сообщения:", error)
    return
  }

  try {
    const results = await getPopularTracks()
    const formattedResults = formatSearchResults(results, "popular")

    await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, formattedResults, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    })

    // Отправляем новое сообщение с меню
    await ctx.reply("Выберите действие:", createMainMenu())
  } catch (error) {
    console.error("Ошибка при получении популярных треков:", error)

    const errorMessage = "❌ Не удалось загрузить популярные треки. Попробуйте позже."

    await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, errorMessage)
    await ctx.reply("Выберите действие:", createMainMenu())
  }
}

// Функция обработки распознавания музыки
async function handleMusicRecognition(ctx, type) {
  let processingMessage
  try {
    processingMessage = await ctx.reply("🎶 Анализирую аудио... Это может занять до 30 секунд.")
  } catch (error) {
    console.error("Ошибка при отправке сообщения:", error)
    return
  }

  try {
    let fileId, duration
    if (type === "voice") {
      fileId = ctx.message.voice.file_id
      duration = ctx.message.voice.duration
    } else if (type === "audio") {
      fileId = ctx.message.audio.file_id
      duration = ctx.message.audio.duration
    }

    // Проверяем длительность
    if (duration > MAX_AUDIO_DURATION_FOR_RECOGNITION) {
      return ctx.reply(
        `❌ Аудио слишком длинное: ${duration} секунд\n` +
          `Максимальная длительность: ${MAX_AUDIO_DURATION_FOR_RECOGNITION} секунд\n\n` +
          `Отправьте более короткую запись.`,
        createMainMenu(),
      )
    }

    // Получаем файл от Telegram
    const file = await ctx.telegram.getFile(fileId)
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`

    // Скачиваем файл
    const timestamp = Date.now()
    const originalPath = path.join(tempDir, `original_${timestamp}.ogg`)
    const convertedPath = path.join(tempDir, `converted_${timestamp}.wav`)

    console.log(`Скачиваем аудио файл: ${fileUrl}`)

    const response = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "stream",
    })

    const writer = fs.createWriteStream(originalPath)
    response.data.pipe(writer)

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve)
      writer.on("error", reject)
    })

    // Обновляем сообщение
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        "🎶 Конвертирую аудио для распознавания...",
      )
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Конвертируем аудио для распознавания
    await convertAudioForRecognition(originalPath, convertedPath)

    // Читаем конвертированный файл
    const audioBuffer = fs.readFileSync(convertedPath)

    // Обновляем сообщение
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMessage.message_id,
        null,
        "🎶 Распознаю музыку через ACRCloud...",
      )
    } catch (editError) {
      console.log("Не удалось отредактировать сообщение")
    }

    // Распознаем музыку
    const result = await recognizeMusic(audioBuffer)

    console.log("Результат распознавания:", JSON.stringify(result, null, 2))

    // Очищаем временные файлы
    cleanupFiles(originalPath)
    cleanupFiles(convertedPath)

    // Обрабатываем результат
    if (result.status && result.status.code === 0 && result.metadata && result.metadata.music) {
      const music = result.metadata.music[0]
      const title = music.title || "Неизвестно"
      const artists = music.artists ? music.artists.map((a) => a.name).join(", ") : "Неизвестно"
      const album = music.album ? music.album.name : "Неизвестно"
      const releaseDate = music.release_date || "Неизвестно"
      const duration = music.duration_ms ? Math.round(music.duration_ms / 1000) : "Неизвестно"
      const score = result.status.score || 0

      // Форматируем длительность
      const durationFormatted =
        duration !== "Неизвестно"
          ? `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, "0")}`
          : "Неизвестно"

      const resultMessage = `
🎶 Музыка распознана!

🎵 **Название:** ${title}
👤 **Исполнитель:** ${artists}
💿 **Альбом:** ${album}
📅 **Год выпуска:** ${releaseDate}
⏱ **Длительность:** ${durationFormatted}
📊 **Точность:** ${Math.round(score)}%

${score >= 80 ? "✅ Высокая точность распознавания" : score >= 50 ? "⚠️ Средняя точность распознавания" : "❌ Низкая точность распознавания"}`

      await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, resultMessage, {
        parse_mode: "Markdown",
      })

      // Отправляем новое сообщение с меню
      await ctx.reply("Выберите действие:", createMainMenu())

      // Если есть внешние ссылки, добавляем их
      if (music.external_metadata) {
        let linksMessage = "\n🔗 **Ссылки:**\n"
        if (music.external_metadata.youtube) {
          linksMessage += `🎬 [YouTube](${music.external_metadata.youtube.vid})\n`
        }
        if (music.external_metadata.spotify) {
          linksMessage += `🎧 [Spotify](${music.external_metadata.spotify.track.external_urls.spotify})\n`
        }
        if (music.external_metadata.deezer) {
          linksMessage += `🎵 [Deezer](${music.external_metadata.deezer.track.link})\n`
        }

        if (linksMessage.length > 20) {
          await ctx.reply(linksMessage, { parse_mode: "Markdown", disable_web_page_preview: true })
        }
      }
    } else {
      // Музыка не распознана
      const errorCode = result.status ? result.status.code : "unknown"
      const errorMsg = result.status ? result.status.msg : "Неизвестная ошибка"

      let userMessage = "❌ Не удалось распознать музыку.\n\n"

      if (errorCode === 1001) {
        userMessage += "🔍 Музыка не найдена в базе данных.\n"
      } else if (errorCode === 2004) {
        userMessage += "⚠️ Аудио слишком короткое или некачественное.\n"
      } else if (errorCode === 3001) {
        userMessage += "📱 Проблема с аудиофайлом.\n"
      } else {
        userMessage += `🔧 Техническая ошибка: ${errorMsg}\n`
      }

      userMessage +=
        "\n💡 Советы для лучшего распознавания:\n" +
        "• Используйте качественную запись\n" +
        "• Минимизируйте фоновые шумы\n" +
        "• Длительность: 10-60 секунд\n" +
        "• Попробуйте другой фрагмент трека"

      await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, userMessage)
      await ctx.reply("Выберите действие:", createMainMenu())
    }

    // Сбрасываем сессию после распознавания
    userSessions.delete(ctx.from.id)
  } catch (error) {
    console.error("Ошибка при распознавании музыки:", error)

    let errorMessage = "❌ Произошла ошибка при распознавании музыки."

    if (error.message.includes("ACRCloud API ключи не настроены")) {
      errorMessage = "❌ Сервис распознавания музыки временно недоступен."
    } else if (error.message.includes("timeout")) {
      errorMessage = "❌ Превышено время ожидания. Попробуйте еще раз."
    } else if (error.message.includes("network")) {
      errorMessage = "❌ Проблема с сетью. Попробуйте позже."
    }

    await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, errorMessage)
    await ctx.reply("Выберите действие:", createMainMenu())

    // Сбрасываем сессию при ошибке
    userSessions.delete(ctx.from.id)
  }
}

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

    const { actualPath, sizeMB, quality: actualQuality, asDocument, platform } = result

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
    } else if (error.message.includes("TikTok") || error.message.includes("tiktok")) {
      errorMessage = "❌ Проблема с TikTok видео. Попробуйте другую ссылку или извлеките аудио."
    } else if (error.message.includes("format")) {
      errorMessage = "❌ Запрошенный формат недоступен. Попробуйте другое качество или извлеките аудио."
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

    // Скачиваем видео для аудио с учетом платформы
    const platform = detectPlatform(url)

    if (platform === "tiktok" || platform === "instagram") {
      // Для TikTok и Instagram используем простое скачивание
      await downloadVideoSimple(url, videoPath)
    } else {
      // Для остальных платформ используем качество 360p
      await downloadVideo(url, videoPath, "360")
    }

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
      parse_mode: "Markdown",
    })

    // Отправляем новое сообщение с меню
    await ctx.reply("Выберите действие:", createMainMenu())
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
  res.send("🤖 Multi-functional Telegram Bot with Music Recognition and Search is running!")
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
    console.log(`✅ Многофункциональный бот @${botInfo.username} успешно запущен!`)
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
