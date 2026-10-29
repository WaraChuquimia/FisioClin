# Como llenar `ficha_clinica.csv`

Es el unico archivo del dataset que se escribe a mano. Todo lo demas lo
calcula el pipeline.

## Antes de empezar

1. Doble clic en `ficha_clinica.csv` (se abre en Excel).
2. Las **9 primeras columnas ya vienen llenas** y no se tocan: son lo que
   midio la camara, y estan ahi para que el fisioterapeuta vea cada
   ejercicio antes de opinar.
3. Se llenan las **19 columnas siguientes**, una fila por ejercicio.
4. Al guardar, Excel avisa que el formato CSV pierde cosas. **Guardar en
   CSV igualmente** — no convertir a .xlsx.

## Prioridad: si el tiempo con el fisioterapeuta es corto

Estas **cuatro** desbloquean toda la etapa siguiente. Son 80 celdas y se
llenan en veinte minutos. El resto puede esperar a una segunda sesion.

| Columna | Valores permitidos |
|---|---|
| `articulacion_objetivo` | `cadera` · `rodilla` · `tobillo` |
| `plano_movimiento` | `sagital` · `frontal` · `transversal` |
| `alineado_con_camara` | `si` · `parcial` · `no` |
| `tipo` | `dinamico` · `sostenido` |

**Sobre `alineado_con_camara`:** pregunta si el movimiento ocurre en el
plano que la camara ve o si le apunta de frente. Un ejercicio `no`
alineado se puede medir igual, pero su angulo **no es un valor
goniometrico** comparable con la norma, y hay que decirlo en el informe.
El pipeline ya calculo una estimacion de esto (columna `desalin_` de la
etapa 3): pedir al fisioterapeuta que confirme o corrija, no que lo juzgue
de cero.

**Sobre `tipo`:** `sostenido` es un estiramiento o una isometria — se
mantiene una posicion. `dinamico` es sube y baja. Cambia por completo la
metrica: un sostenido no tiene repeticiones ni ROM por ciclo, tiene
duracion y estabilidad de la retencion.

## Las 19 columnas, una por una

### Identificacion

| Columna | Que poner | Ejemplo |
|---|---|---|
| `ejercicio` | Nombre clinico normalizado, en minusculas y con guiones bajos. Sin tildes, sin erratas | `puente_gluteos_bilateral` |
| `articulacion_objetivo` | La articulacion que el ejercicio trabaja | `cadera` |
| `articulaciones_secundarias` | Las que acompanan, separadas por `;` | `rodilla;lumbar` |

Ojo: el titulo del archivo **no** es el nombre clinico. Trae erratas
(`SENTADI PROFUNDA`, `LA PIENA`, `SENTADILLLA`) y nombres coloquiales
(`LA CONCHA`, `TWIST`). Por eso existe esta columna.

### Descripcion del movimiento

| Columna | Valores | Nota |
|---|---|---|
| `postura_declarada` | `supino` · `prono` · `decubito_lateral` · `cuadrupedia` · `sedente` · `bipedestacion` · `semisentado` | La columna `postura_medida` da una pista, pero es geometrica: solo distingue vertical / inclinada / horizontal |
| `plano_movimiento` | `sagital` · `frontal` · `transversal` | |
| `alineado_con_camara` | `si` · `parcial` · `no` | |
| `tipo` | `dinamico` · `sostenido` | |
| `lado_trabajado` | `derecho` · `izquierdo` · `alterno` · `bilateral` | `alterno` = hace unas con una pierna y otras con la otra |
| `angulo_a_medir` | Que angulo describe el movimiento | `flexion_cadera` |

### Criterio clinico

| Columna | Que poner |
|---|---|
| `criterio_ejecucion_correcta` | Una frase: que tiene que pasar para que la repeticion valga. Ej: *"Alineacion hombro-cadera-rodilla en el punto alto; sin hiperextension lumbar; descenso frenado"* |
| `errores_esperables` | Los fallos tipicos, separados por `;`. Ej: `rango_insuficiente;descenso_no_frenado` |
| `compensaciones_a_vigilar` | Que parte del cuerpo compensa cuando el paciente no llega. Ej: `arqueo_lumbar;rotacion_pelvica` |

### Rangos

| Columna | Que poner |
|---|---|
| `rom_esperado_min_grados` | Angulo minimo del recorrido, en grados |
| `rom_esperado_max_grados` | Angulo maximo |
| `tolerancia_rom_grados` | Cuantos grados de menos se aceptan sin marcar error |
| `tempo_esperado` | Ritmo esperado. Ej: `2s subida / 3s bajada` o `retencion 20 s` |

**Estos cuatro son los mas delicados.** Si el fisioterapeuta no puede
fijarlos sin ver al paciente, **dejarlos vacios**. Una celda vacia es un
dato honesto; un numero inventado contamina todo el informe. Si da un
valor orientativo y no clinico, anotarlo en `observaciones_clinicas`.

### Firma

| Columna | Que poner |
|---|---|
| `observaciones_clinicas` | Cualquier salvedad. Ej: *"el video muestra la version de suelo; en clinica se hace de pie"* |
| `validado_por` | Nombre o iniciales de quien valido |
| `fecha_validacion` | `2026-08-27` |

**La firma no es burocracia.** Es lo que permite escribir en la tesis "los
criterios fueron validados por un fisioterapeuta" y poder sostenerlo. Sin
esas dos columnas, esa frase no tiene respaldo.

## Ejemplo de una fila llena

Para `C01`, cuyo titulo en el archivo es `PUENTE`:

```
ejercicio                    puente_gluteos_bilateral
articulacion_objetivo        cadera
articulaciones_secundarias   rodilla;lumbar
postura_declarada            supino
plano_movimiento             sagital
alineado_con_camara          si
tipo                         dinamico
lado_trabajado               bilateral
angulo_a_medir               flexion_cadera
criterio_ejecucion_correcta  Alineacion hombro-cadera-rodilla arriba; sin arqueo lumbar
errores_esperables           rango_insuficiente;descenso_no_frenado
compensaciones_a_vigilar     arqueo_lumbar
rom_esperado_min_grados      (vacio hasta que lo fije el fisioterapeuta)
rom_esperado_max_grados      (vacio)
tolerancia_rom_grados        (vacio)
tempo_esperado               2s subida / 3s bajada
observaciones_clinicas
validado_por                 (iniciales)
fecha_validacion             2026-08-27
```

Este ejemplo es **una muestra de formato, no una recomendacion clinica**.
Los valores los decide el fisioterapeuta.

## Dos avisos

**Si dos ejercicios distintos comparten nombre**, ponerlos distintos. El
`ejercicio` va a ser la etiqueta de clase del modelo: dos filas con el
mismo nombre se fusionarian en una sola clase.

**Un ejercicio de rodilla puede estar en el programa de cadera y al
reves.** `C05` se llama "extension de cuadriceps" y esta en la carpeta de
cadera. El `grupo` dice de que carpeta salio; `articulacion_objetivo` dice
que trabaja de verdad. No tienen por que coincidir.

## Al terminar

Guardar y avisar. El pipeline valida la ficha, comprueba que los valores
esten entre los permitidos y sigue con la segmentacion de repeticiones.
