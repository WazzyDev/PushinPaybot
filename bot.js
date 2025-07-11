const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const QRCode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const logoPath = path.join(__dirname, 'media', 'logo.jpg'); // ✅ imagem usada na mensagem 3
const config = require('./config.json');

const bot = new TelegramBot(config.telegramToken, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

const paymentsMap = new Map();

console.log("🤖 Bot iniciado com sucesso!");

app.use(bodyParser.json());

function parsePriceToCents(priceStr) {
  const normalized = priceStr.replace(',', '.').trim();
  const floatValue = parseFloat(normalized);
  if (isNaN(floatValue)) throw new Error('Preço inválido: ' + priceStr);
  return Math.round(floatValue * 100);
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const painelMessage = 
    "🔥 *Painel do 7* chegou pra revolucionar! 🔥\n\n" +
    "👉 *Fake Nubank* — Crie contas falsas top de linha!\n" +
    "👉 *Método Lara* — Técnica avançada para resultados seguros.\n" +
    "👉 *Método CC* — Estratégia focada em cartões de crédito.\n" +
    "👉 *Método Virada de Saldo* — Multiplique seu saldo rápido!\n\n" +
    "Tudo isso reunido num painel simples e prático. Não perde tempo, vem aproveitar!";

  const logoPath = path.join(__dirname, 'media', 'logo.jpg');

  await bot.sendPhoto(chatId, logoPath, {
    caption: painelMessage,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: Object.entries(config.plans).map(([key, plan]) => ([{
        text: `${plan.name} (R$${plan.price})`,
        callback_data: key
      }]))
    }
  });
});

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const dataCallback = callbackQuery.data;

  if (dataCallback.startsWith('check_')) {
    const paymentId = dataCallback.split('_')[1];
    try {
      const res = await fetch(`https://api.pushinpay.com.br/api/transactions/${paymentId}`, {
        method: 'GET',
        headers: {
          "Authorization": `Bearer ${config.pushinpayToken}`,
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      if (!res.ok) throw new Error(`Erro HTTP: ${res.status}`);
      const paymentStatus = await res.json();

      await bot.answerCallbackQuery(callbackQuery.id);

      let statusMsg = '';
      if (paymentStatus.status === 'CONFIRMED' || paymentStatus.status === 'PAID') {
        statusMsg = '✅ Pagamento confirmado!';
      } else if (paymentStatus.status === 'created' || paymentStatus.status === 'pending') {
        statusMsg = '⏳ Pagamento ainda não confirmado.';
      } else {
        statusMsg = `❌ Status do pagamento: ${paymentStatus.status}`;
      }

      await bot.sendMessage(chatId, statusMsg);
    } catch (error) {
      console.error('Erro ao consultar status:', error);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Erro ao consultar status. Tente mais tarde.' });
    }
    return;
  }

  const planKey = dataCallback;
  if (!(planKey in config.plans)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Plano inválido." });
    return;
  }

  const plan = config.plans[planKey];
  let priceInCents;
  try {
    priceInCents = parsePriceToCents(plan.price);
  } catch (e) {
    console.error(e);
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Preço do plano inválido." });
    return;
  }

  try {
    const response = await fetch("https://api.pushinpay.com.br/api/pix/cashIn", {
      method: 'POST',
      headers: {
        "Authorization": `Bearer ${config.pushinpayToken}`,
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        value: priceInCents,
        webhook_url: config.webhookUrl,
        split_rules: []
      })
    });

    if (!response.ok) throw new Error(`Erro HTTP: ${response.status}`);
    const data = await response.json();

    const pixCode = data.pix_code || data.payload || data.qr_code || '';

    paymentsMap.set(data.id, { chatId, planKey });

    // Envia webhook ao criar pagamento
    try {
      await fetch(config.customWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId: data.id,
          chatId: chatId,
          planKey: planKey,
          planName: plan.name,
          price: plan.price,
          createdAt: new Date().toISOString()
        })
      });
    } catch (err) {
      console.error('Erro ao enviar webhook customizado:', err);
    }

    await bot.answerCallbackQuery(callbackQuery.id, { text: `Pagamento para ${plan.name} gerado!` });

    if (pixCode) {
      const qrBuffer = await QRCode.toBuffer(pixCode, { type: 'png' });

      const caption = `
🧾 Pagamento gerado com sucesso!

🎁 Plano: ${plan.name}
💰 Valor: R$${plan.price}

💳 Chave Pix (copia e cola):
${pixCode}

📸 Escaneie o QR Code acima com seu aplicativo bancário.

⚠️ Após o pagamento, clique no botão abaixo para verificar se já foi confirmado.
`;

      const checkStatusKeyboard = {
        inline_keyboard: [[
          { text: "🔄 Verificar pagamento", callback_data: `check_${data.id}` }
        ]]
      };

      await bot.sendPhoto(chatId, qrBuffer, {
        caption,
        reply_markup: checkStatusKeyboard
      });
    }

  } catch (error) {
    console.error('Erro ao criar pagamento:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Erro ao gerar pagamento, tente novamente." });
  }
});

async function notifyPaymentConfirmed(paymentId, paymentData) {
  const { chatId, planKey } = paymentData;
  const plan = config.plans[planKey];
  const message = `✅ Pagamento confirmado!\nPlano: ${plan.name}\nID: ${paymentId}\nObrigado pela sua compra.`;

  if (chatId) await bot.sendMessage(chatId, message);
  if (config.telegramAnnouncementChannelId)
    await bot.sendMessage(config.telegramAnnouncementChannelId, message);
  if (config.discordWebhookUrl) {
    await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
  }
}

app.post('/webhook', (req, res) => {
  const notification = req.body;
  console.log('Webhook recebido:', notification);

  const paymentId = notification.id || notification.paymentId || notification.payment_id;
  if (!paymentId) return res.status(400).send('No payment id');

  if (notification.status === 'CONFIRMED') {
    const paymentData = paymentsMap.get(paymentId);
    if (paymentData) {
      notifyPaymentConfirmed(paymentId, paymentData);
      paymentsMap.delete(paymentId);
    }
  }

  res.status(200).send('OK');
});


const tecladoMsg3 = {
  outline_keyboard: [[
    { text: config.botao1.texto, url: config.botao1.url },
    { text: config.botao2.texto, url: config.botao2.url },
    { text: config.botao3.texto, url: config.botao3.url }
  ]]
};

// ✅ Envio automático de mensagens
if (config.autoMessageChatId) {
  // ------------------ Mensagem 1 ------------------
  setTimeout(() => {
    // dispara a primeira vez
    bot.sendPhoto(
      config.autoMessageChatId,
      logoPath,
      {
        caption: config.mensagem1 || '⏰ Mensagem 1 (a cada 1 min)',
        parse_mode: 'Markdown',
        reply_markup: tecladoMsg3
      }
    );

    // dispara de 1 em 1 minuto depois disso
    setInterval(() => {
      bot.sendPhoto(
        config.autoMessageChatId,
        logoPath,
        {
          caption: config.mensagem1 || '⏰ Mensagem 1 (a cada 1 min)',
          parse_mode: 'Markdown',
          reply_markup: tecladoMsg3
        }
      );
    }, 1 * 60 * 1000); // 1 min
  }, 1 * 60 * 1000);     // primeiro disparo em 1 min

  // ------------------ Mensagem 2 ------------------
  setTimeout(() => {
    bot.sendPhoto(
      config.autoMessageChatId,
      logoPath,
      {
        caption: config.mensagem2 || '📢 Mensagem 2 (a cada 2 min)',
        parse_mode: 'Markdown',
        reply_markup: tecladoMsg3
      }
    );

    setInterval(() => {
      bot.sendPhoto(
        config.autoMessageChatId,
        logoPath,
        {
          caption: config.mensagem2 || '📢 Mensagem 2 (a cada 2 min)',
          parse_mode: 'Markdown',
          reply_markup: tecladoMsg3
        }
      );
    }, 2 * 60 * 1000); // 2 min
  }, 2 * 60 * 1000);     // primeiro disparo em 2 min

  // ------------------ Mensagem 3 ------------------
  setTimeout(() => {
    bot.sendPhoto(
      config.autoMessageChatId,
      logoPath,
      {
        caption: config.mensagem3 || '🔥 Mensagem 3 (a cada 3 min)',
        parse_mode: 'Markdown',
        reply_markup: tecladoMsg3
      }
    );

    setInterval(() => {
      bot.sendPhoto(
        config.autoMessageChatId,
        logoPath,
        {
          caption: config.mensagem3 || '🔥 Mensagem 3 (a cada 3 min)',
          parse_mode: 'Markdown',
          reply_markup: tecladoMsg3
        }
      );
    }, 3 * 60 * 1000); // 3 min
  }, 3 * 60 * 1000);     // primeiro disparo em 3 min
}

app.listen(PORT, () => {
  console.log(`Servidor webhook rodando na porta ${PORT}`);
});
