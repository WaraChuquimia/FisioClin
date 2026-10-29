# Etapa 7 — Ventanas: el dataset de aprendizaje

Salida: `06_ventanas/ventanas.npz`, `clases.json`, `resumen_ventanas.csv`.

```bash
python artrosis_07_ventanas.py
```

Es la unica salida **desechable** del pipeline. Si cambia el diseno de
features o la longitud de ventana, se borra y se regenera en segundos desde
la etapa 3. El dataset maestro (`calidad.csv`) no se toca nunca.

## Forma

```python
d = np.load("06_ventanas/ventanas.npz", allow_pickle=True)
d["X"]            # (899, 30, 14) float32 -- 3 s de movimiento por ventana
d["y_ejercicio"]  # (899,) indice de clase, orden en clases.json
d["y_grupo"]      # (899,) cadera / rodilla
d["y_calidad"]    # (899,) correcta / dudosa / incorrecta, -1 si sin etiqueta
d["escena"]       # (899,) AGRUPAR POR ESTA COLUMNA al partir train/test
d["video"], d["segmento"], d["t_inicio"], d["lado"], d["features"]
```

Ventana de **3 s (30 muestras a 10 Hz)** con paso de 1 s, o sea 66 % de
solapamiento. Tres segundos cubren aproximadamente medio ciclo: la duracion
mediana de una repeticion en este material es de 5,8 s.

## Las 14 features, y por que estas

| # | Feature | Por que |
|---|---|---|
| 0-1 | `flex_cadera_medido` / `_contra` | El angulo objetivo de la mitad de las clases |
| 2-3 | `flex_rodilla_medido` / `_contra` | El de la otra mitad |
| 4-5 | `flex_tobillo_medido` / `_contra` | Distingue sentadillas de flexiones de rodilla |
| 6-7 | `abd_cadera_medido` / `_contra` | Sin esto, las cinco abducciones son invisibles |
| 8 | `inclinacion_tronco` | Postura y compensacion |
| 9-11 | velocidades de cadera, rodilla y abduccion | Distinguen movimientos de igual forma y distinto control |
| 12 | `visibilidad` | Le dice a la red donde no fiarse |
| 13 | `contra_presente` | Marca si el lado contralateral existe o falta |

**Entran angulos, no coordenadas.** Son invariantes a la talla del sujeto,
a su distancia a la camara y a su posicion en el encuadre. Con dos sujetos
en todo el material, cualquier feature que dependa del tamano del cuerpo se
convierte en un identificador de la persona y la red aprende **quien** es
en vez de **que hace**.

**No entra ninguna magnitud que participo en calcular la etiqueta** — ni
ROM, ni duracion de la repeticion, ni razon ida/vuelta. Incluirlas seria
fuga de etiqueta: el modelo las leeria y acertaria sin aprender nada.

## La canonizacion por lado

Cada video mide el lado que la camara ve, que no es el mismo en todos. Si
las features fueran derecha/izquierda, la red aprenderia de que lado estaba
el tripode. El vector se ordena como **lado medido / contralateral**.

## El contralateral ausente

En plano lateral un miembro tapa al otro y el contralateral falta **por
geometria**. Contar esas ausencias como huecos descartaba ventanas enteras
por datos que nunca van a existir: tres clases se quedaban en cero
ventanas. Ahora los huecos se cuentan solo sobre las features del lado
medido y el tronco; el contralateral ausente se rellena con 0 y el canal
`contra_presente` avisa de que es ausencia y no un angulo de 0 grados.

## Lo que NO se hace aqui

**No se estandarizan las features.** La media y la desviacion tienen que
calcularse solo sobre el conjunto de entrenamiento, y la particion se
decide en la etapa siguiente. Estandarizar aqui, sobre todo el dataset,
seria fuga de informacion: sutil, pero real.

## Contenido

- **899 ventanas**, **20 de 20 clases**, **101 escenas**, 19 videos.
- Ventanas por clase: de 16 (`abduccion_de_cadera_en_decubito`) a 142
  (`estiramiento_recto_anterior`). **Desbalance de 8,9x**: el entrenamiento
  tiene que compensarlo con pesos por clase, y hay que reportar F1 macro
  ademas de exactitud.
- Etiqueta de calidad: 130 correctas, 307 dudosas, 41 incorrectas, 421 sin
  etiqueta (la ventana no solapa lo suficiente con ninguna repeticion).

## La advertencia sobre la particion

**Las ventanas se solapan dos tercios entre si.** Dos ventanas consecutivas
son casi el mismo dato. Repartirlas al azar entre entrenamiento y prueba da
una exactitud altisima y falsa.

La columna `escena` existe para partir con agrupamiento. Y aun asi mide
generalizacion a otro plano de camara, **no a otro cuerpo**: con dos
sujetos en el material, y uno de ellos presente en solo dos clases, la
generalizacion a pacientes nuevos no es demostrable con este dataset.
