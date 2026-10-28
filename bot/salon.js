// ============================================================
//  ОДИН САЛОН = ОДИН БОТ
//  Эта функция создаёт бота и всю его логику для одного салона.
//  Вызывается столько раз, сколько салонов в списке.
// ============================================================
const { Bot, InlineKeyboard, Keyboard, InputFile } = require('grammy');
const store = require('./data');
const T = require('./slots');

module.exports = function createSalon(cfg) {
  // cfg = { id, token, admins: [], username }
  const { db, save } = store.load(cfg.id);

  const bot = new Bot(cfg.token);
  const ADMIN_IDS = cfg.admins || [];
  const BOT_USERNAME = cfg.username || '';

  const isAdmin = id => ADMIN_IDS.includes(String(id));
  const money = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const log = (...a) => console.log(`[${cfg.id}]`, ...a);

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function serviceName(id) {
    const ids = T.svcIds(id);
    if (!ids.length) return '—';
    return ids.map(i => {
      const s = db.services.find(x => x.id === i);
      return s ? s.name : i;
    }).join(' + ');
  }
  function servicePrice(id) {
    return T.svcIds(id).reduce((sum, i) => {
      const s = db.services.find(x => x.id === i);
      return sum + (s ? s.price : 0);
    }, 0);
  }
  function masterName(id) {
    const m = db.masters.find(x => x.id === id);
    return m ? m.name : id;
  }

  const BTN = {
    book: '📅 Записаться',
    mine: '🗓 Мои записи',
    contacts: '📍 Контакты',
    sched: '📅 Расписание',
    books: '📋 Записи',
    clients: '👥 Клиенты',
    stats: '📊 Статистика',
    export: '⬇️ Выгрузка',
    settings: '⚙️ Настройки',
    bcast: '📣 Рассылка',
  };

  function clientKb() {
    return new Keyboard()
      .text(BTN.book).row()
      .text(BTN.mine).text(BTN.contacts)
      .resized().persistent();
  }
  function adminKb() {
    return new Keyboard()
      .text(BTN.sched).text(BTN.books).row()
      .text(BTN.clients).text(BTN.stats).row()
      .text(BTN.export).text(BTN.settings).row()
      .text(BTN.bcast)
      .resized().persistent();
  }
  const kbFor = id => (isAdmin(id) ? adminKb() : clientKb());

  // ============================================================
  //  СОЗДАНИЕ ЗАПИСИ (общее для сайта и бота)
  // ============================================================
  function createBooking({ service, master, date, time, name, phone, source, chatId, group, part, parts }) {
    const ids = T.svcIds(service);
    const booking = {
      id: 'B' + (db.seq++),
      group: group || null,
      part: part || 1,
      parts: parts || 1,
      service: ids.join(','),      // строка — для старых мест в коде
      services: ids,               // массив — основное
      duration: T.totalDuration(db, ids),
      price: servicePrice(ids),
      master, date, time,
      name: String(name).slice(0, 60),
      phone: String(phone).slice(0, 30),
      status: 'active',
      chatId: chatId || null,
      remindedAt: null,
      source: source || 'bot',
      createdAt: new Date().toISOString(),
    };
    db.bookings.push(booking);
    save();

    notifyAdmins(
      `🔔 <b>Новая запись</b>` +
      (booking.parts > 1 ? ` · часть ${booking.part} из ${booking.parts}` : '') + `\n\n` +
      `Гость: <b>${esc(booking.name)}</b>\n` +
      `Телефон: ${esc(booking.phone)}\n` +
      `Услуга: ${esc(serviceName(ids))}\n` +
      `Мастер: ${esc(masterName(master))}\n` +
      `Когда: <b>${T.prettyDate(date)}, ${time}</b> · ${booking.duration} мин\n` +
      `Сумма: ${money(booking.price)} сум\n` +
      `Источник: ${esc(booking.source)}`
    );
    return booking;
  }

  async function notifyAdmins(text) {
    for (const id of ADMIN_IDS) {
      try { await bot.api.sendMessage(id, text, { parse_mode: 'HTML' }); }
      catch (e) { console.error('Не отправилось админу', id, e.message); }
    }
  }

  // ============================================================
  //  ЭКРАНЫ АДМИНКИ (общие для кнопок внизу и инлайна)
  // ============================================================
  function viewBooks() {
    const today = T.nowTashkent().date;
    const list = db.bookings
      .filter(b => b.status === 'active' && b.date >= today)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .slice(0, 15);

    if (!list.length) return { text: 'Пока записей нет.', kb: new InlineKeyboard() };

    let text = '<b>Ближайшие записи</b>\n\n';
    const kb = new InlineKeyboard();
    for (const b of list) {
      text += `${T.shortDate(b.date)} ${b.time} · <b>${esc(b.name)}</b>\n` +
              `<i>${esc(masterName(b.master))} · ${esc(serviceName(b.service))} · ${esc(b.phone)}</i>\n\n`;
      kb.text(`✖ ${T.shortDate(b.date)} ${b.time} ${b.name}`.slice(0, 38), `a_cancel_${b.id}`).row();
    }
    return { text, kb };
  }

  function viewMasters() {
    const kb = new InlineKeyboard();
    db.masters.forEach(m => kb.text(m.name, `a_sm_${m.id}`).row());
    return { text: 'Выберите мастера:', kb };
  }

  function viewClients() {
    const map = new Map();
    db.bookings.forEach(b => {
      if (!map.has(b.phone)) map.set(b.phone, { name: b.name, phone: b.phone, count: 0, last: '' });
      const c = map.get(b.phone);
      c.count++;
      if (b.date > c.last) c.last = b.date;
    });
    const list = [...map.values()].sort((a, b) => b.count - a.count).slice(0, 30);
    let text = `<b>Клиенты · ${map.size}</b>\n\n`;
    if (!list.length) text += 'Пока пусто.';
    list.forEach(c => {
      text += `${esc(c.name)} — ${esc(c.phone)}\n<i>визитов: ${c.count}, последний ${T.shortDate(c.last)}</i>\n\n`;
    });
    return { text, kb: new InlineKeyboard() };
  }

  function viewStats() {
    const all = db.bookings;
    const cnt = s => all.filter(b => b.status === s).length;

    let text = `<b>Статистика</b>\n\n`;
    text += `Всего записей: <b>${all.length}</b>\n`;
    text += `Активных: ${cnt('active')}\nОтмен: ${cnt('cancelled')}\nНеявок: ${cnt('noshow')}\n\n`;

    text += `<b>По мастерам</b>\n`;
    db.masters.forEach(m => {
      text += `${esc(m.name)}: ${all.filter(b => b.master === m.id).length}\n`;
    });

    text += `\n<b>Откуда пришли</b>\n`;
    const src = {};
    all.forEach(b => { src[b.source || 'site'] = (src[b.source || 'site'] || 0) + 1; });
    Object.entries(src).forEach(([k, v]) => { text += `${esc(k)}: ${v}\n`; });

    text += `\nПодключили напоминание: ${all.filter(b => b.chatId).length} из ${all.length}`;
    return { text, kb: new InlineKeyboard() };
  }

  function viewSettings() {
    let text = `<b>Настройки</b>\n\n`;
    text += `Часы работы: ${db.salon.hours.start}–${db.salon.hours.end}\n`;
    text += `Шаг записи: ${db.salon.stepMin} мин\nГоризонт: ${db.salon.horizonDays} дней\n\n`;
    text += `<b>Услуги</b>\n`;
    db.services.forEach(s => { text += `${esc(s.name)} — ${s.duration} мин, ${money(s.price)} сум\n`; });
    text += `\n<b>Мастера</b>\n`;
    db.masters.forEach(m => { text += `${esc(m.name)} — ${m.services.map(serviceName).join(', ')}\n`; });
    text += `\n<i>Чтобы изменить — напишите разработчику.</i>`;
    return { text, kb: new InlineKeyboard() };
  }

  async function exportCsv(ctx) {
    const head = 'Дата;Время;Имя;Телефон;Услуга;Мастер;Статус;Источник\n';
    const rows = db.bookings.map(b =>
      [b.date, b.time, b.name, b.phone, serviceName(b.service),
       masterName(b.master), b.status, b.source || 'site'].join(';')
    ).join('\n');
    const buf = Buffer.from('﻿' + head + rows, 'utf8');
    await ctx.replyWithDocument(new InputFile(buf, `nuura-zapisi-${T.nowTashkent().date}.csv`));
  }

  // ============================================================
  //  ЭКРАНЫ КЛИЕНТА
  // ============================================================
  function viewMine(chatId) {
    const today = T.nowTashkent().date;
    const list = db.bookings
      .filter(b => b.chatId === chatId && b.status === 'active' && b.date >= today)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    if (!list.length) {
      return { text: 'У вас пока нет активных записей.', kb: new InlineKeyboard() };
    }
    let text = '<b>Ваши записи</b>\n\n';
    const kb = new InlineKeyboard();
    list.forEach(b => {
      text += `${T.prettyDate(b.date)}, <b>${b.time}</b>\n` +
              `${esc(serviceName(b.service))} · ${esc(masterName(b.master))}\n\n`;
      kb.text(`Отменить ${T.shortDate(b.date)} ${b.time}`, `cl_no_${b.id}`).row();
    });
    return { text, kb };
  }

  function viewContacts() {
    let text = `<b>${esc(db.salon.name)}</b>\n${esc(db.salon.city)}\n\n`;
    text += `Часы работы: ${db.salon.hours.start}–${db.salon.hours.end}\n\n`;
    text += `<b>Услуги</b>\n`;
    db.services.forEach(s => { text += `${esc(s.name)} — ${money(s.price)} сум\n`; });
    return { text, kb: new InlineKeyboard() };
  }

  // ============================================================
  //  ЗАПИСЬ ВНУТРИ БОТА (пошагово, кнопками)
  // ============================================================
  const draft = new Map();   // chatId -> { service, master, date, time, name, phone, step }

  // --- экран выбора услуг: можно отметить несколько ---
  function svcKeyboard(d) {
    const kb = new InlineKeyboard();
    db.services.forEach(s => {
      const on = d.services.includes(s.id);
      kb.text(`${on ? '✅' : '▫️'} ${s.name} · ${money(s.price)}`, `bk_s_${s.id}`).row();
    });
    if (d.services.length) kb.text(`Далее → ${money(servicePrice(d.services))} сум`, 'bk_go');
    return kb;
  }

  function svcText(d) {
    if (!d.services.length) return 'Что вас интересует?\nМожно отметить сразу несколько.';
    const mins = T.totalDuration(db, d.services);
    return `Что вас интересует?\nМожно отметить сразу несколько.\n\n` +
           `Выбрано: ${serviceName(d.services)}\n` +
           `Займёт ${mins} мин · ${money(servicePrice(d.services))} сум`;
  }

  function startBooking(ctx) {
    const d = { step: 'service', services: [] };
    draft.set(ctx.chat.id, d);
    return ctx.reply(svcText(d), { reply_markup: svcKeyboard(d) });
  }

  // нажатие на услугу — включить или выключить
  bot.callbackQuery(/^bk_s_(.+)$/, async ctx => {
    const d = draft.get(ctx.chat.id) || { services: [] };
    d.services = d.services || [];
    const id = ctx.match[1];
    d.services = d.services.includes(id)
      ? d.services.filter(x => x !== id)
      : [...d.services, id];
    d.step = 'service';
    draft.set(ctx.chat.id, d);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(svcText(d), { reply_markup: svcKeyboard(d) });
  });

  // «Далее» — выбор мастера
  bot.callbackQuery('bk_go', async ctx => {
    const d = draft.get(ctx.chat.id);
    if (!d || !d.services || !d.services.length) {
      return ctx.answerCallbackQuery('Сначала выберите услугу');
    }
    d.step = 'master';
    draft.set(ctx.chat.id, d);
    await ctx.answerCallbackQuery();

    const list = db.masters.filter(m => d.services.every(id => m.services.includes(id)));
    const kb = new InlineKeyboard();
    list.forEach(m => kb.text(m.name, `bk_m_${m.id}`).row());
    kb.text('← Назад', 'bk_back_service');

    const head = `${serviceName(d.services)}\n${T.totalDuration(db, d.services)} мин · ${money(servicePrice(d.services))} сум\n\n`;
    await ctx.editMessageText(
      list.length
        ? head + 'Выберите мастера:'
        : head + 'Такое сочетание услуг не делает ни один мастер. Вернитесь назад и уберите что-то.',
      { reply_markup: kb }
    );
  });

  bot.callbackQuery('bk_back_service', async ctx => {
    const d = draft.get(ctx.chat.id) || { services: [] };
    d.services = d.services || [];
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(svcText(d), { reply_markup: svcKeyboard(d) });
  });

  bot.callbackQuery(/^bk_m_(.+)$/, async ctx => {
    const d = draft.get(ctx.chat.id) || {};
    d.master = ctx.match[1]; d.step = 'date';
    draft.set(ctx.chat.id, d);
    await ctx.answerCallbackQuery();
    await showDates(ctx, d);
  });

  async function showDates(ctx, d) {
    const kb = new InlineKeyboard();
    let shown = 0;
    for (const date of T.dateRange(db.salon.horizonDays)) {
      const free = T.freeSlots(db, d.master, date, d.services).length;
      if (!free) continue;
      kb.text(`${T.shortDate(date)} · ${free}`, `bk_d_${date}`);
      shown++;
      if (shown % 2 === 0) kb.row();
    }
    kb.row().text('← Назад', "bk_go");
    await ctx.editMessageText(
      `${serviceName(d.services)} · ${masterName(d.master)}\n\nВыберите день (цифра — сколько свободных окон):`,
      { reply_markup: kb }
    );
  }

  bot.callbackQuery(/^bk_d_(.+)$/, async ctx => {
    const d = draft.get(ctx.chat.id) || {};
    d.date = ctx.match[1]; d.step = 'time';
    draft.set(ctx.chat.id, d);
    await ctx.answerCallbackQuery();

    const slots = T.freeSlots(db, d.master, d.date, d.services);
    const kb = new InlineKeyboard();
    slots.forEach((t, i) => {
      kb.text(t, `bk_t_${t}`);
      if (i % 4 === 3) kb.row();
    });
    kb.row().text('← Назад', `bk_m_${d.master}`);
    await ctx.editMessageText(
      `${masterName(d.master)} · ${T.prettyDate(d.date)}\n\nВыберите время:`,
      { reply_markup: kb }
    );
  });

  bot.callbackQuery(/^bk_t_(.+)$/, async ctx => {
    const d = draft.get(ctx.chat.id) || {};
    d.time = ctx.match[1]; d.step = 'name';
    draft.set(ctx.chat.id, d);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${serviceName(d.services)}\n${masterName(d.master)} · ${T.prettyDate(d.date)}, ${d.time}\n\n` +
      `Как вас зовут? Напишите имя сообщением.`
    );
  });

  bot.callbackQuery(/^bk_confirm$/, async ctx => {
    const d = draft.get(ctx.chat.id);
    if (!d || !d.phone) return ctx.answerCallbackQuery('Что-то пошло не так, начните заново');

    if (!T.freeSlots(db, d.master, d.date, d.services).includes(d.time)) {
      draft.delete(ctx.chat.id);
      await ctx.answerCallbackQuery();
      return ctx.editMessageText('Это время только что заняли. Начните запись заново.');
    }

    const b = createBooking({
      service: d.services, master: d.master, date: d.date, time: d.time,
      name: d.name, phone: d.phone, source: 'bot', chatId: ctx.chat.id,
    });
    draft.delete(ctx.chat.id);
    await ctx.answerCallbackQuery('Записали!');
    await ctx.editMessageText(
      `✅ <b>Записали вас</b>\n\n` +
      `${esc(serviceName(b.service))}\nМастер: ${esc(masterName(b.master))}\n` +
      `${T.prettyDate(b.date)}, <b>${b.time}</b>\n\n` +
      `Напомню за два часа до визита.`,
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('bk_cancel', async ctx => {
    draft.delete(ctx.chat.id);
    await ctx.answerCallbackQuery('Отменено');
    await ctx.editMessageText('Запись отменена. Можете начать заново кнопкой внизу.');
  });

  // ============================================================
  //  /start — вход
  // ============================================================
  bot.command('start', async ctx => {
    touchUser(ctx);
    const payload = (ctx.match || '').trim();

    // пришёл по ссылке с сайта — подключаем напоминание
    if (payload && payload.startsWith('B')) {
      const b = db.bookings.find(x => x.id === payload);
      if (!b) return ctx.reply('Не нашёл такую запись. Возможно, она уже отменена.', { reply_markup: clientKb() });
      b.chatId = ctx.chat.id;
      save();
      return ctx.reply(
        `Готово! Напомню за 2 часа до визита.\n\n` +
        `${serviceName(b.service)}\nМастер: ${masterName(b.master)}\n${T.prettyDate(b.date)}, ${b.time}`,
        { reply_markup: clientKb() }
      );
    }

    if (isAdmin(ctx.from.id)) {
      return ctx.reply(`Панель управления · ${db.salon.name}\n\nВыбирайте кнопками внизу.`,
        { reply_markup: adminKb() });
    }

    return ctx.reply(
      `Здравствуйте! Это запись в студию ${db.salon.name}.\n\n` +
      `Нажмите «Записаться» — это меньше минуты.`,
      { reply_markup: clientKb() }
    );
  });

  // ============================================================
  //  ОБРАБОТКА НАЖАТИЙ НА КНОПКИ ВНИЗУ + ввод имени/телефона
  // ============================================================
  // ============================================================
  //  РАССЫЛКА: админ пишет одно сообщение — оно уходит всем клиентам
  // ============================================================
  const bcast = new Map();                       // чат админа -> черновик рассылки
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // запоминаем всех, кто писал боту
  function touchUser(ctx) {
    const id = ctx.chat && ctx.chat.id;
    if (!id || (ctx.chat.type && ctx.chat.type !== 'private')) return;
    const now = new Date().toISOString();
    let u = db.users.find(x => x.id === id);
    if (!u) {
      u = { id, name: '', username: '', since: now, lastSeen: now, blocked: false };
      db.users.push(u);
    } else if (u.lastSeen && now.slice(0, 13) === u.lastSeen.slice(0, 13) && !u.blocked) {
      return;                                     // в этот же час уже отмечали — не трогаем файл
    }
    if (ctx.from) {
      u.name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || u.name;
      u.username = ctx.from.username || u.username;
    }
    u.lastSeen = now;
    u.blocked = false;
    save();
  }

  // кому отправляем: все, кто писал боту, плюс те, кто пришёл по ссылке с сайта
  function audience() {
    const out = new Map();
    db.users.forEach(u => { if (!isAdmin(u.id)) out.set(u.id, u); });
    db.bookings.forEach(b => {
      if (b.chatId && !isAdmin(b.chatId) && !out.has(b.chatId)) out.set(b.chatId, { id: b.chatId, name: b.name });
    });
    return [...out.values()];
  }

  bot.on('message', async (ctx, next) => {
    touchUser(ctx);

    const st = bcast.get(ctx.chat.id);
    if (!st || !isAdmin(ctx.from.id)) return next();

    const txt = ctx.message.text ? ctx.message.text.trim() : '';
    if (txt && (Object.values(BTN).includes(txt) || txt.startsWith('/'))) {
      bcast.delete(ctx.chat.id);                  // нажал другую кнопку — выходим из рассылки
      return next();
    }

    const people = audience();
    bcast.set(ctx.chat.id, { msgId: ctx.message.message_id, ready: true });

    if (!people.length) {
      bcast.delete(ctx.chat.id);
      return ctx.reply('Пока некому отправлять: ни один клиент не писал боту.',
        { reply_markup: adminKb() });
    }

    await ctx.reply(
      `👆 Вот так это увидят клиенты.\n\nПолучателей: <b>${people.length}</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(`📣 Отправить (${people.length})`, 'bc_send').row()
          .text('Отмена', 'bc_cancel'),
      }
    );
  });

  bot.callbackQuery('bc_cancel', async ctx => {
    bcast.delete(ctx.chat.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Рассылка отменена.');
  });

  bot.callbackQuery('bc_send', async ctx => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
    const st = bcast.get(ctx.chat.id);
    if (!st || !st.ready) {
      await ctx.answerCallbackQuery({ text: 'Сообщение потерялось, начните заново', show_alert: true });
      return;
    }
    bcast.delete(ctx.chat.id);
    await ctx.answerCallbackQuery();

    const people = audience();
    await ctx.editMessageText(`Отправляю… 0 из ${people.length}`);

    let ok = 0, fail = 0;
    for (const p of people) {
      try {
        await bot.api.copyMessage(p.id, ctx.chat.id, st.msgId);
        ok++;
      } catch (e) {
        fail++;
        const u = db.users.find(x => x.id === p.id);
        if (u && /blocked|deactivated|chat not found|user is deactivated/i.test(e.message || '')) u.blocked = true;
        const wait = e.parameters && e.parameters.retry_after;
        if (wait) await sleep((wait + 1) * 1000);
      }
      await sleep(40);                             // ~25 сообщений в секунду — лимит телеграма
      if ((ok + fail) % 25 === 0) {
        try { await ctx.editMessageText(`Отправляю… ${ok + fail} из ${people.length}`); } catch (e) {}
      }
    }
    save();
    log(`рассылка: ${ok} доставлено, ${fail} нет`);

    await ctx.reply(
      `Готово.\n\nДоставлено: <b>${ok}</b>` +
      (fail ? `\nНе дошло: ${fail} — эти люди заблокировали бота.` : ''),
      { parse_mode: 'HTML', reply_markup: adminKb() }
    );
  });

  bot.on('message:contact', async ctx => {
    const d = draft.get(ctx.chat.id);
    if (!d || d.step !== 'phone') return;
    d.phone = ctx.message.contact.phone_number;
    d.step = 'confirm';
    draft.set(ctx.chat.id, d);
    await askConfirm(ctx, d);
  });

  async function askConfirm(ctx, d) {
    const kb = new InlineKeyboard()
      .text('✅ Подтвердить', 'bk_confirm').row()
      .text('Отменить', 'bk_cancel');
    await ctx.reply(
      `<b>Проверьте, всё ли верно</b>\n\n` +
      `Услуга: ${esc(serviceName(d.services))}\n` +
      `Мастер: ${esc(masterName(d.master))}\n` +
      `Когда: <b>${T.prettyDate(d.date)}, ${d.time}</b> · ${T.totalDuration(db, d.services)} мин\n` +
      `Сумма: ${money(servicePrice(d.services))} сум\n` +
      `Имя: ${esc(d.name)}\nТелефон: ${esc(d.phone)}`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }

  bot.on('message:text', async ctx => {
    const txt = ctx.message.text.trim();
    const admin = isAdmin(ctx.from.id);

    // --- сначала: идёт ли сейчас ввод имени/телефона ---
    const d = draft.get(ctx.chat.id);
    if (d && d.step === 'name' && !Object.values(BTN).includes(txt)) {
      d.name = txt; d.step = 'phone';
      draft.set(ctx.chat.id, d);
      const kb = new Keyboard().requestContact('📱 Отправить мой номер').resized().oneTime();
      return ctx.reply(
        `Приятно познакомиться, ${esc(txt)}!\n\nТеперь номер телефона — нажмите кнопку или напишите вручную.`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    }
    if (d && d.step === 'phone' && !Object.values(BTN).includes(txt)) {
      d.phone = txt; d.step = 'confirm';
      draft.set(ctx.chat.id, d);
      await ctx.reply('Принято', { reply_markup: kbFor(ctx.from.id) });
      return askConfirm(ctx, d);
    }

    // --- кнопки клиента ---
    if (txt === BTN.book) return startBooking(ctx);

    if (txt === BTN.mine) {
      const v = viewMine(ctx.chat.id);
      return ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb });
    }
    if (txt === BTN.contacts) {
      const v = viewContacts();
      return ctx.reply(v.text, { parse_mode: 'HTML' });
    }

    // --- кнопки админа ---
    if (admin) {
      if (txt === BTN.books)    { const v = viewBooks();    return ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb }); }
      if (txt === BTN.sched)    { const v = viewMasters();  return ctx.reply(v.text, { reply_markup: v.kb }); }
      if (txt === BTN.clients)  { const v = viewClients();  return ctx.reply(v.text, { parse_mode: 'HTML' }); }
      if (txt === BTN.stats)    { const v = viewStats();    return ctx.reply(v.text, { parse_mode: 'HTML' }); }
      if (txt === BTN.settings) { const v = viewSettings(); return ctx.reply(v.text, { parse_mode: 'HTML' }); }
      if (txt === BTN.export)   return exportCsv(ctx);
      if (txt === BTN.bcast) {
        const n = audience().length;
        bcast.set(ctx.chat.id, {});
        return ctx.reply(
          `<b>Рассылка</b>\n\n` +
          `Пришлите сообщение — текст, фото, видео, что угодно. Я покажу, как оно будет выглядеть, ` +
          `и спрошу подтверждение.\n\n` +
          `Сейчас получателей: <b>${n}</b>\n` +
          `<i>Это те, кто когда-либо писал боту.</i>`,
          { parse_mode: 'HTML' }
        );
      }
    }

    // --- всё остальное ---
    return ctx.reply('Выбирайте кнопками внизу 👇', { reply_markup: kbFor(ctx.from.id) });
  });

  // ============================================================
  //  АДМИН: расписание
  // ============================================================
  bot.callbackQuery(/^a_sm_(.+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const mid = ctx.match[1];
    const kb = new InlineKeyboard();
    T.dateRange(10).forEach((d, i) => {
      kb.text(T.shortDate(d), `a_sd_${mid}_${d}`);
      if (i % 3 === 2) kb.row();
    });
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
    kb.row().text('← К мастерам', 'a_sched_back');
    const text = `<b>${masterName(mid)} · ${T.prettyDate(date)}</b>\n\n` +
                 `🟢 свободно · ⚪️ закрыто · 🔴 занято\n` +
                 `Нажмите на время, чтобы открыть или закрыть окно.`;
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }); } catch (e) {}
  }

  bot.callbackQuery('a_sched_back', async ctx => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const v = viewMasters();
    await ctx.editMessageText(v.text, { reply_markup: v.kb });
  });

  bot.callbackQuery('a_noop', ctx => ctx.answerCallbackQuery('Это время занято записью'));

  bot.callbackQuery(/^a_tg_([^_]+)_([^_]+)_(.+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
    const [, mid, date, time] = ctx.match;
    db.closed[mid] = db.closed[mid] || {};
    db.closed[mid][date] = db.closed[mid][date] || [];
    const arr = db.closed[mid][date];
    const i = arr.indexOf(time);
    if (i >= 0) arr.splice(i, 1); else arr.push(time);
    save();
    await ctx.answerCallbackQuery(i >= 0 ? 'Открыто' : 'Закрыто');
    await showDay(ctx, mid, date);
  });

  // АДМИН: отмена записи
  bot.callbackQuery(/^a_cancel_(.+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
    const b = db.bookings.find(x => x.id === ctx.match[1]);
    if (!b) return ctx.answerCallbackQuery('Не найдено');
    b.status = 'cancelled';
    save();
    await ctx.answerCallbackQuery('Отменено');
    if (b.chatId) {
      try {
        await bot.api.sendMessage(b.chatId,
          `К сожалению, запись на ${T.prettyDate(b.date)} в ${b.time} отменена. Напишите нам, чтобы перенести.`);
      } catch (e) {}
    }
    const v = viewBooks();
    await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.kb });
  });

  // ============================================================
  //  КЛИЕНТ: подтверждение и отмена из напоминания
  // ============================================================
  bot.callbackQuery(/^cl_(ok|no)_(.+)$/, async ctx => {
    const [, action, id] = ctx.match;
    const b = db.bookings.find(x => x.id === id);
    if (!b) return ctx.answerCallbackQuery('Запись не найдена');

    if (action === 'ok') {
      b.confirmed = true;
      save();
      await ctx.answerCallbackQuery('Спасибо, ждём вас!');
      await ctx.editMessageText('Спасибо, ждём вас! 🙌');
      notifyAdmins(`✅ ${esc(b.name)} подтвердил визит — ${T.prettyDate(b.date)}, ${b.time}`);
    } else {
      b.status = 'cancelled';
      save();
      await ctx.answerCallbackQuery('Запись отменена');
      await ctx.editMessageText('Запись отменена. Будем рады видеть вас в другой раз.');
      notifyAdmins(
        `❌ <b>Отмена</b>\n${esc(b.name)} — ${esc(serviceName(b.service))}\n` +
        `${T.prettyDate(b.date)}, ${b.time}\nОкно снова свободно.`
      );
    }
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
            `${esc(serviceName(b.service))}\nМастер: ${esc(masterName(b.master))}\n\nВсё в силе?`,
            {
              parse_mode: 'HTML',
              reply_markup: new InlineKeyboard()
                .text('Приду', `cl_ok_${b.id}`)
                .text('Не смогу', `cl_no_${b.id}`),
            });
          b.remindedAt = new Date().toISOString();
          save();
        } catch (e) { console.error('Напоминание не ушло:', e.message); }
      }
    }
  }, 60000);
  // ---------- запуск ----------
  bot.catch(err => console.error(`[${cfg.id}] ошибка бота:`, err));
  bot.api.setMyCommands([{ command: 'start', description: 'Начать' }]).catch(() => {});
  bot.start();
  log('бот запущен ·', db.salon.name);

  // то, что нужно снаружи (для сайта)
  return {
    id: cfg.id,
    name: db.salon.name,
    username: BOT_USERNAME,
    db, save,
    createBooking,
    serviceName, masterName, servicePrice,
  };
};
