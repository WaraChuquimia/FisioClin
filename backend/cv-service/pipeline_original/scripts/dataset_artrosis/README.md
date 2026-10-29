# Dataset de ejercicios terapeuticos para artrosis de cadera y rodilla

Version **1.0** (dataset completo y red entrenada). Construido desde 20
videos de catalogo — 10 de cadera y 10 de rodilla, uno por ejercicio —
con el objetivo de evaluar el movimiento articular por vision
computacional: reconocer el ejercicio, medir angulos y rango de
movimiento, contar repeticiones y valorar la ejecucion.

Los videos **no viven en el repositorio** (pesan 1,9 GB). Viven en
`~/OneDrive - Escuela Militar de Ingenieria/Desktop/catalogo_de_ejercicios/`,
en dos carpetas (`cadera/` y `RODILLA/`), y el dataset los referencia por
un `id` estable, nunca por su nombre de archivo.

## Estado

| Etapa | Salida | Estado |
|---|---|---|
| 0 Indice | `00_indice/videos.csv` | hecha |
| 1 Contenido | `01_contenido/` | hecha |
| — Ficha clinica | `referencia/ficha_clinica.csv` | llena y validada por PT; normalizada en `ficha_normalizada.csv` |
| 2 Landmarks | `02_landmarks/` | hecha |
| 3 Angulos | `03_angulos/` | hecha |
| 4 Segmentos | `04_segmentos/` | hecha |
| 5 Repeticiones | `05_repeticiones/` | hecha |
| 6 Calidad | `05_repeticiones/calidad.csv` | hecha |
| 7 Ventanas | `06_ventanas/` | hecha |
| 8 Modelo | `07_modelo/` | hecha |
| 9 Evaluacion | `07_modelo/` | hecha |
| 10 Integracion | `07_modelo/latencia.csv` | hecha, con un desajuste abierto |

`python artrosis_verificar.py` imprime este estado al dia, comprueba que
los 20 videos siguen siendo los mismos y avisa si cambio alguna libreria
respecto de la que produjo los datos en disco.

## Estructura

```
dataset_artrosis/
├── 00_indice/        inventario tecnico. Unica puerta de entrada
├── 01_contenido/     diagnostico: escenas, pose, encuadre, orientacion
├── 02_landmarks/     un .npz por video: los 33 puntos, sin interpretar
├── 03_angulos/       una fila por fotograma: features y goniometria
├── 04_segmentos/     tandas de ejercicio recortadas, y las descartadas
├── 05_repeticiones/  ← DATASET MAESTRO: una repeticion por fila
├── 06_ventanas/      ← DATASET ML: tensor regenerable
├── anotaciones/      etiquetas humanas, con autor y fecha
├── referencia/       ficha clinica de los 20 ejercicios (entrada manual)
└── documentacion/    diccionarios por etapa, sello de entorno
```

**La numeracion cambio respecto del diseno inicial.** El diseno no
preveia una etapa de diagnostico separada: suponia pasar del indice
directo a los landmarks. La etapa 1 existe porque las preguntas de
comprension de los datos — cuantos planos hay, cuanta oclusion, que vista,
cuantos sujetos — se contestan con un muestreo barato a 2 Hz y no hacia
falta la extraccion completa para responderlas. Todo lo posterior corrio
un numero.

## Convenciones

**El `id` manda.** `C01`..`C10` para cadera, `R01`..`R10` para rodilla.
Los nombres de archivo traen tildes, dobles espacios, erratas
(`SENTADI PROFUNDA`, `LA PIENA`, `SENTADILLLA`) y numeros de ejercicio que
en las copias sueltas **no coinciden** con los del catalogo. Ninguna etapa
depende de ellos.

**Cada etapa lee de la anterior y escribe salida nueva. Ninguna modifica
su entrada.** Se puede borrar de una etapa hacia adelante y reconstruir
sin volver a tocar los videos, que es lo unico caro del pipeline.

**La escena es la unidad de agrupamiento**, no el fotograma ni la
ventana. Dentro de un plano continuo el material se parece muchisimo:
repartirlo al azar entre entrenamiento y prueba da una exactitud alta y
falsa. Toda particion se hace agrupando por escena — y por sujeto en
cuanto haya mas de uno.

**Nada de valores clinicos inventados.** Lo que no puede medirse va vacio
en `referencia/ficha_clinica.csv` hasta que lo complete un
fisioterapeuta. Si hace falta un numero para que el pipeline corra, se
marca como provisional y se registra como deuda.

**Todo lo descartado se registra con su motivo.** Un dataset donde no se
puede reconstruir que se tiro y por que no es reproducible.

## Reproducir desde cero

```bash
python artrosis_verificar.py
python artrosis_00_indice.py
python artrosis_01_contenido.py && python artrosis_01_resumen.py
python artrosis_02_landmarks.py --worker 0 --workers 4   # un proceso por nucleo
python artrosis_02_landmarks.py --consolidar
python artrosis_03_angulos.py
python artrosis_04_ficha.py
python artrosis_05_segmentos.py
python artrosis_06_calidad.py
python artrosis_07_ventanas.py
python artrosis_08_entrenar.py --folds 5 --semillas 3
python artrosis_09_evaluar.py
python artrosis_09_sensibilidad.py
```

Las dos pasadas que abren los videos son las unicas caras: la 1 tarda unos
25 minutos y la 2 unos 80 minutos de CPU (20 repartidos en 4 procesos). El
resto corre en segundos y se puede repetir cuantas veces haga falta.

## Limitaciones del material

Medidas en la etapa 1, y hay que arrastrarlas hasta el informe final:

1. **Dos sujetos, no uno ni veinte.** Dieciocho videos son del mismo
   fisioterapeuta en la misma sala; `R01` y `R02` son de otra persona, en
   un gimnasio clinico, y son montajes editados. Esos dos videos son los
   unicos de esa persona **y** los unicos de sus dos ejercicios: sujeto,
   escenario y clase son la misma variable, y ninguna particion puede
   separarlos.
2. **Un video por clase.** El fondo predice el ejercicio. Usar features
   invariantes (angulos, no coordenadas crudas) mitiga, no elimina.
3. **Ninguna ejecucion incorrecta.** Es material de demostracion. No hay
   clase negativa real para aprender a distinguir bien de mal ejecutado.
4. **Una sola vista por ejercicio.** Hay material frontal y lateral en el
   conjunto, pero ningun ejercicio esta grabado desde las dos: el efecto
   de la vista no es estudiable con este material.
5. **Encuadre incompleto en parte del metraje.** 72,7 % de los fotogramas
   tienen el nucleo completo y visible; `R03` baja a 46,6 % y `C01` a
   50,4 %.
6. **El servicio en vivo no reproduce las features del dataset.** El
   suavizado de la etapa 3 es no causal: mira 0,35 s hacia el futuro. El
   mismo modelo pasa de 1,00 a 0,00 de exactitud en C01 solo por cambiar
   como se calculan las features. Se cierra rehaciendo las etapas 3 a 8 con
   un filtro causal — sin volver a extraer landmarks — y eso cambia todas
   las cifras de las etapas 8 y 9. Ver `documentacion/10_integracion.md`.
7. **La separacion ejercicio / explicacion no esta resuelta.** Ninguna
   senal postural global la consigue en las 20 clases; hace falta el
   angulo articular. Las columnas de movimiento de la etapa 1 son
   indicativas y no se usan como filtro.
