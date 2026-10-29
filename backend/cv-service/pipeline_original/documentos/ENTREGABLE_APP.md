# FisioClin — qué poner en la app

Entregable de integración. Qué archivos copiar, cómo se usan, qué pantallas
hacen falta, qué se guarda en la base de datos y qué **no** se puede
afirmar.

---

## 1. Los archivos

Copiar al servicio de visión de la app:

| Archivo | Qué es | ¿Se edita? |
|---|---|---|
| `fisioclin_evaluador.py` | **El módulo. Es lo único que la app importa** | No |
| `artrosis_03_angulos.py` | Geometría articular | No |
| `artrosis_06_calidad.py` | Umbrales y reglas de evaluación | Solo los umbrales, y con criterio clínico |
| `dataset_artrosis/07_modelo/configuracion_ejercicios.json` | Los 20 ejercicios con su banda medida | No: se regenera del dataset |
| `dataset_artrosis/07_modelo/modelo.keras` + `escalador.npz` | La red | Solo si `verificar_con_red=True` |

Dependencias: `opencv-python`, `mediapipe==0.10.14`, `numpy`, `scipy`.
TensorFlow **solo** si se activa la verificación con red.

`artrosis_03_angulos.py` y `artrosis_06_calidad.py` se importan a propósito
en vez de copiar sus fórmulas: es la única forma de garantizar que la app
mide **exactamente igual** que el dataset. Si se duplican, divergen.

---

## 2. Cómo se usa

```python
from fisioclin_evaluador import EvaluadorEjercicio, ejercicios_disponibles

# el médico prescribió: 3 series de 10 repeticiones de C01
ev = EvaluadorEjercicio("C01", series=3, repeticiones=10, rom_objetivo=30)

while camara_abierta:
    ok, frame = cap.read()
    estado = ev.procesar(frame)          # llamar a ~10 Hz

    pintar(estado.mensaje, estado.fase, estado.repeticiones, estado.angulo)

    if estado.repeticion_nueva:          # solo en el frame que la completa
        enviar_al_backend(estado.repeticion_nueva)

guardar_sesion(ev.resumen())
ev.cerrar()
```

`estado` trae, en cada fotograma: `fase`, `mensaje` (ya redactado para el
paciente), `hay_persona`, `dato_fiable`, `motivo_no_fiable`, `angulo`,
`lado`, `repeticiones`, `serie`, `progreso` (0–1 dentro de la repetición) y
`repeticion_nueva`.

Las fases que la app tiene que saber pintar:

| Fase | Qué mostrar |
|---|---|
| `SIN_PERSONA` | "Colócate frente a la cámara" |
| `DATO_NO_FIABLE` | El texto de `motivo_no_fiable`, esqueleto en gris |
| `COLOCATE` / `CALIBRANDO` | Posición inicial, semáforo ámbar |
| `LISTO` | "Empieza el movimiento", semáforo verde |
| `MOVIMIENTO` / `EXTREMO` / `VUELTA` | Barra de `progreso`, ángulo en grados |
| `REPETICION` | Contador +1 y el mensaje de la repetición |

---

## 3. Lo que la app debe tener alrededor

### Flujo, y el orden importa

```
Médico prescribe  →  ejercicio + series + repeticiones + ROM objetivo
        ↓
Paciente abre la sesión  →  la app carga SOLO los ejercicios prescritos
        ↓
Colocación de cámara  →  pantalla de encuadre (ver 3.2)
        ↓
Posición inicial confirmada  →  8 fotogramas estable
        ↓
Serie  →  repeticiones evaluadas una a una
        ↓
Resumen de sesión  →  base de datos  →  panel del médico
```

**El paciente no elige el ejercicio.** Es un requisito, no una preferencia:
todo el criterio de evaluación —ROM objetivo, tempo, qué articulación
mirar— viene de la prescripción. `ejercicios_disponibles()` devuelve el
catálogo para que el **médico** prescriba.

### 3.2 La pantalla de encuadre no es opcional

Está medido en la etapa 9: para varios ejercicios la dispersión del ROM
**entre tomas** es de hasta 28° frente a 3° dentro de una misma toma. Si el
paciente pone el teléfono en otro sitio cada día, la evolución del ROM que
verá el médico es ruido de cámara, no progreso del paciente.

Mínimo viable: una guía de silueta en la primera sesión, y guardar una
miniatura del encuadre para reproducirlo en las siguientes.

### 3.3 Tres ejercicios no están listos

`C09`, `R03` y `R10` no tienen banda de referencia medida — el detector no
encontró repeticiones suficientes. `EvaluadorEjercicio` lanza `ValueError`
si se intenta usarlos. **La app debe filtrarlos** con el campo
`listo_para_uso` de `ejercicios_disponibles()`.

### 3.4 Tres ejercicios miden algo que no es su movimiento

`C02`, `C04` y los marcados con `medicion_goniometrica_valida = false`
producen ángulos que **no son goniométricamente comparables**: son
rotaciones o movimientos fuera del plano de la cámara. El sistema los
cuenta y los describe, pero sus grados no deben presentarse al médico como
una medición articular. La app tiene que mostrarlos con una marca visible.

---

## 4. Qué guardar en la base de datos

`ev.resumen()` devuelve el objeto completo. Mapeo a tus tablas:

### `sesiones`
`duracion_segundos` ← `duracion_seg` · `frames_totales` · `frames_procesados`
← `frames_totales − frames_descartados` · `resultado_evaluacion` ←
`"correcto"` si `pct_correctas ≥ 50` · `completado` ← `cumplimiento_pct ≥ 100`

### `metricas_articulares`
Una fila por articulación medida: `angulo_maximo` ← `rom_maximo`,
`angulo_minimo`, y en `angulos_json` el bloque `{rom_medio, rom_objetivo,
repeticiones_detectadas, correctas, dudosas, incorrectas}`.

### Tabla nueva — `repeticiones`

**Esto es lo que hoy te falta y es lo que da valor clínico.** El array
`repeticiones` del resumen trae, por cada una: `n`, `serie`, `t_inicio_s`,
`duracion_s`, `flex_min_grados`, `flex_max_grados`, `rom_grados`,
`duracion_ida_s`, `duracion_vuelta_s`, `razon_ida_vuelta`,
`velocidad_media_gr_s`, `rom_tronco_grados`, `asimetria_rom`, los cinco
indicadores booleanos, `motivos`, `veredicto` y `pct_rom_objetivo`.

Guardar la repetición y no solo el promedio de la sesión es lo que permite
que el médico vea *en qué* falla el paciente, y no solo *cuánto*.

---

## 5. Qué ve cada uno

**El paciente, durante:** semáforo de tres estados, contador de
repeticiones y serie, ángulo actual, barra de progreso, y **un solo mensaje
por repetición** — el primero de `motivos`. Nunca la lista completa: cinco
correcciones a la vez no corrigen nada.

**El médico, después:** cumplimiento (repeticiones hechas / prescritas),
ROM medio y máximo contra el objetivo, % de repeticiones correctas, **qué
indicador falla más**, evolución del ROM por sesión, y la bandera de
calidad del dato.

**Junto a cada número, su confianza.** Un ROM medido con visibilidad
marginal y otro con el cuerpo entero visible no valen lo mismo, y
presentarlos idénticos induce a error clínico.

---

## 6. Qué reemplaza de `Rehab.py`, y por qué

| `Rehab.py` | Sustituto | Motivo |
|---|---|---|
| `calculate_angle` sobre píxeles | `artrosis_03_angulos` en coordenadas métricas | El ángulo en píxeles es el **proyectado**: cambia si se mueve el trípode |
| `REP_ANGLE_DOWN/UP` fijos en rodilla derecha | Umbrales por ejercicio con histéresis y sentido medido | Un puente **empieza arriba**: el umbral fijo no lo cuenta |
| `rehab24_model.tflite` (score binario) | Reglas + red opcional | La cabeza de calidad de la red (0,462) **no supera su línea base** (0,642) |
| `REP_JOINT` una sola articulación | `articulacion_medida` por ejercicio | Hay ejercicios de cadera, de rodilla y de abducción |
| `model_complexity=1` | Ver el apartado 7 | El dataset se construyó con `complexity=2` |

Lo que **sí** conviene conservar de `Rehab.py`: el dibujo accesible de
landmarks (puntos grandes y de alto contraste para adultos mayores), la
confirmación temporal del semáforo, el aviso en gris cuando la visibilidad
es baja, y el guardado local en CSV/JSON como respaldo si la base de datos
no responde. Todo eso está bien resuelto ahí.

---

## 7. Las dos decisiones que quedan abiertas

### El modelo de pose

| | Latencia | Sostenible | Efecto |
|---|---:|---:|---|
| `complexity=2` | 173 ms | 5,8 fps | Es con el que se construyó el dataset |
| `complexity=1` | 58 ms | 17,2 fps | **La exactitud de la red se desploma** |

El evaluador usa `complexity=1` por defecto, porque **las reglas —que son
las que evalúan— funcionan igual** y la app necesita fluidez. Si se activa
`verificar_con_red=True`, hay que subir a `complexity=2` y aceptar 5,8 fps.

### El desajuste causal

El suavizado del dataset es **no causal**: mira 0,35 s hacia el futuro. En
vivo eso no existe, y el evaluador usa una media exponencial hacia atrás.
Consecuencia medida (etapa 10): el mismo modelo pasa de 1,00 a 0,00 de
exactitud en C01 solo por cambiar cómo se calculan las features.

**Por eso la verificación con red viene desactivada.** Las reglas no tienen
ese problema: el ROM, el tempo y la compensación se calculan igual en vivo
que en el dataset.

Para activar la red hay que rehacer las etapas 3 a 8 con un filtro causal.
No requiere volver a extraer landmarks —lo único caro—, pero **cambia todas
las cifras de las etapas 8 y 9**.

---

## 8. Lo que la app no puede afirmar

Estas frases no tienen respaldo y no deben aparecer en la interfaz ni en la
tesis:

1. ❌ *"El sistema evalúa la ejecución mediante aprendizaje profundo."*
   La evalúan las reglas. La red reconoce el ejercicio.
2. ❌ *"Validado en pacientes."* El dataset son 2 sujetos demostrando, no
   pacientes con artrosis ejecutando una prescripción.
3. ❌ *"Detecta ejecuciones incorrectas."* No hay ni una sola ejecución
   incorrecta en el material de entrenamiento.
4. ❌ *"Mide el rango articular con precisión clínica."* No hay validación
   contra goniómetro.
5. ❌ Comparar el ROM entre sesiones sin protocolo de cámara fijo.

Lo que **sí** se puede afirmar: el sistema mide el movimiento articular en
el plano de la cámara, cuenta repeticiones, describe el tempo y la
compensación, y evalúa la ejecución **según criterios biomecánicos
validados por un fisioterapeuta**.

---

## 9. Lo primero que hay que hacer

1. **Integrar el módulo** y probarlo con una persona real frente a la
   cámara — no con los videos del catálogo.
2. **Ajustar los textos** de `_texto_repeticion` y `_texto_posicion_inicial`
   con el fisioterapeuta: son los que lee el paciente.
3. **Añadir la tabla `repeticiones`** a la base de datos.
4. **Pantalla de encuadre.** Sin ella la evolución del ROM no es
   interpretable.
5. **Filtrar C09, R03 y R10** del catálogo que ve el médico.
