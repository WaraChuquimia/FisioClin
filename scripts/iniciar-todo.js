#!/usr/bin/env node

/**
 * FisioClin — levanta el servicio de visión (backend/cv-service) y Expo
 * juntos, con un solo comando (`npm start`).
 *
 * Por qué existe: antes había que acordarse de abrir DOS terminales —
 * una para `uvicorn` y otra para `expo start` — y olvidarse de la
 * primera es el motivo más común de que la app se quede en "Conectando
 * con el servidor de FisioClin..." (ver backend/cv-service/LEEME.md).
 * Esto arranca los dos. Si el servicio ya estaba corriendo (otra
 * terminal, otra sesión), lo detecta por el puerto y no abre uno
 * duplicado. Si falta el entorno virtual, avisa cómo crearlo y sigue
 * solo con Expo en vez de romper todo el arranque por eso.
 *
 * `npx expo start` no se puede interceptar desde el proyecto (es el CLI
 * de Expo directo, no pasa por package.json) — por eso el comando de
 * ahora en más es `npm start`, no `npx expo start`.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DIR_VISION = path.join(RAIZ, 'backend', 'cv-service');
const PUERTO_VISION = 8000;
const PYTHON = path.join(
  DIR_VISION,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);

function puertoOcupado(puerto) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: puerto, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** `child.kill()` en Windows no siempre baja todo el árbol de procesos
 *  (uvicorn arranca subprocesos). `taskkill /T` sí. */
function matarProceso(hijo) {
  if (!hijo || !hijo.pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${hijo.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // Ya se habrá cerrado solo; no es un error que valga la pena mostrar.
    }
  } else {
    hijo.kill('SIGTERM');
  }
}

async function arrancarVision() {
  const yaCorriendo = await puertoOcupado(PUERTO_VISION);
  if (yaCorriendo) {
    console.log(`[VISION] Ya hay algo escuchando en el puerto ${PUERTO_VISION} — lo reutilizo, no abro otro.`);
    return null;
  }
  if (!fs.existsSync(PYTHON)) {
    console.log(`[VISION] No encontré el entorno virtual (${PYTHON}).`);
    console.log('[VISION] Para crearlo, una vez:');
    console.log('[VISION]   cd backend/cv-service');
    console.log('[VISION]   python -m venv .venv');
    console.log('[VISION]   .venv\\Scripts\\activate');
    console.log('[VISION]   pip install -r requirements.txt');
    console.log('[VISION] Sigo solo con Expo — la app va a mostrar "Conectando..." hasta que levantes el servicio.');
    return null;
  }

  console.log('[VISION] Arrancando el servicio de visión...');
  const proceso = spawn(
    PYTHON,
    ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', String(PUERTO_VISION)],
    { cwd: DIR_VISION }
  );
  proceso.stdout.on('data', (d) => process.stdout.write(`[VISION] ${d}`));
  proceso.stderr.on('data', (d) => process.stderr.write(`[VISION] ${d}`));
  proceso.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.log(`[VISION] El servicio se cerró solo (código ${code}). Revisa el log de arriba.`);
    }
  });
  return proceso;
}

async function main() {
  const procesoVision = await arrancarVision();

  console.log('[EXPO] Arrancando Expo...\n');
  // stdio 'inherit': la UI interactiva de Expo (QR, atajos de teclado
  // a/i/w/r) necesita la terminal de verdad, no una tubería con prefijo.
  // En Windows, spawnear un .cmd (como npx) sin shell falla con
  // "spawn EINVAL" — problema conocido de Node, no de este script. Con
  // shell:true, Node pide el comando como una sola cadena (no como
  // array): si no, avisa (con razón) que los argumentos no se escapan.
  // No hay input del usuario acá, son literales fijos.
  const procesoExpo = process.platform === 'win32'
    ? spawn('npx expo start', { cwd: RAIZ, stdio: 'inherit', shell: true })
    : spawn('npx', ['expo', 'start'], { cwd: RAIZ, stdio: 'inherit' });

  let limpiando = false;
  const limpiar = () => {
    if (limpiando) return;
    limpiando = true;
    if (procesoVision) {
      console.log('\n[VISION] Cerrando el servicio de visión...');
      matarProceso(procesoVision);
    }
  };

  procesoExpo.on('exit', (code) => {
    limpiar();
    process.exit(code ?? 0);
  });
  process.on('SIGINT', () => {
    limpiar();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    limpiar();
    process.exit(0);
  });
}

main();
