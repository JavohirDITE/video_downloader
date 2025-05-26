# Используем официальный образ Node.js
FROM node:18-slim

# Устанавливаем системные зависимости
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем последнюю версию yt-dlp
RUN pip3 install --break-system-packages --upgrade yt-dlp

# Создаем рабочую директорию
WORKDIR /app

# Копируем package.json
COPY package*.json ./

# Устанавливаем зависимости Node.js
RUN npm install --only=production

# Копируем исходный код
COPY . .

# Создаем папку для временных файлов
RUN mkdir -p temp

# Открываем порт
EXPOSE 3000

# Запускаем приложение
CMD ["npm", "start"]
