# FisioClin — Plan de trabajo: visión computacional, datos y reporte

> Estado: **borrador de trabajo** · 22 de septiembre de 2026
> Ámbito: app del paciente (`Desktop/FisioClin`) + `backend/cv-service` + Supabase + panel del médico.

Este documento es la ruta para llevar el módulo de visión de «no funciona» a
«sistema que mide, guarda y reporta». Está ordenado por dependencias: cada
fase necesita la anterior. Las casillas son para ir marcando.

---

## Índice

1. [Diagnóstico: por qué hoy no funciona](#1-diagnóstico-por-qué-hoy-no-funciona)
2. [Fase 0 — Desbloqueo](#fase-0--desbloqueo-30-min)
3. [Fase 1 — Esqueleto y reconocimiento fiable](#fase-1--esqueleto-y-reconocimiento-fiable)
4. [Fase 2 — Los datos a Supabase](#fase-2--los-datos-a-supabase)
5. [Fase 3 — El reporte del médico](#fase-3--el-reporte-del-médico)
6. [Fase 4 — El dataset](#fase-4--el-dataset)
7. [Orden y dependencias](#orden-y-dependencias)
8. [Anexo: mediciones de referencia](#anexo-mediciones-de-referencia)

---

## 1. Diagnóstico: por qué hoy no funciona

El problema **no es el modelo**. Son tres capas de fallo apiladas, y la de
abajo tapa a las otras dos.

### Capa 0 — Ni siquiera se conecta

| Hallazgo | Detalle |
|---|---|
| IP obsoleta | `.env` apunta a `ws://172.174.1.254:8000/ws`; la IP real del equipo es **172.174.2.212**. Misma subred (/22), otro host. La app se queda en «conectando» para siempre. |
| Sin entorno | No existe `backend/cv-service/.venv`. El servicio nunca se instaló en este proyecto. |
| Versiones a la deriva | El Python global tiene mediapipe **0.10.14** + numpy **2.0.2**; `requirements.txt` fija **0.10.9** + **1.26.4**. La paridad geométrica documentada (correlación 1,000) se midió con 0.10.9. |

> La misma IP rompe también el escáner de carnet: `components/escanercarnet.tsx`
> deriva su URL de `EXPO_PUBLIC_CV_URL`. Un arreglo, dos funciones.

### Capa 1 — El cuello de botella es la captura

En [`app/rehabilitacion.tsx`](app/rehabilitacion.tsx#L75) se llama a
`takePictureAsync({ base64: true })` **sin redimensionar**. Sale la foto a
resolución plena del sensor. El propio [`ocr_carnet.py`](backend/cv-service/ocr_carnet.py#L50)
lo dice: *«Una foto de 12 MP en base64 son ~8 MB»*. Se intenta mandar eso 8
veces por segundo. `quality: 0.35` solo baja la compresión, no los píxeles.

Con el control de flujo estricto (un fotograma en vuelo), la cadena se
serializa:

| Etapa | Coste |
|---|---|
| `takePictureAsync` + encode base64 | 150–400 ms |
| Transferencia WiFi | 50–300 ms |
| MediaPipe `model_complexity=1` | **85 ms** (medido en este PC) |

**Ritmo real: 1,5–2,5 fps, no 8.** `FPS_CAPTURA = 8` en
[`lib/fisioclin/config.ts`](lib/fisioclin/config.ts#L27) es aspiracional.

Además el timestamp se toma **después** del encode, no en el momento de la
exposición: 200–400 ms de jitter variable sobre los que se construye la
rejilla de 10 Hz.

### Capa 2 — Lo que el remuestreo hace con 2 fps

Medido pasando el propio `Remuestreador` por una señal sintética de puente de
glúteos:

| fps cámara | filas 10 Hz | muestras reales | **% filas inventadas** | vel. pico medida |
|---|---|---|---|---|
| 2,0 | 198 | 44 | **78 %** | 12,5 °/s |
| 3,0 | 197 | 63 | **68 %** | 15,0 °/s |
| 5,0 | 198 | 103 | 48 % | 16,2 °/s |
| 8,0 | 197 | 166 | 16 % | 15,8 °/s |
| 10,0 | 198 | 205 | 0 % | 15,4 °/s |

*(velocidad pico verdadera de la señal: 14,1 °/s)*

A 2–3 fps, **dos de cada tres segundos que ve el LSTM son interpolación
lineal pura**.

#### Tres bugs concretos

**a) El suavizado está en el lado equivocado de la rejilla.**
El EMA de [`main.py`](backend/cv-service/main.py#L241) se aplica en `medir()`,
en tiempo de cámara, **antes** del remuestreo. Su constante de tiempo depende
del fps:

| fps cámara | retraso del EMA |
|---|---|
| 8 | 0,19 s |
| 3 | 0,50 s |
| 2 | **0,75 s** |

El entrenamiento usó Savitzky-Golay a 10 Hz, que es no causal y **no desfasa**.
El mismo paciente en un teléfono más lento produce features sistemáticamente
distintas a las del dataset.

**b) El remuestreador no acota los huecos.**
En [`main.py`](backend/cv-service/main.py#L112), el `while self.t_rejilla <= t`
no tiene tope. Probado: **un corte de red de 2,2 s emite 21 filas de golpe**,
todas interpoladas entre dos muestras reales. El evaluador cuenta
repeticiones sobre eso sin enterarse.

**c) La ventana del teléfono no se entera de los reinicios.**
Cuando el dato no es fiable el servicio hace `remuestreador.reiniciar()`
([`main.py`](backend/cv-service/main.py#L372)), pero la `VentanaDeslizante`
solo se reinicia si `!hay_persona`
([`useEvaluadorFisioclin.ts`](hooks/useEvaluadorFisioclin.ts#L122)). Con un
parpadeo de «Reposiciónate», la ventana conserva 30 muestras que ya no son
contiguas. El LSTM ve un empalme.

### Capa 3 — El lado que salta

[`geometria.py`](backend/cv-service/geometria.py#L95), `lado_visible()`, decide
en **cada fotograma sin histéresis** (el docstring lo admite). Y
`construir_features()` usa ese lado para ordenar las columnas:

```python
lado = fila.get("lado") or "izq"
otro = "der" if lado == "izq" else "izq"
return [ g(f"flex_cadera_{lado}"), g(f"flex_cadera_{otro}"), ... ]
```

Al cambiar el lado se **permutan 8 de las 14 columnas**. En un ejercicio
bilateral como C01 (puente), donde izquierda y derecha se ven casi igual,
`izq >= der` oscila por puro ruido de visibilidad. Dentro de una misma ventana
de 30 muestras conviven filas con la semántica invertida.

**Candidato serio a explicar por qué la cabeza de ejercicio falla «incluso con
las features perfectas».**

---

## Fase 0 — Desbloqueo (30 min)

Sin esto no se puede probar nada de lo demás.

- [x] **0.1** Corregir la IP en `.env` — hecho, y superado por 0.6: ya no
      hace falta, se autodetecta.
- [x] **0.2** Entorno creado: `backend/cv-service/.venv`, con
      `mediapipe==0.10.9` + `numpy==1.26.4` (confirmado con
      `python -c "import mediapipe; print(mediapipe.__version__)"`).
- [x] **0.3** Arrancado y probado: `GET /salud` responde 200 y el WebSocket
      `/ws` acepta conexión, `inicio` y `frame` sin errores (probado con un
      cliente Python sintético).
- [ ] **0.4** **Pendiente de tu teléfono**: no puedo verificar
      `http://172.174.2.212:8000/salud` desde un navegador de celular yo
      mismo. Si al probar la app no conecta, revisa el firewall de Windows
      (permitir Python en redes privadas).
- [x] **0.5** Se mantiene mediapipe 0.10.9 + numpy 1.26.4 (ya era lo que
      fijaba `requirements.txt`). `python tests/verificar_paridad.py`:
      error máximo 2.76e-04 (tolerancia 1e-03), 0 desacuerdos de clase — OK.
- [x] **0.6** Hecho: `lib/fisioclin/config.ts` ahora autodetecta la IP
      desde `Constants.expoConfig.hostUri`; `.env` quedó como override
      comentado. Esta causa de fallo no debería volver a repetirse.

---

## Fase 1 — Esqueleto y reconocimiento fiable

Esta es la fase que convierte «no funciona» en «funciona».

### 1.1 Bug que impide dibujar el esqueleto

Los 17 landmarks **ya viajan** del servicio a la app — no hay que construir
nada en el backend. Pero en [`main.py`](backend/cv-service/main.py#L385):

```python
if landmarks and filas:
    filas[-1]["landmarks"] = landmarks
```

El dibujo está acoplado a la rejilla de medición de 10 Hz. Cuando
`Remuestreador` devuelve 0 filas (el primer fotograma de la sesión, y el
primero después de **cada** reinicio por dato no fiable), los landmarks se
tiran. Es decir: **el esqueleto desaparece justo cuando la pose es marginal**,
que es cuando el paciente lo necesita para recolocarse.

- [x] **1.1.1** Hecho: `landmarks` ahora se calculan en cuanto hay persona
      (antes de los `return` tempranos por "Reposiciónate"/"Acércate"), y
      van en el sobre del mensaje junto con `reinicio`, `t_captura`,
      `muestras_reales` y `filas_emitidas`.
- [x] **1.1.2** Hecho: `ClienteCv` tiene `onLandmarks` y `onCalidad`
      separados de `onFotograma`.

### 1.2 El componente de dibujo

Un `<EsqueletoOverlay>` en SVG (`react-native-svg`) encima del `CameraView`.

- [x] **1.2.1** Instalado: `react-native-svg@15.15.4`.
- [x] **1.2.2** Creado `components/EsqueletoOverlay.tsx`.
- [x] **1.2.3** Aristas dibujadas (tronco, brazos, piernas) en el mismo
      orden que `ESQUELETO` de `main.py`.
- [x] **1.2.4** Puntos y aristas coloreados por visibilidad (verde ≥0,7,
      ámbar ≥0,5, rojo debajo).
- [x] **1.2.5** Montado en `app/rehabilitacion.tsx` dentro de `marcoCamara`,
      con transformación `cover` + `onLayout` para medir la vista real.
      **Pendiente de verificar en el teléfono**: que quede alineado con el
      cuerpo (yo no puedo probar esto sin el dispositivo).

#### Tres cosas que suelen salir mal

**Mapeo de coordenadas.** El servicio redimensiona a 640 px de ancho
conservando proporción ([`main.py`](backend/cv-service/main.py#L190)), así que
los `x`/`y` normalizados siguen siendo relativos a la foto original. Pero la
vista previa **recorta para llenar** el marco (`cover`), y la foto y la vista
casi nunca tienen la misma proporción. Hace falta la transformación explícita:

```
escala  = max(vistaW / fotoW, vistaH / fotoH)
offsetX = (vistaW - fotoW * escala) / 2
offsetY = (vistaH - fotoH * escala) / 2
px = offsetX + x_norm * fotoW * escala
py = offsetY + y_norm * fotoH * escala
```

> Si esto se hace mal, el esqueleto sale desplazado y **parece** que la
> detección falla cuando no falla. Es la causa más común de perder una tarde.

**Espejo.** Con `facing="back"` no hay que espejar. Con la frontal, invertir `x`.

**Suavizado del dibujo.** Los landmarks llegan a 2–8 Hz; dibujados en crudo el
esqueleto salta. Interpolación hacia el último valor (lerp ~0,35 por frame de
render) da una línea fluida sin mentir sobre la medición.

### 1.3 Que reconozca de verdad

Por orden de impacto medido:

- [x] **1.3.1 — Reducir la foto antes de enviarla.** Hecho con
      `expo-image-manipulator`: `takePictureAsync` ya no pide `base64`
      (evita la codificación a resolución plena), y se reescala a 640 px
      de ancho antes de mandarla. **Pendiente medir el fps real en el
      teléfono** (yo no puedo medirlo sin el dispositivo).
- [x] **1.3.2 — Timestamp en el momento de la exposición.** Hecho: se
      captura justo antes de `takePictureAsync`, no después del resize/encode.
- [x] **1.3.3 — EMA movido después de la rejilla.** Ahora vive en
      `Remuestreador._suavizar_fila`, con `dt` fijo (=100 ms) sea cual sea
      el fps de la cámara. Verificado con prueba sintética.
- [x] **1.3.4 — Hueco del remuestreador acotado** a 0,4 s
      (`MAX_HUECO_S`). Más allá, reinicia y pone `reinicio: true` en el
      sobre. Verificado con prueba sintética (el hueco de 2,2 s del
      diagnóstico ya no genera filas inventadas).
- [x] **1.3.5 — Histéresis en el lado.** Nueva clase `GEO.SelectorLado`:
      exige ≥0,1 de ventaja sostenida durante ≥5 fotogramas para cambiar
      de lado. Verificado con prueba sintética (ruido cerca del umbral no
      lo mueve; una ventaja real y sostenida sí).
- [x] **1.3.6 — `VentanaDeslizante` se reinicia con el flag `reinicio`**,
      además del `!hay_persona` que ya tenía.

### 1.4 Instrumentación (no es opcional)

- [x] **1.4.1** HUD en `__DEV__` (esquina del `marcoCamara`): fps real de
      cámara, latencia ida y vuelta, y % de filas interpoladas — calculado
      con los contadores `muestras_reales`/`filas_emitidas` que ahora manda
      el servicio.

### Criterio de aceptación de la Fase 1

**Todo el código de la Fase 1 está hecho y con pruebas sintéticas en verde**
(gap-cap, histéresis, EMA reubicado — ver arriba). Lo que sigue son las 4
verificaciones que necesitan el teléfono real y no puedo hacer yo:

- [ ] Esqueleto visible y estable, alineado con el cuerpo en la vista previa.
- [ ] ≥ 6 fps de cámara sostenidos, medido en el teléfono real.
- [ ] ≤ 35 % de filas interpoladas (mirar el HUD en vivo).
- [ ] El contador acierta **10 de 10** repeticiones en un puente de glúteos
      hecho despacio.

---

## Fase 2 — Los datos a Supabase

### 2.1 El problema: no hay dónde guardarlos

La tabla `sesiones` es un **checkbox**:
`(id_paciente, id_prescripcion, id_ejercicio, ejercicio, fecha_hora,
duracion_segundos, estado, completado, resultado_evaluacion)`, y
`marcar_ejercicio_hoy` escribe `resultado_evaluacion = 'correcto'` a pelo
([`00_desplegar_todo.sql`](supabase/00_desplegar_todo.sql#L296)).

No hay ni una columna para ROM, ángulos o veredictos.

La buena noticia: el tipo `ResumenSesion`
([`lib/fisioclin/tipos.ts`](lib/fisioclin/tipos.ts#L177)) ya tiene exactamente
los campos del reporte clínico. Mapea casi 1:1.

- [x] **2.1.1 — corregido.** Esto ya NO hace falta crearlo: existe un
      proyecto hermano, `C:\Users\WARA\FisioClinDoctor` (el panel del
      médico), con el esquema **real y completo** de 28 tablas —
      `sesiones` + `metricas_articulares` + `repeticiones_ejercicio` +
      `registro_dolor` ya cubren exactamente lo que este paso quería
      inventar, y `ejercicios_catalogo.clase_lstm` ya es el enlace
      `'C01'..'R10'` que se buscaba con un `codigo_cv` nuevo. Corre (en
      este orden) `sql/1_BASE_DE_DATOS.sql`, `sql/2_DATOS.sql` y
      `sql/3_USUARIOS_Y_CLAVES.sql` de ese proyecto — **no** los archivos
      que yo había escrito antes (ya los borré: creaban un esquema
      paralelo incompatible). El proyecto vigente es `ukjsbywrltiuqdawrnye`
      (ver `.env` de ambos proyectos — apuntan al mismo).

```sql
-- ── el eslabón que falta: 'C01' <-> id_ejercicio ────────────────────────
alter table public.ejercicios_catalogo
  add column if not exists codigo_cv text unique;

-- ── cabecera de sesión en vivo ──────────────────────────────────────────
create table if not exists public.sesiones_rehabilitacion (
  id_sesion_rh        bigserial primary key,
  id_paciente         integer not null references public.pacientes,
  id_prescripcion     integer references public.prescripciones_ejercicio,
  id_ejercicio        integer references public.ejercicios_catalogo,
  codigo_cv           text not null,            -- 'C01'
  ejercicio           text not null,
  articulacion        text,
  lado_medido         text,
  fecha_hora          timestamptz not null default now(),
  duracion_seg        numeric,
  series_prescritas   integer,
  repeticiones_prescritas integer,
  series_completadas  integer,
  repeticiones_detectadas integer,
  cumplimiento_pct    numeric,
  rom_medio           numeric,
  rom_maximo          numeric,
  rom_objetivo        numeric,
  correctas           integer,
  dudosas             integer,
  incorrectas         integer,
  pct_correctas       numeric,
  medicion_goniometrica_valida boolean,
  -- calidad de captura: sin esto el dato no es defendible en la tesis
  fps_medio               numeric,
  pct_filas_interpoladas  numeric,
  pct_frames_descartados  numeric,
  -- traza de ángulos a 10 Hz, para el Bland-Altman del objetivo 4
  serie_angulos       jsonb
);

create index if not exists ix_sesrh_paciente_fecha
  on public.sesiones_rehabilitacion (id_paciente, fecha_hora desc);

-- ── una fila por repetición ─────────────────────────────────────────────
create table if not exists public.repeticiones_sesion (
  id_repeticion bigserial primary key,
  id_sesion_rh  bigint not null
    references public.sesiones_rehabilitacion on delete cascade,
  n                     integer,
  serie                 integer,
  t_inicio_s            numeric,
  duracion_s            numeric,
  flex_min_grados       numeric,
  flex_max_grados       numeric,
  rom_grados            numeric,
  duracion_ida_s        numeric,
  duracion_vuelta_s     numeric,
  razon_ida_vuelta      numeric,
  velocidad_media_gr_s  numeric,
  rom_tronco_grados     numeric,
  rom_contralateral_grados numeric,
  asimetria_rom         numeric,
  veredicto             text,
  motivos               text[],
  pct_rom_objetivo      numeric,
  medicion_no_representativa boolean
);

create index if not exists ix_repses_sesion
  on public.repeticiones_sesion (id_sesion_rh, n);
```

### 2.2 El eslabón que falta (hoy rompe todo esto)

[`app/seleccionar-ejercicio.tsx`](app/seleccionar-ejercicio.tsx) lista los
ejercicios desde el **JSON local**, no desde Supabase. Cuando el paciente entra
a `/rehabilitacion?ejercicio=C01`, la app **no sabe** a qué `id_prescripcion`
corresponde. Sin eso no se puede guardar la sesión contra la prescripción del
médico, y el reporte no existe.

- [x] **2.2.1 — corregido.** No hacía falta generar nada: `sql/2_DATOS.sql`
      de FisioClinDoctor ya siembra 10 ejercicios reales, y varios ya
      tienen `clase_lstm` puesto ('R01', 'R02', 'C01', 'C02'…) coincidiendo
      con el catálogo de visión. En cuanto corras esos 3 archivos, el botón
      "Medir con cámara" de la pestaña Ejercicios va a aparecer solo en los
      que ya lo tienen.
- [x] **2.2.2** Hecho: la pestaña Ejercicios
      ([`app/(tabs)/ejercicios.tsx`](app/(tabs)/ejercicios.tsx)) tiene un
      botón "Medir con cámara" en cada ejercicio prescrito que trae
      `codigo_cv`, y entra a `/rehabilitacion` con `idPrescripcion`,
      `series` y `repeticiones` reales como parámetros.
- [x] **2.2.3** Hecho: `app/rehabilitacion.tsx` lee esos parámetros y se
      los pasa al evaluador; si se entra sin ellos (p. ej. desde
      `seleccionar-ejercicio.tsx`, que sigue existiendo como modo de
      práctica libre sin prescripción), usa 3×10 por defecto.

### 2.3 Una sola RPC

Siguiendo el patrón existente (`security definer`, grant a `anon`/`authenticated`):

- [x] **2.3.1** Creado
      [`supabase/guardar_sesion_rehabilitacion.sql`](supabase/guardar_sesion_rehabilitacion.sql):
      resuelve `codigo_cv -> id_ejercicio`, inserta cabecera +
      repeticiones en bloque, y marca la prescripción como completada hoy
      (reutiliza `marcar_ejercicio_hoy`) cuando hay `id_prescripcion`.
- [x] **2.3.2** Añadida como sección 7 de
      [`supabase/00_desplegar_todo.sql`](supabase/00_desplegar_todo.sql).
- [x] **2.3.3** Creado `lib/rehabilitacionData.ts` con
      `guardarSesion(resumen, { idPaciente, idPrescripcion, calidad })`.
- [x] **2.3.4** Hecho: el `console.log` fue reemplazado por la llamada
      real, con estado guardando/error visible en pantalla y botón
      "Reintentar guardar" si falla (no se pierde el resumen ni se sale de
      la pantalla).

### 2.4 La traza de ángulos

- [x] **2.4.1** Hecho: `useEvaluadorFisioclin` acumula `{t, ángulo}` en
      cada fotograma de la rejilla y lo expone por `serieAngulos()`;
      `rehabilitacion.tsx` lo manda en `p_calidad.serie_angulos` al guardar.

> Sin esto no se puede hacer el Bland–Altman contra la goniometría del
> especialista que exige el **objetivo 4**, ni reanalizar una sesión sin
> repetirla con el paciente.

### 2.5 Advertencia de seguridad

Las funciones actuales son `security definer` con grant a `anon`, y el login es
por número de carnet. **Cualquiera con el número de carnet de un paciente lee
su historial clínico.** Para la maqueta vale; antes de grabar pacientes reales
con consentimiento (etapa 3.4) hay que cerrarlo.

- [x] **2.5.1 — mitigado, no resuelto del todo.** Se decidió (con el
      usuario) mantener el login de un solo paso en vez de Supabase Auth
      real, por accesibilidad de pacientes mayores. Se cerró la
      enumeración trivial exigiendo un segundo factor que el paciente ya
      sabe: `buscar_paciente_por_carnet` ahora pide carnet **y** fecha de
      nacimiento (`supabase/buscar_paciente_por_carnet.sql`), y el login
      (`app/login.tsx`) y el escaneo de carnet (`app/escaneo.tsx`, que ya
      leía la fecha de nacimiento del documento) se actualizaron para
      pedirla/mandarla. Sigue sin ser RLS real: quien conozca ambos datos
      de un paciente puede leer su historial. Aceptado como compromiso
      consciente, no como descuido.

---

## Fase 3 — El reporte del médico

> **Aviso:** el panel `Desktop/diseño de fisioclin doctor` es **maqueta pura**.
> Solo tiene `src/components/{Layout,Sidebar}.jsx` y 6 páginas; no hay
> `package.json`, no hay cliente de Supabase, no hay módulo de reportes. No lee
> ni un dato real. El reporte es **construcción nueva**, no conexión.

- [ ] **3.0 Decisión previa:** ¿cuál es el panel definitivo, este o
      `C:\Users\WARA\FisioClinDoctor` (el que tiene backend Express)?
- [ ] **3.1** RPC `obtener_reporte_paciente(p_id_paciente, desde, hasta)`:
      adherencia, evolución del ROM por ejercicio, % de correctas, y los
      motivos de fallo más frecuentes (salen de `motivos[]`).
- [ ] **3.2** Cliente de Supabase en el panel + página `ReportePaciente`:
      curva de ROM en el tiempo, tabla de sesiones, desglose por repetición.
- [ ] **3.3** Exportar a PDF para la historia clínica.

---

## Fase 4 — El dataset

### 4.1 Triaje de la red (una tarde, y define el capítulo 3.4)

La medición actual es correcta pero se hizo sobre **un vídeo de un ejercicio**.
Hay que separar tres hipótesis con una matriz de confusión sobre el split de
validación del entrenamiento:

| Resultado | Conclusión |
|---|---|
| Accuracy de validación **alta** | El problema es el orden de clases en `fisioclin_clases.json` o las features de servicio. Se arregla y **recuperas la red**. |
| Accuracy **~5 %** | El checkpoint exportado no es el bueno, o el entrenamiento no convergió. Toca reentrenar. |

El síntoma observado (100 % de confianza en `elevacion_de_pierna_recta`,
índice 4, cuando la verdad es `puente_de_gluteos`, índice 15, con P por
**debajo** del prior uniforme de 0,05) es el patrón clásico de **etiquetas
desalineadas**: un modelo simplemente malo da probabilidades difusas, no
confianza alta y estable en una clase fija.

- [ ] **4.1.1** Matriz de confusión 20×20 sobre el split de validación.
- [ ] **4.1.2** Documentarla. «La red no acierta» respaldado por una matriz es
      un resultado de tesis; respaldado por un vídeo, es una anécdota que el
      tribunal va a picar.

### 4.2 Los tres ejercicios cojos

C09, R03 y R10 no tienen umbrales medidos: se muestran en la lista pero
`EvaluadorEjercicio` lanza excepción al tocarlos. Hoy son 3 caminos a un error.

- [ ] **4.2.1** Medirles la banda con vídeos nuevos, **u** ocultarlos hasta
      entonces.

### 4.3 El catálogo duplicado

`ml/configuracion_ejercicios.json` y `backend/cv-service/configuracion_ejercicios.json`
son **idénticos hoy** (mismo MD5), igual que los dos `fisioclin_clases.json`.
Pero son copias, y las copias se separan.

- [ ] **4.3.1** Añadir a `tests/verificar_paridad.py` una comprobación de que
      los hashes coinciden. Evita un fallo silencioso carísimo de depurar.

### 4.4 La app **es** el recolector del dataset propio

En cuanto la Fase 2 esté hecha, cada sesión real guarda la traza de ángulos a
10 Hz, etiquetada con el ejercicio prescrito, el veredicto por reglas y la
calidad de captura. **Eso es exactamente el dataset propio que exige el
objetivo 3**, generado por el uso normal del sistema en vez de por una campaña
aparte.

- [ ] **4.4.1** Protocolo de grabación + consentimientos (etapa 3.4).
- [ ] **4.4.2** Exportador del dataset desde Supabase al formato de entrenamiento.
- [ ] **4.4.3** Reentrenar el LSTM con datos de la propia cámara y los propios
      pacientes.
- [ ] **4.4.4** Medir la precisión del **objetivo 4** sobre datos reales.

> **El orden importa: Fase 1 antes que Fase 4.** Si recolectas dataset con la
> captura a 2 fps y el EMA mal colocado, estarás grabando el bug, no al
> paciente.

---

## Orden y dependencias

```
Fase 0 ──▶ Fase 1 ──┬──▶ Fase 2 ──▶ Fase 3 (reporte)
                    └──▶ Fase 4 (dataset)
```

| Fase | Qué consigue |
|---|---|
| **0** | Que arranque |
| **1** | Que **funcione**: esqueleto visible + medición fiel |
| **2** | Que sea un **sistema**: los datos persisten |
| **3** | Que el médico pueda **leerlo** |
| **4** | Que la tesis tenga **dataset y cifras propias** |

---

## Anexo: mediciones de referencia

Todas tomadas en este equipo el 22-09-2026, para poder comparar el antes y el
después.

**Latencia de MediaPipe (imagen 1920×1080):**

| `model_complexity` | ms/fotograma |
|---|---|
| 0 | 84,9 |
| 1 | 84,4 |
| 2 | 107,6 |

**Tamaño de carga útil:**

| Imagen | JPEG | base64 |
|---|---|---|
| 1920×1080 q40 | 699 KB | 933 KB |
| 640×360 q60 | 107 KB | 142 KB |
| 12 MP (según `ocr_carnet.py`) | — | ~8 MB |

**Hueco de red:** 2,2 s sin fotogramas → el remuestreador emite **21 filas**
interpoladas de golpe a partir de 2 muestras reales.

**Entorno:** Python 3.11.9 · mediapipe 0.10.14 · numpy 2.0.2 ·
`rapidocr_onnxruntime` presente · IP local 172.174.2.212/22 ·
proyecto Supabase `pzapqjrdybqmkejsnlys`.

**Catálogo:** 20 ejercicios, 17 con umbrales medidos; sin umbrales: C09, R03, R10.
