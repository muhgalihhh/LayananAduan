const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Ganti dengan URL Google Apps Script yang sudah di-deploy
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxgqXAT7Bk6VelB7VKHGLYMBSyjVcu-GwdbFejtRPKB397I-DNgUips2KyBA9qvVM-9Vw/exec';

// State management untuk percakapan
const conversationState = new Map();

// Template pesan untuk setiap langkah
const messages = {
  welcome: `Selamat datang di Bot WhatsApp Layanan Pengaduan!\n\nSilakan pilih menu:\n1️⃣ Tambah Pengaduan Baru\n2️⃣ Cek Status Pengaduan\n\nKetik angka pilihan Anda.`,
  askName: 'Mohon masukkan nama lengkap Anda:',
  askComplaint: 'Silakan jelaskan keluhan atau pengaduan Anda secara detail:',
  askPhoto: 'Apakah Anda ingin melampirkan foto?\nKetik *Ya* atau *Tidak*',
  photoInstruction: 'Silakan kirim foto yang ingin Anda lampirkan.',
  confirmComplaint: (data) =>
    `Mohon konfirmasi pengaduan Anda:\n\nNama: ${data.nama}\nNo. WhatsApp: ${data.whatsapp}\nKeluhan: ${data.keluhan}\nFoto: ${
      data.foto ? 'Terlampir' : 'Tidak ada'
    }\n\nKetik *Ya* untuk konfirmasi atau *Tidak* untuk membatalkan.`,
  success: (idKeluhan) => `✅ Pengaduan berhasil dicatat!\n\nID Pengaduan: ${idKeluhan}\nUntuk mengecek status pengaduan, pilih menu "Cek Status Pengaduan"`,
  cancelled: 'Pengaduan dibatalkan. Ketik apa saja untuk memulai kembali.',
  error: 'Maaf, terjadi kesalahan dalam sistem. Silakan coba lagi nanti.',
};

// Fungsi untuk menyimpan file media
async function saveMedia(buffer, extension) {
  const fileName = `media_${Date.now()}.${extension}`;
  const filePath = path.join(__dirname, 'uploads', fileName);

  // Buat folder uploads jika belum ada
  if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
    fs.mkdirSync(path.join(__dirname, 'uploads'));
  }

  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const messageType = Object.keys(msg.message)[0];
    let messageContent;
    let imageUrl = '';

    try {
      // Handle different message types
      if (messageType === 'imageMessage' && msg.message.imageMessage) {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: console,
            reuploadRequest: sock.updateMediaMessage,
          }
        );

        // Simpan file
        const extension = msg.message.imageMessage.mimetype.split('/')[1];
        const filePath = await saveMedia(buffer, extension);
        imageUrl = filePath; // Gunakan path file sebagai URL sementara
        messageContent = msg.message.imageMessage.caption || '';
      } else {
        messageContent = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
      }

      await handleMessage(sock, sender, messageContent, msg, imageUrl);
    } catch (error) {
      console.error('Error handling message:', error);
      await sock.sendMessage(sender, { text: messages.error });
    }
  });
}

async function handleMessage(sock, sender, messageText, msg, imageUrl = '') {
  let state = conversationState.get(sender) || {
    step: 'start',
    data: {
      nama: '',
      whatsapp: sender.split('@')[0],
      keluhan: '',
      foto: '',
    },
  };

  const reply = async (text) => {
    await sock.sendMessage(sender, { text });
  };

  try {
    switch (state.step) {
      case 'start':
        await reply(messages.welcome);
        state.step = 'menu_selection';
        break;

      case 'menu_selection':
        if (messageText === '1') {
          await reply(messages.askName);
          state.step = 'waiting_name';
        } else if (messageText === '2') {
          console.log('Checking complaints');
          await checkComplaints(sock, sender);
          state.step = 'start';
        } else {
          await reply(messages.welcome);
        }
        break;

      case 'waiting_name':
        state.data.nama = messageText;
        await reply(messages.askComplaint);
        state.step = 'waiting_complaint';
        break;

      case 'waiting_complaint':
        state.data.keluhan = messageText;
        await reply(messages.askPhoto);
        state.step = 'waiting_photo_confirmation';
        break;

      case 'waiting_photo_confirmation':
        if (messageText.toLowerCase() === 'ya') {
          await reply(messages.photoInstruction);
          state.step = 'waiting_photo';
        } else {
          await reply(messages.confirmComplaint(state.data));
          state.step = 'waiting_final_confirmation';
        }
        break;

      case 'waiting_photo':
        if (imageUrl) {
          state.data.foto = imageUrl;
          await reply(messages.confirmComplaint(state.data));
          state.step = 'waiting_final_confirmation';
        }
        break;

      case 'waiting_final_confirmation':
        if (messageText.toLowerCase() === 'ya') {
          const response = await axios.post(GOOGLE_SCRIPT_URL, {
            action: 'addAduan',
            ...state.data,
          });

          if (response.data.success) {
            await reply(messages.success(response.data.idKeluhan));
          } else {
            await reply(messages.error);
          }
        } else {
          await reply(messages.cancelled);
        }
        state = { step: 'start', data: {} };
        break;
    }
  } catch (error) {
    console.error('Error:', error);
    await reply(messages.error);
    state = { step: 'start', data: {} };
  }

  conversationState.set(sender, state);
}

async function checkComplaints(sock, sender) {
  const phoneNumber = sender.split('@')[0];

  try {
    const response = await axios.get(`${GOOGLE_SCRIPT_URL}?action=checkAduan&whatsapp=${phoneNumber}`);

    if (response.data.success && response.data.data.length > 0) {
      let message = `*Daftar Pengaduan Anda (${phoneNumber}):*\n\n`;
      response.data.data.forEach((aduan, index) => {
        message += `${index + 1}. ID: ${aduan.idKeluhan}\n`;
        message += `   Tanggal: ${aduan.tanggal}\n`;
        message += `   Keluhan: ${aduan.keluhan}\n`;
        message += `   Status: ${aduan.status}\n\n`;
      });
      await sock.sendMessage(sender, { text: message });
    } else {
      await sock.sendMessage(sender, { text: `${phoneNumber} Anda belum memiliki pengaduan yang tercatat.` });
    }
  } catch (error) {
    await sock.sendMessage(sender, { text: 'Maaf, terjadi kesalahan saat mengecek pengaduan.' });
  }
}

// Menjalankan bot
connectToWhatsApp();
