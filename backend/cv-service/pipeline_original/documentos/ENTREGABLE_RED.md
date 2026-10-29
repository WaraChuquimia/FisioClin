# FisioClin — la red neuronal: qué entra, qué sale, cómo se entrena

Entregable del componente inteligente. Todo lo que va en la tesis sobre la
red, y el script para reproducirlo.

---

## 1. Qué le entra a la red

### Forma del tensor

```
X : (899, 30, 14)   float32
     │     │    └── 14 features por instante
     │     └─────── 30 instantes = 3 segundos a 10 Hz
     └───────────── 899 ventanas
```

Una **ventana** son 3 segundos de movimiento. Se eligió esa duración porque
la repetición mediana de este material dura 5,8 s: 3 s cubren
aproximadamente medio ciclo, que es suficiente para reconocer la forma del
movimiento sin necesitar la repetición entera. Las ventanas avanzan de
segundo en segundo, o sea con 66 % de solapamiento.

### Las 14 features

| # | Feature | Unidad |
|---|---|---|
| 0–1 | Flexión de cadera, lado medido y contralateral | grados |
| 2–3 | Flexión de rodilla, lado medido y contralateral | grados |
| 4–5 | Flexión de tobillo, lado medido y contralateral | grados |
| 6–7 | Abducción de cadera, lado medido y contralateral | grados |
| 8 | Inclinación del tronco | grados |
| 9–11 | Velocidad angular de cadera, rodilla y abducción | grados/s |
| 12 | Visibilidad del lado medido | 0–1 |
| 13 | `contra_presente` | 0 ó 1 |

### Las tres reglas que decidieron esa lista

**Entran ángulos, no coordenadas.** Un ángulo es invariante a la talla del
sujeto, a su distancia a la cámara y a dónde esté en el encuadre. Con dos
sujetos en todo el material, cualquier feature que dependa del tamaño del
cuerpo se convierte en un identificador de la persona: la red aprendería
**quién** es en vez de **qué hace**.

**No entra nada que participó en calcular la etiqueta.** Ni ROM, ni
duración de la repetición, ni razón ida/vuelta. Sería fuga de etiqueta: el
modelo las leería y acertaría sin haber aprendido nada. Es el error que más
fácil se cuela y el que produce un 99 % de exactitud que se desmorona al
desplegar.

**El vector se ordena como lado medido / contralateral, no como derecha /
izquierda.** Cada video mide el lado que la cámara ve, y no es el mismo en
todos. Sin esta canonización la red aprendería de qué lado estaba el
trípode.

### El canal `contra_presente`

En plano lateral un miembro tapa al otro: el contralateral falta **por
geometría**, no por fallo. Cuando falta, esas cuatro features van a 0 y
este canal vale 0, para que la red distinga **ausencia** de *"un ángulo de
0 grados"*. Sin este canal, tres clases se quedaban sin una sola ventana.

---

## 2. Qué sale

Dos cabezas sobre el mismo tronco:

| Salida | Clases | Qué predice |
|---|---:|---|
| `ejercicio` | 20 | Cuál de los 20 ejercicios del catálogo |
| `calidad` | 3 | CORRECTA / DUDOSA / INCORRECTA |

**La segunda está ahí para demostrar que no funciona.** Aprende a
reproducir reglas que ya se calculan exacto desde los mismos ángulos, así
que solo puede perder información. Quedó en **0,462 frente a su línea base
de 0,642**, y eso justifica que la evaluación de la ejecución la hagan las
reglas y no la red. Es un resultado, no un fallo.

421 de las 899 ventanas no tienen etiqueta de calidad (no solapan lo
suficiente con ninguna repetición): entran al entrenamiento con peso 0 en
esa cabeza y peso normal en la de ejercicio.

---

## 3. La arquitectura

```
Entrada (30, 14)
      ↓
LSTM 64, return_sequences=True      20 224 parámetros
      ↓
Dropout 0.3
      ↓
LSTM 32                             12 416
      ↓
Dropout 0.3
      ↓
Dense 32, ReLU                       1 056
      ↓
   ┌──┴──┐
   ↓     ↓
Dense 20  Dense 3     softmax        660 + 99
ejercicio  calidad

Total: 34 455 parámetros
```

**Por qué tan pequeña.** 34 mil parámetros para 899 ventanas ya es una
razón de 38 parámetros por ejemplo. Una red mayor memoriza el conjunto de
entrenamiento y no generaliza. Con este tamaño de dataset, la capacidad no
es lo que limita el resultado.

**Por qué dos capas LSTM y no una.** La primera devuelve la secuencia
completa y la segunda la resume en un vector: es la forma habitual de que
la red construya representaciones de dos niveles temporales. Con una sola
capa el resultado es parecido — está dentro del ruido entre folds.

**Por qué dropout 0,3 en las dos.** Es lo único que impide el
sobreajuste con este tamaño de muestra.

**Por qué el tronco compartido.** Las dos cabezas salen del mismo Dense 32:
reconocer el ejercicio y juzgar su ejecución comparten la representación
del movimiento.

---

## 4. Hiperparámetros

| Parámetro | Valor | Por qué |
|---|---|---|
| Optimizador | Adam | Estándar, sin ajuste fino que justificar |
| Tasa de aprendizaje | 1e-3 | El valor por defecto de Adam |
| Lote | 32 | Con 719 ventanas de entrenamiento son ~22 pasos por época |
| Épocas máximas | 80 | Con parada temprana casi nunca se alcanzan |
| Parada temprana | paciencia 15 sobre `val_loss`, restaurando los mejores pesos | Sin esto sobreajusta hacia la época 30 |
| Pérdida | `sparse_categorical_crossentropy` en las dos cabezas | Etiquetas enteras, no one-hot |
| Peso de la pérdida | ejercicio 1,0 · calidad 0,3 | La cabeza de calidad no debe dominar el entrenamiento |
| Peso por muestra | inverso a la frecuencia de su clase | El desbalance es de **8,9×**: de 16 a 142 ventanas por clase |

Épocas reales hasta la parada: entre 20 y 34.

---

## 5. El protocolo de entrenamiento

Esta es la parte que un tribunal mira con más atención, porque es donde se
falsean los resultados sin querer.

### La partición

`StratifiedGroupKFold`, **5 folds agrupando por escena**, repetido con **3
semillas** = 15 corridas.

**Agrupada**, porque las ventanas se solapan dos tercios: dos consecutivas
son casi el mismo dato, y repartirlas al azar da una exactitud altísima y
falsa.

**Por escena y no por video**, y esto hay que explicarlo en la tesis: cada
clase está en un solo video, así que apartar un video deja a esa clase
**sin un solo ejemplo de entrenamiento**. No es una elección metodológica,
es una consecuencia del material. Por eso la cifra mide **generalización a
otro plano de cámara, no a otro cuerpo**.

**Estratificada**, porque con `GroupKFold` a secas había folds donde una
clase entera caía del lado de la prueba: la exactitud se desplomaba a 0,167
y la desviación entre folds era de 0,170. Estratificar la bajó a 0,142 y
subió la media de 0,418 a 0,528.

### El escalado

Media y desviación **calculadas solo con el fold de entrenamiento** y
aplicadas sin recalcular al de prueba. Escalar sobre todo el dataset es
fuga de información: sutil, pero real, y es lo que más veces se hace mal.

---

## 6. Qué reportar, y cómo

| Métrica | Resultado | Línea base |
|---|---:|---:|
| Ejercicio, por ventana de 3 s | 0,528 ± 0,142 | 0,158 |
| Ejercicio, F1 macro | 0,402 ± 0,105 | — |
| **Ejercicio, voto por tanda** | **0,558 ± 0,127** | — |
| Calidad (cabeza de la red) | 0,462 ± 0,132 | **0,642** |

**Cuatro reglas al reportar:**

1. **Siempre con la línea base al lado.** 0,558 sobre 20 clases es 3,5
   veces el azar. Sin esa referencia el número no significa nada.
2. **Siempre con la desviación.** Los folds van de 0,226 a 0,736. Con 899
   ventanas cualquier cifra única es frágil; el número honesto es media ±
   desviación sobre las 15 corridas, nunca el mejor fold.
3. **El voto por tanda es la cifra clínica.** Al paciente no le importa
   qué pasa en una ventana de 3 s: le importa que el sistema reconozca la
   serie que está haciendo.
4. **Nunca la exactitud del modelo final sobre este material.** Ese modelo
   entrenó con todas las escenas y ya vio esos datos: da 0,95 y está
   contaminada.

---

## 7. Las cinco trampas que este diseño evita

Vale la pena listarlas en la tesis, porque demuestran criterio:

1. **Partición al azar con ventanas solapadas** → exactitud falsa.
2. **Escalar antes de partir** → fuga de información.
3. **Meter el ROM como feature** → fuga de etiqueta.
4. **Features que dependen del tamaño del cuerpo** → la red aprende quién
   es la persona.
5. **Reportar el mejor fold, o el modelo final sobre su propio material**
   → cifras irreproducibles.

---

## 8. Cómo entrenar

```bash
python entrenar_red_colab.py --semillas 3 --arquitectura lstm
```

Necesita **solo** `ventanas.npz` y `clases.json`. En Colab con GPU:

```python
from google.colab import files
files.upload()                       # ventanas.npz y clases.json
!pip install scikit-learn
!python entrenar_red_colab.py --semillas 5
```

Produce `metricas_<arquitectura>.csv`, `matriz_confusion_<arq>.csv`,
`modelo_final.keras` y `escalador.npz`.

### Comparar arquitecturas

`--arquitectura` acepta `lstm`, `gru`, `lstm_profunda` y `bilstm`.
Comparar arquitecturas es un experimento legítimo para la tesis, **pero con
la misma partición y varias semillas**: con 899 ventanas la diferencia
entre dos folds es mayor que la diferencia entre dos arquitecturas.

Ya medido: GRU da 0,489 ± 0,090 frente a LSTM 0,528 ± 0,142. **Están dentro
del ruido**, y la conclusión honesta es que este dataset no tiene
resolución para distinguirlas — no que una sea mejor.

Una advertencia sobre `bilstm`: una LSTM bidireccional lee la secuencia
hacia adelante y hacia atrás, así que **no se puede usar en tiempo real**.
Sirve para analizar video grabado, no para el evaluador en vivo.

---

## 9. Si quieres mejorar el resultado, en este orden

1. **Más sujetos.** La curva de aprendizaje sigue subiendo con todo el
   material disponible: la pendiente medida dice que más datos ayudan. Es
   lo que más sube el resultado y lo único que permite afirmar
   generalización a pacientes.
2. **Ventanas más largas.** 3 s cubren medio ciclo. Con 5 s la red vería el
   ciclo completo; el coste es perder ventanas en las tandas cortas.
3. **Aumento de datos seguro**: ruido gaussiano pequeño, escalado temporal
   de ±10–20 %, espejado izquierda↔derecha **intercambiando también las
   etiquetas de lado**. Prohibido cualquier transformación que altere los
   ángulos, porque cambiaría la magnitud sobre la que se definió la
   etiqueta.
4. **Arquitectura.** Es lo último, y con este tamaño de dataset es lo que
   menos va a cambiar el resultado.
