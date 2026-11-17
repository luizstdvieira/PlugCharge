import React, { useState } from 'react';
import {
  APIProvider,
  Map,
  AdvancedMarker,
  Pin,
  InfoWindow,
  useAdvancedMarkerRef,
} from '@vis.gl/react-google-maps';
import { MapPin, Navigation } from 'lucide-react';
import type { ChargingStatus, TotemLocation } from '../types/totem';

interface TotemMapProps {
  location: TotemLocation;
  status: ChargingStatus;
  onUpdateLocation: (lat: number, lng: number) => Promise<void>;
}

const STATUS_LABEL: Record<ChargingStatus, string> = {
  PRONTO: 'ESP32-S3 Pronta',
  CARREGAMENTO_INICIADO: 'Carregamento Iniciado',
  CARREGANDO: 'Carregando por Indução',
  CONCLUIDO: 'Carga Concluída',
  PARADO: 'Parado',
};

function TotemMarker({
  location,
  status,
}: {
  location: TotemLocation;
  status: ChargingStatus;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const [infoOpen, setInfoOpen] = useState(true);

  const isCharging =
    status === 'CARREGANDO' || status === 'CARREGAMENTO_INICIADO';

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: location.lat, lng: location.lng }}
        title={location.name}
        onClick={() => setInfoOpen((prev) => !prev)}
      >
        <Pin
          background={isCharging ? '#16a34a' : '#0f172a'}
          borderColor={isCharging ? '#14532d' : '#334155'}
          glyphColor="#ffffff"
          scale={1.15}
        />
      </AdvancedMarker>
      {infoOpen && marker && (
        <InfoWindow anchor={marker} onCloseClick={() => setInfoOpen(false)}>
          <div className="p-1 min-w-[180px] text-slate-900">
            <p className="text-xs font-semibold">{location.name}</p>
            <p className="text-[11px] text-slate-600 mt-0.5">
              {STATUS_LABEL[status]}
            </p>
          </div>
        </InfoWindow>
      )}
    </>
  );
}

export function TotemMap({
  location,
  status,
  onUpdateLocation,
}: TotemMapProps) {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const handleUseMyLocation = () => {
    if (!navigator.geolocation) {
      setGeoError('Geolocalização não suportada neste navegador.');
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await onUpdateLocation(pos.coords.latitude, pos.coords.longitude);
        } finally {
          setLocating(false);
        }
      },
      () => {
        setGeoError('Não foi possível obter sua localização atual.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  return (
    <section
      id="localizacao"
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
    >
      <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Localização do Totem de Indução
          </h2>
          <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>{location.name}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={handleUseMyLocation}
          disabled={locating}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 w-full sm:w-auto"
        >
          <Navigation className="w-3.5 h-3.5" />
          {locating ? 'Localizando...' : 'Usar Minha Localização'}
        </button>
      </div>

      {geoError && (
        <div className="px-6 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">
          {geoError}
        </div>
      )}

      <div className="h-[260px] sm:h-[340px] w-full bg-slate-100">
        {apiKey ? (
          <APIProvider apiKey={apiKey} libraries={['marker']}>
            <Map
              mapId="DEMO_MAP_ID"
              center={{ lat: location.lat, lng: location.lng }}
              defaultZoom={16}
              gestureHandling="greedy"
              disableDefaultUI={false}
              internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              style={{ width: '100%', height: '100%' }}
            >
              <TotemMarker
                location={location}
                status={status}
              />
            </Map>
          </APIProvider>
        ) : (
          <div className="h-full w-full flex flex-col items-center justify-center p-6 text-center text-slate-500 text-sm">
            <MapPin className="w-6 h-6 text-slate-400 mb-2" />
            <p className="font-medium text-slate-700">
              Chave do Google Maps não encontrada no ambiente
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Recarregue a página após concluir o provisionamento da API Key.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
