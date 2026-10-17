// Данные салонов.
//   Справочник (услуги, мастера, часы) — файл salons/<id>.json в репозитории.
//   Записи клиентов — файл на диске сервера, живут отдельно и не теряются.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SALONS_DIR = path.join(__dirname, 'salons');

// если справочника нет — берём этот шаблон
const TEMPLATE = {
  salon: {
    name: 'Салон',
    city: 'Ташкент',
    hours: { start: '09:00', end: '20:00' },
    stepMin: 90,
    horizonDays: 14,
  },
  services: [
    { id: 'manicure', name: 'Маникюр с покрытием', nameUz: 'Qoplamali manikyur',
      duration: 90, price: 180000 },
  ],
  masters: [
    { id: 'master1', name: 'Мастер', services: ['manicure'], workdays: [1,2,3,4,5,6] },
  ],
};

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

// ---------- загрузка одного салона ----------
function load(salonId) {
  // 1. справочник из репозитория
  let ref;
  try {
    ref = JSON.parse(fs.readFileSync(path.join(SALONS_DIR, `${salonId}.json`), 'utf8'));
  } catch (e) {
    console.warn(`[${salonId}] нет файла salons/${salonId}.json — беру шаблон`);
    ref = JSON.parse(JSON.stringify(TEMPLATE));
  }

  // 2. записи с диска
  ensureDir(DATA_DIR);
  const file = path.join(DATA_DIR, `${salonId}.json`);
  let live;
  try {
    live = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    live = { bookings: [], closed: {}, seq: 1 };
  }

  const db = {
    salon: Object.assign({}, TEMPLATE.salon, ref.salon),
    services: ref.services || TEMPLATE.services,
    masters: ref.masters || TEMPLATE.masters,
    bookings: live.bookings || [],
    closed: live.closed || {},
    seq: live.seq || 1,
  };

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify({
        bookings: db.bookings, closed: db.closed, seq: db.seq,
      }, null, 2));
    } catch (e) {
      console.error(`[${salonId}] не смог сохранить записи:`, e.message);
    }
  }

  return { db, save };
}

module.exports = { load, TEMPLATE, DATA_DIR, SALONS_DIR };
