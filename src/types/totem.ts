export type ChargingStatus =
  | 'PRONTO'
  | 'CARREGAMENTO_INICIADO'
  | 'CARREGANDO'
  | 'CONCLUIDO'
  | 'PARADO';

export type SensorMode = 'BYPASS_MANUAL' | 'HC_SR04';

export type EspCommand = 'NONE' | 'START_CHARGING' | 'STOP_CHARGING' | 'RESET';

export interface TotemEvent {
  id: string;
  timestamp: string;
  source: 'APP' | 'ESP32-S3' | 'SERVIDOR';
  message: string;
}

export interface TotemLocation {
  lat: number;
  lng: number;
  name: string;
  address: string;
}

export interface TotemState {
  status: ChargingStatus;
  progress: number;
  lcdLine1: string;
  lcdLine2: string;
  sensorMode: SensorMode;
  carDetected: boolean;
  distanceCm: number | null;
  voltageV: number;
  currentA: number;
  powerW: number;
  temperatureC: number;
  espConnected: boolean;
  espDeviceId: string;
  espIp: string | null;
  lastSeenAt: string | null;
  sessionStartedAt: string | null;
  elapsedSeconds: number;
  commandSeq: number;
  pendingCommand: EspCommand;
  location: TotemLocation;
  events: TotemEvent[];
}
