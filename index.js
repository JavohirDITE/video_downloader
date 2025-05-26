const { Telegraf } = require("telegraf")
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

// Функция для скачивания видео с помощью yt-dlp
async function downloadVideo(url, outputPath) {
  const command = `yt-dlp -f "best[height<=720]" --no-playlist -o "${outputPath}" "${url}"`
  console.log(`Выполняется команда: ${command}`)

  try {
    const { stdout, stderr } = await execPromise(command)
    console.log("yt-dlp stdout:", stdout)
    if (stderr) console.log("yt-dlp stderr:", stderr)
    return true
  } catch (error) {
    console.error("Ошибка yt-dlp:", error)
    throw error
  }
}

// Функция для извлечения аудио с помощью ffmpeg
async function extractAudio(videoPath, audioPath) {
  const command = `ffmpeg -i "${videoPath}" -vn -acodec mp3 -ab 192k "${audioPath}" -y`
  console.log(`Выполняется команда: ${command}`)

  try {
    const { stdout, stderr } = await execPromise(command)
    console.log("ffmpeg stdout:", stdout)
    if (stderr) console.log("ffmpeg stderr:", stderr)
    return true
  } catch (error) {
    console.error("Ошибка ffmpeg:", error)
    throw error
  }
}

// Команда /start - приветствие
bot.start((ctx) => {
  const welcomeMessage = `
🎬 Добро пожаловать в бот для скачивания видео и аудио!

📋 Доступные команды:
/video <ссылка> - скачать видео
/music <ссылка> - извлечь аудио в MP3

🌐 Поддерживаемые платформы:
• YouTube
• TikTok
• Instagram
• Twitter
• Facebook
• И многие другие!

💡 Пример использования:
/video https://www.youtube.com/watch?v=dQw4w9WgXcQ
/music https://www.youtube.com/watch?v=dQw4w9WgXcQ

⚡ Бот полностью бесплатный и без ограничений!
    `

  ctx.reply(welcomeMessage)
})

// Команда /help - справка
bot.help((ctx) => {
  const helpMessage = `
📖 Справка по использованию бота:

🎥 /video <ссылка> - Скачивает видео в качестве до 720p
🎵 /music <ссылка> - Извлекает аудио в формате MP3 (192 kbps)

✅ Поддерживаемые сайты:
• YouTube (youtube.com, youtu.be)
• TikTok (tiktok.com)
• Instagram (instagram.com)
• Twitter (twitter.com, x.com)
• Facebook (facebook.com)
• VK (vk.com)
• И более 1000 других сайтов!

⚠️ Примечания:
• Максимальный размер файла: 50 МБ (ограничение Telegram)
• Время обработки: 1-3 минуты в зависимости от размера
• Бот работает 24/7 и полностью бесплатен

🔧 Если возникли проблемы, попробуйте:
1. Проверить правильность ссылки
2. Убедиться, что видео доступно публично
3. Попробовать другую ссылку
    `

  ctx.reply(helpMessage)
})

// Обработка команды /video
bot.command("video", async (ctx) => {
  const args = ctx.message.text.split(" ")

  if (args.length < 2) {
    return ctx.reply(
      "❌ Пожалуйста, укажите ссылку на видео.\n\nПример: /video https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )
  }

  const url = args[1]

  if (!isValidUrl(url)) {
    return ctx.reply("❌ Неверный формат ссылки. Пожалуйста, укажите корректную ссылку.")
  }

  const processingMessage = await ctx.reply("⏳ Обрабатываю запрос... Это может занять несколько минут.")

  try {
    // Генерируем уникальное имя файла
    const timestamp = Date.now()
    const videoFileName = `video_${timestamp}.%(ext)s`
    const videoPath = path.join(tempDir, videoFileName)

    console.log(`Начинаем скачивание видео: ${url}`)

    // Скачиваем видео
    await downloadVideo(url, videoPath)

    // Ищем скачанный файл (yt-dlp автоматически определяет расширение)
    const files = fs.readdirSync(tempDir).filter((file) => file.startsWith(`video_${timestamp}`))

    if (files.length === 0) {
      throw new Error("Файл не найден после скачивания")
    }

    const actualVideoPath = path.join(tempDir, files[0])
    const fileStats = fs.statSync(actualVideoPath)
    const fileSizeMB = fileStats.size / (1024 * 1024)

    console.log(`Размер файла: ${fileSizeMB.toFixed(2)} МБ`)

    // Проверяем размер файла (ограничение Telegram - 50 МБ)
    if (fileSizeMB > 50) {
      cleanupFiles(actualVideoPath)
      return ctx.editMessageText(
        "❌ Файл слишком большой (более 50 МБ). Попробуйте видео покороче или используйте команду /music для извлечения только аудио.",
      )
    }

    await ctx.editMessageText("📤 Отправляю видео...")

    // Отправляем видео пользователю
    await ctx.replyWithVideo(
      { source: actualVideoPath },
      {
        caption: "✅ Видео успешно скачано!",
      },
    )

    // Удаляем временный файл
    cleanupFiles(actualVideoPath)

    // Удаляем сообщение о процессе
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка при обработке видео:", error)

    let errorMessage = "❌ Произошла ошибка при скачивании видео."

    if (error.message.includes("Video unavailable")) {
      errorMessage = "❌ Видео недоступно. Возможно, оно приватное или удалено."
    } else if (error.message.includes("Unsupported URL")) {
      errorMessage = "❌ Данный сайт не поддерживается. Попробуйте другую ссылку."
    } else if (error.message.includes("network")) {
      errorMessage = "❌ Проблемы с сетью. Попробуйте позже."
    }

    await ctx.editMessageText(errorMessage)
  }
})

// Обработка команды /music
bot.command("music", async (ctx) => {
  const args = ctx.message.text.split(" ")

  if (args.length < 2) {
    return ctx.reply(
      "❌ Пожалуйста, укажите ссылку на видео для извлечения аудио.\n\nПример: /music https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )
  }

  const url = args[1]

  if (!isValidUrl(url)) {
    return ctx.reply("❌ Неверный формат ссылки. Пожалуйста, укажите корректную ссылку.")
  }

  const processingMessage = await ctx.reply("⏳ Скачиваю видео и извлекаю аудио... Это может занять несколько минут.")

  try {
    // Генерируем уникальные имена файлов
    const timestamp = Date.now()
    const videoFileName = `video_${timestamp}.%(ext)s`
    const videoPath = path.join(tempDir, videoFileName)
    const audioPath = path.join(tempDir, `audio_${timestamp}.mp3`)

    console.log(`Начинаем скачивание видео для аудио: ${url}`)

    // Скачиваем видео
    await downloadVideo(url, videoPath)

    // Ищем скачанный файл
    const files = fs.readdirSync(tempDir).filter((file) => file.startsWith(`video_${timestamp}`))

    if (files.length === 0) {
      throw new Error("Файл не найден после скачивания")
    }

    const actualVideoPath = path.join(tempDir, files[0])

    await ctx.editMessageText("🎵 Извлекаю аудио...")

    // Извлекаем аудио
    await extractAudio(actualVideoPath, audioPath)

    const audioStats = fs.statSync(audioPath)
    const audioSizeMB = audioStats.size / (1024 * 1024)

    console.log(`Размер аудио файла: ${audioSizeMB.toFixed(2)} МБ`)

    // Проверяем размер аудио файла
    if (audioSizeMB > 50) {
      cleanupFiles(actualVideoPath)
      cleanupFiles(audioPath)
      return ctx.editMessageText("❌ Аудио файл слишком большой (более 50 МБ). Попробуйте видео покороче.")
    }

    await ctx.editMessageText("📤 Отправляю аудио...")

    // Отправляем аудио пользователю
    await ctx.replyWithAudio(
      { source: audioPath },
      {
        caption: "✅ Аудио успешно извлечено!",
        title: `Audio_${timestamp}`,
        performer: "Video Downloader Bot",
      },
    )

    // Удаляем временные файлы
    cleanupFiles(actualVideoPath)
    cleanupFiles(audioPath)

    // Удаляем сообщение о процессе
    await ctx.deleteMessage(processingMessage.message_id)
  } catch (error) {
    console.error("Ошибка при обработке аудио:", error)

    let errorMessage = "❌ Произошла ошибка при извлечении аудио."

    if (error.message.includes("Video unavailable")) {
      errorMessage = "❌ Видео недоступно. Возможно, оно приватное или удалено."
    } else if (error.message.includes("Unsupported URL")) {
      errorMessage = "❌ Данный сайт не поддерживается. Попробуйте другую ссылку."
    } else if (error.message.includes("network")) {
      errorMessage = "❌ Проблемы с сетью. Попробуйте позже."
    }

    await ctx.editMessageText(errorMessage)
  }
})

// Обработка неизвестных команд
bot.on("text", (ctx) => {
  const text = ctx.message.text

  // Если сообщение начинается с /, но это не известная команда
  if (text.startsWith("/")) {
    return ctx.reply("❌ Неизвестная команда. Используйте /help для просмотра доступных команд.")
  }

  // Если пользователь отправил просто ссылку
  if (isValidUrl(text)) {
    return ctx.reply(
      "💡 Я вижу, что вы отправили ссылку! Используйте команды:\n\n/video " +
        text +
        " - для скачивания видео\n/music " +
        text +
        " - для извлечения аудио",
    )
  }

  // Для любого другого текста
  ctx.reply("❓ Я не понимаю это сообщение. Используйте /help для просмотра доступных команд.")
})

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error("Ошибка бота:", err)
  if (ctx) {
    ctx.reply("❌ Произошла внутренняя ошибка. Попробуйте позже.")
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

// Настройка webhook для Railway
app.use(express.json())

// Health check endpoint
app.get('/', (req, res) => {
  res.send('🤖 Telegram Video Downloader Bot is running!')
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
    console.log(`✅ Бот @${botInfo.username} успешно запущен!`)
    
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
