# FisioClin — paquete completo

Dataset de ejercicios terapéuticos para artrosis de cadera y rodilla,
construido desde 20 videos de catálogo mediante CRISP-DM, con su red
temporal, su evaluador en vivo y su documentación.

## Qué hay aquí

```
colab/          Cuaderno para entrenar en Google Colab
dataset/        El conjunto de datos completo, con toda su trazabilidad
scripts/        Los 19 programas que lo producen, en orden de ejecución
documentos/     Los entregables escritos
```

## Empezar por aquí

**Para entrenar sin instalar nada:** abre `colab/FisioClin_entrenamiento.ipynb`
en Google Colab, sube `dataset/06_ventanas/ventanas.npz` y
`dataset/06_ventanas/clases.json`, y ejecuta las celdas en orden.

**Para entender el conjunto de datos:** `dataset/README.md` y los diez
documentos de `dataset/documentacion/`.

**Para integrarlo en la app:** `documentos/ENTREGABLE_APP.md`.

**Para documentar la red en la tesis:** `documentos/ENTREGABLE_RED.md`.

## El conjunto de datos, en cifras

| | |
|---|---|
| Material de origen | 20 videos · 37,1 min · **2 sujetos** |
| Fotogramas con pose | 21 808 muestras a 10 Hz · 99,2 % |
| Goniometría | 21 147 fotogramas · 8 ángulos articulares |
| Conjunto maestro | **136 repeticiones** con ROM, tempo y compensación |
| Conjunto de aprendizaje | **899 ventanas** · 20 clases · 101 escenas |
| Reconocimiento | **0,558 ± 0,127** por tanda (línea base 0,158) |
| Evaluación de la ejecución | Por reglas: la red no supera su línea base |

## Reproducir el conjunto desde los videos

Los videos no van en el paquete: pesan 1,9 GB. Con ellos en su carpeta:

```bash
python artrosis_verificar.py
python artrosis_00_indice.py
python artrosis_01_contenido.py && python artrosis_01_resumen.py
python artrosis_02_landmarks.py --worker 0 --workers 4
python artrosis_02_landmarks.py --consolidar
python artrosis_03_angulos.py
python artrosis_04_ficha.py
python artrosis_05_segmentos.py
python artrosis_06_calidad.py
python artrosis_07_ventanas.py
python artrosis_08_entrenar.py --folds 5 --semillas 3
python artrosis_09_evaluar.py
python artrosis_09_sensibilidad.py
python artrosis_11_configuracion.py
```

Sólo la segunda pasada es cara (unos 80 minutos de CPU repartidos en cuatro
procesos). El resto corre en segundos.

## Lo que estos datos NO permiten afirmar

1. Generalización a pacientes nuevos: hay **dos sujetos**, y uno aparece en
   sólo dos clases.
2. Detección de ejecuciones incorrectas: **no hay ninguna** en el material.
3. Que la red evalúa la calidad: la evalúan las reglas, y está medido.
4. Precisión clínica del ángulo: falta validación contra goniómetro.
5. Comparación del rango entre sesiones sin protocolo de cámara fijo.

Todo ello está desarrollado en `dataset/documentacion/`.
