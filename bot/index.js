// ============================================================
//  K.PROD — один сервер, много салонов
//
//  Как добавить салон:
//    1. Создать бота у @BotFather, получить токен
//    2. Положить salons/<id>.json с услугами и мастерами
//    3. В Railway → Variables добавить:
//         SALONS      = nuura,leyla        (через запятую)
//         TOKEN_LEYLA = 123456:AA...
//         ADMINS_LEYLA = 6996710979
//         USERNAME_LEYLA = leyla_bot
//    4. Перезапустить
// ============================================================
const express = require('express');
const cors = require('cors');

const createSalon = require('./salon');
const T = require('./slots');

const API_KEY = process.env.API_KEY || 'change-me';
const SITE_ORIGIN = process.env.SITE_ORIGIN || '*';
const PORT = process.env.PORT || 3000;

// ---------- читаем список салонов из переменных окружения ----------
function readSalonConfigs() {
  const ids = (process.env.SALONS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  if (!ids.length) {
    console.error('Пусто в переменной SALONS. Пример: SALONS=nuura');
    process.exit(1);
  }

  const out = [];
  for (const id of ids) {
    const U = id.toUpperCase();
    const token = process.env[`TOKEN_${U}`];
    if (!token) {
      console.error(`[${id}] нет переменной TOKEN_${U} — салон пропущен`);
      continue;
    }
    out.push({
      id,
      token,
      admins: (process.env[`ADMINS_${U}`] || '').split(',').map(s => s.trim()).filter(Boolean),
      username: process.env[`USERNAME_${U}`] || '',
    });
  }

  if (!out.length) {
    console.error('Ни одного салона не удалось запустить — проверьте токены');
    process.exit(1);
  }
  return out;
}

// ---------- поднимаем всех ----------
const SALONS = new Map();
for (const cfg of readSalonConfigs()) {
  try {
    SALONS.set(cfg.id, createSalon(cfg));
  } catch (e) {
    console.error(`[${cfg.id}] не запустился:`, e.message);
  }
}
console.log(`Всего салонов на сервере: ${SALONS.size}`);

// ============================================================
//  API ДЛЯ САЙТОВ
//  Каждый сайт присылает свой salon — по нему находим нужный салон.
// ============================================================
const app = express();
app.use(express.json());
app.use(cors({ origin: SITE_ORIGIN === '*' ? true : SITE_ORIGIN.split(',').map(s => s.trim()) }));

function auth(req, res, next) {
  if (req.get('X-API-Key') !== API_KEY) return res.status(401).json({ error: 'Неверный ключ' });
  next();
}

// находит салон по параметру; если салон на сервере один — можно не указывать
function pick(req, res) {
  const id = String(req.query.salon || (req.body && req.body.salon) || '').trim().toLowerCase();
  if (!id) {
    if (SALONS.size === 1) return [...SALONS.values()][0];
    res.status(400).json({ error: 'Не указан салон' });
    return null;
  }
  const s = SALONS.get(id);
  if (!s) { res.status(404).json({ error: 'Такого салона нет' }); return null; }
  return s;
}

app.get('/', (req, res) =>
  res.send(`K.PROD · работает салонов: ${SALONS.size}`));

app.get('/api/config', auth, (req, res) => {
  const s = pick(req, res); if (!s) return;
  res.json({
    salonId: s.id,
    salon: s.db.salon,
    services: s.db.services,
    masters: s.db.masters,
    dates: T.dateRange(s.db.salon.horizonDays).map(d => ({
      date: d,
      label: T.shortDate(d),
      dow: ['вс','пн','вт','ср','чт','пт','сб'][T.dowOf(d)],
    })),
    botUsername: s.username,
  });
});

app.get('/api/slots', auth, (req, res) => {
  const s = pick(req, res); if (!s) return;
  const { master, date } = req.query;
  if (!master || !date) return res.status(400).json({ error: 'Нужны master и date' });
  const ids = T.svcIds(req.query.services || req.query.service);
  res.json({ slots: T.freeSlots(s.db, master, date, ids), duration: T.totalDuration(s.db, ids) });
});

// ---------- цепочка визитов: несколько мастеров подряд ----------
function parseLegs(db, raw) {
  if (!Array.isArray(raw)) return null;
  const legs = [];
  for (const l of raw) {
    const ids = T.svcIds(l && (l.services || l.service));
    if (!l || !l.master || !ids.length) return null;
    const m = db.masters.find(x => x.id === l.master);
    if (!m) return null;
    if (!ids.every(id => db.services.find(x => x.id === id))) return null;
    if (!ids.every(id => m.services.includes(id))) return null;
    legs.push({ master: l.master, services: ids });
  }
  return legs.length ? legs : null;
}

app.post('/api/chain/slots', auth, (req, res) => {
  const s = pick(req, res); if (!s) return;
  const { date } = req.body || {};
  const legs = parseLegs(s.db, req.body && req.body.legs);
  if (!date || !legs) return res.status(400).json({ error: 'Нужны date и legs' });
  res.json(T.chainSlots(s.db, date, legs));
});

app.post('/api/chain/book', auth, (req, res) => {
  const s = pick(req, res); if (!s) return;
  const { date, time, name, phone } = req.body || {};
  const legs = parseLegs(s.db, req.body && req.body.legs);
  if (!date || !time || !name || !phone || !legs) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  // проверяем всю цепочку целиком, до создания хоть одной записи
  const durs = legs.map(l => T.totalDuration(s.db, l.services));
  let cur = T.toMin(time);
  for (let i = 0; i < legs.length; i++) {
    if (!T.canFit(s.db, legs[i].master, date, cur, durs[i])) {
      return res.status(409).json({ error: 'Это время уже заняли. Выберите другое.' });
    }
    cur += durs[i];
  }

  const group = 'G' + Date.now().toString(36);
  const made = [];
  cur = T.toMin(time);
  for (let i = 0; i < legs.length; i++) {
    made.push(s.createBooking({
      service: legs[i].services, master: legs[i].master,
      date, time: T.toHHMM(cur), name, phone,
      source: req.body.source || 'site',
      group, part: i + 1, parts: legs.length,
    }));
    cur += durs[i];
  }

  res.json({
    ok: true,
    group,
    bookingId: made[0].id,
    remindUrl: `https://t.me/${s.username}?start=${made[0].id}`,
    parts: made.map(b => ({
      time: b.time, master: s.masterName(b.master),
      service: s.serviceName(b.services), duration: b.duration, price: b.price,
    })),
    summary: {
      date: T.prettyDate(date), time,
      duration: made.reduce((n, b) => n + b.duration, 0),
      price: made.reduce((n, b) => n + b.price, 0),
    },
  });
});

// ---------- запись к одному мастеру (старый путь, оставлен для совместимости) ----------
app.post('/api/book', auth, (req, res) => {
  const s = pick(req, res); if (!s) return;
  const { master, date, time, name, phone } = req.body || {};
  const ids = T.svcIds(req.body.services || req.body.service);

  if (!ids.length || !master || !date || !time || !name || !phone) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  const m = s.db.masters.find(x => x.id === master);
  if (!m) return res.status(400).json({ error: 'Нет такого мастера' });
  if (!ids.every(id => m.services.includes(id))) {
    return res.status(400).json({ error: 'Этот мастер делает не все выбранные услуги' });
  }
  if (!T.freeSlots(s.db, master, date, ids).includes(time)) {
    return res.status(409).json({ error: 'Это время уже заняли. Выберите другое.' });
  }

  const booking = s.createBooking({
    service: ids, master, date, time, name, phone,
    source: req.body.source || 'site',
  });

  res.json({
    ok: true,
    bookingId: booking.id,
    remindUrl: `https://t.me/${s.username}?start=${booking.id}`,
    summary: {
      service: s.serviceName(ids), master: s.masterName(master),
      date: T.prettyDate(date), time,
      duration: booking.duration, price: booking.price,
    },
  });
});

app.listen(PORT, () => console.log('API слушает порт', PORT));
