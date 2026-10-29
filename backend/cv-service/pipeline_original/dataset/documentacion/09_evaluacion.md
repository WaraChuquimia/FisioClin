# Etapa 9 — Evaluacion

Salidas en `07_modelo/`: `curva_aprendizaje.csv`, `ablacion.csv`,
`sensibilidad_umbrales.csv`, `repetibilidad_rom.csv`,
`_curva_aprendizaje.png`.

```bash
python artrosis_09_evaluar.py        # curva de aprendizaje y ablacion (~25 min)
python artrosis_09_sensibilidad.py   # umbrales y repetibilidad (segundos)
```

Cuatro preguntas que las metricas de la etapa 8 no contestan.

## 1. Serviria de algo mas material?

Se entrena con fracciones crecientes de las escenas de entrenamiento y se
mide la exactitud fuera de fold. Cinco folds por punto.

| Escenas | Ventanas | Clases sin ejemplo | Exactitud por ventana | Por tanda |
|---:|---:|---:|---|---:|
| 20 (25 %) | 180 | 5,8 | 0,155 ± 0,071 | 0,124 |
| 40 (50 %) | 371 | 1,8 | 0,335 ± 0,119 | 0,356 |
| 60 (75 %) | 555 | 0,6 | 0,452 ± 0,141 | 0,443 |
| 80 (100 %) | 719 | 0,0 | 0,495 ± 0,118 | 0,519 |

**La curva sigue subiendo.** La pendiente se reduce — +0,118 entre el 50 y
el 75 %, +0,042 entre el 75 y el 100 % — pero no se ha agotado. Con todo el
material disponible el modelo todavia esta aprendiendo.

Esto responde con un numero a la pregunta de si la captura complementaria
esta justificada: **si**. No es una intuicion metodologica, es la pendiente
medida de la curva.

Con el 25 % del material casi seis clases se quedan sin un solo ejemplo de
entrenamiento y la exactitud cae a la linea base. Es otra forma de ver lo
escaso que es el material: **el dataset entero esta cerca del minimo para
que las 20 clases existan.**

## 2. Aportan algo las features anadidas?

Se reentrena quitando grupos de features, con la misma particion.

| Variante | Features | Exactitud por ventana | Por tanda |
|---|---:|---|---:|
| completo | 14 | 0,495 ± 0,118 | 0,519 |
| sin abduccion | 11 | 0,529 ± 0,144 | 0,528 |
| sin velocidades | 11 | 0,519 ± 0,081 | 0,535 |
| solo angulos | 9 | 0,492 ± 0,078 | 0,521 |

**Las cuatro variantes son indistinguibles entre si.** Las diferencias
(0,03) son mucho menores que la desviacion entre folds (0,08-0,14).

Con cinco corridas por variante, este experimento **solo puede detectar
diferencias mayores que unos 0,15**. No demuestra que las features
adicionales sean inutiles: demuestra que este dataset no tiene resolucion
para medir su efecto. Afirmar cualquiera de las dos cosas con estos numeros
seria pasarse.

Lo que si se puede decir: **para clasificar el ejercicio bastan los nueve
angulos**. La abduccion no se anadio para clasificar sino para **medir**
— sin ella, cinco ejercicios del catalogo tenian su ROM calculado sobre un
plano que no es el suyo, y la segmentacion en repeticiones no los
detectaba. Ahi si es imprescindible, y eso no lo mide esta tabla.

## 3. Dependen las conclusiones de mis umbrales?

Se mueve cada constante de la etiqueta un ±20 % y se reevalua **por el
mismo camino de codigo**, contando cuantos veredictos cambian.

| Umbral | −20 % | +20 % |
|---|---:|---:|
| `DESVIO_TEMPO` | **10,3 %** | 6,6 % |
| `RAZON_DEJADO_CAER` | 7,4 % | 4,4 % |
| `RAZON_BRUSCO` | 2,9 % | 4,4 % |
| `FACTOR_TRONCO` | 4,4 % | 0,0 % |
| `ASIMETRIA_MAX` | 1,5 % | 0,0 % |

El umbral mas influyente cambia el **10,3 %** de los veredictos. La
etiqueta no depende criticamente de ninguna constante arbitraria, que es la
objecion evidente a un etiquetado por reglas.

## 4. Es repetible la medicion?

Sin goniometro no se puede medir el error absoluto. Se mide la
repetibilidad, separando la dispersion **dentro** de una toma de la
dispersion **entre** tomas del mismo ejercicio.

| Ejercicio | Dentro de escena | Entre escenas |
|---|---:|---:|
| elevacion de pierna recta | 2,7 grados | **28,4** |
| extension de rodilla en prono | 5,2 | **28,8** |
| flexion de rodilla al pecho | 3,3 | 9,4 |
| hip thrust | 9,0 | 1,5 |
| estiramiento recto anterior | 1,8 | 0,8 |

**Para varios ejercicios la medicion depende mas del plano de camara que
del movimiento.** En `elevacion_de_pierna_recta` dos repeticiones de la
misma toma difieren 2,7 grados y dos tomas distintas difieren 28,4.

Consecuencia directa: el ROM es comparable **entre repeticiones de una
misma sesion**, no necesariamente entre sesiones grabadas con la camara en
otro sitio — que es exactamente lo que haria un paciente en su casa. Sin
un protocolo de colocacion de camara, el seguimiento de la evolucion del
ROM entre sesiones no es fiable.

## Lo que sigue faltando

Ninguno de estos cuatro analisis sustituye a una anotacion humana. Siguen
sin existir:

- el acierto del detector de repeticiones contra un observador,
- el acuerdo de la etiqueta de ejecucion con un fisioterapeuta,
- la validacion goniometrica de los angulos contra un instrumento.

Los tres necesitan una persona, no mas codigo.
