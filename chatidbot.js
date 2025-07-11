const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot('8094771791:AAEVaOjbxIXHvj_brT6w8EeieM7ZVij-Z-E', { polling: true });

bot.on('message', (msg) => {
  console.log('💬 Mensagem recebida!');
  console.log('🔹 Tipo:', msg.chat.type);
  console.log('🔹 Título:', msg.chat.title);
  console.log('🔹 chat.id:', msg.chat.id);
});