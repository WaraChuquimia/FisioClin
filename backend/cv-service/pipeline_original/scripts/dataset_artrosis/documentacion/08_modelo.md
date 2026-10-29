# Etapa 8 — Particion y red temporal

Salidas en `07_modelo/`: `metricas_validacion.csv`, `matriz_confusion.csv`,
`modelo.keras`, `escalador.npz`, `modelo.json`.

```bash
python artrosis_08_entrenar.py --folds 5 --semillas 3
```

## La particion

`StratifiedGroupKFold` agrupando por **escena**, 5 folds, 3 semillas: 15
corridas.

**Por que agrupada.** Las ventanas se solapan dos tercios: dos
consecutivas son casi el mismo dato, y repartirlas al azar da una exactitud
altisima y falsa.

**Por que por escena y no por video.** Agrupar por video seria mas
exigente, y es imposible: cada clase esta en un solo video, asi que apartar
un video deja a esa clase sin un solo ejemplo de entrenamiento. No es una
eleccion metodologica sino una consecuencia del material.

**Por que estratificada.** Con `GroupKFold` a secas hubo folds donde una
clase entera caia del lado de la prueba: la exactitud se desplomaba a 0,167
y la desviacion entre folds era de 0,170. Estratificar respeta los grupos
igual y ademas reparte las clases.

**El escalador se ajusta solo con el fold de entrenamiento.** Ajustarlo
sobre todo el dataset seria fuga de informacion.

## La red

```
(30, 14) -> LSTM 64 -> Dropout 0.3 -> LSTM 32 -> Dropout 0.3 -> Dense 32
                                                        |
                                    +-------------------+-------------------+
                                    v                                       v
                          Dense 20 softmax                        Dense 3 softmax
                            (ejercicio)                              (calidad)
```

Adam 1e-3, lote 32, hasta 80 epocas con parada temprana (paciencia 15,
restaurando los mejores pesos). Peso por muestra inversamente proporcional
a la frecuencia de su clase, para compensar el desbalance de 8,9x. La
perdida de la cabeza de calidad pesa 0,3.

## Resultados fuera de fold — 15 corridas

| Metrica | Valor | Linea base |
|---|---:|---:|
| Ejercicio, por ventana de 3 s | **0,528 ± 0,142** | 0,158 |
| Ejercicio, F1 macro | 0,402 ± 0,105 | — |
| Ejercicio, voto por tanda | **0,558 ± 0,127** | — |
| Calidad (cabeza de la red) | 0,462 ± 0,132 | **0,642** |

**La desviacion es grande y hay que reportarla siempre.** Los folds van de
0,226 a 0,736 de exactitud por ventana. Con 899 ventanas y 101 escenas
cualquier cifra unica es fragil: el numero honesto es media y dispersion
sobre las 15 corridas, no el mejor fold.

## La cabeza de calidad quedo por debajo de su linea base, y no es un fallo

0,462 frente a 0,642. La red aprende a reproducir las reglas de la etapa 6,
que ya se calculan exacto desde los mismos angulos: solo puede perder
informacion por el camino. Es el resultado que se esperaba y **es la
justificacion de que la evaluacion de la ejecucion la hagan las reglas y no
la red**. La prediccion de la red se puede exponer aparte, como contraste,
pero no como criterio.

## Por clase

Las dos peores son `extension_flexion_de_rodilla` (F1 0,14) y
`elevacion_de_pierna_recta` (F1 0,01), **los dos unicos videos del segundo
sujeto**, y se confunden entre si: 50 y 34 casos cruzados. Que el modelo
las confunda entre ellas y no con el resto indica que **no esta usando el
escenario para clasificar** — si lo usara, esas dos, grabadas en un
gimnasio distinto, serian trivialmente separables del resto. Es evidencia
de que las features invariantes hacen su trabajo.

Las demas confusiones son anatomicamente coherentes: el estiramiento del
recto anterior con la extension de rodilla sobre cojin (las dos son flexion
de rodilla en el suelo), y la extension de rodilla en prono con la flexion
de rodilla al pecho.

## Lo que NO se puede afirmar con estas cifras

1. **Generalizacion a pacientes nuevos.** La particion por escena mide
   generalizacion a otro plano de camara, no a otro cuerpo. Con dos sujetos
   en el material, uno de ellos en solo dos clases, no es demostrable.
2. **Que la red evalua la calidad de la ejecucion.** No la supera a las
   reglas; la evaluan las reglas.
3. **Ninguna cifra obtenida reproduciendo los propios videos con el modelo
   final.** Ese modelo entreno con todas las escenas y ya vio ese material.
   La cifra publicable es la de fuera de fold: **0,558 por tanda**, siempre
   junto a la linea base de 0,158.
