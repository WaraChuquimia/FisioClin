# Etapa 2 — Landmarks

Salida: `02_landmarks/<id>.npz`, uno por video, mas `registro_worker*.csv`.

```bash
python artrosis_02_landmarks.py --worker 0 --workers 4   # un proceso por nucleo
```

Es la unica etapa cara (unos 2 s de proceso por segundo de video) y la
unica que vuelve a abrir los videos. Todo lo posterior trabaja sobre estos
archivos y corre en segundos.

## Parametros fijados

| Parametro | Valor | Por que |
|---|---|---|
| Frecuencia de muestreo | **10 Hz** | Un ciclo de ejercicio dura 2–6 s (0,17–0,5 Hz): a 10 Hz caen 20–60 muestras por repeticion. Fija la cadencia del dataset para que una ventana de N muestras dure lo mismo aunque entre material grabado a otra velocidad |
| Modelo | `model_complexity=2` | El pesado. Los angulos son el producto de esta etapa y no se puede recuperar precision perdida aqui |
| Modo | video, con seguimiento | Da landmarks temporalmente mas estables que tratar cada fotograma por separado |
| Ancho de proceso | 640 px | MediaPipe reescala internamente; mas resolucion no mejora y multiplica el tiempo |
| Confianzas | 0,5 / 0,5 | Valores por defecto de la libreria |

## Que se guarda

| Clave | Forma | Que es |
|---|---|---|
| `lm` | `(N, 33, 4)` | Coordenadas **normalizadas de imagen** `x, y, z, visibility`. Para encuadre, oclusion y para dibujar sobre el video |
| `mundo` | `(N, 33, 4)` | Coordenadas **metricas** centradas en la cadera. Aqui se calculan los angulos: no las deforma la perspectiva |
| `frame` | `(N,)` | Fotograma del video original |
| `t_seg` | `(N,)` | Segundo dentro del video |
| `escena` | `(N,)` | Plano continuo. **Unidad de agrupamiento para train/test** |
| `meta` | `(7,)` | id, grupo, Hz destino, fps nativo, complejidad, ancho, umbral de corte |

Los fotogramas sin pose se guardan igual, con `NaN`. **No se filtra nada
en esta etapa**: ni por visibilidad, ni por encuadre, ni por postura.
Descartar aqui seria irreversible; descartar en la etapa 3 no lo es.

## Las dos representaciones

MediaPipe devuelve dos juegos de puntos y confundirlos es un error caro:

* `lm` esta en coordenadas de imagen. Un angulo calculado ahi es el angulo
  **proyectado en la pantalla**, que depende de donde estaba el tripode.
* `mundo` esta en metros aproximados, con origen en el punto medio de las
  caderas y ejes anclados al cuerpo. Es la representacion correcta para
  goniometria porque no la deforma la perspectiva.

Ninguna de las dos arregla el problema de fondo: con **una sola camara**,
un movimiento que ocurre fuera del plano que la camara ve se estima por
inferencia del modelo, no por medicion. Que ejercicios estan en ese caso
lo dice la columna `alineado_con_camara` de la ficha clinica.

## El reinicio en los cortes de plano

En modo video MediaPipe arrastra la pose del fotograma anterior para
suavizar. A traves de un corte de montaje eso **inventa una transicion que
no existe**: interpola entre dos posturas que en la realidad no estan
conectadas.

Por eso los cortes se detectan primero — misma regla que la etapa 1, sobre
la rejilla de 10 Hz — y el estimador se reinicia en cada uno. Es la razon
de que el script recorra cada video dos veces.

Estos `escena` son mas finos que los de la etapa 1, que se calcularon
sobre un muestreo de 2 Hz para diagnostico. **La particion autoritativa es
la de esta etapa.**

## Registro

`registro_worker*.csv` — una fila por video: `muestras`, `escenas`,
`cortes`, `con_pose`, `pct_pose`, `vis_nucleo_p50`, `vis_nucleo_p05`,
`mb`, `segundos_proceso`. Sirve para detectar de un vistazo el video que
se proceso mal.
