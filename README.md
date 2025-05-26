# 🎬 Telegram Video Downloader Bot

Telegram бот для скачивания видео и извлечения аудио с популярных платформ.

## 🌟 Возможности

- 📥 Скачивание видео в качестве до 720p
- 🎵 Извлечение аудио в формате MP3 (192 kbps)
- 🌐 Поддержка 1000+ сайтов (YouTube, TikTok, Instagram, Twitter и др.)
- 🚀 Быстрая обработка
- 💯 Полностью бесплатно и без ограничений

## 📋 Команды

- `/start` - Приветствие и инструкции
- `/help` - Справка по использованию
- `/video <ссылка>` - Скачать видео
- `/music <ссылка>` - Извлечь аудио в MP3

## 🛠 Установка и настройка

### 1. Создание Telegram бота

1. Найдите @BotFather в Telegram
2. Отправьте команду `/newbot`
3. Следуйте инструкциям для создания бота
4. Сохраните полученный токен

### 2. Локальная установка

\`\`\`bash
# Клонируйте репозиторий
git clone <your-repo-url>
cd telegram-video-downloader-bot

# Установите зависимости Node.js
npm install

# Установите системные зависимости (Ubuntu/Debian)
sudo apt update
sudo apt install python3 python3-pip ffmpeg

# Установите yt-dlp
pip3 install yt-dlp

# Создайте файл .env
cp .env.example .env
# Отредактируйте .env и добавьте ваш BOT_TOKEN
\`\`\`

### 3. Деплой на Railway

1. Зарегистрируйтесь на [Railway.app](https://railway.app)
2. Подключите ваш GitHub репозиторий
3. В настройках проекта добавьте переменную окружения:
   - `BOT_TOKEN` = ваш токен от @BotFather
4. Railway автоматически развернет ваш бот

### 4. Альтернативный деплой через Railway CLI

\`\`\`bash
# Установите Railway CLI
npm install -g @railway/cli

# Войдите в аккаунт
railway login

# Инициализируйте проект
railway init

# Добавьте переменную окружения
railway variables set BOT_TOKEN=your_bot_token_here

# Разверните проект
railway up
\`\`\`

## 🔧 Технические детали

### Зависимости

- **Node.js 18+** - Основная среда выполнения
- **telegraf** - Библиотека для работы с Telegram Bot API
- **yt-dlp** - Инструмент для скачивания видео
- **ffmpeg** - Обработка аудио и видео

### Ограничения

- Максимальный размер файла: 50 МБ (ограничение Telegram)
- Качество видео: до 720p (для экономии места)
- Качество аудио: 192 kbps MP3

### Поддерживаемые платформы

- YouTube (youtube.com, youtu.be)
- TikTok (tiktok.com)
- Instagram (instagram.com)
- Twitter/X (twitter.com, x.com)
- Facebook (facebook.com)
- VK (vk.com)
- И более 1000 других сайтов!

## 🐛 Устранение неполадок

### Проблема: "Команда yt-dlp не найдена"
\`\`\`bash
# Переустановите yt-dlp
pip3 install --upgrade yt-dlp
\`\`\`

### Проблема: "ffmpeg не установлен"
\`\`\`bash
# Ubuntu/Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg

# Windows
# Скачайте с https://ffmpeg.org/download.html
\`\`\`

### Проблема: "Видео недоступно"
- Проверьте, что видео публично доступно
- Убедитесь, что ссылка корректна
- Попробуйте другое видео

## 📝 Лицензия

MIT License - используйте свободно для любых целей.

## 🤝 Поддержка

Если у вас возникли вопросы или проблемы:
1. Проверьте раздел "Устранение неполадок"
2. Создайте Issue в GitHub репозитории
3. Убедитесь, что все зависимости установлены корректно

## 🔄 Обновления

Бот автоматически поддерживает новые сайты благодаря регулярным обновлениям yt-dlp.
