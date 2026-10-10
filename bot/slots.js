// Всё про время: часовой пояс Ташкента, свободные окна.
const TZ_OFFSET = 5 * 60; // Ташкент = UTC+5, без перехода на летнее время

// текущее время в Ташкенте как объект {date:'YYYY-MM-DD', min: минуты от полуночи}
function nowTashkent() {
  const d = new Date(Date.now() + TZ_OFFSET * 60000);
  return {
    date: d.toISOString().slice(0, 10),
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// день недели для даты 'YYYY-MM-DD'
function dowOf(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

// список дат на горизонт вперёд
function dateRange(days) {
  const out = [];
  const base = new Date(Date.now() + TZ_OFFSET * 60000);
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// человекочитаемая дата: "16 августа, вс"
const MONTHS = ['января','февраля','марта','апреля','мая','июня',
                'июля','августа','сентября','октября','ноября','декабря'];
const DOWS = ['вс','пн','вт','ср','чт','пт','сб'];

function prettyDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${DOWS[d.getUTCDay()]}`;
}

function shortDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

// --- главное: свободные окна мастера на дату ---
function freeSlots(db, masterId, dateStr, serviceId) {
  const master = db.masters.find(m => m.id === masterId);
  if (!master) return [];

  const dow = dowOf(dateStr);
  if (!master.workdays.includes(dow)) return [];

  const service = db.services.find(s => s.id === serviceId);
  const dur = service ? service.duration : db.salon.stepMin;

  const step = db.salon.stepMin;
  const open = toMin(db.salon.hours.start);
  const close = toMin(db.salon.hours.end);

  const now = nowTashkent();
  const isToday = dateStr === now.date;

  // занятые интервалы: активные записи этого мастера на эту дату
  const busy = db.bookings
    .filter(b => b.master === masterId && b.date === dateStr && b.status === 'active')
    .map(b => {
      const s = db.services.find(x => x.id === b.service);
      const start = toMin(b.time);
      return [start, start + (s ? s.duration : step)];
    });

  // вручную закрытые
  const closedList = (db.closed[masterId] && db.closed[masterId][dateStr]) || [];

  const out = [];
  for (let t = open; t + dur <= close; t += step) {
    const hhmm = toHHMM(t);

    if (isToday && t < now.min + 60) continue;          // не раньше чем через час
    if (closedList.includes(hhmm)) continue;            // закрыто вручную

    const overlap = busy.some(([bs, be]) => t < be && t + dur > bs);
    if (overlap) continue;

    out.push(hhmm);
  }
  return out;
}

// все окна дня (для админки — с пометкой состояния)
function daySlots(db, masterId, dateStr) {
  const step = db.salon.stepMin;
  const open = toMin(db.salon.hours.start);
  const close = toMin(db.salon.hours.end);
  const closedList = (db.closed[masterId] && db.closed[masterId][dateStr]) || [];
  const booked = db.bookings
    .filter(b => b.master === masterId && b.date === dateStr && b.status === 'active')
    .map(b => b.time);

  const out = [];
  for (let t = open; t < close; t += step) {
    const hhmm = toHHMM(t);
    let state = 'free';
    if (booked.includes(hhmm)) state = 'booked';
    else if (closedList.includes(hhmm)) state = 'closed';
    out.push({ time: hhmm, state });
  }
  return out;
}

module.exports = {
  nowTashkent, toMin, toHHMM, dowOf, dateRange,
  prettyDate, shortDate, freeSlots, daySlots, TZ_OFFSET,
};
