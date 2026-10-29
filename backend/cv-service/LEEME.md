# FisioClin — modelo de ejercicio en la app

Los cuatro archivos del entrenamiento (`fisioclin_lstm (4).tflite`,
`media.npy`, `desviacion.npy`, `fisioclin_clases.json`) ya están
adaptados y repartidos entre la app y este servicio. Esto explica dónde
quedó cada cosa, cómo se enciende y qué se puede creer de lo que sale.

---

## Por qué no se carga el .tflite en el teléfono

Dos cosas de este modelo necesitan código nativo, y Expo Go no carga
módulos nativos:

- **TFLite** necesita `react-native-fast-tflite` → development build.
- **MediaPipe Pose** necesita un plugin de frame processor → también.

Así que el reparto es:

| Pieza | Dónde corre | Por qué |
|---|---|---|
| Pose (33 landmarks) | `backend/cv-service` (Python) | MediaPipe es nativo |
| Ángulos y 14 features | `backend/cv-service` | van pegados a la pose |
| Contador de repeticiones | teléfono, `lib/fisioclin/evaluador.ts` | solo necesita el ángulo |
| Reglas de calidad | teléfono, `lib/fisioclin/evaluador.ts` | aritmética pura |
| LSTM | teléfono, `lib/fisioclin/modelo.ts` | reescrito en JS, sin nativo |

El `.tflite` no se usa en producción: sus pesos se extrajeron a
`ml/fisioclin_lstm_pesos.json` y el paso hacia adelante está reescrito en
TypeScript. Son 9.815 pesos y ~270.000 multiplicaciones por ventana:
**0,59 ms** por inferencia, una vez por segundo. El `.tflite` se guarda
aquí solo como referencia para las pruebas.

---

## Archivos

### En la app (`ml/`)

| Archivo | Qué es |
|---|---|
| `fisioclin_lstm_pesos.json` | los pesos del `.tflite`, des-cuantizados de int8 (102 KB) |
| `fisioclin_escalador.json` | `media.npy` + `desviacion.npy` |
| `fisioclin_clases.json` | 20 ejercicios, 2 grupos, 3 calidades, 14 features |
| `configuracion_ejercicios.json` | el catálogo con los umbrales medidos |
| `fisioclin_vector_prueba.json` | un caso con su salida, para la autoprueba en el teléfono |

### En la app (`lib/fisioclin/`)

| Archivo | Qué hace |
|---|---|
| `tipos.ts` | el contrato entre el servicio y la app |
| `modelo.ts` | el LSTM en JS + `autoprueba()` |
| `ventana.ts` | ventana deslizante de 30×14 a 10 Hz, paso 1 s |
| `evaluador.ts` | máquina de estados + reglas de calidad |
| `clienteCv.ts` | WebSocket con control de flujo |
| `config.ts` | la URL del servicio |

Más `hooks/useEvaluadorFisioclin.ts` y la pantalla `app/rehabilitacion.tsx`.

---

## Encenderlo

**1. El servicio de visión** (una vez):

```bash
cd backend/cv-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Y cada vez:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` no es opcional: sin eso solo escucha en `localhost` y el
teléfono no llega. Comprueba en el navegador que responde:
`http://localhost:8000/salud`.

**2. Decirle a la app dónde está.** En el `.env` de la raíz ya quedó la
línea; hay que poner tu IP real, la misma que sale en el QR de
`npx expo start` (`exp://192.168.x.x:8081`):

```
EXPO_PUBLIC_CV_URL=ws://192.168.1.42:8000/ws
```

`localhost` desde el teléfono es el teléfono, no tu PC. Las variables
`EXPO_PUBLIC_*` se leen al empaquetar, así que después de cambiarla hay
que arrancar con `npx expo start -c`.

**3. En el teléfono**, entrar a "Rehabilitar". El panel dice
"Servicio de visión conectado" cuando el WebSocket está vivo.

Si el firewall de Windows pregunta, hay que permitir Python en redes
privadas. Es el fallo más habitual: el servicio arranca, la app dice
"conectando" para siempre.

---

## Cómo se usa desde otra pantalla

```tsx
const ev = useEvaluadorFisioclin({
  url: URL_CV,
  ejercicio: 'C01',      // id del catálogo
  series: 3,
  repeticiones: 10,
  romObjetivo: 35,       // de la prescripción; si falta se usa la ficha
});

ev.estado.mensaje       // "Controla el movimiento"
ev.estado.angulo        // 42.1
ev.estado.repeticiones  // 4
ev.repeticiones         // todas, con veredicto y motivos
ev.resumen()            // para guardar en Supabase
```

La pantalla solo tiene que sacar la foto y pasarla:

```tsx
if (ev.listoParaEnviar()) {
  const foto = await camara.current.takePictureAsync({ base64: true, quality: 0.35 });
  ev.enviarFotograma(foto.base64, (Date.now() - t0) / 1000);
}
```

`ejerciciosDisponibles()` en `evaluador.ts` lista los 20 con su ficha.
**17 se pueden contar**; C09, R03 y R10 no tienen banda de referencia
medida y el evaluador se niega a arrancar con ellos.

---

## El reloj de 10 Hz

El modelo mira 30 muestras y las trata como 3 segundos. `takePictureAsync`
da entre 4 y 8 fotos por segundo, irregulares. Si se le pasaran tal cual,
30 muestras serían 5 o 6 segundos y el LSTM vería algo que nunca vio.

Por eso el servicio mantiene una rejilla fija de 10 Hz, interpola sobre
ella y devuelve las filas que quedaron completas — a veces 0, a veces 2.
Por eso la respuesta trae `filas: [...]` y no un solo fotograma.

Las velocidades usan diferencia centrada, igual que el `np.gradient` del
dataset, así que cada fila sale con 100 ms de retraso. Es el precio de
que las features se parezcan a las del entrenamiento.

---

## Qué está verificado, y qué no

### La geometría es exacta

Se sacaron los landmarks del vídeo del catálogo del puente (3.326
fotogramas) y se pasaron por `geometria.py` y por `artrosis_03_angulos`
—el código original del dataset— sobre exactamente los mismos puntos:

| Canal | correlación | diferencia media |
|---|---|---|
| `flex_cadera` (izq/der) | 1,000 / 1,000 | 0,14° / 0,11° |
| `flex_rodilla` (izq/der) | 0,999 / 0,998 | 0,08° / 0,21° |
| `flex_tobillo` (izq/der) | 0,995 / 0,999 | 0,13° / 0,12° |
| `inclinacion_tronco` | 1,000 | 0,03° |
| `abd_cadera` (izq/der) | 0,750 / 0,987 | 4,02° / 0,58° |

La abducción parecía el patito feo, pero no lo era: es un canal de muy
poca amplitud donde el ruido del detector manda (desviación 4,88° en
crudo contra 1,49° ya filtrado), y la comparación era mi señal cruda
contra la suya filtrada. Aplicando el mismo savgol a las dos:

| Canal | correlación | diferencia media |
|---|---|---|
| `abd_cadera` (izq/der) | 1,000 / 1,000 | 0,01° / 0,02° |

Vale la pena recordarlo al leer las features en vivo: la abducción es
el canal más ruidoso de los catorce.

### El LSTM en JS es el .tflite

`python tests/verificar_paridad.py` → error máximo **2,8e-4** sobre 16
ventanas, mismo argmax en todas. El ruido es la cuantización int8.

`autoprueba()` repite la comprobación dentro del teléfono, porque `Math.tanh`
y `Math.exp` no están obligados a dar el mismo bit en todos los motores
y aquí se encadenan 60 pasos de LSTM.

### La cabeza de ejercicio NO está lista

Esto conviene saberlo antes de enseñárselo a nadie. Con el vídeo del
puente de glúteos:

| Camino | Qué predice |
|---|---|
| Pipeline original del dataset (savgol incluido) | 97,2 % `elevacion_de_pierna_recta` |
| Este código, en vivo | 100 % `elevacion_de_pierna_recta` |
| P(`puente_de_gluteos`) | media 0,032, máximo 0,041 |

El prior uniforme de 20 clases es 0,05. O sea: la red no reconoce el
ejercicio correcto **ni siquiera con las features perfectas** — no es un
problema del puerto ni de correr en el teléfono. Que los dos caminos se
equivoquen igual es, de hecho, la mejor prueba de que el puerto es fiel.

Por eso `verificarConRed` viene **apagada**. Antes de encenderla hay que
medir, ejercicio por ejercicio, en cuáles acierta.

La cabeza de calidad arrastra lo mismo desde el entrenamiento: 0,462
contra una línea base de 0,642.

**Quien evalúa es `evaluador.ts`**, con las reglas calculadas exactas
sobre los ángulos: tempo, compensación de tronco, asimetría y ritmo. Eso
no depende de la red y funciona.

---

## Pruebas

```bash
python tests/verificar_paridad.py
```

Revisa el catálogo, compara el JSON de la app contra el `.tflite` y
regenera el vector de autoprueba. Correrlo cada vez que se reentrene.

```bash
python tests/probar_con_video.py "ruta/al/video.mp4" C01
```

Pasa un vídeo por todo el pipeline simulando el ritmo irregular de la
cámara del teléfono e imprime el z-score de cada feature. Lo que hay que
mirar es el **|z|**: si se mide bien, queda en torno a ±2. Un |z| de 8 es
una feature en otras unidades, con otro signo, o sobre el punto
equivocado. El porcentaje de acierto del ejercicio no es el criterio —
ver la sección anterior.

---

## Lo que este sistema no hace

- **No diagnostica ni prescribe.** Mide y reporta; la decisión clínica es
  del profesional.
- **No detecta varias personas.** MediaPipe Pose sigue a una sola. Si en
  el encuadre hay más, seguirá a la que detecte primero.
- **No compara sesiones grabadas con la cámara en sitios distintos.** La
  dispersión del ROM entre tomas llega a 28° frente a 3° dentro de una
  toma. Fijar la cámara es un requisito, no una recomendación.
- **No elige el ejercicio.** Lo prescribe el médico y la app lo sabe.

---

## Si algún día quieres todo en el teléfono

Haría falta un development build (`npx expo prebuild` + `eas build
--profile development`) y un plugin de MediaPipe Pose para
`react-native-vision-camera`. El LSTM ya no sería el problema: corre en
JS desde hoy. El único motivo por el que existe este servicio es la pose.

---

## Series y repeticiones en el servicio (23-sep-2026)

`evaluador_series.py` cuenta una prescripción como **3 x 12** (12
repeticiones, descanso, dos veces más) y devuelve, por repetición, si
salió bien y por qué; por serie, cuántas salieron bien y si la serie
estuvo bien hecha; y los parámetros biomecánicos de las dos.

La máquina de estados y las reglas son las de `lib/fisioclin/evaluador.ts`,
copiadas constante por constante. Si se cambia una, hay que cambiar la otra.

### Veredicto de la serie

Sobre las repeticiones **prescritas**, no las hechas:

| Veredicto | Condición |
|---|---|
| `BIEN_HECHA` | serie completa y ≥ 80 % correctas |
| `MEJORABLE` | serie completa y ≥ 50 % |
| `MAL_HECHA` | serie completa y < 50 % |
| `INCOMPLETA` | faltaron repeticiones |

Una serie se cierra al llegar a las repeticiones prescritas, tras 20 s sin
repetición con la serie a medias (el paciente se puso a descansar), o a
mano con `cerrar_serie`. Los umbrales (80 %, 50 %, 20 s) son una
propuesta: hay que validarlos con el fisioterapeuta en la etapa 3.5.

### Parámetros que salen

- **Por repetición:** ángulo mínimo y máximo, ROM, duración de ida y
  vuelta, velocidad media y pico, ROM e inclinación máxima del tronco, ROM
  contralateral y asimetría, % del ROM objetivo, los ángulos de todas las
  articulaciones en el extremo (`angulos_en_extremo`) y el
  mínimo/máximo/ROM de cada una (`rango_articular`).
- **Por serie:** ROM medio, mínimo y máximo, CV del ROM (constancia),
  caída del ROM del último tercio frente al primero (fatiga), duración y
  velocidad medias, tronco medio, ROM medio por articulación y las
  observaciones más frecuentes.

### Protocolo WebSocket

```jsonc
// app -> servicio
{"tipo": "inicio", "ejercicio": "R08", "series": 3, "repeticiones": 12}
{"tipo": "frame", "t": 1.23, "jpg": "<base64>"}
{"tipo": "cerrar_serie"}
{"tipo": "fin"}                       // -> {"tipo": "resumen", "resumen": {...}}
```

Cada `fotograma` trae además `sesion` con la serie en curso, las
repeticiones nuevas (`repeticiones_nuevas`) y las series recién cerradas
(`series_cerradas`). Si `inicio` no trae `series` ni `repeticiones`, el
servicio se porta como antes y solo mide.

**Las series y repeticiones las define el médico al prescribir** (tabla
`prescripcion`, llegan a la app por `obtener_catalogo_ejercicios`). No
hay valores por defecto en ninguna capa: si falta uno, el servicio
devuelve error y la app muestra "Falta la prescripción" en vez de evaluar
contra una rutina inventada.

### REST

- `GET /ejercicios`: el catálogo, con qué ids se pueden contar.
- `POST /analizar-video` (multipart: `video`, `ejercicio`, `series`,
  `repeticiones`, `rom_objetivo` opcional): el informe completo de un
  vídeo grabado. Tarda más o menos lo que dura el vídeo.

```bash
curl -X POST http://localhost:8000/analizar-video -F "video=@sentadilla.mp4" -F ejercicio=R08 -F series=3 -F repeticiones=12
```

### Cuidado: el veredicto depende de los fps

Con el vídeo de la sentadilla profunda (R08), las mismas 3 repeticiones
salen **CORRECTAS** leídas a 10 fps del vídeo y **DUDOSAS** ("No frenaste
la vuelta") mandadas a ~6 fps como lo hace el teléfono. La regla de tempo
compara la duración de ida y la de vuelta, y a pocos fps el extremo se
marca con ±0,15 s de error. Antes de dar por buenos los porcentajes hay
que medir los fps reales del teléfono (el HUD de desarrollo los enseña) y
revisar esa regla con el fisioterapeuta.

---

## Video en vivo en el teléfono (24-sep-2026)

Antes el teléfono sacaba **fotos sueltas** (`takePictureAsync`, 3–6 por
segundo) y las mandaba al PC; el esqueleto llegaba tarde y a saltos. Ahora:

```
cámara (video) ─▶ WebView con MediaPipe Pose web ─▶ esqueleto en CADA cuadro, en el teléfono
                                   │
                                   └─ 33 puntos, ~15/s, mensaje `pose` ─▶ este servicio
                                      (ángulos, rejilla de 10 Hz, series y repeticiones)
```

- `components/CamaraPose.tsx`: el WebView. Usa `@mediapipe/tasks-vision`
  0.10.14 y `pose_landmarker_full` (el mismo modelo que `model_complexity=1`).
  La primera vez baja ~19 MB de internet (jsDelivr y Google) y luego
  quedan en caché.
- El esqueleto ya no depende del servidor: aunque el PC esté apagado, se
  ve. Contar repeticiones sí necesita el servidor.
- Mantener pulsado el cronómetro muestra fps del video, GPU/CPU y latencia.

### Verificado

Con los 712 cuadros del vídeo de la sentadilla profunda (R08), pasados
por MediaPipe web (GPU) en el navegador y mandados por WebSocket como lo
hace la app:

| | Python (imagen) | Teléfono (web) |
|---|---|---|
| Persona detectada | — | 709 / 712 |
| Filas con ángulo | 576 | 533 |
| Repeticiones | 3 | 3 |
| ROM (°) | 67,9 · 69,3 · 87,1 | 70,0 · 73,9 · 88,3 |
| Veredictos | C · C · C | C · C · D |

La visibilidad de MediaPipe web sale ~0,08 más baja en rodillas; se
corrige con `CORRECCION_VIS_TELEFONO = 0.1` en `main.py`. La tercera
repetición cambia a DUDOSA por la regla de ida/vuelta, que ya se sabía
sensible (ver la sección de fps).

**No verificado en un teléfono real** todavía: los fps dependen del
equipo, y `getUserMedia` dentro del WebView necesita el permiso de
cámara de Expo Go (la pantalla lo pide).

---

## Dónde empieza la repetición (24-sep-2026)

El `sentido` de `configuracion_ejercicios.json` salió de cómo **empezaban
los vídeos de demostración**, no de la posición inicial clínica. En la
sentadilla (R08) dice `desciende`: "se empieza agachado". Un paciente que
empezaba **de pie**, como se le indica, tenía la cuenta corrida medio
ciclo y **no se le contaba la última repetición** (con 3 sentadillas
simuladas desde de pie: 2 de 3).

Ahora la partida es el extremo (alto o bajo) donde el paciente se queda
quieto **la primera vez**, y queda fija toda la sesión (así no se da la
vuelta si se detiene abajo en la sentadilla). Mismo cambio en
`evaluador_series.py` y en `lib/fisioclin/evaluador.ts`. Con la misma
simulación: 3 de 3.

La posición que se le indica al paciente para cada ejercicio está en
`lib/fisioclin/posiciones.ts` (pantalla y voz). Hay que revisar esos
textos con el fisioterapeuta.

---

## Por qué casi todo salía DUDOSA (24-sep-2026)

Tres fallos, corregidos igual en `evaluador_series.py` y `evaluador.ts`
(misma salida comprobada fila por fila sobre el vídeo de R08):

1. **Tiempos mal medidos.** La ida contaba desde que el paciente se
   quedaba quieto en la partida (sumaba lo que esperaba antes de moverse)
   y la vuelta incluía la pausa en el extremo. Simulación de sentadillas
   perfectas 3-1-3: antes 1 de 3 CORRECTA ("No frenaste la vuelta");
   ahora 3 de 3. Y una que se deja caer al bajar pasaba de CORRECTA a
   INCORRECTA ("El movimiento de ida fue brusco"). Ahora se buscan en la
   historia del ciclo los instantes reales: sale, llega al extremo, deja
   el extremo, vuelve (`_tiempos_reales` / `tiemposReales`).
2. **La última serie se cerraba por "descanso".** 20 s sin repetición
   cerraban la serie; si era la última, la sesión quedaba TERMINADA y no
   se contaba nada más. Con el vídeo de R08: 1 repetición en vez de 3.
   Ahora el descanso solo cierra series que no son la última.
3. **El paciente no sabía el ritmo.** La ficha dice 3-1-3 (7 s) y nadie
   se lo decía; la voz y la pantalla ahora lo dicen al empezar, y al
   fallar una repetición la voz da el consejo ("Regresa más despacio").

Ojo: R01, R04 y R09 tienen `medible_goniometricamente = false` en el
catálogo, así que TODAS sus repeticiones salen DUDOSA por diseño.
