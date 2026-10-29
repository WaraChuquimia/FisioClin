# Etapa 0 — Indice de videos crudos

Salida: `00_indice/videos.csv`. Se regenera con:

```bash
python artrosis_00_indice.py
```

El script solo lee. No copia, no mueve y no reescribe ningun video.

## Origen del material

Carpeta canonica, fuera del repositorio (~1,9 GB):

```
~/OneDrive - Escuela Militar de Ingenieria/Desktop/catalogo_de_ejercicios/
├── cadera/    10 archivos .mp4
└── RODILLA/   10 archivos .mp4
```

Existen copias sueltas de algunos de estos videos en `Downloads/` y en la
raiz de `OneDrive/`, con numeracion de ejercicio distinta. **No se usan.**
La carpeta de arriba es la unica puerta de entrada al dataset.

## Regla de asignacion del `id`

`C` para cadera, `R` para rodilla, mas el numero de ejercicio que declara
el propio nombre del archivo (`...-ejercicio-7.mp4` → `C07`). Si dos
archivos de una carpeta declararan el mismo numero, el segundo recibe el
primer numero libre y queda registrado en `incidencias`. En esta corrida
no hubo ningun choque: los 20 numeros declarados son unicos dentro de su
carpeta.

El `id` es la clave de todo el dataset. Las etapas siguientes referencian
`C01`..`R10` y nunca el nombre del archivo, que trae tildes, dobles
espacios y erratas (`SENTADI PROFUNDA`, `LA PIENA`, `SENTADILLLA`).

## Columnas

| Columna | Que es |
|---|---|
| `id` | Identificador estable `C01`..`C10`, `R01`..`R10` |
| `grupo` | `cadera` o `rodilla`, segun la carpeta de origen |
| `archivo`, `carpeta` | Nombre y carpeta originales, para poder volver al video |
| `ancho`, `alto`, `resolucion` | Dimensiones del fotograma |
| `fps_nativo` | Fotogramas por segundo del contenedor |
| `n_frames` | Fotogramas declarados por el contenedor |
| `duracion_s` | `n_frames / fps_nativo` |
| `codec` | FourCC del flujo de video |
| `tamano_mb` | Tamano del archivo |
| `mbits_por_s` | Tasa de bits media. Delata material de procedencia distinta |
| `huella` | SHA-1 de tamano + primer y ultimo megabyte. Detecta si el archivo cambio o si dos entradas son el mismo video |
| `n_ejercicio_declarado` | Numero que trae el nombre del archivo |
| `titulo_crudo` | Nombre del ejercicio segun el archivo, sin tildes ni sufijos |
| `incidencias` | Anomalias detectadas (`fps_no_estandar`, reasignacion de numero) |

## Que NO contiene esta etapa

Nada sobre el contenido: ni vista de camara, ni postura, ni cuantas
personas aparecen, ni cuanto del metraje es ejercicio. Eso es la etapa
siguiente y requiere abrir los videos, no solo sus cabeceras.
