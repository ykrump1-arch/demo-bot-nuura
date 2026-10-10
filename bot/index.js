// ============================================================
//  NUURA — бот записи + API для сайта
//  Запуск: node index.js
// ============================================================
const { Bot, InlineKeyboard } = require('grammy');
const express = require('express');
const cors = require('cors');

const store = require('./data');
const T = require('./slots');

const db = store.load();

// ---------- переменные окружения ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const API_KEY = process.env.API_KEY || 'change-me';
const SITE_ORIGIN = process.env.SITE_ORIGIN || '*';
const BOT_USERNAME = process.env.BOT_USERNAME || 'nuuranail_bot';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Нет BOT_TOKEN в переменных окружения');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const isAdmin = id => ADMIN_IDS.includes(String(id));

const money = n => n.toLocaleString('ru-RU').replace(/,/g, ' ');

function serviceName(id) {
  const s = db.services.find(x => x.id === id);
  return s ? s.name : id;
}
function masterName(id) {
  const m = db.masters.find(x => x.id === id);
  return m ? m.name : id;
}

// ============================================================
//  API ДЛЯ САЙТА
// ============================================================
const app = express();
app.use(express.json());
app.use(cors({ origin: SITE_ORIGIN === '*' ? true : SITE_ORIGIN.split(',').map(s => s.trim()) }));

// проверка ключа
function auth(req, res, next) {
  if (req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'Неверный ключ' });
  }
  next();
}

app.get('/', (req, res) => res.send('NUURA bot is running'));

// услуги, мастера, даты
app.get('/api/config', auth, (req, res) => {
  res.json({
    salon: db.salon,
    services: db.services,
    masters: db.masters,
    dates: T.dateRange(db.salon.horizonDays).map(d => ({
      date: d,
      label: T.shortDate(d),
      dow: ['вс','пн','вт','ср','чт','пт','сб'][T.dowOf(d)],
    })),
    botUsername: BOT_USERNAME,
  });
});

// свободное время
app.get('/api/slots', auth, (req, res) => {
  const { master, date, service } = req.query;
  if (!master || !date) return res.status(400).json({ error: 'Нужны master и date' });
  res.json({ slots: T.freeSlots(db, master, date, service) });
});

// создать запись
app.post('/api/book', auth, (req, res) => {
  const { service, master, date, time, name, phone } = req.body || {};

  if (!service || !master || !date || !time || !name || !phone) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (!db.services.find(s => s.id === service)) {
    return res.status(400).json({ error: 'Нет такой услуги' });
  }
  if (!db.masters.find(m => m.id === master)) {
    return res.status(400).json({ error: 'Нет такого мастера' });
  }
  // окно ещё свободно?
  if (!T.freeSlots(db, master, date, service).includes(time)) {
    return res.status(409).json({ error: 'Это время уже заняли. Выберите другое.' });
  }

  const booking = {
    id: 'B' + (db.seq++),
    service, master, date, time,
    name: String(name).slice(0, 60),
    phone: String(phone).slice(0, 30),
    status: 'active',
    chatId: null,          // появится, если клиент подключит напоминание
    remindedAt: null,
    source: req.body.source || 'site',
    createdAt: new Date().toISOString(),
  };
  db.bookings.push(booking);
  store.save();

  notifyAdmins(
    `🔔 <b>Новая запись</b>\n\n` +
    `Гость: <b>${esc(booking.name)}</b>\n` +
    `Телефон: ${esc(booking.phone)}\n` +
    `Услуга: ${esc(serviceName(service))}\n` +
    `Мастер: ${esc(masterName(master))}\n` +
    `Когда: <b>${T.prettyDate(date)}, ${time}</b>\n` +
    `Источник: ${esc(booking.source)}`
  );

  res.json({
    ok: true,
    bookingId: booking.id,
    remindUrl: `https://t.me/${BOT_USERNAME}?start=${booking.id}`,
    summary: {
      service: serviceName(service),
      master: masterName(master),
      date: T.prettyDate(date),
      time,
    },
  });
});

app.listen(PORT, () => console.log('API слушает порт', PORT));

// ============================================================
//  ВСПОМОГАТЕЛЬНОЕ
// ============================================================
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyAdmins(text) {
  for (const id of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Не отправилось админу', id, e.message);
    }
  }
}

// ============================================================
//  БОТ: СТОРОНА КЛИЕНТА
// ============================================================
bot.command('start', async ctx => {
  const payload = (ctx.match || '').trim();

  // пришёл по ссылке с сайта — подключаем напоминание
  if (payload && payload.startsWith('B')) {
    const b = db.bookings.find(x => x.id === payload);
    if (!b) {
      return ctx.reply('Не нашёл такую запись. Возможно, она уже отменена.');
    }
    b.chatId = ctx.chat.id;
    store.save();
    return ctx.reply(
      `Готово! Напомню вам за 2 часа до визита.\n\n` +
      `${serviceName(b.service)}\n` +
      `Мастер: ${masterName(b.master)}\n` +
      `${T.prettyDate(b.date)}, ${b.time}`
    );
  }

  if (isAdmin(ctx.from.id)) return adminMenu(ctx);

  return ctx.reply(
    `Здравствуйте! Это бот записи студии ${db.salon.name}.\n\n` +
    `Записаться удобнее на сайте — там видно свободное время.\n` +
    `После записи вернитесь сюда, и я напомню о визите.`
  );
});

// кнопки в напоминании
bot.callbackQuery(/^cl_(ok|no)_(.+)$/, async ctx => {
  const [, action, id] = ctx.match;
  const b = db.bookings.find(x => x.id === id);
  if (!b) return ctx.answerCallbackQuery('Запись не найдена');

  if (action === 'ok') {
    b.confirmed = true;
    store.save();
    await ctx.answerCallbackQuery('Спасибо, ждём вас!');
    await ctx.editMessageText('Спасибо, ждём вас! 🙌');
    notifyAdmins(`✅ ${esc(b.name)} подтвердил визит — ${T.prettyDate(b.date)}, ${b.time}`);
  } else {
    b.status = 'cancelled';
    store.save();
    await ctx.answerCallbackQuery('Запись отменена');
    await ctx.editMessageText('Запись отменена. Будем рады видеть вас в другой раз.');
    notifyAdmins(
      `❌ <b>Отмена</b>\n${esc(b.name)} — ${esc(serviceName(b.service))}\n` +
      `${T.prettyDate(b.date)}, ${b.time}\nОкно снова свободно.`
    );
  }
});

// ============================================================
//  БОТ: АДМИНКА
// ============================================================
function adminMenu(ctx) {
  const kb = new InlineKeyboard()
    .text('📅 Расписание', 'a_sched').text('📋 Записи', 'a_books').row()
    .text('👥 Клиенты', 'a_clients').text('📊 Статистика', 'a_stats').row()
    .text('⬇️ Выгрузка', 'a_export').text('⚙️ Настройки', 'a_settings');
  return ctx.reply(`Панель управления · ${db.salon.name}`, { reply_markup: kb });
}

bot.command('admin', ctx => {
  if (!isAdmin(ctx.from.id)) return;
  return adminMenu(ctx);
});

bot.callbackQuery('a_menu', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text('📅 Расписание', 'a_sched').text('📋 Записи', 'a_books').row()
    .text('👥 Клиенты', 'a_clients').text('📊 Статистика', 'a_stats').row()
    .text('⬇️ Выгрузка', 'a_export').text('⚙️ Настройки', 'a_settings');
  await ctx.editMessageText(`Панель управления · ${db.salon.name}`, { reply_markup: kb });
});

// ---------- записи ----------
bot.callbackQuery('a_books', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();

  const today = T.nowTashkent().date;
  const list = db.bookings
    .filter(b => b.status === 'active' && b.date >= today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .slice(0, 20);

  if (!list.length) {
    return ctx.editMessageText('Пока записей нет.', {
      reply_markup: new InlineKeyboard().text('← Назад', 'a_menu'),
    });
  }

  let text = '<b>Ближайшие записи</b>\n\n';
  const kb = new InlineKeyboard();
  for (const b of list) {
    text += `${T.shortDate(b.date)} ${b.time} · ${esc(b.name)}\n` +
            `<i>${esc(masterName(b.master))} · ${esc(serviceName(b.service))} · ${esc(b.phone)}</i>\n\n`;
    kb.text(`✖ ${T.shortDate(b.date)} ${b.time} ${b.name}`.slice(0, 40), `a_cancel_${b.id}`).row();
  }
  kb.text('← Назад', 'a_menu');
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(/^a_cancel_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  const b = db.bookings.find(x => x.id === ctx.match[1]);
  if (!b) return ctx.answerCallbackQuery('Не найдено');
  b.status = 'cancelled';
  store.save();
  await ctx.answerCallbackQuery('Отменено');
  if (b.chatId) {
    try {
      await bot.api.sendMessage(b.chatId,
        `К сожалению, запись на ${T.prettyDate(b.date)} в ${b.time} отменена. Свяжитесь с нами, чтобы перенести.`);
    } catch (e) {}
  }
  await ctx.editMessageText('Запись отменена, окно снова свободно.', {
    reply_markup: new InlineKeyboard().text('← К записям', 'a_books'),
  });
});

// ---------- расписание ----------
bot.callbackQuery('a_sched', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  db.masters.forEach(m => kb.text(m.name, `a_sm_${m.id}`).row());
  kb.text('← Назад', 'a_menu');
  await ctx.editMessageText('Выберите мастера:', { reply_markup: kb });
});

bot.callbackQuery(/^a_sm_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const mid = ctx.match[1];
  const kb = new InlineKeyboard();
  T.dateRange(10).forEach((d, i) => {
    kb.text(T.shortDate(d), `a_sd_${mid}_${d}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row().text('← Назад', 'a_sched');
  await ctx.editMessageText(`${masterName(mid)} — выберите день:`, { reply_markup: kb });
});

bot.callbackQuery(/^a_sd_([^_]+)_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  await showDay(ctx, ctx.match[1], ctx.match[2]);
});

async function showDay(ctx, mid, date) {
  const slots = T.daySlots(db, mid, date);
  const kb = new InlineKeyboard();
  slots.forEach((s, i) => {
    const mark = s.state === 'booked' ? '🔴' : s.state === 'closed' ? '⚪️' : '🟢';
    kb.text(`${mark} ${s.time}`, s.state === 'booked' ? 'a_noop' : `a_tg_${mid}_${date}_${s.time}`);
    if (i % 4 === 3) kb.row();
  });
  kb.row().text('← Назад', `a_sm_${mid}`);
  const text = `<b>${masterName(mid)} · ${T.prettyDate(date)}</b>\n\n` +
               `🟢 свободно · ⚪️ закрыто · 🔴 занято\n` +
               `Нажмите на время, чтобы открыть или закрыть окно.`;
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {}
}

bot.callbackQuery('a_noop', ctx => ctx.answerCallbackQuery('Это время занято записью'));

bot.callbackQuery(/^a_tg_([^_]+)_([^_]+)_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  const [, mid, date, time] = ctx.match;
  db.closed[mid] = db.closed[mid] || {};
  db.closed[mid][date] = db.closed[mid][date] || [];
  const arr = db.closed[mid][date];
  const i = arr.indexOf(time);
  if (i >= 0) arr.splice(i, 1); else arr.push(time);
  store.save();
  await ctx.answerCallbackQuery(i >= 0 ? 'Открыто' : 'Закрыто');
  await showDay(ctx, mid, date);
});

// ---------- клиенты ----------
bot.callbackQuery('a_clients', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const map = new Map();
  db.bookings.forEach(b => {
    const k = b.phone;
    if (!map.has(k)) map.set(k, { name: b.name, phone: b.phone, count: 0, last: '' });
    const c = map.get(k);
    c.count++;
    if (b.date > c.last) c.last = b.date;
  });
  const list = [...map.values()].sort((a, b) => b.count - a.count).slice(0, 30);
  let text = `<b>Клиенты · ${map.size}</b>\n\n`;
  if (!list.length) text += 'Пока пусто.';
  list.forEach(c => {
    text += `${esc(c.name)} — ${esc(c.phone)}\n<i>визитов: ${c.count}, последний ${T.shortDate(c.last)}</i>\n\n`;
  });
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('← Назад', 'a_menu'),
  });
});

// ---------- статистика ----------
bot.callbackQuery('a_stats', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();

  const all = db.bookings;
  const active = all.filter(b => b.status === 'active');
  const cancelled = all.filter(b => b.status === 'cancelled');
  const noshow = all.filter(b => b.status === 'noshow');

  let text = `<b>Статистика</b>\n\n`;
  text += `Всего записей: <b>${all.length}</b>\n`;
  text += `Активных: ${active.length}\n`;
  text += `Отмен: ${cancelled.length}\n`;
  text += `Неявок: ${noshow.length}\n\n`;

  text += `<b>По мастерам</b>\n`;
  db.masters.forEach(m => {
    const n = all.filter(b => b.master === m.id).length;
    text += `${esc(m.name)}: ${n}\n`;
  });

  text += `\n<b>По источникам</b>\n`;
  const src = {};
  all.forEach(b => { src[b.source || 'site'] = (src[b.source || 'site'] || 0) + 1; });
  Object.entries(src).forEach(([k, v]) => { text += `${esc(k)}: ${v}\n`; });

  const withRemind = all.filter(b => b.chatId).length;
  text += `\nПодключили напоминание: ${withRemind} из ${all.length}`;

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('← Назад', 'a_menu'),
  });
});

// ---------- выгрузка ----------
bot.callbackQuery('a_export', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery('Готовлю файл…');
  const head = 'Дата;Время;Имя;Телефон;Услуга;Мастер;Статус;Источник\n';
  const rows = db.bookings.map(b =>
    [b.date, b.time, b.name, b.phone, serviceName(b.service),
     masterName(b.master), b.status, b.source || 'site'].join(';')
  ).join('\n');
  const buf = Buffer.from('﻿' + head + rows, 'utf8');
  await ctx.replyWithDocument(
    new (require('grammy').InputFile)(buf, `nuura-zapisi-${T.nowTashkent().date}.csv`)
  );
});

// ---------- настройки ----------
bot.callbackQuery('a_settings', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  let text = `<b>Настройки</b>\n\n`;
  text += `Часы работы: ${db.salon.hours.start}–${db.salon.hours.end}\n`;
  text += `Шаг записи: ${db.salon.stepMin} мин\n`;
  text += `Горизонт: ${db.salon.horizonDays} дней\n\n`;
  text += `<b>Услуги</b>\n`;
  db.services.forEach(s => { text += `${esc(s.name)} — ${s.duration} мин, ${money(s.price)} сум\n`; });
  text += `\n<b>Мастера</b>\n`;
  db.masters.forEach(m => {
    text += `${esc(m.name)} — ${m.services.map(serviceName).join(', ')}\n`;
  });
  text += `\n<i>Чтобы изменить — напишите мне, поправлю.</i>`;
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('← Назад', 'a_menu'),
  });
});

// ============================================================
//  НАПОМИНАНИЯ ЗА 2 ЧАСА
// ============================================================
setInterval(async () => {
  const now = T.nowTashkent();
  for (const b of db.bookings) {
    if (b.status !== 'active' || !b.chatId || b.remindedAt) continue;
    if (b.date !== now.date) continue;

    const diff = T.toMin(b.time) - now.min;
    if (diff <= 120 && diff > 0) {
      try {
        await bot.api.sendMessage(b.chatId,
          `Напоминаем о визите сегодня в <b>${b.time}</b>\n\n` +
          `${esc(serviceName(b.service))}\nМастер: ${esc(masterName(b.master))}\n\n` +
          `Всё в силе?`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('Приду', `cl_ok_${b.id}`)
              .text('Не смогу', `cl_no_${b.id}`),
          });
        b.remindedAt = new Date().toISOString();
        store.save();
      } catch (e) {
        console.error('Напоминание не ушло:', e.message);
      }
    }
  }
}, 60000);

// ============================================================
bot.catch(err => console.error('Ошибка бота:', err));
bot.start();
console.log('Бот запущен');
