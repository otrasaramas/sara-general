-- Tablas del juego de puntos y misiones.
-- Correr una sola vez en Supabase → SQL Editor.

-- Tu avatar: puntos para gastar, XP (nivel), racha y meta diaria
create table if not exists players (
  phone text primary key,
  points integer not null default 0,
  xp integer not null default 0,
  streak integer not null default 0,
  best_streak integer not null default 0,
  daily_goal integer not null default 80,
  last_day date not null default current_date, -- primer día todavía sin cerrar
  created_at timestamptz not null default now()
);

-- Cada movimiento de puntos: tarea | mision | canje | castigo | bono
create table if not exists point_log (
  id bigint generated always as identity primary key,
  phone text not null,
  day date not null,
  kind text not null,
  points integer not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists point_log_phone_day on point_log (phone, day);

-- Tienda de recompensas de cada usuario
create table if not exists rewards (
  id bigint generated always as identity primary key,
  phone text not null,
  name text not null,
  cost integer not null check (cost > 0),
  created_at timestamptz not null default now()
);
