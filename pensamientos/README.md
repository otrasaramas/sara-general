# Mi diario de pensamiento

Un lugar para dejar constancia de lo que pienso sobre la vida, cómo hacer las cosas
y lo que me llega cuando pasan cosas. La idea es que con el tiempo se vea **una sola
forma de ver el mundo: la mía**.

## Cómo está organizado

- `entradas/`   → cada pensamiento, tal como me llegó, con fecha. Es el diario crudo.
- `conceptos/`  → una nota por idea que se repite (ej. `control.md`, `ritmo.md`).
  Va juntando todas las entradas donde aparece y cómo ha evolucionado.
- `huecos.md`   → lo que no entiendo, lo que quiero profundizar y lo que falta verificar.
- `MAPA.md`     → el mapa: qué conceptos existen, cómo se conectan y cuáles son
  los principios que van quedando firmes.
- `_plantilla.md` → formato de una entrada nueva.

## Cómo lo uso

1. Le cuento a Claude el pensamiento, tal cual, sin ordenarlo.
2. Claude lo guarda en `entradas/` con fecha, sin cambiarle la voz.
3. Claude verifica los datos (fact check) y me dice: con qué otros pensamientos conecta, qué concepto aparece,
   qué tensión o contradicción hay (las contradicciones son valiosas, no se borran).
4. Se actualizan `conceptos/` y `MAPA.md`.
5. De vez en cuando hacemos una **revisión**: qué ideas se repiten, cuáles cambiaron,
   y qué principios ya puedo llamar míos.

## Reglas

- Mis palabras mandan. Claude ordena y conecta, pero no reescribe lo que pienso.
- Un pensamiento puede estar a medias. Se guarda igual.
- Si cambio de opinión, no se borra lo anterior: se agrega la nueva entrada y se enlaza.
