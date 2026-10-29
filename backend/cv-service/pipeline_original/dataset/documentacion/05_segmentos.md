# Etapa 5 — Tandas y repeticiones

Salidas: `04_segmentos/segmentos.csv`, `04_segmentos/segmentos_descartados.csv`
y `05_repeticiones/repeticiones.csv` (**el dataset maestro**: una
repeticion por fila). Corre en segundos.

```bash
python artrosis_05_segmentos.py
```

## La senal

Aqui se cierra lo que la etapa 1 dejo abierto. Alli quedo demostrado que
ninguna senal derivada de la postura global separa ejercicio de quietud:
la velocidad instantanea no distingue un puente lento de estar tumbado, y
la excursion postural es ciega a una abduccion en cuadrupedia, donde el
tronco no se mueve.

La senal que si lo consigue es **el angulo de la articulacion que ese
ejercicio mueve**, que la ficha clinica declara ejercicio por ejercicio
(`articulacion_medida`). Un ejercicio esta ocurriendo cuando ese angulo
recorre un arco y vuelve, no cuando el cuerpo se desplaza.

## Cuatro decisiones, cada una corrigiendo un error medido

### 1. El lado que se elige es el que MAS SE MUEVE, no el que mejor se ve

Parece razonable medir el lado con mas landmarks visibles, y es un error:
en los ejercicios de piernas alternas la camara suele ver mejor la pierna
de apoyo, que es justamente la que no trabaja. Con el criterio de
visibilidad, C09 (extension de cadera en cuadrupedia) media la pierna
quieta.

### 2. Las repeticiones se buscan sobre la ESCENA, no sobre la tanda

La tanda es un recorte hecho con una ventana movil de excursion, y sus
bordes caen a media repeticion. Como la deteccion de picos exige un
extremo a cada lado, la primera y la ultima repeticion de cada tanda se
perdian; con tandas de una o dos repeticiones, eso era perderlas casi
todas. **Efecto medido: de 52 repeticiones a 79.**

La escena es un plano continuo, la unidad natural del movimiento. Cada
repeticion se asigna despues a la tanda con la que mas se solapa.

### 3. La deteccion es agnostica al sentido del movimiento

Una repeticion es una excursion y su vuelta, **sin importar si el angulo
sube o baja primero**. En un puente o en una extension de cadera en
cuadrupedia el ciclo empieza arriba: la cadera parte flexionada y el
movimiento la lleva a la extension, asi que el ciclo es pico-valle-pico.
En una elevacion de rodilla al pecho es al reves.

Exigir valle-pico-valle, que es lo que se hace por defecto, solo detectaba
los ejercicios que empiezan abajo. **Efecto medido: de 79 repeticiones a
157**, y la columna `sentido` guarda cual de los dos es cada clase.

### 4. La asignacion es por solapamiento, no por el instante del pico

En un ejercicio con retencion arriba el pico cae en una meseta; la
excursion movil alli es baja y el pico queda fuera de la tanda que ese
mismo movimiento genero.

## Umbrales

| Constante | Valor | Que decide |
|---|---|---|
| `EXCURSION_TANDA` | 15 grados | Recorrido minimo en 6 s para considerar que se ejercita |
| `DURACION_MIN_TANDA` | 4 s | Una tanda mas corta no contiene una repeticion |
| `PROMINENCIA_MIN` / `_REL` | 10 grados / 0,25 | Cuanto tiene que destacar un extremo: el mayor de los dos |
| `SEPARACION_MIN` | 1 s | Entre extremos consecutivos, para no contar dos veces |
| `DURACION_REP` | 1 a 15 s | Fuera de ese rango no es una repeticion |
| `EXCURSION_RETENCION` | 8 grados | Por encima, no se esta sosteniendo |

## Columnas de `repeticiones.csv`

Identificacion: `repeticion_id`, `segmento_id`, `id`, `escena`,
`ejercicio`, `grupo`, `tipo`, `articulacion_medida`, `lado_medido`,
`movimiento`, `alineado_con_camara`.

Tiempo: `t_inicio_s`, `t_pico_s`, `t_fin_s`, `duracion_s`, `sentido`.

Recorrido: `flex_min_grados`, `flex_max_grados`, `rom_grados`.

Dinamica: `duracion_ida_s`, `duracion_vuelta_s`, `razon_ida_vuelta`,
`velocidad_media_gr_s`, `velocidad_pico_gr_s`.

Compensacion y simetria: `rom_tronco_grados`,
`rom_contralateral_grados`, `asimetria_rom`.

**`razon_ida_vuelta` es la columna que detecta la repeticion dejada caer.**
Un ROM correcto ejecutado sin control excentrico no es una repeticion
correcta, y ninguna medida de recorrido lo ve: solo la razon entre fases.

## Validacion

`_deteccion.png` dibuja la senal angular con las tandas y las repeticiones
detectadas encima, para cuatro videos. Es la comprobacion que hizo
aparecer los cuatro errores de arriba; cualquier cambio de umbral deberia
volver a mirarse ahi antes de darlo por bueno.

## Limitaciones conocidas

1. **Sin verdad de referencia.** Nadie ha contado a mano las repeticiones
   de un video. La validacion es visual sobre la senal, no contra un
   observador humano: no hay una cifra de acierto del detector. Cerrar
   esto pide anotar manualmente un subconjunto.
2. **C09 sigue subdetectado** (1 repeticion). Sus escenas contienen uno o
   dos ciclos cada una y los extremos de escena se pierden.
3. **R10 (equilibrio monopodal) da cero retenciones.** Su angulo de
   rodilla oscila entre 8 y 78 grados, asi que el criterio de retencion no
   lo reconoce. Es un problema de definicion, no de umbral: en un ejercicio
   de equilibrio lo que se sostiene es el centro de masas, no un angulo
   articular. Necesita su propia metrica, basada en la oscilacion del
   tronco.
4. **El angulo sigue sin signo** (ver `03_angulos.md`): en los ejercicios
   de extension de cadera, la hiperextension se lee como flexion creciente.
