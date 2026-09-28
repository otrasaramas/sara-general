const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => res.send("Bot activo ✅"));
app.get("/webhook", (req, res) => res.send("Webhook listo ✅"));

// Clientes
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Estado temporal de conversación por usuario
const sessions = {};

// ─── HELPERS ───────────────────────────────────────────────────────────────

function twiReply(res, msg) {
  res.set("Content-Type", "text/xml");
  res.send(`<Response><Message>${msg}</Message></Response>`);
}

function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { step: null, data: {} };
  return sessions[phone];
}

function clearSession(phone) {
  sessions[phone] = { step: null, data: {} };
}

const HELP_MSG = `📋 *Mis Pendientes Bot*

Comandos disponibles:

➕ *agregar* — Agregar una tarea (paso a paso)
📥 *cargar* — Cargar varias tareas de una vez
📋 *lista* — Ver todas tus tareas
✅ *listo [N]* — Marcar tarea N como hecha (se archiva)
🗑 *borrar [N]* — Eliminar tarea N
📅 *calendario* — Calendario óptimo día por día con horarios
🎯 *plan [minutos]* — Plan rápido solo para hoy
🏷 *categorias* — Ver/ajustar prioridad de categorías
❓ *ayuda* — Ver este menú

🎮 *Juego de puntos*
⭐ *puntos* — Tu avatar: puntos, nivel, racha y meta de hoy
⚔️ *hice [misión] [🍅]* — Sumar una misión que no estaba en la lista (ej: *hice editar video 2*)
🛒 *tienda* — Recompensas para gastar tus puntos
🎁 *canjear [N]* — Gastar puntos en la recompensa N
➕ *premio [nombre] [costo]* — Agregar una recompensa a la tienda
🎯 *meta [N]* — Cambiar tu meta diaria de puntos
📜 *historial* — Últimos movimientos de puntos`;

const CATEGORIES = ["Trabajo", "Personal", "Salud", "Hogar", "Finanzas", "Educación", "Otro"];
const PRIORITIES = ["Alta", "Media", "Baja"];

// Eje de balance de vida: Trabajo vs Creatividad/Arte (meta 70/30)
const AREAS = ["Trabajo", "Creatividad"];
const AREA_EMOJI = { Trabajo: "💼", Creatividad: "🎨" };
const BALANCE_TARGET = { Trabajo: 0.7, Creatividad: 0.3 };

// Pomodoros: 25 min de trabajo + 5 de descanso = 30 min por ciclo
const POMODORO_WORK = 25;
const POMODORO_BREAK = 5;

// Disponibilidad por defecto (lunes a viernes, sin fines de semana)
const AVAILABILITY = {
  workDays: [1, 2, 3, 4, 5], // 1 = lunes ... 5 = viernes (getDay: 0=domingo)
  blocks: [
    { start: "07:30", end: "09:00", pomodoros: 3 }, // 90 min  → 3 🍅
    { start: "11:00", end: "13:00", pomodoros: 4 }, // 120 min → 4 🍅
    { start: "14:30", end: "17:00", pomodoros: 5 }  // 150 min → 5 🍅
  ]
};
const POMODOROS_PER_DAY = AVAILABILITY.blocks.reduce((s, b) => s + b.pomodoros, 0); // 12

const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// ─── FECHAS ────────────────────────────────────────────────────────────────

// Devuelve una fecha ISO (YYYY-MM-DD) a partir de texto libre, o null.
function parseDueDate(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t || t === "-" || t === "no" || t === "ninguna" || t === "sin fecha") return null;

  const today = new Date();
  const toISO = d => d.toISOString().slice(0, 10);

  if (t === "hoy") return toISO(today);
  if (t === "mañana" || t === "manana") {
    const d = new Date(today); d.setDate(d.getDate() + 1); return toISO(d);
  }
  if (t === "pasado mañana" || t === "pasado manana") {
    const d = new Date(today); d.setDate(d.getDate() + 2); return toISO(d);
  }

  // "en N dias" / "en N semanas"
  let m = t.match(/^en\s+(\d+)\s+d[ií]as?$/);
  if (m) { const d = new Date(today); d.setDate(d.getDate() + parseInt(m[1])); return toISO(d); }
  m = t.match(/^en\s+(\d+)\s+semanas?$/);
  if (m) { const d = new Date(today); d.setDate(d.getDate() + parseInt(m[1]) * 7); return toISO(d); }

  // Próximo día de la semana: "lunes", "el viernes", etc.
  const dayIdx = DAY_NAMES.findIndex(n => t === n || t === `el ${n}` || t === `próximo ${n}` || t === `proximo ${n}`);
  if (dayIdx >= 0) {
    const d = new Date(today);
    let diff = (dayIdx - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    return toISO(d);
  }

  // YYYY-MM-DD
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;

  // DD/MM o DD/MM/YYYY (también con guiones)
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const day = parseInt(m[1]), month = parseInt(m[2]);
    let year = m[3] ? parseInt(m[3]) : today.getFullYear();
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Si la fecha (sin año) ya pasó este año, asumimos el próximo año
    let d = new Date(year, month - 1, day);
    if (!m[3] && d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
      d = new Date(year + 1, month - 1, day);
    }
    return toISO(d);
  }

  return null;
}

// Muestra una fecha ISO de forma amable: "vie 20 jun"
function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T12:00:00");
  const dow = DAY_NAMES[d.getDay()].slice(0, 3);
  return `${dow} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
}

// Días restantes hasta la fecha de entrega (puede ser negativo si venció)
function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d = new Date(iso + "T12:00:00");
  return Math.round((d - t0) / (1000 * 60 * 60 * 24));
}

// Muestra una cantidad de pomodoros: "2 pomodoros", "1 pomodoro", "1.5 pomodoros"
function fmtPomos(n) {
  if (n == null) return "—";
  return `${n} pomodoro${n === 1 ? "" : "s"}`;
}

// Fecha local YYYY-MM-DD (según la zona horaria del servidor: configurá TZ, ej: TZ=America/Bogota)
function localISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysISO(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localISO(d);
}

// ─── JUEGO: PUNTOS Y MISIONES ──────────────────────────────────────────────
// Sos un avatar: cada tarea o misión completada da puntos (10 por 🍅).
// Cada día hábil hay una meta: si la alcanzás sumás racha, si no, perdés los puntos que faltaron.
// Los puntos se gastan en la tienda de recompensas. El XP (todo lo ganado) sube tu nivel.

const PUNTOS_POR_POMODORO = 10;
const META_DIARIA_DEFAULT = 80;  // 8 🍅 de los 12 disponibles por día
const BONO_RACHA_CADA = 5;       // cada 5 días seguidos cumpliendo la meta...
const BONO_RACHA = 50;           // ...+50 pts de bono
const XP_POR_NIVEL = 500;
const GANANCIAS = ["tarea", "mision"]; // tipos de movimiento que cuentan para la meta diaria
const KIND_EMOJI = { tarea: "✅", mision: "⚔️", canje: "🎁", castigo: "📉", bono: "🔥" };

const RECOMPENSAS_DEFAULT = [
  { name: "📱 30 min de redes / scroll", cost: 40 },
  { name: "📺 Un capítulo de serie", cost: 50 },
  { name: "🎮 1 hora de ocio sin culpa", cost: 80 },
  { name: "☕ Antojo o café afuera", cost: 100 },
  { name: "🛍 Comprarme algo que quiero", cost: 400 }
];

const pomosToPoints = p => Math.max(1, Math.round(p * PUNTOS_POR_POMODORO));
const nivel = xp => Math.floor(xp / XP_POR_NIVEL) + 1;
const isWorkDay = iso => AVAILABILITY.workDays.includes(new Date(iso + "T12:00:00").getDay());

function progressBar(value, goal) {
  const filled = Math.min(10, Math.floor((value / goal) * 10));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

async function logPoints(phone, kind, points, note, day = localISO()) {
  await supabase.from("point_log").insert({ phone, day, kind, points, note });
}

async function getPlayer(phone) {
  const { data } = await supabase.from("players").select("*").eq("phone", phone).maybeSingle();
  if (data) return data;
  const { data: created, error } = await supabase
    .from("players")
    .insert({ phone, points: 0, xp: 0, streak: 0, best_streak: 0, daily_goal: META_DIARIA_DEFAULT, last_day: localISO() })
    .select()
    .single();
  if (error) throw error;
  await supabase.from("rewards").insert(RECOMPENSAS_DEFAULT.map(r => ({ phone, ...r })));
  return created;
}

// Cierra los días pendientes (desde last_day hasta ayer): racha y bono si se cumplió la meta,
// castigo si no. Los fines de semana no tienen meta. Devuelve líneas para avisarle al usuario.
async function settleDays(player) {
  const today = localISO();
  if (player.last_day >= today) return [];

  const { data: logs } = await supabase
    .from("point_log")
    .select("day, points")
    .eq("phone", player.phone)
    .in("kind", GANANCIAS)
    .gte("day", player.last_day)
    .lt("day", today);
  const earnedByDay = {};
  (logs || []).forEach(l => { earnedByDay[l.day] = (earnedByDay[l.day] || 0) + l.points; });

  const goal = player.daily_goal;
  let { points, xp, streak, best_streak } = player;
  const events = [];

  for (let d = player.last_day; d < today; d = addDaysISO(d, 1)) {
    if (!isWorkDay(d)) continue;
    const earned = earnedByDay[d] || 0;
    if (earned >= goal) {
      streak++;
      best_streak = Math.max(best_streak, streak);
      let line = `✅ ${formatDate(d)}: meta cumplida (${earned}/${goal}) · racha ${streak} 🔥`;
      if (streak % BONO_RACHA_CADA === 0) {
        points += BONO_RACHA;
        xp += BONO_RACHA;
        await logPoints(player.phone, "bono", BONO_RACHA, `Racha de ${streak} días`, d);
        line += ` · 🎁 +${BONO_RACHA} de bono`;
      }
      events.push(line);
    } else {
      const lost = Math.min(points, goal - earned);
      points -= lost;
      if (lost) await logPoints(player.phone, "castigo", -lost, `Meta no cumplida (${earned}/${goal})`, d);
      const perdida = lost ? `-${lost} pts` : "no tenías puntos para perder";
      events.push(`📉 ${formatDate(d)}: no llegaste a la meta (${earned}/${goal}) · ${perdida}${streak ? " · se cortó la racha" : ""}`);
      streak = 0;
    }
  }

  await supabase.from("players").update({ points, xp, streak, best_streak, last_day: today }).eq("phone", player.phone);
  Object.assign(player, { points, xp, streak, best_streak, last_day: today });
  return events;
}

async function loadPlayer(phone) {
  const player = await getPlayer(phone);
  const events = await settleDays(player);
  return { player, events };
}

// Antepone el resumen de días cerrados (si hay) a la respuesta
function withEvents(events, body) {
  if (!events.length) return body;
  const shown = events.length > 5 ? [...events.slice(-5), `…y ${events.length - 5} día(s) antes`] : events;
  return `📆 *Días cerrados*\n${shown.join("\n")}\n\n${body}`;
}

async function earnedToday(phone) {
  const { data } = await supabase
    .from("point_log")
    .select("points")
    .eq("phone", phone)
    .eq("day", localISO())
    .in("kind", GANANCIAS);
  return (data || []).reduce((s, l) => s + l.points, 0);
}

async function earnPoints(player, kind, points, note) {
  const nivelAntes = nivel(player.xp);
  await logPoints(player.phone, kind, points, note);
  player.points += points;
  player.xp += points;
  await supabase.from("players").update({ points: player.points, xp: player.xp }).eq("phone", player.phone);

  const hoy = await earnedToday(player.phone);
  const goal = player.daily_goal;
  let msg = `🪙 *+${points} pts* (tenés ${player.points})`;
  if (isWorkDay(localISO())) {
    msg += `\n🎯 Hoy: ${hoy}/${goal} ${progressBar(hoy, goal)}`;
    if (hoy >= goal && hoy - points < goal) msg += `\n🏆 *¡Meta del día cumplida!*`;
  } else {
    msg += `\n🌴 Hoy no hay meta: esto es puro extra.`;
  }
  if (nivel(player.xp) > nivelAntes) msg += `\n⬆️ *¡Subiste a nivel ${nivel(player.xp)}!*`;
  return msg;
}

async function formatStatus(phone) {
  const { player, events } = await loadPlayer(phone);
  const hoy = await earnedToday(phone);
  const goal = player.daily_goal;
  const lvl = nivel(player.xp);
  const faltaNivel = lvl * XP_POR_NIVEL - player.xp;

  let msg = `🎮 *Tu avatar*\n\n`;
  msg += `⭐ Nivel ${lvl} · ${player.xp} XP (${faltaNivel} para el nivel ${lvl + 1})\n`;
  msg += `🪙 Puntos para gastar: *${player.points}*\n`;
  msg += `🔥 Racha: ${player.streak} día(s) (mejor: ${player.best_streak})\n\n`;

  if (isWorkDay(localISO())) {
    const pct = Math.min(100, Math.round((hoy / goal) * 100));
    msg += `🎯 *Hoy* (${formatDate(localISO())}): ${hoy}/${goal}\n${progressBar(hoy, goal)} ${pct}%\n`;
    if (hoy >= goal) {
      msg += `🏆 ¡Meta cumplida! Lo que sumes ahora es extra.`;
    } else {
      const falta = goal - hoy;
      msg += `Te faltan ${falta} pts (~${fmtPomos(Math.ceil(falta / PUNTOS_POR_POMODORO))}). Si no llegás, al cerrar el día perdés hasta ${falta} pts.`;
    }
  } else {
    msg += `🌴 Hoy es fin de semana: sin meta. Lo que hagas suma extra (${hoy} pts hoy).`;
  }

  msg += `\n\n*hice [misión] [🍅]* · *listo N* · *tienda* · *historial*`;
  return withEvents(events, msg);
}

async function getRewards(phone) {
  const { data } = await supabase.from("rewards").select("*").eq("phone", phone).order("cost", { ascending: true });
  return data || [];
}

async function formatShop(phone) {
  const { player, events } = await loadPlayer(phone);
  const rewards = await getRewards(phone);
  let msg = `🛒 *Tienda de recompensas*\nTenés *${player.points}* 🪙\n\n`;
  if (!rewards.length) msg += `Todavía no tenés recompensas.\n`;
  rewards.forEach((r, i) => {
    const estado = player.points >= r.cost ? "✅" : `🔒 (faltan ${r.cost - player.points})`;
    msg += `${i + 1}. ${r.name} — *${r.cost}* ${estado}\n`;
  });
  msg += `\nCanjeá con *canjear N*.\nAgregá con *premio [nombre] [costo]* (ej: *premio Ir al cine 150*).\nQuitá con *quitar premio N*.`;
  return withEvents(events, msg);
}

async function formatHistory(phone) {
  const { events } = await loadPlayer(phone);
  const { data } = await supabase
    .from("point_log")
    .select("*")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(15);
  if (!data?.length) return withEvents(events, "📜 Todavía no hay movimientos. ¡Completá una misión con *listo N* o *hice ...*!");
  let msg = `📜 *Últimos movimientos*\n\n`;
  data.forEach(l => {
    const signo = l.points > 0 ? `+${l.points}` : `${l.points}`;
    msg += `${KIND_EMOJI[l.kind] || "•"} ${formatDate(l.day)} · *${signo}* · ${l.note || l.kind}\n`;
  });
  return withEvents(events, msg);
}

// ─── TAREAS ────────────────────────────────────────────────────────────────

async function getTasks(phone) {
  const { data } = await supabase
    .from("tasks")
    .select("*")
    .eq("phone", phone)
    .eq("done", false)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("cat_priority", { ascending: true })
    .order("priority", { ascending: true });
  return data || [];
}

async function formatTaskList(phone) {
  const tasks = await getTasks(phone);
  if (!tasks.length) return "✨ No tienes tareas pendientes. Usa *agregar* para añadir una.";

  const priorityLabel = { Alta: "🔴", Media: "🟡", Baja: "🟢" };
  let msg = `📋 *Tus pendientes (${tasks.length})*\n\n`;
  tasks.forEach((t, i) => {
    const areaTag = t.area ? `${AREA_EMOJI[t.area]} ${t.area} · ` : "";
    const pomoTag = t.pomodoros ? `🍅 ${t.pomodoros} · ` : "";
    msg += `${i + 1}. ${priorityLabel[t.priority]} *${t.name}*\n`;
    msg += `   ${pomoTag}${areaTag}⏱ ${t.minutes}min · 📁 ${t.category}\n`;
    if (t.due_date) {
      const dias = daysUntil(t.due_date);
      let aviso = "";
      if (dias < 0) aviso = ` ⚠️ vencida hace ${Math.abs(dias)}d`;
      else if (dias === 0) aviso = " ⚠️ ¡es hoy!";
      else if (dias === 1) aviso = " ⏰ mañana";
      else if (dias <= 3) aviso = ` ⏰ en ${dias}d`;
      msg += `   📅 Entrega: ${formatDate(t.due_date)}${aviso}\n`;
    }
  });
  const total = tasks.reduce((s, t) => s + t.minutes, 0);
  const totalPomos = tasks.reduce((s, t) => s + (t.pomodoros || 0), 0);
  const dias = (totalPomos / POMODOROS_PER_DAY).toFixed(1).replace(/\.0$/, "");
  msg += `\n⏳ Total: ${totalPomos ? `${totalPomos} 🍅 · ` : ""}${Math.floor(total / 60)}h ${total % 60}m`;
  if (totalPomos) msg += `\n📆 ~${dias} día(s) llenos (${POMODOROS_PER_DAY} 🍅/día)`;
  return msg;
}

// ─── FLUJO AGREGAR TAREA ───────────────────────────────────────────────────

async function handleAgregar(phone, msg, session, res) {
  const s = session;

  if (!s.step) {
    s.step = "agregar_nombre";
    return twiReply(res, "➕ ¿Cómo se llama la tarea?");
  }

  if (s.step === "agregar_nombre") {
    s.data.name = msg;
    s.step = "agregar_area";
    return twiReply(res, `🎯 ¿Es de *trabajo* o de *creatividad/arte*?\n\n1. 💼 Trabajo\n2. 🎨 Creatividad`);
  }

  if (s.step === "agregar_area") {
    const map = { "1": "Trabajo", "2": "Creatividad", trabajo: "Trabajo", t: "Trabajo", creatividad: "Creatividad", arte: "Creatividad", c: "Creatividad" };
    const area = map[msg.toLowerCase().trim()];
    if (!area) return twiReply(res, "Respondé 1 (Trabajo) o 2 (Creatividad).");
    s.data.area = area;
    s.step = "agregar_pomodoros";
    return twiReply(res, `🍅 ¿Cuántos *pomodoros* creés que toma *${s.data.name}*?\n\n(1 pomodoro = 25 min de trabajo. Podés usar medios, ej: 1.5)`);
  }

  if (s.step === "agregar_pomodoros") {
    const pomos = parseFloat(msg.replace(",", "."));
    if (isNaN(pomos) || pomos <= 0) return twiReply(res, "Ingresá un número válido de pomodoros (ej: 1, 2, 1.5).");
    s.data.pomodoros = pomos;
    s.data.minutes = Math.round(pomos * POMODORO_WORK); // minutos de trabajo
    s.step = "agregar_prioridad";
    return twiReply(res, `🎯 ¿Qué prioridad tiene?\n\n1. Alta\n2. Media\n3. Baja`);
  }

  if (s.step === "agregar_prioridad") {
    const map = { "1": "Alta", "2": "Media", "3": "Baja", alta: "Alta", media: "Media", baja: "Baja" };
    const priority = map[msg.toLowerCase()];
    if (!priority) return twiReply(res, "Respondé 1, 2 o 3 (o Alta/Media/Baja).");
    s.data.priority = priority;
    s.step = "agregar_fecha";
    return twiReply(res, `📅 ¿Para cuándo es? (fecha de entrega)\n\nEjemplos: *mañana*, *viernes*, *20/06*, *en 3 dias*.\nSi no tiene fecha, escribí *-*.`);
  }

  if (s.step === "agregar_fecha") {
    if (msg.trim() !== "-" && parseDueDate(msg) === null) {
      return twiReply(res, "No entendí la fecha 🤔. Probá con *mañana*, *viernes*, *20/06* o *en 3 dias*. Si no tiene fecha, escribí *-*.");
    }
    s.data.due_date = parseDueDate(msg); // null si "-"
    s.step = "agregar_categoria";
    return twiReply(res, `📁 ¿Categoría?\n\n${CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }

  if (s.step === "agregar_categoria") {
    const idx = parseInt(msg) - 1;
    const byName = CATEGORIES.find(c => c.toLowerCase() === msg.toLowerCase());
    const category = CATEGORIES[idx] || byName;
    if (!category) return twiReply(res, `Elegí un número del 1 al ${CATEGORIES.length}.`);
    s.data.category = category;

    // Obtener prioridad de categoría del usuario
    const { data: catData } = await supabase
      .from("tasks")
      .select("category, cat_priority")
      .eq("phone", phone)
      .eq("category", category)
      .limit(1);

    const catPriority = catData?.[0]?.cat_priority ?? 5;

    await supabase.from("tasks").insert({
      phone,
      name: s.data.name,
      minutes: s.data.minutes,
      pomodoros: s.data.pomodoros || null,
      priority: s.data.priority,
      category,
      cat_priority: catPriority,
      due_date: s.data.due_date || null,
      area: s.data.area || null,
      done: false
    });

    clearSession(phone);
    const fechaTxt = s.data.due_date ? `\n📅 Entrega: ${formatDate(s.data.due_date)}` : "";
    const areaTxt = s.data.area ? `${AREA_EMOJI[s.data.area]} ${s.data.area} · ` : "";
    return twiReply(res, `✅ Tarea guardada:\n\n*${s.data.name}*\n${areaTxt}🍅 ${fmtPomos(s.data.pomodoros)} (${s.data.minutes}min) · ${s.data.priority} · ${category}${fechaTxt}\n\nEscribí *lista* para ver tus pendientes o *calendario* para tu plan.`);
  }
}

// ─── GENERAR PLAN CON IA ───────────────────────────────────────────────────

async function generatePlan(phone, availableMinutes, extraContext) {
  const tasks = await getTasks(phone);
  if (!tasks.length) return "No tenés tareas pendientes. Usá *agregar* para añadir una.";

  const taskList = tasks
    .map(t => `- "${t.name}" | ${t.minutes}min | Prioridad: ${t.priority} | Categoría: ${t.category} (prioridad de categoría: ${t.cat_priority}/10)`)
    .join("\n");

  const prompt = `Sos un experto en productividad y gestión del tiempo. Tu objetivo es ayudar al usuario a completar la mayor cantidad de tareas importantes en el menor tiempo posible.

El usuario tiene ${availableMinutes} minutos disponibles hoy.
${extraContext ? `Contexto: ${extraContext}` : ""}

Sus tareas pendientes (ordenadas por prioridad):
${taskList}

Generá un plan ultra-eficiente considerando:
1. Prioridad de categoría (número más bajo = más prioritaria)
2. Prioridad de tarea (Alta > Media > Baja)
3. Agrupá tareas de la misma categoría para evitar cambios de contexto
4. Sugerí técnicas de eficiencia si aplica (pomodoro, batching, etc.)
5. Si hay tareas que se pueden hacer en paralelo o mientras se espera algo, indicálo

Respondé en este formato:
PLAN:
[lista numerada, cada ítem: Número. Tarea - Xmin - tip de eficiencia si aplica]

TIEMPO TOTAL: Xmin de ${availableMinutes}min disponibles

ESTRATEGIA:
[2-3 oraciones sobre la lógica y cómo hacer todo más rápido]

CONSEJO:
[un tip concreto de productividad para hoy]`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }]
  });

  return response.content[0].text;
}

// ─── GENERAR CALENDARIO DIARIO CON HORARIOS ────────────────────────────────

async function generateCalendar(phone, extraContext) {
  const tasks = await getTasks(phone);
  if (!tasks.length) return "No tenés tareas pendientes. Usá *agregar* para añadir una.";

  const today = new Date();
  const todayStr = `${DAY_NAMES[today.getDay()]} ${today.getDate()} de ${MONTH_NAMES[today.getMonth()]} de ${today.getFullYear()}`;

  const taskList = tasks
    .map(t => {
      const fecha = t.due_date ? formatDate(t.due_date) : "sin fecha";
      const dias = t.due_date ? daysUntil(t.due_date) : null;
      const venc = dias === null ? "" : dias < 0 ? ` (¡VENCIDA hace ${Math.abs(dias)} días!)` : ` (en ${dias} días)`;
      const area = t.area || "Sin clasificar";
      const pomos = t.pomodoros ? `${t.pomodoros} pomodoro(s)` : `${Math.ceil(t.minutes / POMODORO_WORK)} pomodoro(s) aprox`;
      return `- "${t.name}" | Área: ${area} | ${pomos} (${t.minutes}min) | Prioridad: ${t.priority} | Categoría: ${t.category} | Entrega: ${fecha}${venc}`;
    })
    .join("\n");

  // Balance actual por área en pomodoros (meta 70% Trabajo / 30% Creatividad)
  const pom = { Trabajo: 0, Creatividad: 0 };
  tasks.forEach(t => { if (t.area && pom[t.area] !== undefined) pom[t.area] += (t.pomodoros || t.minutes / POMODORO_WORK); });
  const totalAreaPom = pom.Trabajo + pom.Creatividad;
  const balanceTxt = totalAreaPom === 0
    ? "Aún no hay tareas clasificadas por área."
    : `Trabajo: ${Math.round(pom.Trabajo / totalAreaPom * 100)}% (${+pom.Trabajo.toFixed(1)} 🍅) · Creatividad: ${Math.round(pom.Creatividad / totalAreaPom * 100)}% (${+pom.Creatividad.toFixed(1)} 🍅). Meta: 70% Trabajo / 30% Creatividad.`;

  const blocksTxt = AVAILABILITY.blocks.map(b => `${b.start}–${b.end} (${b.pomodoros} 🍅)`).join(", ");

  const prompt = `Sos un experto en productividad y planificación. Tu objetivo es armar un CALENDARIO DIARIO con horarios concretos para que el usuario complete sus tareas a tiempo, sin agobiarse.

HOY es ${todayStr}.

MÉTODO POMODORO: 1 pomodoro = ${POMODORO_WORK} min de trabajo + ${POMODORO_BREAK} min de descanso. Pensá y agendá TODO en pomodoros.

DISPONIBILIDAD POR DEFECTO del usuario (de lunes a viernes, NO fines de semana):
Bloques libres cada día y cuántos pomodoros entran en cada uno: ${blocksTxt}.
En total son ${POMODOROS_PER_DAY} pomodoros por día. Dentro de cada bloque, poné un descanso de ${POMODORO_BREAK} min entre pomodoros; los huecos entre bloques son los descansos largos.

${extraContext ? `AVISOS DEL USUARIO PARA ESTA SEMANA (tienen prioridad sobre la disponibilidad por defecto): ${extraContext}\n` : ""}
BALANCE DE VIDA (importante para el usuario): busca un equilibrio de ~70% Trabajo y ~30% Creatividad/Arte en los pomodoros dedicados.
Balance actual de tareas pendientes → ${balanceTxt}

Tareas pendientes:
${taskList}

Reglas para armar el calendario:
1. RESPETÁ las fechas de entrega: ninguna tarea puede quedar agendada después de su fecha. Las vencidas o más próximas van primero. (Esta regla manda sobre el balance.)
2. Trabajá en pomodoros: cada tarea ocupa su cantidad de pomodoros. Un bloque no puede tener más pomodoros de los que le caben.
3. Dentro de lo posible, equilibrá apuntando a 70% Trabajo / 30% Creatividad. Intercalá algo de creatividad la mayoría de los días para que no quede todo trabajo al inicio y arte al final.
4. Asigná horarios concretos respetando los descansos (ej: 07:30–07:55 trabajo, 07:55–08:00 descanso).
5. Si una tarea necesita más pomodoros de los que quedan en el día, partila y seguí al día siguiente (indicá "🍅 1 de 3", etc.).
6. Empezá desde HOY. Solo usá días hábiles (lunes a viernes) salvo que el usuario avise lo contrario en sus avisos.
7. Si el usuario avisó que un día está por fuera o que tiene tiempo extra (ej: un domingo), ajustá ese día.
8. Si no alcanzan los pomodoros para entregar algo a tiempo, marcá una ⚠️ ALERTA indicando qué tarea está en riesgo.
9. Si el balance está muy lejos del 70/30 (ej: no hay tareas de creatividad), mencionalo amablemente y sugerí sumar alguna.

Respondé en este formato (claro y para WhatsApp, usando *negritas* y emojis con moderación):

📅 *TU CALENDARIO*

*[Día fecha]* (X 🍅)
🍅 HH:MM–HH:MM — Tarea
🍅 HH:MM–HH:MM — Tarea
☕ HH:MM–HH:MM — Descanso largo

*[Día fecha]* (X 🍅)
... (continuá los días necesarios hasta agendar todo)

Al final agregá:
✅ *Resumen:* cuántos pomodoros en total, cuántos días toma, si llegás a todas las entregas y el balance Trabajo/Creatividad que quedó (ej: 68% / 32%).
⚠️ *Alertas:* (solo si hay tareas en riesgo de no llegar a tiempo o si el balance quedó lejos del 70/30)`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }]
  });

  return response.content[0].text;
}

// ─── CARGA MASIVA DE TAREAS ─────────────────────────────────────────────────

async function bulkAddTasks(phone, text) {
  const today = new Date();
  const todayStr = `${DAY_NAMES[today.getDay()]} ${today.getDate()} de ${MONTH_NAMES[today.getMonth()]} de ${today.getFullYear()} (ISO: ${today.toISOString().slice(0, 10)})`;

  const prompt = `Extraé las tareas de la siguiente lista que escribió el usuario. Cada línea suele ser una tarea.

HOY es ${todayStr}.

Para cada tarea devolvé estos campos:
- name: nombre corto de la tarea (string)
- area: una de ["Trabajo", "Creatividad"] (Creatividad = arte/creativo). Si no se entiende, usá "Trabajo".
- pomodoros: número de pomodoros de 25 min (acepta decimales). Si el usuario dio minutos u horas, convertilo (1 pomodoro = 25 min). Si no se indica, usá 1.
- priority: una de ["Alta", "Media", "Baja"]. "urgente"→Alta. Si no se indica, "Media".
- due_date: fecha de entrega en formato YYYY-MM-DD calculada respecto a HOY, o null si no tiene. Interpretá "mañana", "viernes", "20/06", "en 3 dias", etc.
- category: una de ["Trabajo", "Personal", "Salud", "Hogar", "Finanzas", "Educación", "Otro"]. Si no se entiende, "Otro".

Lista del usuario:
"""
${text}
"""

Respondé ÚNICAMENTE con un array JSON válido, sin texto adicional ni markdown. Ejemplo:
[{"name":"Diseñar logo","area":"Creatividad","pomodoros":3,"priority":"Alta","due_date":"2026-06-19","category":"Trabajo"}]`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }]
  });

  let raw = response.content[0].text.trim();
  raw = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = raw.indexOf("["), end = raw.lastIndexOf("]");
  if (start >= 0 && end >= 0) raw = raw.slice(start, end + 1);

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed) || !parsed.length) return null;

  // Prioridad de categoría existente del usuario
  const { data: existing } = await supabase.from("tasks").select("category, cat_priority").eq("phone", phone);
  const catPrio = {};
  (existing || []).forEach(r => { if (catPrio[r.category] === undefined) catPrio[r.category] = r.cat_priority; });

  const rows = parsed.map(t => {
    const area = AREAS.includes(t.area) ? t.area : "Trabajo";
    const priority = PRIORITIES.includes(t.priority) ? t.priority : "Media";
    const category = CATEGORIES.includes(t.category) ? t.category : "Otro";
    const pomodoros = (!isNaN(parseFloat(t.pomodoros)) && parseFloat(t.pomodoros) > 0) ? parseFloat(t.pomodoros) : 1;
    const due = (typeof t.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.due_date)) ? t.due_date : null;
    return {
      phone,
      name: String(t.name || "Tarea sin nombre").slice(0, 200),
      pomodoros,
      minutes: Math.round(pomodoros * POMODORO_WORK),
      priority,
      category,
      cat_priority: catPrio[category] ?? 5,
      due_date: due,
      area,
      done: false
    };
  });

  await supabase.from("tasks").insert(rows);
  return rows;
}

// ─── WEBHOOK PRINCIPAL ─────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  const phone = req.body.From?.replace("whatsapp:", "");
  const msg = req.body.Body?.trim();

  if (!phone || !msg) return twiReply(res, "Error procesando mensaje.");

  const session = getSession(phone);
  const cmd = msg.toLowerCase();

  // Si hay una sesión activa, continuar el flujo
  if (session.step?.startsWith("agregar")) {
    return handleAgregar(phone, msg, session, res);
  }

  if (session.step === "plan_contexto") {
    const { minutes } = session.data;
    clearSession(phone);
    try {
      const plan = await generatePlan(phone, minutes, msg === "-" ? "" : msg);
      return twiReply(res, plan);
    } catch {
      return twiReply(res, "Error generando el plan. Intentá de nuevo.");
    }
  }

  if (session.step === "cal_contexto") {
    clearSession(phone);
    try {
      const cal = await generateCalendar(phone, msg.trim() === "-" ? "" : msg);
      return twiReply(res, cal);
    } catch (e) {
      return twiReply(res, "Error generando el calendario. Intentá de nuevo.");
    }
  }

  if (session.step === "cargar_lista") {
    clearSession(phone);
    if (msg.trim() === "-" || cmd === "cancelar") return twiReply(res, "Carga cancelada.");
    try {
      const rows = await bulkAddTasks(phone, msg);
      if (!rows) return twiReply(res, "No pude interpretar la lista 🤔. Asegurate de poner una tarea por línea. Probá de nuevo con *cargar*.");
      const pomTotal = rows.reduce((s, r) => s + r.pomodoros, 0);
      let out = `✅ Cargué *${rows.length}* tarea(s):\n\n`;
      rows.forEach((r, i) => {
        const f = r.due_date ? ` · 📅 ${formatDate(r.due_date)}` : "";
        out += `${i + 1}. ${AREA_EMOJI[r.area]} *${r.name}* — 🍅 ${r.pomodoros} · ${r.priority}${f}\n`;
      });
      out += `\n🍅 Total: ${+pomTotal.toFixed(1)} (~${(pomTotal / POMODOROS_PER_DAY).toFixed(1)} días)\n\nEscribí *calendario* para tu plan o *lista* para revisarlas.`;
      return twiReply(res, out);
    } catch {
      return twiReply(res, "Error procesando la lista. Intentá de nuevo con *cargar*.");
    }
  }

  if (session.step?.startsWith("cat_")) {
    return handleCategorias(phone, msg, session, res);
  }

  // Comandos principales
  if (cmd === "agregar" || cmd === "nueva" || cmd === "add") {
    return handleAgregar(phone, msg, session, res);
  }

  if (cmd === "cargar" || cmd === "varias" || cmd === "cargar tareas" || cmd === "lote") {
    session.step = "cargar_lista";
    session.data = {};
    return twiReply(res, `📥 *Carga masiva*\n\nPegá todas tus tareas en un mensaje, *una por línea*, con este formato:\n\n*Tarea | área | pomodoros | prioridad | fecha | categoría*\n\nEjemplo:\nDiseñar logo | creatividad | 3 | alta | viernes | Trabajo\nReporte mensual | trabajo | 4 | alta | mañana | Trabajo\nBocetos serie | creatividad | 2 | media | - | Personal\n\n💡 Si te falta algún dato, igual lo entiendo (uso valores por defecto). La fecha podés escribirla como *mañana, viernes, 20/06, en 3 dias* o *-* si no tiene.\n\nEscribí *-* para cancelar.`);
  }

  if (cmd === "lista" || cmd === "pendientes" || cmd === "mis pendientes") {
    const list = await formatTaskList(phone);
    return twiReply(res, list);
  }

  if (cmd.startsWith("listo ") || cmd.startsWith("done ")) {
    const n = parseInt(cmd.split(" ")[1]);
    const tasks = await getTasks(phone);
    const task = tasks[n - 1];
    if (!task) return twiReply(res, `No encontré la tarea número ${n}. Escribí *lista* para ver tus tareas.`);
    await supabase.from("tasks").update({ done: true }).eq("id", task.id);
    let out = `✅ *${task.name}* marcada como completada. 💪`;
    try {
      const { player, events } = await loadPlayer(phone);
      const pomos = task.pomodoros || task.minutes / POMODORO_WORK;
      out = withEvents(events, `${out}\n\n${await earnPoints(player, "tarea", pomosToPoints(pomos), task.name)}`);
    } catch (e) {
      console.error("Juego:", e.message); // si el juego falla, la tarea igual queda completada
    }
    return twiReply(res, out);
  }

  // ─── Juego de puntos ───
  const GAME_ERROR = "Error en el juego de puntos 🎮. ¿Ya creaste las tablas de *supabase/juego.sql*?";

  if (["puntos", "estado", "juego", "avatar", "nivel"].includes(cmd)) {
    try { return twiReply(res, await formatStatus(phone)); }
    catch (e) { console.error("Juego:", e.message); return twiReply(res, GAME_ERROR); }
  }

  if (/^(hice|misi[oó]n)(\s|$)/.test(cmd)) {
    const rest = msg.replace(/^\S+\s*/, "").trim();
    if (!rest) return twiReply(res, "⚔️ Contame qué hiciste y cuántos 🍅 te tomó. Ej: *hice editar video 2* o *hice plan de la semana 1*");
    const m = rest.match(/^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(?:🍅|pomodoros?|pomos?)?$/i);
    const name = (m ? m[1] : rest).slice(0, 200);
    const pomos = m ? parseFloat(m[2].replace(",", ".")) : 1;
    if (!(pomos > 0) || pomos > 24) return twiReply(res, "Ingresá una cantidad de pomodoros válida (ej: 1, 2, 1.5).");
    try {
      const { player, events } = await loadPlayer(phone);
      const body = `⚔️ Misión cumplida: *${name}* (${fmtPomos(pomos)})\n\n${await earnPoints(player, "mision", pomosToPoints(pomos), name)}`;
      return twiReply(res, withEvents(events, body));
    } catch (e) { console.error("Juego:", e.message); return twiReply(res, GAME_ERROR); }
  }

  if (["tienda", "recompensas", "premios"].includes(cmd)) {
    try { return twiReply(res, await formatShop(phone)); }
    catch (e) { console.error("Juego:", e.message); return twiReply(res, GAME_ERROR); }
  }

  if (cmd.startsWith("canjear ") || cmd.startsWith("gastar ")) {
    const n = parseInt(cmd.split(" ")[1]);
    try {
      const { player, events } = await loadPlayer(phone);
      const reward = (await getRewards(phone))[n - 1];
      if (!reward) return twiReply(res, withEvents(events, `No encontré la recompensa ${n}. Escribí *tienda* para verlas.`));
      if (player.points < reward.cost) {
        return twiReply(res, withEvents(events, `🔒 *${reward.name}* cuesta ${reward.cost} y tenés ${player.points}. Te faltan ${reward.cost - player.points} pts (~${fmtPomos(Math.ceil((reward.cost - player.points) / PUNTOS_POR_POMODORO))}). ¡Vos podés! 💪`));
      }
      player.points -= reward.cost;
      await logPoints(phone, "canje", -reward.cost, reward.name);
      await supabase.from("players").update({ points: player.points }).eq("phone", phone);
      return twiReply(res, withEvents(events, `🎁 Canjeaste *${reward.name}* por ${reward.cost} pts.\n🪙 Te quedan ${player.points}.\n\n¡Disfrutalo sin culpa, te lo ganaste! ✨`));
    } catch (e) { console.error("Juego:", e.message); return twiReply(res, GAME_ERROR); }
  }

  if (cmd.startsWith("premio ")) {
    const m = msg.replace(/^\S+\s*/, "").trim().match(/^(.+?)\s+(\d+)$/);
    if (!m || parseInt(m[2]) <= 0) return twiReply(res, "Formato: *premio [nombre] [costo]*. Ej: *premio Ir al cine 150*");
    try {
      await getPlayer(phone);
      await supabase.from("rewards").insert({ phone, name: m[1].slice(0, 200), cost: parseInt(m[2]) });
      return twiReply(res, `🛒 Agregué *${m[1]}* a la tienda por ${parseInt(m[2])} pts.\n\nEscribí *tienda* para verla.`);
    } catch (e) { console.error("Juego:", e.message); return twiReply(res, GAME_ERROR); }
  }

  if (cmd.startsWith("quitar premio ")) {
    const n = parseInt(cmd.split(" ")[2]);
    try {
      const reward = (await getRewards(phone))[n - 1];
      if (!reward) return twiReply(res, `No encontré la recompensa ${n}. Escribí *tienda* para verlas.`);
      await supabase.from("rewards").delete().eq("id", reward.id);
      return twiReply(res, `🗑 Quité *${reward.name}* de la tienda.`);
    } catch (e) { console.error("Juego:", e.message); return twiReply(res, GAME_ERROR); }
  }

  if (cmd.startsWith("meta")) {
    const n = parseInt(cmd.split(" ")[1]);
    try {
      const { player, events } = await loadPlayer(phone); // cierra los días anteriores con la meta vieja
      if (!n || n <= 0) {
        return twiReply(res, withEvents(events, `🎯 Tu meta diaria es *${player.daily_goal} pts* (~${fmtPomos(player.daily_goal / PUNTOS_POR_POMODORO)}).\n\nCambiala con *meta [N]*. Ej: *meta 60*`));
      }
      await supabase.from("players").update({ daily_goal: n }).eq("phone", phone);
      return twiReply(res, withEvents(events, `🎯 Nueva meta diaria: *${n} pts* (~${fmtPomos(n / PUNTOS_POR_POMODORO)}).`));
    } catch (e) { console.error("Juego:", e.message); return twiReply(res, GAME_ERROR); }
  }

  if (cmd === "historial" || cmd === "movimientos") {
    try { return twiReply(res, await formatHistory(phone)); }
    catch (e) { console.error("Juego:", e.message); return twiReply(res, GAME_ERROR); }
  }

  if (cmd.startsWith("borrar ") || cmd.startsWith("eliminar ")) {
    const n = parseInt(cmd.split(" ")[1]);
    const tasks = await getTasks(phone);
    const task = tasks[n - 1];
    if (!task) return twiReply(res, `No encontré la tarea número ${n}.`);
    await supabase.from("tasks").delete().eq("id", task.id);
    return twiReply(res, `🗑 *${task.name}* eliminada.`);
  }

  if (cmd === "calendario" || cmd === "agenda" || cmd === "cal") {
    session.step = "cal_contexto";
    session.data = {};
    return twiReply(res, `📅 Voy a armar tu calendario en pomodoros 🍅, respetando tus horarios (L–V: 7:30–9, 11–13, 14:30–17 = 12 🍅/día).\n\n¿Alguna novedad para estos días? Por ejemplo:\n• "el miércoles estoy por fuera"\n• "el jueves solo en la mañana"\n• "este domingo tengo libre de 9 a 12"\n\nEscribí *-* si tu semana es normal.`);
  }

  if (cmd.startsWith("plan")) {
    const parts = cmd.split(" ");
    const minutes = parseInt(parts[1]);
    if (!minutes || isNaN(minutes)) {
      return twiReply(res, "Indicá los minutos disponibles. Ej: *plan 120*\n\nTambién podés agregar contexto: *plan 120 estoy cansado y tengo reunión a las 3*");
    }
    session.step = "plan_contexto";
    session.data.minutes = minutes;
    return twiReply(res, `⏱ Tenés ${minutes} minutos. ¿Algún contexto extra para hoy? (ej: "estoy cansado", "tengo reunión a las 3pm")\n\nEscribí *-* si no hay nada especial.`);
  }

  if (cmd === "categorias" || cmd === "categorías") {
    return handleCategorias(phone, msg, session, res);
  }

  if (cmd === "ayuda" || cmd === "help" || cmd === "hola" || cmd === "inicio") {
    return twiReply(res, HELP_MSG);
  }

  // Fallback
  return twiReply(res, `No entendí ese comando. Escribí *ayuda* para ver qué podés hacer.`);
});

// ─── FLUJO CATEGORÍAS ──────────────────────────────────────────────────────

async function handleCategorias(phone, msg, session, res) {
  if (!session.step || session.step === "cat_menu") {
    session.step = "cat_menu";
    let menuMsg = `🏷 *Prioridad de categorías*\n\nNúmero más bajo = más prioritaria\n\n`;
    
    const { data: cats } = await supabase
      .from("tasks")
      .select("category, cat_priority")
      .eq("phone", phone)
      .not("done", "eq", true);

    const catMap = {};
    (cats || []).forEach(t => { catMap[t.category] = t.cat_priority; });

    CATEGORIES.forEach((c, i) => {
      const p = catMap[c] ?? 5;
      menuMsg += `${i + 1}. ${c} — prioridad *${p}*\n`;
    });

    menuMsg += `\nEscribí el número de la categoría que querés cambiar, o *cancelar* para salir.`;
    return twiReply(res, menuMsg);
  }

  if (session.step === "cat_menu") {
    if (msg.toLowerCase() === "cancelar") { clearSession(phone); return twiReply(res, "Cancelado."); }
    const idx = parseInt(msg) - 1;
    const cat = CATEGORIES[idx];
    if (!cat) return twiReply(res, "Elegí un número válido o escribí *cancelar*.");
    session.data.editCat = cat;
    session.step = "cat_set_priority";
    return twiReply(res, `¿Qué prioridad le das a *${cat}*? (1 = máxima, 10 = mínima)`);
  }

  if (session.step === "cat_set_priority") {
    const p = parseInt(msg);
    if (isNaN(p) || p < 1 || p > 10) return twiReply(res, "Ingresá un número entre 1 y 10.");
    const cat = session.data.editCat;
    await supabase.from("tasks").update({ cat_priority: p }).eq("phone", phone).eq("category", cat).eq("done", false);
    clearSession(phone);
    return twiReply(res, `✅ *${cat}* ahora tiene prioridad ${p}.\n\nEscribí *categorias* para seguir ajustando o *lista* para ver tus tareas.`);
  }
}

// ─── INICIAR SERVIDOR ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Bot corriendo en puerto ${PORT}`));
