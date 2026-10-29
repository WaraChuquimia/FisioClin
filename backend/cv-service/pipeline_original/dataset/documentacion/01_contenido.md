# Etapa 1 — Que hay dentro de los videos

Salidas en `01_contenido/`. Se regeneran con:

```bash
python artrosis_01_contenido.py     # ~25 min: abre los 20 videos
python artrosis_01_resumen.py       # segundos: agrega a escena y a video
```

La primera pasada es de **diagnostico, no de extraccion**: muestrea pose a
2 Hz y sus landmarks no se guardan. La extraccion buena es la etapa 2.

## Como se mide cada cosa

| Pregunta | Como se responde |
|---|---|
| Corte de plano | Diferencia media entre fotogramas consecutivos (1 de cada 3, en gris a 320 px). Un corte dispara un salto mucho mayor que cualquier movimiento humano. Umbral por video: `max(18, 6 x mediana)` |
| Hay persona | MediaPipe Pose devuelve landmarks |
| Cuantas personas | Detector de caras (`face_detection`, rango largo). Es una cota inferior: una persona de espaldas no tiene cara detectable |
| Cuerpo completo | Los 8 landmarks del nucleo dentro del encuadre con margen del 1 % y visibilidad minima > 0,5 |
| Orientacion | `ancho_hombros / largo_tronco`. En perfil los hombros se proyectan superpuestos (razon baja); de frente ocupan medio tronco (razon alta). Mide cuanto del plano frontal del cuerpo mira a la camara, no donde esta el tripode |
| Postura | Inclinacion del vector cadera->hombro respecto de la vertical de la imagen: ~0 grados de pie, ~90 tumbado |
| Hay ejercicio | **Excursion**: recorrido (p95 - p5) de tres senales posturales en una ventana de 6 s que no cruza cortes de plano, cada una dividida por su percentil 75. Ver la limitacion de abajo |

## La limitacion de la deteccion de ejercicio

Dos intentos, los dos refutados con el propio material:

1. **Velocidad instantanea** (desplazamiento de landmarks entre muestras).
   Refutada con `C01`: un puente de gluteos de 111 s, ejercicio de
   principio a fin, quedaba marcado como 5 % de movimiento. A 2 Hz un
   movimiento terapeutico lento desplaza tan poco entre muestras que no se
   distingue de estar quieto.

2. **Excursion postural** (la que quedo implementada). Corrige el caso del
   puente y pasa el control negativo: las escenas donde el sujeto esta de
   pie explicando a camara quedan por debajo del umbral. Pero es **ciega a
   los ejercicios donde solo se mueve un miembro con el tronco fijo**:
   `C10` (abduccion de cadera en cuadrupedia) marca 0 % de movimiento
   siendo ejercicio casi todo el video.

La conclusion es metodologica y condiciona el plan: **ninguna senal
derivada de la postura global separa ejercicio de quietud en las 20
clases. La senal que si lo hace es el angulo articular.** Por eso la
segmentacion en tandas no puede calcularse aqui: necesita los angulos, es
decir la etapa de goniometria, y por eso las columnas de movimiento de
esta etapa son **indicativas y no se usan como filtro**.

## Columnas

`frames_muestreados.csv` -- una fila cada 0,5 s de video:
`id`, `frame`, `t_seg`, `escena`, `pose`, `n_caras`, `vis_nucleo_min`,
`vis_nucleo_media`, `tronco_px`, `razon_hombros`, `razon_caderas`,
`inclinacion_tronco`, `cuerpo_completo`, `alto_relativo`, `mov_nucleo`,
`mov_articular`, `dif_umbral`.

`escenas.csv` -- un plano continuo por fila: limites, duracion, `pct_pose`,
`pct_cuerpo_completo`, `vis_nucleo_media`, `vista_estimada`,
`postura_estimada`, `excursion_mediana`, `pct_muestras_movimiento`,
`caras_max`, `clase`.

`contenido.csv` -- un video por fila, con los agregados y el reparto de
escenas por clase.

Clases de escena: `MOVIMIENTO`, `MIXTA`, `QUIETO_DE_PIE` (candidata a
explicacion), `QUIETO_EN_POSICION` (candidata a retencion de
estiramiento), `PLANO_MUY_CORTO`, `SIN_PERSONA`.

## Umbrales

Todos provisionales, calibrados sobre las distribuciones de este material
y verificados mirando fotogramas. Se recalibran si entra material nuevo:
`VISTA_FRONTAL 0.45`, `VISTA_PERFIL 0.25`, `POSTURA_DE_PIE 25`,
`POSTURA_TUMBADO 60`, `UMBRAL_EXCURSION 1.0`, `VENTANA_EXCURSION 6 s`,
`POSE_MINIMA 60 %`, `ESCENA_MINIMA_S 2 s`.
