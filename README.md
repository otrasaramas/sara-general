# pendientes-bot1
to tackle my to do list 

## 🎮 Juego de puntos y misiones

Sos un avatar: cada tarea (`listo N`) o misión suelta (`hice editar video 2`) te da **10 puntos por pomodoro**.

- **Meta diaria** (lunes a viernes, por defecto 80 pts ≈ 8 🍅): si la cumplís sumás **racha** 🔥 (cada 5 días seguidos, +50 de bono). Si no, al cerrar el día **perdés los puntos que te faltaron**. Los fines de semana no hay meta: todo suma extra.
- **Tienda**: gastá tus puntos en recompensas (`tienda`, `canjear N`) y armá las tuyas (`premio Ir al cine 150`).
- **Nivel**: todo lo que ganás es XP; cada 500 XP subís de nivel.

Setup: correr `supabase/juego.sql` una vez en el SQL Editor de Supabase y configurar la variable `TZ` (ej. `America/Bogota`) para que los días cierren a tu medianoche.
