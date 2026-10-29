# Etapa 3 — Angulos articulares

Salida: `03_angulos/frames_maestro.csv` (una fila por fotograma admitido) y
`resumen_angulos.csv`. Corre en segundos.

```bash
python artrosis_03_angulos.py
```

## El calculo

Con el vertice de la articulacion en P2 y los extremos en P1 y P3:

    A = P1 - P2,   B = P3 - P2,   theta = arccos( (A . B) / (|A| |B|) )

Se calcula sobre las coordenadas **metricas** (`mundo`), no sobre las de
imagen: un angulo medido en pixeles es el angulo proyectado en la
pantalla, que cambia si se mueve el tripode.

| Articulacion | Puntos (proximal, vertice, distal) |
|---|---|
| Cadera | hombro, cadera, rodilla |
| Rodilla | cadera, rodilla, tobillo |
| Tobillo | rodilla, tobillo, punta del pie |

**Dos convenciones que no hay que mezclar.** `<articulacion>` es el angulo
interior (180 grados = segmento recto). `flex_<articulacion>` es la
flexion clinica (0 grados = extension completa), que es la del goniometro
y la que entiende un fisioterapeuta: `flex = 180 - interior`.

## Las cuatro comprobaciones antes de escribir un angulo

Cada una se anadio porque una fallaba donde las otras no veian nada. Las
cuatro son necesarias:

| # | Comprobacion | Que atrapa |
|---|---|---|
| 1 | **Admision**: hombro-cadera-rodilla del lado mejor visto por encima de 0,50 | Fotogramas donde no hay un lado utilizable |
| 2 | **Goniometria**: los 3 puntos de ESA articulacion por encima de 0,60 | Angulos calculados sobre puntos adivinados |
| 3 | **Plausibilidad del esqueleto**: tronco reconstruido dentro del 15 % de la mediana del dataset (0,490 m) | Reconstrucciones metricas degeneradas |
| 4 | **Recorte del suavizado** a [0, 180] | Sobrepasos del filtro |

### Por que la admision no incluye el tobillo

El tobillo es el punto que MediaPipe pierde mas a menudo: mediana 0,27 en
C02 y 0,12 en el lado tapado de C01. Exigirlo para admitir el fotograma
descartaba la mitad de esos dos videos **por un punto que el ejercicio no
usa** — el angulo de cadera se define con hombro, cadera y rodilla. Con el
tobillo fuera del criterio, C01 pasa de 51,8 % a 100 % de fotogramas
admitidos y C02 de 46,3 % a 92,7 %. Cada angulo mantiene ademas su propia
comprobacion (la 2) sobre los tres puntos que si lo definen.

### Por que hace falta la prueba de plausibilidad

En R04 aparecian flexiones de cadera de 178 grados, imposibles. No las
detectaba la visibilidad (seguia alta) ni el encuadre (el cuerpo estaba
dentro del cuadro). Lo que las delataba era la **proporcion**: en esos
fotogramas — un primer plano — el tronco reconstruido medida 0,359 m
frente a 0,489 m del resto del material. El tronco de una persona no
cambia de longitud dentro de su propio video.

La referencia es la mediana de **todo el dataset**, no la de cada video:
la de R04 estaba contaminada por sus propios fotogramas malos. Se puede
usar una referencia comun porque las medianas por video van de 0,445 a
0,530 m, incluidos los dos videos del otro sujeto.

## Suavizado

Savitzky-Golay, ventana de 7 muestras (0,7 s a 10 Hz), orden 2, **por
escena** — nunca a traves de un corte de plano. Se eligio sobre una media
movil porque preserva los extremos, y los extremos de esta serie son
justamente el ROM: aplanarlos seria subestimar el recorrido.

Los huecos de hasta 3 muestras se interpolan; los mas largos parten la
serie en tramos que se suavizan por separado. La velocidad angular
(grados/s) se deriva de la serie ya suavizada.

## La columna `desalin_`

Para cada articulacion se calcula tambien **el mismo angulo proyectado en
el plano de la imagen**, y se guarda la diferencia con el metrico. Mide
cuanto se sale el movimiento del plano que ve la camara.

Es una estimacion medida de la columna `alineado_con_camara` de la ficha
clinica: el fisioterapeuta confirma o corrige en vez de juzgarlo a ojo.
Valores medianos por video, del angulo de cadera: entre 4,1 grados (C08,
bien alineado con el plano de la camara) y 25,9 grados (R09, sentadilla
bulgara, que la etapa 1 ya habia clasificado como vista oblicua). Las tres
vistas oblicuas de la etapa 1 — R07, R09, R10 — son justamente las tres de
mayor desalineacion: las dos medidas, independientes entre si, coinciden.

## Columnas

`id`, `grupo`, `escena`, `frame`, `t_seg`, `vis_min_nucleo`,
`vis_media_nucleo`, `vis_lado_medido`, `lado_medido`, `cuerpo_completo`,
`tronco_m`, `razon_tronco`, `inclinacion_tronco`, y por cada una de las
seis articulaciones: `<art>` (interior suavizado), `flex_<art>` (flexion
clinica), `vel_<art>` (grados/s), `desalin_<art>`.

Celda vacia = no se cumplio alguna de las comprobaciones. **Una celda
vacia es preferible a un angulo calculado sobre puntos adivinados.**

## Limitacion conocida y no resuelta

`arccos` devuelve siempre un valor en [0, 180] y **no distingue flexion de
hiperextension**: si la cadera pasa de la posicion neutra hacia atras, el
angulo interior vuelve a bajar desde 180 y la flexion calculada sube en
vez de hacerse negativa. Afecta a los ejercicios de extension de cadera
(puente, hip thrust, extension en cuadrupedia y de pie), que son varios en
este catalogo.

Resolverlo pide un **angulo con signo**: proyectar sobre el plano sagital
del cuerpo y usar `atan2` en vez de `arccos`, tomando la direccion
anterior del tronco como referencia. Queda pendiente para la siguiente
iteracion.
