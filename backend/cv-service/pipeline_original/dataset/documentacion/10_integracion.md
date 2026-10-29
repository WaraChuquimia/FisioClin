# Etapa 10 — Integracion en vivo

Salidas: `07_modelo/latencia.csv` y este documento.

```bash
python artrosis_10_servicio.py --videos C01,R06 --complejidad 2
```

El evaluador recorre un video como si los fotogramas llegaran de una
camara: solo puede mirar hacia atras. Reparte las responsabilidades como
quedo demostrado en la etapa 8 — **la red dice que ejercicio es, las reglas
dicen si esta bien ejecutado**.

## Latencia

Medido sobre 200-300 fotogramas por video, en CPU.

| Modelo de pose | Pose | Features + red | Total | Sostenible |
|---|---:|---:|---:|---:|
| `complexity=2` (el del dataset) | 171 ms | 2 ms | **173 ms** | 5,8 fps |
| `complexity=1` | 56 ms | 2 ms | **58 ms** | 17,2 fps |

**La inferencia no es el cuello de botella: la pose lo es.** La red tarda
2 ms.

Una correccion que valia 100x: la primera version llamaba a
`modelo.predict()` por fotograma y costaba **201 ms**. `predict` monta un
bucle de datos completo en cada llamada, y sobre un solo ejemplo eso cuesta
mucho mas que la propia red. Con `modelo(x, training=False)` baja a 2 ms.
Ademas se predice cada 5 fotogramas — dos veces por segundo — porque el
ejercicio no cambia diez veces por segundo.

**El dataset asume 10 Hz y `complexity=2` solo sostiene 5,8.** Las opciones
son bajar la cadencia del dataset a 5 Hz y reentrenar, o reconstruirlo con
`complexity=1`. Las dos obligan a rehacer la extraccion de landmarks.

## El problema serio: el servicio no reproduce las features del dataset

El mismo modelo, con los mismos pesos, sobre los mismos fotogramas:

| Video | Con features offline | Con features en vivo |
|---|---:|---:|
| C01 | 1,00 | **0,00** |
| C03 | 1,00 | 0,04 |
| R08 | 0,94 | 0,29 |
| R06 | 0,99 | 0,59 |

La columna offline esta contaminada — el modelo final entreno con ese
material — pero eso no invalida la comparacion: **aisla la unica variable
que cambia, que es como se calculan las features.**

### De donde sale la diferencia

1. **El suavizado del dataset es no causal.** La etapa 3 usa un
   Savitzky-Golay centrado de 7 muestras: para dar el valor de un instante
   mira 0,35 s hacia el futuro. En vivo eso no existe, y el servicio usa
   una media movil de las 5 ultimas. Son dos senales distintas.
2. **La velocidad se calcula distinto.** Offline es el gradiente de la
   serie ya suavizada; en vivo es la diferencia con la muestra anterior.
3. **La referencia de tronco es distinta.** Offline es la mediana de todo
   el dataset; en vivo se aprende sobre la marcha.

### Una hipotesis que result falsa, y conviene anotarla

Se probo primero que el modelo fallaba por estar clasificando tramos de
"no ejercicio" que nunca vio en el entrenamiento. **No es eso**: separando
las predicciones dentro y fuera de las tandas, la exactitud dentro es a
veces *peor* que fuera (C01: 0 % dentro, 47 % fuera). La causa es el
desajuste de senal, no el contexto.

## Que hay que hacer

**Reconstruir las features con un filtro causal y reentrenar.** El
suavizado tiene que ser el mismo en el dataset y en el servicio; cual de
los dos se cambia es indiferente mientras sean el mismo. Lo natural es
hacer causal el del dataset, porque el del servicio no puede dejar de
serlo.

Coste: re-correr las etapas 3 a 8. **No hace falta volver a extraer
landmarks**, que es lo unico caro — son segundos de calculo mas unos 20
minutos de entrenamiento.

Consecuencia: **cambia todas las cifras de las etapas 8 y 9**, porque la
senal de entrada es otra. Es una decision de la autora, no del pipeline:
mientras no se haga, las cifras publicadas son validas **para el analisis
de video grabado** y no para el sistema en vivo, y hay que decirlo asi.
