import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Инициализируем переменные окружения из файла .env
dotenv.config();

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('Ошибка: Токен бота не задан в файле .env');
    process.exit(1);
}

const bot = new Telegraf(token);

// Определяем пути для сохранения временных файлов
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Список поддерживаемых расширений и MIME-типов
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Гарантируем наличие папки uploads при старте бота
try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
} catch (err) {
    console.error('Не удалось создать папку для загрузок:', err);
}

// Вспомогательная функция для форматирования размера файла
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 1. Обработка команды /start с красивой HTML-разметкой
bot.command('start', async (ctx) => {
    const welcomeMessage = 
        `🖼 <b>Добро пожаловать!</b>\n\n` +
        `Отправьте мне фотографию или изображение, и я загружу его в облачное хранилище.\n\n` +
        `После загрузки вы получите прямую ссылку на изображение.`;
    
    await ctx.replyWithHTML(welcomeMessage);
});

// Обработчик медиа-файлов (Фотографии и Документы)
bot.on(['photo', 'document'], async (ctx) => {
    let fileId;
    let fileSize;
    let fileName = 'image.jpg';
    let fileExt = 'jpg';
    let mimeType = 'image/jpeg';
    
    const isDocument = !!ctx.message.document;

    if (isDocument) {
        const doc = ctx.message.document;
        fileId = doc.file_id;
        fileSize = doc.file_size;
        fileName = doc.file_name || 'image.jpg';
        fileExt = fileName.split('.').pop().toLowerCase();
        mimeType = doc.mime_type;

        // Валидация формата для документов
        if (!ALLOWED_EXTENSIONS.includes(fileExt) && !ALLOWED_MIME_TYPES.includes(mimeType)) {
            return ctx.reply('❌ Пожалуйста, отправьте фотографию или файл изображения.');
        }
    } else {
        // Если отправлено как фото, Telegram сжимает его и отдаёт массив вариантов. Берем самый крупный.
        const photoArray = ctx.message.photo;
        const largestPhoto = photoArray[photoArray.length - 1];
        fileId = largestPhoto.file_id;
        fileSize = largestPhoto.file_size;
        fileExt = 'jpg'; // Сжатые фото Telegram всегда приводит к JPG
    }

    // 4. Отправка сообщения о начале загрузки
    const loadingMessage = await ctx.reply('⏳ Загружаю изображение...', {
        reply_to_message_id: ctx.message.message_id
    });

    const tempFilePath = path.join(UPLOADS_DIR, `${fileId}.${fileExt}`);

    try {
        // Получаем прямую ссылку на скачивание файла с серверов Telegram
        const fileLink = await ctx.telegram.getFileLink(fileId);
        
        // Скачиваем файл во временную директорию
        const response = await fetch(fileLink.href);
        if (!response.ok) throw new Error('Не удалось скачать файл из Telegram');
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        await fs.writeFile(tempFilePath, buffer);

        // Формируем FormData для отправки в облачное хранилище tmpfiles.org
        const formData = new FormData();
        const fileBlob = new Blob([buffer], { type: mimeType });
        formData.append('file', fileBlob, fileName);

        // Отправляем файл в облако
        const uploadResponse = await fetch('https://tmpfiles.org/api/v1/upload', {
            method: 'POST',
            body: formData
        });

        if (!uploadResponse.ok) throw new Error('Ошибка при ответе облачного хранилища');

        const uploadData = await uploadResponse.json();
        
        // Трансформируем обычную ссылку просмотра в прямую ссылку скачивания (добавляем /dl/)
        const viewUrl = uploadData.data.url;
        const directLink = viewUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');

        // Форматируем метаданные для ответа
        const formattedSize = formatBytes(fileSize);
        const formattedFormat = fileExt.toUpperCase();

        // Формируем финальный красивый ответ
        const successMessage = 
            `✅ <b>Изображение успешно загружено!</b>\n\n` +
            `📄 <b>Формат:</b> ${formattedFormat}\n` +
            `📦 <b>Размер:</b> ${formattedSize}\n\n` +
            `🔗 <b>Прямая ссылка:</b>\n${directLink}`;

        // Изменяем текст загрузочного сообщения на финальный результат
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            loadingMessage.message_id,
            null,
            successMessage,
            { parse_mode: 'HTML', disable_web_page_preview: false }
        );

    } catch (error) {
        console.error('Ошибка в процессе обработки:', error);

        // 6. Если произошла ошибка, уведомляем пользователя и убираем лоадер
        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMessage.message_id);
        } catch (delError) {
            // Игнорируем ошибку удаления, если сообщение уже пропало
        }
        await ctx.reply('❌ Произошла ошибка при загрузке изображения. Попробуйте позже.');
    } finally {
        // Обязательно очищаем за собой локальный файл, чтобы не забивать диск
        try {
            await fs.unlink(tempFilePath);
        } catch (err) {
            // Файл мог не создаться, если падение произошло до записи
        }
    }
});

// 5. Обработка любых других типов сообщений (текст, стикеры, голосовые и т.д.)
bot.on('message', async (ctx) => {
    await ctx.reply('❌ Пожалуйста, отправьте фотографию или файл изображения.');
});

// Мягкий запуск бота (Long Polling)
bot.launch(() => {
    console.log('🚀 Робот успешно запущен и готов принимать изображения!');
});

// Корректная остановка при завершении процесса сервера
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
