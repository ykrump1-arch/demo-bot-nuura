// Данные салона и записи. Хранятся в JSON-файле.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'store.json');

// ---------- начальные данные демо-салона ----------
const DEFAULT = {
  salon: {
    name: 'NUURA',
    city: 'Ташкент',
    hours: { start: '09:00', end: '20:00' },
    stepMin: 90,        // шаг сетки времени (1,5 часа)
    horizonDays: 14,    // на сколько дней вперёд можно записаться
  },
  services: [
    { id: 'manicure', name: 'Маникюр с покрытием', nameUz: 'Qoplamali manikyur',
      duration: 90, price: 180000 },
    { id: 'brows',    name: 'Брови: коррекция и окрашивание', nameUz: 'Qosh: korreksiya va bo‘yash',
      duration: 60, price: 120000 },
    { id: 'lashes',   name: 'Наращивание ресниц', nameUz: 'Kiprik qo‘shish',
      duration: 120, price: 250000 },
  ],
  masters: [
    { id: 'sabina',  name: 'Сабина',  services: ['manicure', 'brows'],             workdays: [1,2,3,4,5,6] },
    { id: 'aziza',   name: 'Азиза',   services: ['brows', 'lashes'],               workdays: [1,2,3,4,5] },
    { id: 'gulnoza', name: 'Гулноза', services: ['manicure', 'brows', 'lashes'],   workdays: [2,3,4,5,6,0] },
  ],
  // вручную закрытые окна: { masterId: { 'YYYY-MM-DD': ['11:00', '13:30'] } }
  closed: {},
  // записи
  bookings: [],
  seq: 1,
};

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // на случай если добавились новые поля
    db.salon = Object.assign({}, DEFAULT.salon, db.salon);
    // шаг сетки всегда берём из настроек кода, а не из старого файла
    db.salon.stepMin = Number(process.env.STEP_MIN || DEFAULT.salon.stepMin);
    // справочники услуг и мастеров тоже живут в коде — чтобы правки доезжали
    db.services = DEFAULT.services;
    db.masters = DEFAULT.masters;
    db.closed = db.closed || {};
    db.bookings = db.bookings || [];
    db.seq = db.seq || 1;
  } catch (e) {
    db = JSON.parse(JSON.stringify(DEFAULT));
    save();
  }
  return db;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Не смог сохранить данные:', e.message);
  }
}

function reset() {
  db = JSON.parse(JSON.stringify(DEFAULT));
  save();
}

module.exports = { load, save, reset, DEFAULT };
