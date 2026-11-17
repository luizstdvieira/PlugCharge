import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import Bonjour from 'bonjour-service';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ChargingStatus,
  SensorMode,
  TotemEvent,
  TotemState,
} from './src/types/totem.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const ESP_TIMEOUT_MS = 15000;

function formatLcdLine(text: string): string {
  return text.slice(0, 16);
}

function createEvent(
  source: TotemEvent['source'],
  message: string
): TotemEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    source,
    message,
  };
}

const state: TotemState = {
  status: 'PRONTO',
  progress: 0,
  lcdLine1: 'ESP32-S3 Pronta',
  lcdLine2: 'Aguard. inicio',
  sensorMode: 'BYPASS_MANUAL',
  carDetected: true,
  distanceCm: null,
  voltageV: 0,
  currentA: 0,
  powerW: 0,
  temperatureC: 26.4,
  espConnected: false,
  espDeviceId: 'ESP32-S3-TOTEM-01',
  espIp: null,
  lastSeenAt: null,
  sessionStartedAt: null,
  elapsedSeconds: 0,
  commandSeq: 1,
  pendingCommand: 'NONE',
  location: {
    lat: -23.55052,
    lng: -46.633308,
    name: 'Plug&Charge — Totem Indução #01',
    address: 'Estação de Carregamento Sem Fio · Setor A',
  },
  events: [
    createEvent(
      'SERVIDOR',
      'Servidor Plug&Charge iniciado. ESP32-S3 pronta para carregamento.'
    ),
  ],
};

function pushEvent(source: TotemEvent['source'], message: string) {
  state.events = [createEvent(source, message), ...state.events].slice(0, 30);
}

async function startServer() {
  const app = express();
  const bonjour = new Bonjour({}, (error: unknown) => {
    console.error('mDNS error:', error);
  });
  app.use(express.json());

  // Allow CORS for local ESP32-S3 / external microcontroller requests
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const dashboardClients = new Set<WebSocket>();
  const espClients = new Set<WebSocket>();

  function broadcastState() {
    const payload = JSON.stringify({ type: 'state:update', data: state });
    for (const client of dashboardClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
    for (const esp of espClients) {
      if (esp.readyState === WebSocket.OPEN) {
        esp.send(
          JSON.stringify({
            type: 'esp:command',
            command: state.pendingCommand,
            commandSeq: state.commandSeq,
            status: state.status,
            lcdLine1: state.lcdLine1,
            lcdLine2: state.lcdLine2,
            sensorMode: state.sensorMode,
            progress: state.progress,
          })
        );
      }
    }
  }

  function markEspAlive(ip: string | null, deviceId?: string) {
    const wasConnected = state.espConnected;
    state.espConnected = true;
    state.lastSeenAt = new Date().toISOString();
    if (ip) state.espIp = ip;
    if (deviceId) state.espDeviceId = deviceId;
    if (!wasConnected) {
      pushEvent('ESP32-S3', `Placa ${state.espDeviceId} conectada.`);
    }
  }

  // Periodic check for ESP32-S3 heartbeat timeout and session elapsed timer
  setInterval(() => {
    let changed = false;
    if (state.espConnected && state.lastSeenAt && espClients.size === 0) {
      const elapsedSinceSeen =
        Date.now() - new Date(state.lastSeenAt).getTime();
      if (elapsedSinceSeen > ESP_TIMEOUT_MS) {
        state.espConnected = false;
        pushEvent('SERVIDOR', 'Conexão HTTP com ESP32-S3 expirou (timeout).');
        changed = true;
      }
    }

    if (
      (state.status === 'CARREGAMENTO_INICIADO' ||
        state.status === 'CARREGANDO') &&
      state.sessionStartedAt
    ) {
      state.elapsedSeconds = Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(state.sessionStartedAt).getTime()) / 1000
        )
      );
      changed = true;
    }

    if (changed) {
      broadcastState();
    }
  }, 1000);

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/ws', `http://${req.headers.host}`);
    const role = url.searchParams.get('role') || 'dashboard';
    const remoteIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      null;

    if (role === 'esp32') {
      espClients.add(ws);
      markEspAlive(remoteIp);
      broadcastState();
    } else {
      dashboardClients.add(ws);
      ws.send(JSON.stringify({ type: 'state:update', data: state }));
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'esp:hello') {
          dashboardClients.delete(ws);
          espClients.add(ws);
          markEspAlive(remoteIp, msg.deviceId);
          broadcastState();
        } else if (msg.type === 'esp:telemetry') {
          markEspAlive(remoteIp, msg.deviceId);
          applyEspTelemetry(msg);
          broadcastState();
        }
      } catch {
        // Ignore malformed JSON frames
      }
    });

    ws.on('close', () => {
      dashboardClients.delete(ws);
      if (espClients.has(ws)) {
        espClients.delete(ws);
        if (espClients.size === 0) {
          state.espConnected = false;
          pushEvent('ESP32-S3', 'WebSocket da ESP32-S3 desconectado.');
          broadcastState();
        }
      }
    });
  });

  function applyEspTelemetry(payload: {
    status?: ChargingStatus;
    sensorMode?: SensorMode;
    progress?: number;
    distanceCm?: number | null;
    voltageV?: number;
    currentA?: number;
    powerW?: number;
    temperatureC?: number;
    lcdLine1?: string;
    lcdLine2?: string;
  }) {
    if (
      (payload.sensorMode === 'BYPASS_MANUAL' ||
        payload.sensorMode === 'HC_SR04') &&
      payload.sensorMode !== state.sensorMode
    ) {
      state.sensorMode = payload.sensorMode;
      pushEvent(
        'ESP32-S3',
        payload.sensorMode === 'HC_SR04'
          ? 'Sensor HC-SR04 ativado pela ESP32-S3.'
          : 'Sensor HC-SR04 desativado pela ESP32-S3.'
      );
    }

    if (typeof payload.distanceCm === 'number') {
      state.distanceCm = Number(payload.distanceCm.toFixed(1));
      if (state.sensorMode === 'HC_SR04') {
        state.carDetected = state.distanceCm > 0 && state.distanceCm <= 25;
      }
    }

    if (typeof payload.voltageV === 'number') {
      state.voltageV = Number(payload.voltageV.toFixed(2));
    }
    if (typeof payload.currentA === 'number') {
      state.currentA = Number(payload.currentA.toFixed(2));
    }
    if (typeof payload.powerW === 'number') {
      state.powerW = Number(payload.powerW.toFixed(1));
    } else if (
      typeof payload.voltageV === 'number' &&
      typeof payload.currentA === 'number'
    ) {
      state.powerW = Number((state.voltageV * state.currentA).toFixed(1));
    }
    if (typeof payload.temperatureC === 'number') {
      state.temperatureC = Number(payload.temperatureC.toFixed(1));
    }

    if (typeof payload.progress === 'number') {
      const clamped = Math.max(0, Math.min(100, Math.round(payload.progress)));
      state.progress = clamped;
      if (clamped >= 100) {
        state.status = 'CONCLUIDO';
        state.lcdLine1 = 'Carga Concluida';
        state.lcdLine2 = 'Carga Concluida';
        state.pendingCommand = 'NONE';
        pushEvent('ESP32-S3', 'Carregamento concluído.');
      } else if (
        clamped > 0 &&
        (state.status === 'CARREGAMENTO_INICIADO' ||
          state.status === 'CARREGANDO')
      ) {
        state.status = 'CARREGANDO';
        state.lcdLine1 = formatLcdLine(`Carregando: ${clamped}%`);
        state.lcdLine2 = formatLcdLine(
          state.powerW > 0 ? `Potencia: ${state.powerW}W` : 'Inducao Ativa'
        );
      }
    }

    if (payload.status && payload.status !== state.status) {
      state.status = payload.status;
      if (payload.status === 'CARREGAMENTO_INICIADO') {
        state.lcdLine1 = 'Carro em posicao';
        state.lcdLine2 = 'Carreg. iniciado';
      }
    }

    if (typeof payload.lcdLine1 === 'string') {
      state.lcdLine1 = formatLcdLine(payload.lcdLine1);
    }
    if (typeof payload.lcdLine2 === 'string') {
      state.lcdLine2 = formatLcdLine(payload.lcdLine2);
    }
  }

  // REST API for Dashboard
  app.get('/api/state', (_req, res) => {
    res.json(state);
  });

  app.post('/api/charging/start', (_req, res) => {
    state.status = 'CARREGAMENTO_INICIADO';
    state.progress = 0;
    state.carDetected = true;
    state.lcdLine1 = 'Carro em posicao';
    state.lcdLine2 = 'Carreg. iniciado';
    state.pendingCommand = 'START_CHARGING';
    state.commandSeq += 1;
    state.sessionStartedAt = new Date().toISOString();
    state.elapsedSeconds = 0;
    state.voltageV = 12.0;
    state.currentA = 1.25;
    state.powerW = 15.0;

    pushEvent(
      'APP',
      'Sinal enviado para ESP32-S3: Carro está em posição · Carregamento iniciado.'
    );
    broadcastState();
    res.json(state);
  });

  app.post('/api/charging/stop', (_req, res) => {
    state.status = 'PARADO';
    state.pendingCommand = 'STOP_CHARGING';
    state.commandSeq += 1;
    state.voltageV = 0;
    state.currentA = 0;
    state.powerW = 0;
    state.lcdLine1 = 'Carreg. Parado';
    state.lcdLine2 = 'ESP32-S3 Pronta';
    pushEvent('APP', 'Carregamento interrompido pelo painel.');
    broadcastState();
    res.json(state);
  });

  app.post('/api/charging/reset', (_req, res) => {
    state.status = 'PRONTO';
    state.progress = 0;
    state.pendingCommand = 'RESET';
    state.commandSeq += 1;
    state.sessionStartedAt = null;
    state.elapsedSeconds = 0;
    state.voltageV = 0;
    state.currentA = 0;
    state.powerW = 0;
    state.carDetected = state.sensorMode === 'BYPASS_MANUAL';
    state.lcdLine1 = 'ESP32-S3 Pronta';
    state.lcdLine2 = 'Aguard. inicio';
    pushEvent('APP', 'Totem reiniciado para estado Pronto.');
    broadcastState();
    res.json(state);
  });

  app.post('/api/sensor/mode', (req, res) => {
    const mode = req.body?.mode as SensorMode;
    if (mode !== 'BYPASS_MANUAL' && mode !== 'HC_SR04') {
      res.status(400).json({ error: 'Modo de sensor inválido.' });
      return;
    }
    state.sensorMode = mode;
    if (mode === 'BYPASS_MANUAL') {
      state.carDetected = true;
      pushEvent(
        'APP',
        'Sensor HC-SR04 em bypass: ESP32-S3 mantida Pronta para carregamento.'
      );
    } else {
      state.carDetected =
        state.distanceCm !== null && state.distanceCm > 0 && state.distanceCm <= 25;
      pushEvent('APP', 'Sensor ultrassônico HC-SR04 ativado.');
    }
    broadcastState();
    res.json(state);
  });

  app.post('/api/lcd/message', (req, res) => {
    const { line1, line2 } = req.body || {};
    if (typeof line1 === 'string') state.lcdLine1 = formatLcdLine(line1);
    if (typeof line2 === 'string') state.lcdLine2 = formatLcdLine(line2);
    state.commandSeq += 1;
    pushEvent(
      'APP',
      `Mensagem LCD atualizada: "${state.lcdLine1}" / "${state.lcdLine2}".`
    );
    broadcastState();
    res.json(state);
  });

  app.post('/api/location', (req, res) => {
    const { lat, lng, name, address } = req.body || {};
    if (typeof lat === 'number' && typeof lng === 'number') {
      state.location = {
        lat,
        lng,
        name: typeof name === 'string' ? name : state.location.name,
        address: typeof address === 'string' ? address : state.location.address,
      };
      pushEvent('APP', `Localização do totem atualizada (${lat.toFixed(4)}, ${lng.toFixed(4)}).`);
      broadcastState();
    }
    res.json(state);
  });

  // REST API for ESP32-S3 Microcontroller
  app.get('/api/esp/command', (req, res) => {
    const remoteIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      null;
    const deviceId =
      typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    markEspAlive(remoteIp, deviceId);
    broadcastState();

    res.json({
      command: state.pendingCommand,
      commandSeq: state.commandSeq,
      status: state.status,
      lcdLine1: state.lcdLine1,
      lcdLine2: state.lcdLine2,
      sensorMode: state.sensorMode,
      progress: state.progress,
    });
  });

  app.post('/api/esp/telemetry', (req, res) => {
    const remoteIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      null;
    const payload = req.body || {};
    const isBenchTest = Boolean(payload.benchTest);

    if (!isBenchTest) {
      markEspAlive(remoteIp, payload.deviceId);
    }
    applyEspTelemetry(payload);
    broadcastState();
    res.json({ ok: true, state });
  });

  // Vite middleware for development, static serving for production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Plug&Charge server running on http://0.0.0.0:${PORT}`);
    const mdnsService = bonjour.publish({
      name: 'PlugCharge Totem',
      type: 'http',
      port: PORT,
      host: 'plugcharge.local',
      disableIPv6: true,
    });
    mdnsService.on('error', (error) => {
      console.error('Could not advertise plugcharge.local via mDNS:', error);
    });
  });

  server.on('close', () => bonjour.destroy());
}

startServer();
