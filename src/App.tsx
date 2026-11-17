import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  Cpu,
  Wifi,
  WifiOff,
  Zap,
  Code2,
  MapPin,
  Clock,
} from 'lucide-react';
import type { TotemState } from './types/totem';
import { TotemMap } from './components/TotemMap';
import { EspFirmwareModal } from './components/EspFirmwareModal';

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '--:--:--';
  }
}

export default function App() {
  const [totem, setTotem] = useState<TotemState | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [firmwareOpen, setFirmwareOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const onQuota = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  const fetchInitialState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const data: TotemState = await res.json();
        setTotem(data);
      }
    } catch {
      setErrorMsg('Não foi possível conectar ao servidor do totem.');
    }
  }, []);

  useEffect(() => {
    fetchInitialState();

    let initialConnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connectWs = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/ws?role=dashboard`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        setWsConnected(true);
        setErrorMsg(null);
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'state:update' && msg.data) {
            setTotem(msg.data);
          }
        } catch {
          // Ignore malformed message
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        reconnectTimer = setTimeout(connectWs, 2500);
      };
    };

    initialConnectTimer = setTimeout(() => {
      initialConnectTimer = null;
      connectWs();
    }, 0);

    return () => {
      disposed = true;
      if (initialConnectTimer) clearTimeout(initialConnectTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, [fetchInitialState]);

  const callApi = async (
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<void> => {
    setBusyAction(true);
    setErrorMsg(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error || 'Falha ao enviar comando para o totem.');
        return;
      }
      if (json.state) {
        setTotem(json.state);
      } else if (json.status) {
        setTotem(json);
      }
    } catch {
      setErrorMsg('Erro de rede ao comunicar com o servidor.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleStart = () => callApi('/api/charging/start');
  const handleStop = () => callApi('/api/charging/stop');
  const handleReset = () => callApi('/api/charging/reset');

  const handleUpdateLocation = async (lat: number, lng: number) => {
    await callApi('/api/location', { lat, lng });
  };

  const isChargingActive =
    totem?.status === 'CARREGAMENTO_INICIADO' ||
    totem?.status === 'CARREGANDO';

  const statusHeading = (() => {
    if (!totem) return 'Está carregando';
    switch (totem.status) {
      case 'PRONTO':
        return 'ESP32-S3 Pronta para Carregamento';
      case 'CARREGAMENTO_INICIADO':
        return 'Carro está em posição · Carregamento iniciado';
      case 'CARREGANDO':
        return 'Está carregando';
      case 'CONCLUIDO':
        return 'Carregamento concluído';
      case 'PARADO':
        return 'Carregamento interrompido';
    }
  })();

  const statusDescription = (() => {
    if (!totem) return '';
    switch (totem.status) {
      case 'PRONTO':
        return 'ESP32-S3 pronta para carregamento. Pressione Iniciar Carregamento para enviar o sinal ao totem.';
      case 'CARREGAMENTO_INICIADO':
        return 'Comando enviado para a ESP32-S3. Mensagem atualizada no LCD do totem e carregamento por indução iniciado.';
      case 'CARREGANDO':
        return 'Transferência de energia por indução em andamento.';
      case 'CONCLUIDO':
        return 'Relé de indução desligado com segurança.';
      case 'PARADO':
        return 'Sessão encerrada manualmente. Reinicie o totem para uma nova carga.';
    }
  })();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Tier 2 Demo Key Quota Warning Banner */}
      {quotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Top Bar Contract: 3 zones */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-4 sm:gap-8">
          <a
            href="#visao-geral"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display"
          >
            Plug&amp;Charge
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a
              href="#visao-geral"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Visão Geral
            </a>
            <a
              href="#localizacao"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Localização
            </a>
            <a
              href="#historico"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Histórico
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setFirmwareOpen(true)}
              className="min-h-[44px] sm:min-h-0 inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Code2 className="w-3.5 h-3.5" />
              Firmware ESP32-S3
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-24 md:pb-8 flex flex-col gap-6">
        {errorMsg && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-xl text-sm flex items-center justify-between gap-4">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-xs font-medium underline shrink-0"
            >
              Dispensar
            </button>
          </div>
        )}

        {/* Main 2-column Grid */}
        <div
          id="visao-geral"
          className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
        >
          {/* Left Column: Focal Control + Progress Bar + Map */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            {/* Primary Charging Control & Progress Card */}
            <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col gap-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-xl">
                  <div className="text-xs font-medium text-slate-500 flex items-center gap-2">
                    <span>Totem de Indução #01</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Seq #{totem?.commandSeq ?? 1}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {wsConnected ? 'Tempo real ativo' : 'Reconectando...'}
                    </span>
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight text-slate-900 mt-1.5 text-balance">
                    {statusHeading}
                  </h1>
                  <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                    {statusDescription}
                  </p>
                </div>

                <div
                  className={`px-3.5 py-2 rounded-lg text-xs font-semibold border flex items-center gap-2 ${
                    isChargingActive
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : totem?.status === 'CONCLUIDO'
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        : 'bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isChargingActive
                        ? 'bg-emerald-500'
                        : totem?.status === 'CONCLUIDO'
                          ? 'bg-emerald-600'
                          : 'bg-slate-400'
                    }`}
                  />
                  <span>
                    {!totem
                      ? 'Está carregando'
                      : isChargingActive
                        ? 'Está carregando'
                        : totem?.status === 'CONCLUIDO'
                          ? 'Carregamento concluído'
                          : 'Não está carregando'}
                  </span>
                </div>
              </div>

              {/* Indeterminate Charging Bar */}
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-medium text-slate-600">
                  Carregamento
                </span>
                <div
                  className="h-4 w-full bg-slate-100 border border-slate-200 rounded-lg overflow-hidden"
                  role={isChargingActive ? 'progressbar' : undefined}
                  aria-label={
                    isChargingActive ? 'Carregamento em andamento' : undefined
                  }
                >
                  <div
                    className={`h-full ${
                      isChargingActive
                        ? 'charging-progress-indeterminate bg-emerald-600'
                        : totem?.status === 'CONCLUIDO'
                          ? 'w-full bg-emerald-600'
                          : 'w-0 bg-slate-400'
                    }`}
                  />
                </div>
              </div>

              {/* Telemetry Metrics Row */}
              <div className="grid grid-cols-2 sm:grid-cols-3 border-t border-b border-slate-200 py-4 gap-4">
                <div>
                  <p className="text-xs text-slate-500">Tensão</p>
                  <p className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
                    {(totem?.voltageV ?? 0).toFixed(1)} V
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Potência</p>
                  <p className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
                    {(totem?.powerW ?? 0).toFixed(1)} W
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Tempo Decorrrido</p>
                  <p className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
                    {formatDuration(totem?.elapsedSeconds ?? 0)}
                  </p>
                </div>
              </div>

              {/* Primary Control Actions */}
              <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3">
                {!isChargingActive ? (
                  <button
                    type="button"
                    onClick={handleStart}
                    disabled={busyAction || !totem}
                    className="min-h-[48px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-4 h-4" />
                    Iniciar Carregamento
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStop}
                    disabled={busyAction}
                    className="min-h-[48px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Square className="w-4 h-4" />
                    Parar Carregamento
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleReset}
                  disabled={busyAction || !totem}
                  className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reiniciar Totem
                </button>

              </div>
            </section>

            {/* Google Maps Platform Location Section */}
            {totem && (
              <TotemMap
                location={totem.location}
                status={totem.status}
                onUpdateLocation={handleUpdateLocation}
              />
            )}
          </div>

          {/* Right Column: ESP32-S3 Connection + Event Log */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            {/* Hardware Connection Card */}
            <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col gap-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Comunicação ESP32-S3
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Estado da conexão com a placa do totem
                  </p>
                </div>
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  {totem?.espConnected ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      <Wifi className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-emerald-700">ESP32 Conectada</span>
                    </>
                  ) : (
                    <>
                      <WifiOff className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-slate-500">Aguardando ESP32</span>
                    </>
                  )}
                </div>
              </div>

              {/* Hardware Details Table */}
              <div className="divide-y divide-slate-100 text-xs border-t border-slate-200 pt-2">
                <div className="py-2.5 flex items-center justify-between gap-4">
                  <span className="text-slate-500">Estado do Carregamento</span>
                  <span
                    className={`font-semibold ${
                      isChargingActive
                        ? 'text-emerald-700'
                        : 'text-slate-700'
                    }`}
                  >
                    {isChargingActive
                      ? 'Está carregando'
                      : totem?.status === 'CONCLUIDO'
                        ? 'Concluído'
                        : 'Não está carregando'}
                  </span>
                </div>
                <div className="py-2.5 flex items-center justify-between gap-4">
                  <span className="text-slate-500 flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-slate-400" />
                    Dispositivo
                  </span>
                  <span className="font-mono text-slate-900">
                    {totem?.espDeviceId ?? 'ESP32-S3-TOTEM-01'}
                  </span>
                </div>
                <div className="py-2.5 flex items-center justify-between gap-4">
                  <span className="text-slate-500">Último Sinal ESP32</span>
                  <span className="font-mono tabular-nums text-slate-900">
                    {totem?.lastSeenAt ? formatTime(totem.lastSeenAt) : 'Nenhum'}
                  </span>
                </div>
                <div className="py-2.5 flex items-center justify-between gap-4">
                  <span className="text-slate-500">Endpoint REST ESP32</span>
                  <span className="font-mono text-slate-700 truncate max-w-[200px]">
                    /api/esp/command
                  </span>
                </div>
              </div>
            </section>

            {/* Real-Time Event Log */}
            <section
              id="historico"
              className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col gap-4"
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-base font-semibold text-slate-900">
                  Registro de Eventos
                </h2>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {totem?.events.length ?? 0} registros
                </span>
              </div>

              <div className="divide-y divide-slate-100 max-h-[260px] overflow-y-auto pr-1">
                {totem?.events.map((ev) => (
                  <div key={ev.id} className="py-2.5 flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono tabular-nums">
                      <span>{formatTime(ev.timestamp)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-slate-700">
                        {ev.source}
                      </span>
                    </div>
                    <p className="text-xs text-slate-700 leading-relaxed">
                      {ev.message}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* Fixed Mobile Bottom Tab Bar (Thumb-Zone Navigation) */}
      <nav
        aria-label="Navegação Mobile"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-4 items-center h-16"
      >
        <a
          href="#visao-geral"
          className="min-h-[44px] flex flex-col items-center justify-center text-slate-700 hover:text-emerald-600 transition-colors"
        >
          <Zap className="w-5 h-5" />
          <span className="text-[11px] font-medium tracking-tight mt-0.5">
            Controle
          </span>
        </a>
        <a
          href="#localizacao"
          className="min-h-[44px] flex flex-col items-center justify-center text-slate-700 hover:text-emerald-600 transition-colors"
        >
          <MapPin className="w-5 h-5" />
          <span className="text-[11px] font-medium tracking-tight mt-0.5">
            Mapa
          </span>
        </a>
        <a
          href="#historico"
          className="min-h-[44px] flex flex-col items-center justify-center text-slate-700 hover:text-emerald-600 transition-colors"
        >
          <Clock className="w-5 h-5" />
          <span className="text-[11px] font-medium tracking-tight mt-0.5">
            Histórico
          </span>
        </a>
        <button
          type="button"
          onClick={() => setFirmwareOpen(true)}
          className="min-h-[44px] flex flex-col items-center justify-center text-slate-700 hover:text-emerald-600 transition-colors cursor-pointer"
        >
          <Code2 className="w-5 h-5" />
          <span className="text-[11px] font-medium tracking-tight mt-0.5">
            Firmware
          </span>
        </button>
      </nav>

      <EspFirmwareModal
        open={firmwareOpen}
        onClose={() => setFirmwareOpen(false)}
      />
    </div>
  );
}
