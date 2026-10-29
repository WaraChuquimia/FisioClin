# Etapa 6 — Etiqueta de ejecucion

Salidas: `05_repeticiones/calidad.csv` (el maestro con indicadores y
veredicto) y `resumen_calidad.csv`.

```bash
python artrosis_06_calidad.py
```

## Un indicador por criterio, no una etiqueta unica

Una repeticion puede tener mal el tempo **y** compensar con el tronco a la
vez. Colapsar eso en "incorrecta" pierde justo lo que le sirve al paciente
y al medico, que necesitan saber **en que** falla. Cada criterio es una
columna booleana independiente y el veredicto se deriva de ellas.

| Veredicto | Regla |
|---|---|
| `CORRECTA` | ningun indicador se activa y la medicion es representativa |
| `DUDOSA` | se activa un indicador, **o** la medicion no es representativa |
| `INCORRECTA` | se activan dos o mas |

**`DUDOSA` no es indecision: es honestidad.** Cuando el movimiento ocurre
fuera del plano de la camara, forzar un binario introduce ruido de etiqueta
que despues el modelo aprende como si fuera senal.

## De donde sale cada criterio

Esto es lo que decide cuanto vale cada numero de esta etapa:

| Indicador | Referencia | Circular |
|---|---|---|
| `tempo_dejado_caer` | biomecanica: la vuelta no puede durar mucho menos que la ida | no |
| `tempo_brusco` | idem, al reves | no |
| `duracion_fuera_de_tempo` | `tempo_esperado` de la ficha clinica | **no** |
| `compensacion_tronco` | la mediana del propio ejercicio | **SI** |
| `asimetria` | comparacion entre los dos lados de la misma repeticion | no |

**`compensacion_tronco` es circular** y va marcado como tal: no existe un
umbral clinico de cuanto puede moverse el tronco, asi que cada repeticion
se compara con la mediana de su propia clase. Acertarla mide coherencia
del sistema consigo mismo, no acuerdo con un fisioterapeuta.

## Por que el ROM no entra en el veredicto

`rom_esperado` de la ficha es un arco medido **desde la posicion neutra**;
`rom_grados` es el **recorrido del ciclo detectado**. Solo coinciden cuando
el ejercicio arranca en neutro, y varios no lo hacen:

| Caso | Medido | Esperado | Lectura |
|---|---:|---:|---|
| C09 extension de cadera en cuadrupedia | 71 grados | 30 | 237 % |
| R04 hip thrust | 73 | 30 | 244 % |
| R02 elevacion de pierna recta | 84 | 45 | 187 % |
| C07 estiramiento (sostenido) | 7,6 | 120 | 6 % |

En cuadrupedia la cadera parte de unos 90 grados de flexion, asi que el
ciclo recorre 70-90 grados aunque solo los ultimos 30 sean extension mas
alla de neutro. En C07 se compara la oscilacion de una retencion contra el
arco de flexion, que son cosas distintas.

Aplicado tal cual, el criterio marcaba **147 de 157 repeticiones como rango
insuficiente**: casi todas las demostraciones de un fisioterapeuta. Cuando
una regla dice eso, la regla esta mal.

El ROM se guarda como `pct_arco_esperado`, **columna descriptiva**.
Convertirlo en criterio pide que el fisioterapeuta aclare, por ejercicio,
si el `0-30` significa el arco recorrido o los limites absolutos.

## La correccion de lateralidad

En la primera corrida `asimetria` se disparaba en 64 de 128 repeticiones y
hundia el resultado. La causa no era el umbral: la ficha declaraba
**18 ejercicios bilaterales** y solo 5 lo son.

Se resolvio midiendo, no declarando: **la correlacion temporal entre el
angulo del lado derecho y el del izquierdo.** Si las dos piernas recorren
su arco a la vez, la correlacion es alta; si una trabaja mientras la otra
descansa, es baja o negativa.

| Bilaterales medidos | correlacion |
|---|---:|
| C01 puente | +0,76 |
| C04 twist | +0,82 |
| R04 hip thrust | +0,97 |
| R07 peso muerto | +0,91 |
| R08 sentadilla profunda | +0,90 |

C07, el estiramiento del recto anterior, da **−0,97**: perfectamente
anticorrelado, una pierna estira mientras la otra descansa. En un ejercicio
alterno la asimetria entre lados es lo esperado y no un error, asi que el
indicador solo se aplica donde `bilateral_medido = 1`. **Efecto: de 64
activaciones a 7.**

## Resultado

128 repeticiones: **31 correctas, 82 dudosas, 15 incorrectas**.

De las 82 dudosas, **31 lo son porque la medicion no es representativa** —
24 por movimiento fuera del plano de la camara y 7 por rotacion, que con
una sola camara solo deja ver su sombra — y 51 por tener un unico
indicador activo.

Sobre las 97 repeticiones con medicion fiable: 31 correctas, 51 dudosas,
15 incorrectas.

## Lo que esta etiqueta NO es

**No es un criterio clinico validado.** Sale de reglas, y de las cinco solo
cuatro tienen referencia externa. Cualquier exactitud medida contra ella
mide acuerdo con estas reglas, no con un fisioterapeuta.

**Y el material no es una coleccion de ejecuciones correctas.** Son
demostraciones de catalogo, no ejecuciones de un paciente siguiendo una
prescripcion. Nadie ha confirmado que cada tanda demostrada sea, ella
misma, una ejecucion correcta segun el criterio de la propia ficha.

Cerrar las dos cosas pide lo mismo: que un clinico anote un subconjunto.
