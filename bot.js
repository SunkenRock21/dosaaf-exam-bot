require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const storage = require('./storage');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : 0;
if (!BOT_TOKEN) { console.error('Ошибка: задайте BOT_TOKEN в .env'); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const sessions = new Map();
(async () => { await storage.initStorage(); console.log('Storage initialized at', storage.DATA_FILE); })();

const isAdmin = id => ADMIN_ID && Number(id) === Number(ADMIN_ID);
function formatExamDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const datePart = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }).format(d).replace(' г.', ' года');
    const timePart = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `${datePart} в ${timePart}`;
  } catch (e) { return iso; }
}
function tryParseDate(s) {
  if (!s) return null;
  const dm = /^(\d{1,2})[\.:](\d{1,2})[\.:](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/;
  const m = s.match(dm);
  if (m) {
    const day = m[1].padStart(2,'0'), month = m[2].padStart(2,'0'), year = m[3];
    const hh = m[4] ? m[4].padStart(2,'0') : '00', mm = m[5] || '00';
    const iso = `${year}-${month}-${day}T${hh}:${mm}:00`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  const alt = s.length === 10 ? s + 'T00:00:00' : s.replace(' ', 'T');
  const d2 = new Date(alt);
  return isNaN(d2.getTime()) ? null : d2;
}

async function sendInvitation(rec, examIso) {
  const human = formatExamDate(examIso);
  const text = `Приглашение на экзамен:\n\nФИО: ${rec.fullName}\nДата и время: ${human}\nПожалуйста, приходите за 10 минут до начала.`;
  const opts = { reply_markup: { inline_keyboard: [[ { text: 'Подтвердить получение', callback_data: `confirm_${rec.id}` } ]] } };
  await bot.sendMessage(rec.chatId, text, opts);
  await storage.markInvited(rec.id);
}

const adminKeyboard = { reply_markup: { keyboard: [['Меню админа'], ['Список заявок','Назначить экзамен'], ['Разослать всем','Разослать по ID'], ['Очистить список','Удалить участников'], ['Скачать список']], resize_keyboard: true, one_time_keyboard: false } };

const userKeyboard = { reply_markup: { keyboard: [['Записаться на экзамен']], resize_keyboard: true, one_time_keyboard: false } };

bot.onText(/\/start/, (m) => {
  try {
    if (isAdmin(m.from.id)) {
      return bot.sendMessage(m.chat.id, 'Панель администратора.', adminKeyboard);
    }
    return bot.sendMessage(m.chat.id, 'Привет! Я бот для регистрации на экзамен. Используйте кнопку "Записаться на экзамен" или введите /register для начала.', userKeyboard);
  } catch (e) {
    console.error('Ошибка в /start handler', e);
  }
});

function beginRegistration(msg) {
  const chatId = msg.chat.id;
  if (isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Профиль администратора не может отправлять заявки.');
  sessions.set(chatId, { step: 'full_name', data: {} });
  bot.sendMessage(chatId, 'Введите ФИО (полностью):', { reply_markup: { keyboard: [['Отмена']], one_time_keyboard: true, resize_keyboard: true } });
}
bot.onText(/^Записаться на экзамен$/i, beginRegistration);
bot.onText(/\/register/, beginRegistration);

bot.onText(/^Меню админа$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Команда доступна только администратору.');
  const opts = { reply_markup: { inline_keyboard: [ [ { text: 'Список заявок', callback_data: 'cmd_list' } ], [ { text: 'Назначить экзамен', callback_data: 'cmd_set_exam' } ], [ { text: 'Разослать всем', callback_data: 'cmd_invite_all' }, { text: 'Разослать по ID', callback_data: 'cmd_invite_by_id' } ], [ { text: 'Очистить список', callback_data: 'cmd_clear_list' }, { text: 'Удалить участников', callback_data: 'cmd_delete_by_id' } ], [ { text: 'Скачать список', callback_data: 'cmd_download_list' } ] ] } };
  await bot.sendMessage(msg.chat.id, 'Меню админа:', opts);
});

bot.onText(/^Список заявок$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Команда доступна только администратору.');
  const rows = await storage.getRegistrations();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Заявок пока нет.', adminKeyboard);
  const lines = rows.map(r => `${r.id} | ${r.fullName} | ${r.phone} | попытка ${r.attempt} | приглашён:${r.invited?1:0}`);
  await bot.sendMessage(msg.chat.id, 'Список заявок:\n' + lines.join('\n'), adminKeyboard);
});

bot.onText(/^Назначить экзамен$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Команда доступна только администратору.');
  sessions.set(msg.chat.id, { step: 'set_exam', data: {} });
  await bot.sendMessage(msg.chat.id, 'Отправьте дату и время экзамена в удобном формате: DD.MM.YYYY HH:MM или YYYY-MM-DD HH:MM', adminKeyboard);
});

bot.onText(/^Разослать всем$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Команда доступна только администратору.');
  const examDt = await storage.getSetting('exam_datetime'); if (!examDt) return bot.sendMessage(msg.chat.id, 'Дата экзамена не установлена.', adminKeyboard);
  const targets = await storage.getRegistrations(); if (!targets.length) return bot.sendMessage(msg.chat.id, 'Не найдено ни одной регистрации.', adminKeyboard);
  const sent = [];
  for (const r of targets) { try { await sendInvitation(r, examDt); sent.push(`${r.fullName} (ID:${r.id})`); } catch (e) { console.error('sendInvitation error', e); } }
  if (sent.length) {
    await storage.setPendingRemovalRequests(msg.chat.id, targets.map(r => r.id));
    const opts = { reply_markup: { inline_keyboard: [[ { text: 'Удалить приглашённых участников', callback_data: 'remove_invited_confirm' }, { text: 'Оставить', callback_data: 'remove_invited_cancel' } ]] } };
    return bot.sendMessage(msg.chat.id, `Приглашения отправлены:\n${sent.join('\n')}\n\nУдалить приглашённых участников?`, opts);
  }
  return bot.sendMessage(msg.chat.id, 'Не удалось разослать приглашения.', adminKeyboard);
});

bot.onText(/^Разослать по ID$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Команда доступна только администратору.');
  sessions.set(msg.chat.id, { step: 'invite_by_id', data: {} });
  await bot.sendMessage(msg.chat.id, 'Отправьте список id через запятую (пример: 1,2,3).', adminKeyboard);
});

bot.onText(/^Очистить список$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Команда доступна только администратору.');
  const opts = { reply_markup: { inline_keyboard: [[ { text: 'Подтвердить очистку', callback_data: 'clear_confirm' }, { text: 'Отмена', callback_data: 'clear_cancel' } ]] } };
  await bot.sendMessage(msg.chat.id, 'Вы уверены, что хотите удалить ВСЕ заявки? Действие необратимо.', opts);
});

bot.onText(/^Удалить участников$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Команда доступна только администратору.');
  sessions.set(msg.chat.id, { step: 'delete_by_id', data: {} });
  await bot.sendMessage(msg.chat.id, 'Отправьте список id участников для удаления через запятую (пример: 1,2,3).', adminKeyboard);
});

bot.onText(/^Скачать список$/i, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Команда доступна только администратору.');
  const rows = await storage.getRegistrations();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Заявок пока нет.', adminKeyboard);
  const header = 'СПИСОК ЗАРЕГИСТРИРОВАННЫХ УЧАСТНИКОВ\n\n';
  const lines = rows.map(r => `${r.fullName} | ${r.phone} | попытка ${r.attempt}`);
  const content = header + lines.join('\n');
  const tmp = path.join(os.tmpdir(), `registrations_${Date.now()}.txt`);
  try {
    await fs.promises.writeFile(tmp, content, 'utf8');
    await bot.sendDocument(msg.chat.id, tmp);
    await storage.appendAudit({ adminId: msg.from.id, action: 'download_list_txt', count: rows.length });
  } catch (e) {
    console.error('Ошибка при формировании файла списка (TXT):', e);
    await bot.sendMessage(msg.chat.id, 'Ошибка при формировании файла.');
  } finally {
    try { await fs.promises.unlink(tmp); } catch (e) {}
  }
});

bot.on('message', async (msg) => {
  if (!msg.text) return; if (msg.text.startsWith('/')) return;
  const chatId = msg.chat.id; const session = sessions.get(chatId); if (!session) return;
  try {
    if (session.step === 'full_name') { session.data.fullName = msg.text.trim(); session.step = 'phone'; sessions.set(chatId, session); return bot.sendMessage(chatId, 'Введите номер телефона (в формате +79876543210):'); }
    if (session.step === 'phone') { session.data.phone = msg.text.trim(); session.step = 'attempt'; sessions.set(chatId, session); return bot.sendMessage(chatId, 'Введите номер попытки сдачи экзамена (например 1 или 2):'); }
    if (session.step === 'attempt') {
      const attempt = parseInt(msg.text.trim(),10);
      if (Number.isNaN(attempt)) return bot.sendMessage(chatId, 'Неверный формат. Введите число.');
      const rec = await storage.addRegistration(chatId, session.data.fullName, session.data.phone, attempt);
      sessions.delete(chatId);
      bot.sendMessage(chatId, 'Спасибо, заявка принята. Когда списки будут готовы — получите уведомление.', { reply_markup: { remove_keyboard: true } });
      if (ADMIN_ID) {
        try { await bot.sendMessage(ADMIN_ID, `Новая заявка #${rec.id}:\nФИО: ${rec.fullName}\nТелефон: ${rec.phone}\nПопытка: ${rec.attempt}`); } catch (e) {}
      }
      return;
    }
    if (session.step === 'set_exam') {
      if (!isAdmin(msg.from.id)) { sessions.delete(chatId); return; }
      const parsed = tryParseDate(msg.text.trim());
      if (!parsed) { sessions.delete(chatId); return bot.sendMessage(chatId, 'Не удалось распознать дату.'); }
      await storage.setSetting('exam_datetime', parsed.toISOString());
      sessions.delete(chatId);
      return bot.sendMessage(chatId, `Дата экзамена сохранена: ${formatExamDate(parsed.toISOString())}`, adminKeyboard);
    }
    if (session.step === 'invite_by_id') {
      if (!isAdmin(msg.from.id)) { sessions.delete(chatId); return; }
      const ids = msg.text.split(',').map(x => Number(x.trim())).filter(x => !isNaN(x));
      sessions.delete(chatId);
      const examDt = await storage.getSetting('exam_datetime'); if (!examDt) return bot.sendMessage(chatId, 'Дата экзамена не установлена.');
      const targets = await storage.getRegistrationsByIds(ids);
      const sent = [];
      for (const r of targets) { try { await sendInvitation(r, examDt); sent.push(`${r.fullName} (ID:${r.id})`); } catch (e) {} }
      return bot.sendMessage(chatId, sent.length ? `Приглашения отправлены:\n${sent.join('\n')}` : 'Не удалось разослать приглашения.');
    }
    if (session.step === 'delete_by_id') {
      if (!isAdmin(msg.from.id)) { sessions.delete(chatId); return; }
      const ids = msg.text.split(',').map(x => Number(x.trim())).filter(x => !isNaN(x));
      sessions.delete(chatId);
      const removed = [], notFound = [];
      for (const id of ids) { const ok = await storage.removeRegistration(id); if (ok) removed.push(id); else notFound.push(id); }
      await storage.appendAudit({ adminId: msg.from.id, action: 'delete_by_id', removed, notFound, idsAttempted: ids });
      return bot.sendMessage(chatId, `${removed.length ? 'Удалены: ' + removed.join(', ') + '\n' : ''}${notFound.length ? 'Не найдены: ' + notFound.join(', ') : ''}` || 'Ничего не удалено.');
    }
  } catch (e) { console.error('session error', e); sessions.delete(chatId); }
});

bot.on('callback_query', async (cb) => {
  const d = cb.data, uid = cb.from.id;
  if (d && d.startsWith('confirm_')) {
    const id = Number(d.split('_')[1]); const reg = await storage.getRegistrationById(id);
    if (!reg) return bot.answerCallbackQuery(cb.id, { text: 'Заявка не найдена.' });
    if (cb.from.id !== reg.chatId) return bot.answerCallbackQuery(cb.id, { text: 'Подтвердить может только получатель.' });
    try { await storage.markConfirmed(id); await bot.answerCallbackQuery(cb.id, { text: 'Подтверждение получено.' }); try { const human = formatExamDate(await storage.getSetting('exam_datetime')); await bot.editMessageText(`Приглашение на экзамен:\n\nФИО: ${reg.fullName}\nДата и время: ${human}\nСтатус: Приглашение принято`, { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {} if (ADMIN_ID) try { await bot.sendMessage(ADMIN_ID, `Пользователь подтвердил приглашение. Заявка #${id}`); } catch (e) {} } catch (e) { console.error('confirm err', e); return bot.answerCallbackQuery(cb.id, { text: 'Ошибка при сохранении.' }); }
    return;
  }
  if (!isAdmin(uid)) return bot.answerCallbackQuery(cb.id, { text: 'Недостаточно прав.' });

  if (d === 'cmd_list') { await bot.answerCallbackQuery(cb.id); const rows = await storage.getRegistrations(); if (!rows.length) return bot.sendMessage(uid, 'Заявок пока нет.', adminKeyboard); return bot.sendMessage(uid, 'Список заявок:\n' + rows.map(r => `${r.id} | ${r.fullName} | ${r.phone} | попытка ${r.attempt} | приглашён:${r.invited?1:0}`).join('\n'), adminKeyboard); }
  if (d === 'cmd_set_exam') { await bot.answerCallbackQuery(cb.id); sessions.set(uid, { step: 'set_exam', data: {} }); return bot.sendMessage(uid, 'Отправьте дату и время экзамена в удобном формате: DD.MM.YYYY HH:MM или YYYY-MM-DD HH:MM', adminKeyboard); }
  if (d === 'cmd_invite_all') {
    await bot.answerCallbackQuery(cb.id, { text: 'Запускаю рассылку...' });
    const examDt = await storage.getSetting('exam_datetime'); if (!examDt) return bot.sendMessage(uid, 'Дата экзамена не установлена.', adminKeyboard);
    const targets = await storage.getRegistrations(); if (!targets.length) return bot.sendMessage(uid, 'Нет заявок.', adminKeyboard);
    const sent = [];
    for (const r of targets) { try { await sendInvitation(r, examDt); sent.push(`${r.fullName} (ID:${r.id})`); } catch (e) {} }
    if (sent.length) { await storage.setPendingRemovalRequests(uid, targets.map(r=>r.id)); const opts = { reply_markup: { inline_keyboard: [[ { text: 'Удалить приглашённых участников', callback_data: 'remove_invited_confirm' }, { text: 'Оставить', callback_data: 'remove_invited_cancel' } ]] } }; return bot.sendMessage(uid, `Приглашения отправлены:\n${sent.join('\n')}\n\nУдалить приглашённых участников?`, opts); }
    return bot.sendMessage(uid, 'Не удалось разослать приглашения.', adminKeyboard);
  }
  if (d === 'cmd_download_list') {
    await bot.answerCallbackQuery(cb.id, { text: 'Формирую TXT со списком...' });
    const rows = await storage.getRegistrations();
    if (!rows.length) return bot.sendMessage(uid, 'Заявок пока нет.', adminKeyboard);
    const header = 'СПИСОК ЗАРЕГИСТРИРОВАННЫХ УЧАСТНИКОВ\n\n';
    const lines = rows.map(r => `${r.fullName} | ${r.phone} | попытка ${r.attempt}`);
    const content = header + lines.join('\n');
    const tmp = path.join(os.tmpdir(), `registrations_${Date.now()}.txt`);
    try {
      await fs.promises.writeFile(tmp, content, 'utf8');
      await bot.sendDocument(uid, tmp);
      await storage.appendAudit({ adminId: uid, action: 'download_list_txt', count: rows.length });
    } catch (e) {
      console.error('Ошибка при формировании/отправке TXT:', e);
      await bot.sendMessage(uid, 'Ошибка при формировании файла.');
    } finally {
      try { await fs.promises.unlink(tmp); } catch (e) {}
    }
    return;
  }
  if (d === 'cmd_invite_by_id') { await bot.answerCallbackQuery(cb.id); sessions.set(uid, { step: 'invite_by_id', data: {} }); return bot.sendMessage(uid, 'Отправьте список id через запятую (пример: 1,2,3).', adminKeyboard); }
  if (d === 'cmd_clear_list') { await bot.answerCallbackQuery(cb.id); const opts = { reply_markup: { inline_keyboard: [[ { text: 'Подтвердить очистку', callback_data: 'clear_confirm' }, { text: 'Отмена', callback_data: 'clear_cancel' } ]] } }; return bot.sendMessage(uid, 'Вы уверены, что хотите удалить ВСЕ заявки?', opts); }
  if (d === 'cmd_delete_by_id') { await bot.answerCallbackQuery(cb.id); sessions.set(uid, { step: 'delete_by_id', data: {} }); return bot.sendMessage(uid, 'Отправьте список id участников для удаления через запятую (пример: 1,2,3).', adminKeyboard); }

  if (d === 'clear_confirm') { try { await storage.clearRegistrations(); await storage.appendAudit({ adminId: uid, action: 'clear_all' }); await bot.answerCallbackQuery(cb.id, { text: 'Список очищен.' }); return bot.editMessageText('Список заявок успешно очищен.', { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) { console.error(e); return bot.answerCallbackQuery(cb.id, { text: 'Ошибка при очистке.' }); } }
  if (d === 'clear_cancel') { await bot.answerCallbackQuery(cb.id, { text: 'Отмена.' }); try { await bot.editMessageText('Очистка отменена.', { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {} return; }

  if (d === 'remove_invited_confirm') {
    const pending = await storage.getPendingRemovalRequests(uid);
    if (!pending || !pending.length) { await bot.answerCallbackQuery(cb.id, { text: 'Нет ожидающих удаления.' }); try { await bot.editMessageText('Нет приглашённых участников, ожидающих удаления.', { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {} return; }
    let removed = 0; for (const id of pending) { try { const ok = await storage.removeRegistration(id); if (ok) removed++; } catch (e) {} }
    await storage.clearPendingRemovalRequests(uid);
    await storage.appendAudit({ adminId: uid, action: 'remove_invited', removedCount: removed, ids: pending });
    await bot.answerCallbackQuery(cb.id, { text: `Удалено ${removed} заявок.` }); try { await bot.editMessageText(`Удалено ${removed} приглашённых заявок из списка.`, { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {}
    return;
  }
  if (d === 'remove_invited_cancel') { await storage.clearPendingRemovalRequests(uid); await bot.answerCallbackQuery(cb.id, { text: 'Отмена удаления.' }); try { await bot.editMessageText('Удаление приглашённых участников отменено.', { chat_id: cb.message.chat.id, message_id: cb.message.message_id }); } catch (e) {} return; }
});

bot.on('polling_error', (err) => console.error('Polling error:', err));

console.log('Bot started (polling)...');

async function cleanupConfirmedAtExam() {
  try {
    const examDt = await storage.getSetting('exam_datetime'); if (!examDt) return;
    const last = await storage.getSetting('last_cleanup_exam'); if (last && last === examDt) return;
    const now = new Date(), examDate = new Date(examDt); if (isNaN(examDate.getTime())) return;
    if (now >= examDate) {
      const rows = await storage.getRegistrations(); const toRem = rows.filter(r => r.invited);
      let removed = 0; for (const r of toRem) { const ok = await storage.removeRegistration(r.id); if (ok) removed++; }
      await storage.setSetting('last_cleanup_exam', examDt);
      await storage.appendAudit({ adminId: 'system', action: 'auto_cleanup', removedCount: removed, examDatetime: examDt });
      if (ADMIN_ID) try { await bot.sendMessage(ADMIN_ID, `Авто-очистка: удалено ${removed} приглашённых заявок по дате ${formatExamDate(examDt)}`); } catch (e) {}
    }
  } catch (e) { console.error('cleanup error', e); }
}
setInterval(cleanupConfirmedAtExam, 60 * 1000);
cleanupConfirmedAtExam();
